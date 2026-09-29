/**
 * koishi-plugin-chatluna-vision
 *
 * 图片理解策略（R6 / R7 / R8）。
 *
 * 背景：ChatLuna 默认把图片变成提示词里的 `[image:http://127.0.0.1:5140/...]`
 * —— 一个模型根本打不开的本地 URL，所以模型只会说"图挂了，我看不见"。
 *
 * 本插件挂钩 `ctx.chatluna.messageTransformer.before()`，在 ChatLuna 处理元素之前
 * **直接改写 elements 数组**，把图片换成文字描述或整段删掉。
 *
 * 策略：
 *   1. 先算图片 sha256，查库
 *      - 命中 → 直接替换成描述文字（零 API 调用）
 *   2. 没命中：
 *      - 私聊               → 解析（阻塞等待），然后替换
 *      - 群里 且 @了bot      → 解析（阻塞等待），然后替换
 *      - 群里 且 没@bot      → **整段删掉**，模型完全不知道有图
 *   3. 引用消息里的图走同一条逻辑（ChatLuna 会递归调用，options.quote = true）
 *
 * 关键事实（实证来源）：
 *   - `before(fn, priority)` 的回调签名是 `(session, elements, message, model, options)`，
 *     `elements` 就是待处理数组，可原地 splice / 替换。见 `lib/services/chat.cjs` 的 `_runBeforeTransform`。
 *   - 引用消息会被 `transform()` **递归**再跑一遍（带 `{ quote: true }`），
 *     所以消息里的图和引用里的图会各触发一次本回调，不需要特判。
 *   - 图片 URL 带 rkey 有 TTL，**必须当场下载**，不能入队延后。
 */

const { Schema, Logger, h } = require('koishi')
const crypto = require('node:crypto')

const name = 'chatluna-vision'
const inject = { required: ['database', 'http'], optional: ['chatluna'] }

const TABLE = 'chatluna_image_cache'
const logger = new Logger('chatluna-vision')

// sharp 是可选的：宿主没装就自动跳过压缩（见 compress()）
let sharp = null
try {
  sharp = require('sharp')
} catch {
  logger.warn('没装 sharp，图片压缩已禁用（大图解析会很慢）。装了重启即可生效')
}

const DEFAULT_DESCRIBE_PROMPT =
  '直接说出这张图里的内容，就像你自己看到的一样。' +
  '不要出现「图 / 图片 / 画面 / 图中 / 这是一张」这类说明性字眼，' +
  '不要写「我看到了」，不要评价、不要客套、不要问问题、不要加任何前缀。' +
  '图里有文字就把文字原样写出来。一句话，越短越好。'

const Config = Schema.intersect([
  Schema.object({
    visionModel: Schema.string()
      .default('deepseek/deepseek/deepseek-v4-flash-vision-exp')
      .description(
        '用来识别图片的模型（ChatLuna 完整模型名）。' +
        '必须含 "vision" 才会被 ChatLuna 判定为支持图片输入。'
      ),
    parseInPrivate: Schema.boolean().default(true).description('私聊里是否解析图片（阻塞等待解析完成后才回复）'),
    parseInGroupWhenAt: Schema.boolean().default(true).description(
      '群里被 @ 时是否解析图片（含引用消息里的图）'
    ),
    parseAllGroupImages: Schema.boolean().default(false).description(
      '群里是否无条件解析所有图片。默认关——群友发图太频繁，全解析烧钱又慢'
    ),
    parseWhenUserIds: Schema.array(Schema.string())
      .role('table')
      .default(['__proactive_trigger__'])
      .description(
        '这些"用户"发的图无条件解析（R9 主动插话用）。' +
          'chatluna-proactive-trigger 触发时伪造成这个 userId，' +
          '它会把群历史里的图转成 data URL 塞进来；' +
          '如果不在这里放行，本插件会把那些图当成"群里没叫 bot 的图"直接丢掉'
      ),
    ignoreUnparsedInGroup: Schema.boolean().default(true).description(
      '群里遇到未解析过的图是否"装作没看见"。关掉则退化成 ChatLuna 默认行为（塞一个打不开的 URL）'
    ),
    describePrompt: Schema.string().default(DEFAULT_DESCRIBE_PROMPT).description('让视觉模型描述图片时用的提示词'),
    maxImageBytes: Schema.natural().default(8 * 1024 * 1024).description('超过这个大小的图直接跳过（字节）'),
    timeout: Schema.natural().default(60000).description('单张图解析的超时时间（毫秒）'),
    compress: Schema.boolean().default(true).description(
      '送模型前是否压缩图片（需要宿主装了 sharp）。实测 1.1MB 的 PNG 能压到 68KB，' +
        '解析耗时从 19 秒降到几秒。sharp 缺失时自动退回用原图'
    ),
    maxEdge: Schema.natural().default(1024).description('压缩后长边最大像素（不会放大）'),
    jpegQuality: Schema.natural().min(1).max(100).default(85).description(
      '压缩成 JPEG 的质量。调低省流量但图里的文字可能糊'
    ),
    healthCheckUrl: Schema.string().default('').description(
      '启动时抓取这张图跑一次完整链路（下载 → 压缩 → 视觉模型 → 出描述）并写进日志，' +
        '用来确认视觉通路是通的。留空则跳过。'
    ),
    debug: Schema.boolean().default(false).description('打印每张图的处理过程'),
  }),
  Schema.object({
    textTemplate: Schema.string().default('{desc}').description(
      '替换进提示词的模板，{desc} 会被替换成描述。默认直接就是描述本身，' +
        '不附加任何说明文字；想让模型明确知道"这是张图"可以改成 [图片] {desc}'
    ),
  }),
])

// ------------------------------------------------------------------ 工具

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/** 取出元素里的图片 URL（Koishi 的 img 元素属性名可能是 src 或 url） */
function imageUrlOf(el) {
  const a = el?.attrs || {}
  return a.src || a.url || a.file || null
}

/** 这段 elements 里有没有 @ 当前 bot */
function hasAtBot(elements, session) {
  if (!Array.isArray(elements)) return false
  return elements.some(
    (el) => el?.type === 'at' && String(el?.attrs?.id) === String(session?.selfId)
  )
}

/**
 * 本消息是否"叫了 bot"。四个来源，满足其一即可：
 *   1. Koishi 自己算出来的 stripped.appel / atSelf —— 开头 @bot，或以 nickname 开头
 *      （见 @koishijs/core `get stripped()`，这两个字段就是 ChatLuna 的触发依据）
 *   2. 正文 elements 里 @ 了 bot（含 @ 在句子中间的情况）
 *   3. 引用消息的 elements 里 @ 了 bot
 *   4. 引用了 bot 自己发的消息（手机端最常见的"接着聊"方式）
 *
 * 注意：跟进插件（chatluna-followup）会往 elements 前面插一个指向 bot 的 at，
 * 所以群里"@过 bot 之后的后续消息"也会走第 2 条，图片照样会被解析。
 */
function isBotCalled(session, currentElements) {
  if (session?.stripped?.appel || session?.stripped?.atSelf) return true
  if (hasAtBot(session?.elements, session)) return true
  if (hasAtBot(currentElements, session)) return true
  if (hasAtBot(session?.quote?.elements, session)) return true
  if (
    session?.quote?.user?.id != null &&
    String(session.quote.user.id) === String(session?.selfId)
  ) {
    return true
  }
  return false
}

// ------------------------------------------------------------------ 应用

function apply(ctx, config) {
  // 按 hash 存描述，永久有效
  ctx.model.extend(
    TABLE,
    {
      hash: { type: 'string', length: 64 },
      description: { type: 'text', initial: '' },
      model: { type: 'string', length: 128, nullable: true },
      bytes: { type: 'integer', initial: 0 },
      createdAt: { type: 'timestamp', nullable: true },
    },
    { primary: ['hash'] }
  )

  const log = (...a) => config.debug && logger.info(...a)

  async function getCached(hash) {
    const rows = await ctx.database.get(TABLE, { hash })
    return rows[0]?.description || null
  }

  async function putCached(hash, description, model, bytes) {
    await ctx.database.upsert(TABLE, [
      { hash, description, model, bytes, createdAt: new Date() },
    ])
  }

  /**
   * 下载图片字节。必须当场做——rkey 有 TTL。
   *
   * ★ 要支持 `data:` URL：R9 的 chatluna-proactive-trigger 会把群历史里的图
   *   先缓存到本地、再以 `data:image/png;base64,...` 的形式塞进 elements
   *   （它自己的注释：避免本地文件路径被 chatluna 当成 HTTP URL 去读）。
   *   ctx.http.file() 不认 data URL，不特判就会整个 fallback 到"忽略未解析图片"。
   */
  async function download(url) {
    const s = String(url || '')
    if (s.startsWith('data:')) {
      const comma = s.indexOf(',')
      if (comma < 0) throw new Error('data URL 格式不对')
      const header = s.slice(5, comma) // 形如 image/png;base64
      const payload = s.slice(comma + 1)
      const isBase64 = /;base64/i.test(header)
      const mime = String(header.split(';')[0] || 'image/jpeg').trim() || 'image/jpeg'
      const buf = isBase64
        ? Buffer.from(payload, 'base64')
        : Buffer.from(decodeURIComponent(payload), 'utf8')
      if (buf.length === 0) throw new Error('data URL 解出 0 字节')
      if (buf.length > config.maxImageBytes) throw new Error(`图片过大 ${buf.length} 字节`)
      return { buf, mime: /^image\//.test(mime) ? mime : 'image/jpeg' }
    }
    const res = await ctx.http.file(url, { timeout: config.timeout })
    const data = res?.data
    if (!data) throw new Error('下载结果为空')
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
    if (buf.length === 0) throw new Error('下载到 0 字节')
    if (buf.length > config.maxImageBytes) throw new Error(`图片过大 ${buf.length} 字节`)
    // content-type 可能带 ";charset=utf-8"，直接塞进 data URL 会坏掉
    let type = String(res.type || res.mime || 'image/jpeg').split(';')[0].trim()
    if (!/^image\//.test(type)) type = 'image/jpeg'
    return { buf, mime: type }
  }

  /**
   * 送模型前压一下：长边缩到 maxEdge、转 JPEG。
   *
   * 为什么必须做：原图会以 base64 塞进请求体，1.1MB 的 PNG 变成 1.5MB 的 base64，
   * 实测视觉调用要 19~24 秒，而且整条 transform 都被卡住。
   * 压完通常 60~80KB，耗时降到几秒。压缩本身只要 30~80ms。
   *
   * sharp 是可选的：没装、或者这张图解不开（比如某些动图/畸形文件），
   * 就原样返回，不因为压缩失败而丢掉图片。
   * 注意：**缓存 hash 用原图算**，所以换压缩参数不会让缓存失效。
   */
  async function compress(buf, mime) {
    if (!config.compress || !sharp) return { buf, mime }
    try {
      const out = await sharp(buf)
        .rotate() // 按 EXIF 摆正，否则手机竖拍会躺倒
        .resize({
          width: config.maxEdge,
          height: config.maxEdge,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .flatten({ background: '#ffffff' }) // PNG 透明区转 JPEG 会变黑，垫白底
        .jpeg({ quality: config.jpegQuality, mozjpeg: true })
        .toBuffer()
      if (!out || out.length === 0) return { buf, mime }
      if (out.length >= buf.length) return { buf, mime } // 压完反而更大就别压
      return { buf: out, mime: 'image/jpeg' }
    } catch (e) {
      logger.debug('压缩失败，改用原图：%s', e.message)
      return { buf, mime }
    }
  }

  /** 调 ChatLuna 的视觉模型描述图片 */
  async function describe(buf, mime) {
    const { HumanMessage } = require('@langchain/core/messages')
    const ref = await ctx.chatluna.createChatModel(config.visionModel)
    const model = ref?.value
    if (!model) throw new Error(`拿不到模型 ${config.visionModel}`)

    const b64 = buf.toString('base64')
    const res = await model.invoke(
      [
        new HumanMessage({
          content: [
            { type: 'text', text: config.describePrompt },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
          ],
        }),
      ],
      { timeout: config.timeout }
    )
    const text = typeof res?.content === 'string'
      ? res.content
      : Array.isArray(res?.content)
        ? res.content.map((c) => c?.text || '').join('')
        : ''
    const out = String(text).trim()
    if (!out) throw new Error('模型返回空描述')
    return out
  }

  /** 同一张图在一轮里可能被并行请求多次，用这张表把并发合并成一次解析 */
  const inflight = new Map()

  /**
   * 把一段 elements 里的图片按策略处理掉（原地改写数组）。
   *
   * 循环内**不**做 splice —— 多张图是并行解析的，边处理边删会把下标搞乱。
   * 约定：图片位要么换成 text 元素，要么置 null 表示丢弃，最后统一压实。
   */
  async function handleElements(session, elements, isQuotePass) {
    if (!Array.isArray(elements) || elements.length === 0) return

    const isDirect = !!session.isDirect
    // 注意：@ 判定要看**整条消息**（引用那段自己可能没有 at），所以这里不看当前这一段
    const atBot = isBotCalled(session, elements)

    const indexes = []
    for (let i = 0; i < elements.length; i++) {
      if (elements[i]?.type === 'img') indexes.push(i)
    }
    if (indexes.length === 0) return

    const tag = isQuotePass ? '引用' : '正文'

    await Promise.all(
      indexes.map(async (i) => {
        const url = imageUrlOf(elements[i])
        if (!url) {
          elements[i] = null
          return
        }

        // ---- 1) 先下载并算 hash（rkey 有 TTL，必须当场下）----
        let hash = null
        let buf = null
        let mime = null
        try {
          const got = await download(url)
          buf = got.buf
          mime = got.mime
          hash = sha256(buf)
        } catch (e) {
          log('%s 图片下载失败（%s）：%s', tag, String(url).slice(0, 60), e.message)
        }

        // ---- 2) 查缓存：命中就直接换成文字，零 API 调用 ----
        if (hash) {
          const cached = await getCached(hash)
          if (cached) {
            elements[i] = h.text(config.textTemplate.replace('{desc}', cached))
            log('%s 缓存命中 %s', tag, hash.slice(0, 12))
            return
          }
        }

        // ---- 3) 没命中，决定要不要现场解析 ----
        // 主动插话（R9）伪装的 userId 无条件放行：那些图是插件特意从群历史里
        // 挑出来缓存好的，丢掉就等于让 bot"瞎着"插话。
        const forced = (config.parseWhenUserIds || []).includes(String(session.userId))
        const shouldParse =
          forced ||
          config.parseAllGroupImages ||
          (isDirect && config.parseInPrivate) ||
          (!isDirect && config.parseInGroupWhenAt && atBot)

        if (!shouldParse) {
          // 群里没 @bot 且没缓存 —— 装作没看见，模型完全不知道有图
          if (config.ignoreUnparsedInGroup) {
            elements[i] = null
            log('%s 忽略未解析图片（群聊未叫 bot）', tag)
          }
          return
        }

        // ---- 4) 现场解析：阻塞在这里，回复会等它出结果 ----
        if (!buf) {
          elements[i] = h.text(config.textTemplate.replace('{desc}', '无法读取（图片已失效）'))
          return
        }
        try {
          log('%s 开始解析 %s（%d 字节）…', tag, hash.slice(0, 12), buf.length)
          const t0 = Date.now()
          let task = inflight.get(hash)
          if (!task) {
            task = compress(buf, mime)
              .then((send) => {
                if (send.buf !== buf) {
                  log('%s 已压缩 %d → %d 字节', tag, buf.length, send.buf.length)
                }
                return describe(send.buf, send.mime)
              })
              .then(async (desc) => {
                await putCached(hash, desc, config.visionModel, buf.length)
                return desc
              })
              .finally(() => inflight.delete(hash))
            inflight.set(hash, task)
          }
          const desc = await task
          elements[i] = h.text(config.textTemplate.replace('{desc}', desc))
          logger.info('图片已解析（%d ms）：%s', Date.now() - t0, desc.slice(0, 60))
        } catch (e) {
          logger.warn('图片解析失败：%s', e.message)
          elements[i] = h.text(config.textTemplate.replace('{desc}', '解析失败'))
        }
      })
    )

    // ---- 压实：丢掉标记为 null 的位置，并且必须原地改（ChatLuna 持有这个数组的引用）----
    const kept = elements.filter((el) => el != null)
    if (kept.length !== elements.length) {
      elements.length = 0
      elements.push(...kept)
    }
  }

  ctx.inject(['chatluna'], (ctx2) => {
    const transformer = ctx2.chatluna?.messageTransformer
    if (!transformer || typeof transformer.before !== 'function') {
      logger.warn('messageTransformer.before 不可用，图片策略未生效')
      return
    }
    // priority 设高一点，尽量在别的 before 之前跑（数字大的排后面，这里用小负数抢先）
    transformer.before(async (session, elements, _message, _model, options) => {
      try {
        await handleElements(session, elements, !!options?.quote)
      } catch (e) {
        logger.warn('处理图片时出错：%s', e.message)
      }
    }, -100)
    logger.info(
      '图片策略已挂载（视觉模型：%s；压缩 %s）',
      config.visionModel,
      config.compress ? (sharp ? `开，长边 ${config.maxEdge} / JPEG q${config.jpegQuality}` : '要开但没装 sharp') : '关'
    )

    // 自检：不阻塞插件加载，跑完把结果写进日志
    if (config.healthCheckUrl) {
      ctx.setTimeout(async () => {
        const t0 = Date.now()
        try {
          const got = await download(config.healthCheckUrl)
          const send = await compress(got.buf, got.mime)
          const tc = Date.now()
          const desc = await describe(send.buf, send.mime)
          logger.info(
            '视觉自检通过（总 %d ms，其中压缩 %d ms；%d 字节 → 送模型 %d 字节）：%s',
            Date.now() - t0,
            tc - t0,
            got.buf.length,
            send.buf.length,
            desc.slice(0, 120)
          )
        } catch (e) {
          logger.warn('视觉自检失败：%s', e.message)
        }
      }, 3000)
    }
  })

  // 人工干预：清缓存 / 看统计
  // ★ 点号全名（`vision.stat`），不是 `vision/stat`：斜杠写法的子指令名字只有 `stat`，
  //   而 Commander 按整名查 _aliases（core:1411/1432）→ 用户敲 `/vision.stat` 永远没反应。
  ctx.command('vision.stat', '看图片解析缓存统计', { authority: 3 }).action(async () => {
    const rows = await ctx.database.get(TABLE, {})
    const total = rows.reduce((s, r) => s + (r.bytes || 0), 0)
    return `已缓存 ${rows.length} 张图的描述，共 ${(total / 1024 / 1024).toFixed(1)} MB 原图`
  })

  ctx
    .command('vision.forget <hash:string>', '删掉某张图的解析缓存', { authority: 3 })
    .action(async (_a, hash) => {
      if (!hash) return '要给 hash 前缀'
      const rows = await ctx.database.get(TABLE, {})
      if (rows.length === 0) return '缓存是空的'
      const hit = rows.filter((r) => r.hash.startsWith(hash))
      if (hit.length === 0) return `没有以 ${hash} 开头的记录`
      for (const r of hit) await ctx.database.remove(TABLE, { hash: r.hash })
      return `删掉了 ${hit.length} 条`
    })
}

module.exports = { name, inject, Config, apply }
