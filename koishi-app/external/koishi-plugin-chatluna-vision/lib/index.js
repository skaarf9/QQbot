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
const fs = require('node:fs')

const name = 'chatluna-vision'
const inject = { required: ['database', 'http'], optional: ['chatluna'] }

const TABLE = 'chatluna_image_cache'

/**
 * 缓存版本。**只有"送进模型的字节会变"的改动才需要 +1**：
 * 换了压缩参数、换了描述模板、换了视觉模型，旧描述就代表不了现在会看到的东西。
 *
 * ★ 为什么必须有这个：缓存键是**原图**的 sha256（`putCached` 注释里写了"换压缩参数
 *   不会让缓存失效"——那在当时是特性，现在是 bug）。2026-10-03 把无差别压缩改成
 *   按阈值压缩之后，旧库里那些"被 JPEG 压糊了的描述"会一直被命中，改了参数却不生效。
 *   所以加一列 `v`，读的时候要求 `v >= CACHE_VERSION`，老的自动重解析。
 *
 * v1 = 无差别压缩 + 裸 {desc} 模板
 * v2 = 阈值压缩 + [图片] 标记 + 引用图分开 + 多图编号
 */
const CACHE_VERSION = 2
const logger = new Logger('chatluna-vision')

// sharp 是可选的：宿主没装就自动跳过压缩（见 compress()）
let sharp = null
try {
  sharp = require('sharp')
} catch {
  logger.warn('没装 sharp，图片压缩已禁用（大图解析会很慢）。装了重启即可生效')
}

// imghash 也是可选的：用来算 pHash（感知哈希），做"同一张图换个字节也算同一张"的去重。
// 与 chatluna-sticker 用的是**同一个库、同一套 64 位 pHash**，所以两边认的是同一批图。
let imghash = null
try {
  imghash = require('imghash')
} catch {
  logger.warn('没装 imghash，图片去重退化为 sha256 精确匹配（转发/重压过的图会重复解析）')
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
    fallbackModel: Schema.string()
      .default('deepseek/deepseek/deepseek-v4-flash-vision-exp')
      .description(
        '备用视觉模型：主模型失败（超时 / 空响应 / 5xx）时自动改用这个。' +
        '留空 = 不兜底。免费 stealth 模型可用性会抖，强烈建议留着这个兜底'
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
    dedupeByPhash: Schema.boolean().default(true).description(
      '★ 用感知哈希（pHash）去重：同一张图被**转发 / 重压 / 换格式**之后字节变了，' +
        'sha256 认不出来，但 pHash 认得出。与 chatluna-sticker 用同一套 64 位 pHash'
    ),
    phashThreshold: Schema.natural().min(0).max(32).default(5).description(
      'pHash 汉明距离 ≤ 这个值就当成同一张图（默认 5，与 chatluna-sticker 一致）。调大更容易命中但可能误判'
    ),
    timeout: Schema.natural().default(60000).description('单张图解析的超时时间（毫秒）'),
    compress: Schema.boolean().default(true).description(
      '送模型前是否压缩图片（需要宿主装了 sharp）。实测 1.1MB 的 PNG 能压到 68KB，' +
        '解析耗时从 19 秒降到几秒。sharp 缺失时自动退回用原图'
    ),
    compressMinBytes: Schema.natural().default(256 * 1024).description(
      '★ 小于这个字节数、且长边没超过 maxEdge 的图**原样送模型**，一个字节都不动。' +
        '默认 256KB。' +
        '为什么要这个：旧行为是**所有图无差别重压成 JPEG q85**，实测一张 123KB 的表情包也被' +
        '压成 78KB —— 体积没省多少，图里的文字和细节却被抹掉了，模型反而认错。' +
        '压缩的意义只在「本来就要缩小」或「本来就很大」这两种情况。' +
        '0 = 退回旧行为（所有图都压）。注意：带 EXIF 旋转信息的图仍会强制压一次来摆正'
    ),
    maxEdge: Schema.natural().default(1024).description('压缩后长边最大像素（不会放大）'),
    jpegQuality: Schema.natural().min(1).max(100).default(85).description(
      '压缩成 JPEG 的质量。调低省流量但图里的文字可能糊'
    ),
    blockingTimeoutMs: Schema.natural().default(15000).description(
      '★ 现场解析最长阻塞多久（毫秒），超了就先用占位文字放行这一轮，解析在后台继续跑并写进缓存，' +
        '同一张图下次直接命中。默认 15000。' +
        '为什么要有：解析是在 transform 里**同步等**的，一张 5MB 的图会把整轮回复拖住几十秒，' +
        '期间用户发什么都排在后面 —— 这就是"偶尔延迟很高"的一半来源。0 = 一直等（旧行为）'
    ),
    healthCheckUrl: Schema.string().default('').description(
      '启动时抓取这张图跑一次完整链路（下载 → 压缩 → 视觉模型 → 出描述）并写进日志，' +
        '用来确认视觉通路是通的。留空则跳过。'
    ),
    debug: Schema.boolean().default(false).description('打印每张图的处理过程'),
    correctTool: Schema.boolean().default(true).description(
      '是否给模型注册 vision_correct 工具：让 AI 在"认出这张图其实是别的"之后，' +
        '主动把已缓存的文字描述改掉（下次同一张图就走修正后的描述）'
    ),
    syncSticker: Schema.boolean().default(true).description(
      '修正描述时，是否一并把 chatluna-sticker 表情库里的 description 同步改掉（靠 pHash 对上）'
    ),
    selfAware: Schema.boolean().default(true).description(
      '★ 让视觉模型知道"图里画的可能就是 bot 自己"。' +
        '身份事实来自 chatluna-persona 的人设卡片（data/persona/self.yml），' +
        '它会在描述提示词前面加一段"这个角色长什么样、什么算她、什么不算她"。' +
        '开了之后描述开头会带 [自己] / [可能自己] 标记，对话模型据此知道"这表情包说的是我"'
    ),
    selfCompare: Schema.union([
      Schema.const('text').description('只给文字形象描述（省一次图片传输，快）'),
      Schema.const('image').description('每次都把参考形象图一起送进去比对（最准，但每张图多传一张参考图）'),
      Schema.const('auto').description('先纯文字；只有拿不准（[可能自己]）时再带参考图重认一次'),
      Schema.const('off').description('不注入身份（等于关掉自我识别）'),
    ])
      .default('text')
      .description(
        '★ 视觉模型"认出自己"的三种做法。实测口径见 docs/28：' +
          '文字描述能认出**典型形象**（蓝色鲸鱼娘/女仆装/鲸鱼耳），' +
          '但把别的蓝发角色误认成自己的概率明显更高；配参考图能压住误判，代价是每次多一张图。'
      ),
    selfImage: Schema.string().default('').description(
      '参考形象图（本地路径或 http 链接）。留空 = 用 self.yml 的 selfImage（auto 会取 bot 的 QQ 头像并缓存）'
    ),
  }),
  Schema.object({
    textTemplate: Schema.string().default('[图片{i}] {desc}').description(
      '把描述替换进用户消息时用的模板。`{desc}` = 描述本身，`{i}` = 图片序号' +
        '（一条消息里只有一张图时展开成空串，多张时展开成 " 1" / " 2"）。' +
        '★ 别把它设成裸 `{desc}`：那样描述会**跟用户自己打的话长得一模一样**，' +
        '模型会以为是你说的，于是回出「你这描述也太渗人了」这种错位的话（2026-10-03 实测）。'
    ),
    quoteTextTemplate: Schema.string().default('[引用的图片{i}] {desc}').description(
      '★ 引用消息里的图用这个模板，和正文的图**分开**。' +
        '之前两个共用一套模板，模型分不清哪张是"他现在发的"、哪张是"他引用的那条里的"，' +
        '描述会串到另一张图上。'
    ),
    timeoutTemplate: Schema.string().default('[图片{i}] （这张图还在识别，先当没看清）').description(
      '解析超过 blockingTimeoutMs 时先塞进消息里的占位文字'
    ),
    numberedWhenMultiple: Schema.boolean().default(true).description(
      '一条消息里有多张图时，是否给每张图编号（配合模板里的 {i}）。' +
        '关掉则 {i} 永远展开成空串'
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
      phash: { type: 'string', length: 16, nullable: true },
      description: { type: 'text', initial: '' },
      model: { type: 'string', length: 128, nullable: true },
      bytes: { type: 'integer', initial: 0 },
      // 见文件头 CACHE_VERSION：0 = 旧版本（会被当成未命中，自动重解析）
      v: { type: 'integer', initial: 0 },
      createdAt: { type: 'timestamp', nullable: true },
      // ---- 修正痕迹（2026-10-04 加）----
      // 为什么要记：`/vision.this` 是"对话模型有没有把自己认出来 / 有没有改对"的唯一观测口，
      // 而"这条描述是模型原始输出、还是后来被 vision_correct 改过"光看 description 分不出来。
      // 三列都 nullable，加列是纯增量（Koishi 启动时 ALTER TABLE ADD COLUMN），旧行不受影响。
      correctedFrom: { type: 'text', nullable: true },
      correctedBy: { type: 'string', length: 64, nullable: true },
      correctedAt: { type: 'timestamp', nullable: true },
      /** 描述里带 [自己] / [可能自己] 标记时的结论：yes / maybe / no（便于直接查库统计） */
      selfFlag: { type: 'string', length: 8, nullable: true },
    },
    { primary: ['hash'] }
  )

  const log = (...a) => config.debug && logger.info(...a)

  // 压缩/缓存的可观测计数（vision.stat 会读）
  const stats = { compressed: 0, skipped: 0, timeout: 0 }

  /** 这条缓存记录还是"当前版本"的吗 */
  const isFreshRow = (r) => Number(r?.v ?? 0) >= CACHE_VERSION

  /**
   * 把描述套进模板。
   *
   * `{i}` 在有且仅有一条消息里出现多张图时展开成 " 1"/" 2"，否则展开成空串 ——
   * 这样单图还是 `[图片] 描述`，多图自动变成 `[图片 1] 描述` / `[图片 2] 描述`，
   * 模型就不会把第 2 张的描述安到第 1 张头上。
   */
  function applyTemplate(tpl, desc, idx, total) {
    const t = String(tpl ?? '{desc}')
    const label = config.numberedWhenMultiple !== false && total > 1 ? ` ${idx + 1}` : ''
    return t.replace(/\{desc\}/g, String(desc ?? '')).replace(/\{i\}/g, label)
  }

  // ---------------------------------------------------------------- 自我识别
  //
  // 2026-10-04 加。原来的问题：视觉模型**不知道角色的存在**，于是把 bot 自己的形象
  // 描述成"蓝色小女孩"，对话模型看到这句完全认不出是自己；而表情包库里的描述也是这么来的，
  // 于是"这张图说的是我自己"这件事在整个系统里无人知晓。
  //
  // 做法：从 chatluna-persona 的人设卡片取身份事实（长什么样 / 什么算她 / 什么不算她），
  // 拼在描述提示词前面，并要求模型在描述**开头**打标记。
  //
  // ★ 为什么用 [自己] / [可能自己] 两个标记，而不是让模型自由表述：
  //   自由表述（"这好像是你自己吧"）没法机械校验，也读不出模型的把握程度；
  //   三态刚好对应三种处理：敢认（yes）、拿不准（maybe，可再带参考图重认）、当普通图（no）。
  //   标记进的是**缓存描述**，所以对话模型、表情包检索、日志三处都看得到同一份结论。

  const SELF_YES = '[自己]'
  const SELF_MAYBE = '[可能自己]'
  /** 参考图的说明：必须写清楚"这张不是待识别的图"，否则模型会把参考图也描述一遍 */
  const REF_LABEL = '下面这张是【参考形象图】，只是用来比对的，**不要描述这一张**，也不要把它的内容算进上面的描述里。'

  /** 人设卡片服务（没装 chatluna-persona 就是 null，全部功能自动退化为"没有自我识别"） */
  function persona() {
    return ctx.get('chatluna_persona') || null
  }

  /** 送进模型的描述提示词 = 身份段 + 用户配的 describePrompt */
  function describePromptText() {
    if (!config.selfAware || config.selfCompare === 'off') return config.describePrompt
    let block = ''
    try {
      block = persona()?.block?.('vision') || ''
    } catch (e) {
      logger.debug('取身份段失败：%s', e.message)
    }
    return block ? `${block}\n\n${config.describePrompt}` : config.describePrompt
  }

  /** 描述开头的标记 → yes / maybe / no。兼容模型写成全角括号或加字的情况 */
  function selfFlagOf(desc) {
    const t = String(desc || '').trim()
    const head = t.slice(0, 16)
    if (/[[【]\s*可能(是)?自己\s*[\]】]/.test(head)) return 'maybe'
    if (/[[【]\s*自己\s*[\]】]/.test(head)) return 'yes'
    return 'no'
  }

  /** 把标记规范到最前面（模型有时写成"这张图 [自己] …"，那样前缀判断就失效了） */
  function normalizeSelfMark(desc) {
    const t = String(desc || '').trim()
    const flag = selfFlagOf(t)
    if (flag === 'no') return t
    const stripped = t
      .replace(/[[【]\s*可能(是)?自己\s*[\]】]/g, '')
      .replace(/[[【]\s*自己\s*[\]】]/g, '')
      .trim()
    return `${flag === 'yes' ? SELF_YES : SELF_MAYBE} ${stripped}`
  }

  /** 参考形象图的本地路径；优先用插件配置的 selfImage（测试时好替换），否则问人设卡片 */
  async function selfRefPath() {
    const want = String(config.selfImage || '').trim()
    if (want && !/^https?:/i.test(want)) {
      const p = require('node:path').resolve(ctx.baseDir, want)
      if (fs.existsSync(p)) return p
      logger.warn('selfImage 指向的文件不存在：%s', p)
    }
    try {
      const p = persona()
      if (p && typeof p.imagePath === 'function') {
        if (want && /^https?:/i.test(want)) return await p.imagePath(false)
        return await p.imagePath()
      }
    } catch (e) {
      logger.debug('取参考形象图失败：%s', e.message)
    }
    return null
  }

  /** 参考图的 content 分片（压缩后缓存 10 分钟：它基本不变，没必要每张图重压一遍） */
  const refCache = { path: null, at: 0, parts: null }
  async function refParts() {
    const p = await selfRefPath()
    if (!p) return []
    if (refCache.path === p && refCache.parts && Date.now() - refCache.at < 600000) return refCache.parts
    try {
      const raw = fs.readFileSync(p)
      const send = await compress(raw, /\.png$/i.test(p) ? 'image/png' : 'image/jpeg')
      const parts = [
        { type: 'text', text: REF_LABEL },
        {
          type: 'image_url',
          image_url: { url: `data:${send.mime};base64,${send.buf.toString('base64')}` },
        },
      ]
      refCache.path = p
      refCache.at = Date.now()
      refCache.parts = parts
      log('参考形象图已就绪：%s（%d → %d 字节）', p, raw.length, send.buf.length)
      return parts
    } catch (e) {
      logger.warn('读参考形象图失败（%s）：%s', p, e.message)
      return []
    }
  }

  // ---- 感知哈希索引：phash(16 位 hex) -> { hash, description } ----
  // 只在本进程写入这张表，所以内存索引和库是一致的；启动时建一次，写入时增量更新。
  const phashIndex = new Map()
  let phashReady = false

  async function buildPhashIndex() {
    if (!imghash || !config.dedupeByPhash) return
    try {
      const rows = await ctx.database.get(TABLE, {})
      phashIndex.clear()
      for (const r of rows) {
        // ★ 旧版本的描述不进索引：否则"改完参数不生效"会从 sha256 那条路绕到 pHash 这条路上
        if (r.phash && isFreshRow(r)) {
          phashIndex.set(String(r.phash), { hash: r.hash, description: r.description })
        }
      }
      phashReady = true
      log('pHash 索引已建立：%d 条', phashIndex.size)
    } catch (e) {
      logger.warn('建 pHash 索引失败（退化为 sha256）：%s', e.message)
    }
  }

  /** 算 pHash（64 位 hex）。失败返回 null，不影响主流程 */
  async function computePhash(buf) {
    if (!imghash || !config.dedupeByPhash) return null
    try {
      const h = await imghash.hash(buf, 8, 'hex')
      return h ? String(h).toLowerCase() : null
    } catch (e) {
      logger.debug('算 pHash 失败（%s）：%s', e.message, '退化为 sha256')
      return null
    }
  }

  /** 64 位 hex 的汉明距离 */
  function hamming(a, b) {
    if (!a || !b || a.length !== b.length) return 64
    try {
      let x = BigInt('0x' + a) ^ BigInt('0x' + b)
      let d = 0
      while (x > 0n) {
        d += Number(x & 1n)
        x >>= 1n
      }
      return d
    } catch {
      return 64
    }
  }

  /** 在索引里找汉明距离 ≤ 阈值的最近一条 */
  function nearestByPhash(phash) {
    let best = null
    let bestD = config.phashThreshold + 1
    for (const [p, meta] of phashIndex) {
      const d = hamming(phash, p)
      if (d <= config.phashThreshold && d < bestD) {
        bestD = d
        best = meta
      }
    }
    return best
  }

  /** 超时哨兵：和正常的描述字符串不可能撞上（描述不会是 Symbol） */
  const TIMED_OUT = Symbol('vision-timeout')

  /**
   * 给一个 promise 套上限时。**不取消**它 —— 传进来的 task 自己会写缓存，
   * 所以超时只是"这一轮不等了"，不是"这次白干了"。
   */
  function withTimeout(task, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(TIMED_OUT), ms)
      if (typeof timer.unref === 'function') timer.unref()
      task.then(
        (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        (e) => {
          clearTimeout(timer)
          reject(e) // 失败照旧抛出，交给外层 try/catch
        }
      )
    })
  }

  async function getCached(hash) {
    const rows = await ctx.database.get(TABLE, { hash })
    const r = rows[0]
    if (!r?.description) return null
    // ★ 版本不对 = 当成没缓存。理由见文件头 CACHE_VERSION
    if (!isFreshRow(r)) {
      log('缓存版本过旧（v%d < v%d），重解析 %s', Number(r.v ?? 0), CACHE_VERSION, String(hash).slice(0, 12))
      return null
    }
    return r.description
  }

  async function putCached(hash, description, model, bytes, phash) {
    await ctx.database.upsert(TABLE, [
      {
        hash,
        phash: phash || null,
        description,
        model,
        bytes,
        v: CACHE_VERSION,
        createdAt: new Date(),
        // 描述里带 [自己] / [可能自己] 时顺手记一列，方便直接查库统计（不依赖文本匹配）
        selfFlag: selfFlagOf(description),
      },
    ])
    if (phash) phashIndex.set(phash, { hash, description })
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
   * ★ 但「要压」不等于「所有图都压」（2026-10-03 修）
   *
   *   旧实现是无条件的：`sharp(buf).resize(...).jpeg({quality:85})`，只要压完更小就采用。
   *   实测一张 **123KB 的表情包**也被压成 78KB —— 省下的 45KB 对 7 秒的调用毫无意义，
   *   而 JPEG 的有损重编码把图里的文字和细节抹掉了，模型反而认错图（用户原话：
   *   "怀疑图片压缩会对所有大小的图片起作用，导致图片没有正确理解到"）。**用户是对的。**
   *
   *   现在的判据是「**不压会付代价**」才压，两种情况：
   *     a. 长边超过 maxEdge —— 不缩就是几千像素，token 和时间都受不了；
   *     b. 字节数超过 compressMinBytes —— base64 之后进请求体，是真的贵。
   *   两个都不满足就**原样送**，一个字节都不动。外加一个例外：带 EXIF 旋转信息的图
   *   必须过一遍 sharp 才能摆正，否则手机竖拍会躺倒。
   *
   * sharp 是可选的：没装、或者这张图解不开（比如某些动图/畸形文件），
   * 就原样返回，不因为压缩失败而丢掉图片。
   */
  async function compress(buf, mime) {
    if (!config.compress || !sharp) return { buf, mime, why: 'off' }
    const minBytes = Number(config.compressMinBytes) || 0
    try {
      // metadata() 只读文件头，比整图解码便宜得多
      let meta = null
      try {
        meta = await sharp(buf).metadata()
      } catch {}

      if (meta) {
        const longEdge = Math.max(meta.width || 0, meta.height || 0)
        const tooBigEdge = longEdge > config.maxEdge
        const tooManyBytes = minBytes <= 0 || buf.length > minBytes
        const needsRotate = Number(meta.orientation || 1) >= 5
        if (!tooBigEdge && !tooManyBytes && !needsRotate) {
          stats.skipped++
          log(
            '不压缩（%d 字节 ≤ %d 且长边 %d ≤ %d）：%s',
            buf.length,
            minBytes,
            longEdge,
            config.maxEdge,
            String(mime || '?')
          )
          return { buf, mime, why: 'small' }
        }
        log(
          '压缩理由：长边 %d%s｜字节 %d%s%s',
          longEdge,
          tooBigEdge ? ` > ${config.maxEdge}` : ` ≤ ${config.maxEdge}`,
          buf.length,
          tooManyBytes ? ` > ${minBytes}` : ` ≤ ${minBytes}`,
          needsRotate ? '｜需要按 EXIF 摆正' : ''
        )
      }

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
      if (!out || out.length === 0) return { buf, mime, why: 'empty' }
      if (out.length >= buf.length) return { buf, mime, why: 'bigger' } // 压完反而更大就别压
      stats.compressed++
      return { buf: out, mime: 'image/jpeg', why: 'compressed' }
    } catch (e) {
      logger.debug('压缩失败，改用原图：%s', e.message)
      return { buf, mime, why: 'error' }
    }
  }

  /**
   * 调 ChatLuna 的视觉模型描述图片（单次，指定模型）。
   *
   * `extra` 是跟在待识别图后面的额外 content 分片（目前只有"参考形象图 + 它的说明"）。
   * ★ 顺序不能反：待识别的图**永远在第一张**，模型描述的对象才明确；把参考图放前面
   *   实测会让模型开始描述参考图（"一个蓝色头发的女孩…"），而那正是自己，等于白跑一趟。
   */
  async function describeWith(modelName, buf, mime, extra = []) {
    const { HumanMessage } = require('@langchain/core/messages')
    const ref = await ctx.chatluna.createChatModel(modelName)
    const model = ref?.value
    if (!model) throw new Error(`拿不到模型 ${modelName}`)

    const b64 = buf.toString('base64')
    const content = [
      { type: 'text', text: describePromptText() },
      { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
      ...extra,
    ]
    const res = await model.invoke([new HumanMessage({ content })], { timeout: config.timeout })
    const text = typeof res?.content === 'string'
      ? res.content
      : Array.isArray(res?.content)
        ? res.content.map((c) => c?.text || '').join('')
        : ''
    const out = String(text).trim()
    if (!out) throw new Error('模型返回空描述')
    return normalizeSelfMark(out)
  }

  /**
   * 描述图片：主模型失败（超时 / 空响应 / 5xx）时退回 fallbackModel。
   * 视觉档大多是多供应商转发的（历史上的免费 stealth 模型 space-bunny-alpha
   * 已于 2026-10-06 被上游下架），可用性会抖，没有兜底的话那几张图会直接变成「解析失败」。
   *
   * selfCompare 的四种模式在这里分流（见配置说明与 docs/28 的实测）：
   *   off   → 不注入身份（旧行为）
   *   text  → 只给文字形象描述
   *   image → 每次都带参考形象图
   *   auto  → 先纯文字；模型自己标了 [可能自己] 才带参考图重认一次
   */
  async function describe(buf, mime) {
    const mode = config.selfAware ? config.selfCompare : 'off'
    const extra = mode === 'image' ? await refParts() : []
    const once = async (modelName) => describeWith(modelName, buf, mime, extra)
    let text
    try {
      text = await once(config.visionModel)
    } catch (e) {
      if (!config.fallbackModel || config.fallbackModel === config.visionModel) throw e
      logger.warn('视觉主模型失败（%s），退回备用模型 %s', e.message, config.fallbackModel)
      text = await once(config.fallbackModel)
    }
    if (mode === 'auto' && selfFlagOf(text) === 'maybe') {
      const parts = await refParts()
      if (parts.length) {
        try {
          const second = await describeWith(config.visionModel, buf, mime, parts)
          logger.info('自我识别不确定，带参考图重认：「%s」→「%s」', text.slice(0, 40), second.slice(0, 40))
          text = second
        } catch (e) {
          logger.warn('带参考图重认失败（保留第一次的结果）：%s', e.message)
        }
      }
    }
    return text
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

    // ★ 正文的图和引用的图用**不同模板**，多张图按位置编号。
    //   两个目的：
    //     1. 模型分得清"哪张是他刚发的、哪张在他引用的那条消息里"（之前共用一套模板，会串）；
    //     2. 一条消息里有多张图时带序号，描述不会互相安错人。
    const tpl = isQuotePass ? config.quoteTextTemplate : config.textTemplate
    const total = indexes.length
    /** 第 k 张（0 基）的描述该渲染成什么文本 */
    const render = (k, desc) => h.text(applyTemplate(tpl, desc, k, total))

    await Promise.all(
      indexes.map(async (i, k) => {
        const url = imageUrlOf(elements[i])
        if (!url) {
          elements[i] = null
          return
        }

        // ---- 1) 先下载并算 hash（rkey 有 TTL，必须当场下）----
        let hash = null
        let phash = null
        let buf = null
        let mime = null
        try {
          const got = await download(url)
          buf = got.buf
          mime = got.mime
          hash = sha256(buf)
          phash = await computePhash(buf)
        } catch (e) {
          log('%s 图片下载失败（%s）：%s', tag, String(url).slice(0, 60), e.message)
        }

        // ---- 2) 查缓存：命中就直接换成文字，零 API 调用 ----
        //   2a. sha256 精确命中（最快，且不依赖 imghash）
        //   2b. pHash 近似命中（同一张图被转发 / 重压 / 换格式，sha256 变了但 pHash 没变）
        if (hash) {
          let cached = await getCached(hash)
          if (cached) {
            elements[i] = render(k, cached)
            log('%s 缓存命中(sha256) %s', tag, hash.slice(0, 12))
            return
          }
          if (phash && phashReady) {
            const near = nearestByPhash(phash)
            if (near?.description) {
              cached = near.description
              elements[i] = render(k, cached)
              log('%s 缓存命中(pHash %s≈%s) %s', tag, phash, near.hash.slice(0, 8), hash.slice(0, 12))
              // 顺手把这条新字节也记下来，下次走 sha256 更快
              try {
                await putCached(hash, cached, config.visionModel, buf.length, phash)
              } catch {}
              return
            }
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
          elements[i] = render(k, '无法读取（图片已失效）')
          return
        }
        try {
          log('%s 开始解析 %s（%d 字节）…', tag, hash.slice(0, 12), buf.length)
          const t0 = Date.now()
          // 并发合并用 pHash 当键（比 sha256 更稳）：同一张图的不同字节副本也能并成一次调用
          const inflightKey = phash || hash
          let task = inflight.get(inflightKey)
          if (!task) {
            task = compress(buf, mime)
              .then((send) => {
                if (send.buf !== buf) {
                  log('%s 已压缩 %d → %d 字节', tag, buf.length, send.buf.length)
                } else if (send.why === 'small') {
                  // 阈值内不压缩：这条日志是"压缩没乱动小图"的现场证据
                  logger.info('不压缩，原样送模型（%d 字节，无需缩小）', buf.length)
                }
                return describe(send.buf, send.mime)
              })
              .then(async (desc) => {
                await putCached(hash, desc, config.visionModel, buf.length, phash)
                return desc
              })
              .finally(() => inflight.delete(inflightKey))
            inflight.set(inflightKey, task)
          }

          // ★ 阻塞上限：解析卡住时不能让整轮回复陪葬。
          //   超时后**不取消** task —— 它在后台继续跑、照常写缓存，
          //   所以同一张图下一次出现就是缓存命中，代价只付一次。
          const capMs = Number(config.blockingTimeoutMs) || 0
          const desc = capMs > 0 ? await withTimeout(task, capMs) : await task
          if (desc === TIMED_OUT) {
            stats.timeout++
            elements[i] = h.text(applyTemplate(config.timeoutTemplate, '', k, total))
            logger.info(
              '图片解析超过 %d ms，先放行本轮（后台继续，%s 解析完会进缓存）',
              capMs,
              hash.slice(0, 12)
            )
            task.catch(() => {})
            return
          }
          elements[i] = render(k, desc)
          logger.info('图片已解析（%d ms）：%s', Date.now() - t0, desc.slice(0, 60))
        } catch (e) {
          logger.warn('图片解析失败：%s', e.message)
          elements[i] = render(k, '解析失败')
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

  // ---------------------------------------------------------------- 描述修正
  //
  // 场景：视觉模型把图认错了（「蓝色小女孩」其实是 bot 自己），群友纠正之后，
  // 该由 AI 自己把**已缓存的描述**改掉——否则下次这张图又是错的描述。
  //
  // 定位方式（按可靠性排序）：
  //   1. hash 前缀（sha256 或 pHash）—— 最准
  //   2. old_description 原文被现有描述**包含**（模型通常会把看到的那句原样贴回来）
  //   3. 退一步：两句的最长公共子串 ≥ 4 个字
  //   4. 再退：刚解析过、且 15 分钟内只有一条 → 就用它
  // 命中多条时**不猜**，把候选列回去让模型再指一次。

  /** 最长公共子串（要求长度 ≥ 2 才有意义），用于模糊定位 */
  function longestCommonSubstring(a, b) {
    if (!a || !b) return ''
    const m = a.length
    const n = b.length
    if (m * n > 200000) return '' // 太长就不算了，避免卡住
    let best = 0
    let bestEnd = 0
    let prev = new Array(n + 1).fill(0)
    for (let i = 1; i <= m; i++) {
      const cur = new Array(n + 1).fill(0)
      for (let j = 1; j <= n; j++) {
        if (a[i - 1] === b[j - 1]) {
          cur[j] = prev[j - 1] + 1
          if (cur[j] > best) {
            best = cur[j]
            bestEnd = i
          }
        }
      }
      prev = cur
    }
    return a.slice(bestEnd - best, bestEnd)
  }

  async function locateImage({ hash, oldDesc }) {
    const rows = await ctx.database.get(TABLE, {})
    if (!rows.length) return { rows: [], how: '缓存是空的' }

    const h = String(hash || '').trim().toLowerCase()
    if (h) {
      const byHash = rows.filter((r) => String(r.hash || '').toLowerCase().startsWith(h))
      if (byHash.length) return { rows: byHash, how: `sha256 前缀 ${h}` }
      const byP = rows.filter(
        (r) => r.phash && String(r.phash).toLowerCase().startsWith(h)
      )
      if (byP.length) return { rows: byP, how: `pHash 前缀 ${h}` }
      return { rows: [], how: `没有 hash 以 ${h} 开头的记录` }
    }

    const t = String(oldDesc || '').trim()
    if (t) {
      const exact = rows.filter((r) => (r.description || '').includes(t))
      if (exact.length) return { rows: exact, how: '原描述包含匹配' }
      let bestKey = ''
      for (const r of rows) {
        const k = longestCommonSubstring(t, r.description || '')
        if (k.length > bestKey.length) bestKey = k
      }
      if (bestKey.length >= 4) {
        const fuzzy = rows.filter((r) => (r.description || '').includes(bestKey))
        if (fuzzy.length) return { rows: fuzzy, how: `片段匹配「${bestKey}」` }
      }
      // 再退一步：刚解析出来、15 分钟内只有一条 → 大概率就是它
      const recent = rows.filter(
        (r) => r.createdAt && Date.now() - new Date(r.createdAt).getTime() < 15 * 60 * 1000
      )
      if (recent.length === 1) return { rows: recent, how: '最近一次解析（15 分钟内唯一一条）' }
      if (!bestKey) return { rows: [], how: '没匹配上任何描述' }
      return { rows: [], how: `只匹配到片段「${bestKey}」但对不上完整描述` }
    }

    // 只给了 hash 也没有、old_description 也没有 → 用"最近一条"
    const sorted = rows
      .filter((r) => r.createdAt)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    if (sorted.length) return { rows: [sorted[0]], how: '最近解析的一条' }
    return { rows: [], how: '无法定位（没给 hash 也没给原描述）' }
  }

  /** 改缓存 + 同步表情包库 */
  async function applyCorrection(row, newDesc, extraTags, by = 'unknown') {
    // ★ 标记继承：模型/人改描述时通常只改内容、不会补 [自己] 标记。
    //   如果原来就认出来"这是自己"，改完却因为没写标记而被记成"不是自己"，等于把知识丢了。
    const newFlag = selfFlagOf(newDesc)
    const keepFlag = newFlag === 'no' && selfFlagOf(row.description) !== 'no' ? selfFlagOf(row.description) : newFlag
    await ctx.database.set(
      TABLE,
      { hash: row.hash },
      {
        description: newDesc,
        correctedFrom: String(row.description || '').slice(0, 1000),
        correctedBy: by,
        correctedAt: new Date(),
        selfFlag: keepFlag,
      }
    )
    if (row.phash) phashIndex.set(String(row.phash), { hash: row.hash, description: newDesc })

    let stickerSynced = 0
    if (config.syncSticker && row.phash) {
      try {
        const metas = await ctx.database.get('sticker_meta', {})
        for (const m of metas) {
          if (!m?.pHash) continue
          const same =
            String(m.pHash).toLowerCase() === String(row.phash).toLowerCase() ||
            hamming(String(m.pHash), String(row.phash)) <= config.phashThreshold
          if (!same) continue
          const patch = { description: newDesc }
          if (Array.isArray(extraTags) && extraTags.length) {
            patch.tags = [...new Set([...(m.tags || []), ...extraTags.map(String)])]
          }
          await ctx.database.set('sticker_meta', { pHash: m.pHash }, patch)
          stickerSynced++
        }
      } catch (e) {
        // 没装 chatluna-sticker 时表不存在，忽略
        logger.debug('同步表情包库跳过：%s', e.message)
      }
    }
    return stickerSynced
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
      '图片策略已挂载（视觉模型：%s%s；压缩 %s；去重 %s；阻塞上限 %s）',
      config.visionModel,
      config.fallbackModel && config.fallbackModel !== config.visionModel
        ? `（备用 ${config.fallbackModel}）`
        : '',
      config.compress
        ? sharp
          ? `开，长边 ${config.maxEdge} / JPEG q${config.jpegQuality}；` +
            (Number(config.compressMinBytes) > 0
              ? `≤${(Number(config.compressMinBytes) / 1024).toFixed(0)}KB 且不超长边的原样送`
              : '★ 阈值 0 = 所有图都压（旧行为）')
          : '要开但没装 sharp'
        : '关',
      config.dedupeByPhash && imghash ? `sha256 + pHash(≤${config.phashThreshold})` : 'sha256（pHash 不可用）',
      Number(config.blockingTimeoutMs) > 0 ? `${config.blockingTimeoutMs}ms` : '不限（旧行为）'
    )

    // 建 pHash 索引：不阻塞插件加载
    ctx.setTimeout(() => {
      buildPhashIndex().catch(() => {})
    }, 3000)

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
            '视觉自检通过（总 %d ms，其中压缩 %d ms；%d 字节 → 送模型 %d 字节，%s）：%s',
            Date.now() - t0,
            tc - t0,
            got.buf.length,
            send.buf.length,
            send.why === 'small' ? '阈值内未压缩' : '已压缩',
            desc.slice(0, 120)
          )
        } catch (e) {
          logger.warn('视觉自检失败：%s', e.message)
        }
      }, 3000)
    }

    // ---------------------------------------------------------- vision_correct 工具
    registerCorrectTool(ctx2)
  })

  /** 把 vision_correct 注册给 ChatLuna（模型可调用） */
  function registerCorrectTool(ctx2) {
    if (!config.correctTool) return
    const platform = ctx2.chatluna?.platform
    if (!platform || typeof platform.registerTool !== 'function') {
      logger.warn('platform.registerTool 不可用，vision_correct 未注册')
      return
    }
    let toolFactory
    let z
    try {
      toolFactory = require('@langchain/core/tools').tool
      z = require('zod').z
    } catch (e) {
      logger.warn('缺少 @langchain/core 或 zod，vision_correct 未注册：%s', e.message)
      return
    }

    platform.registerTool('vision_correct', {
      description:
        '修正之前对某张图片的描述。当你发现之前那条图片描述认错了（比如把某个角色/表情认成别的东西），' +
        '或者群友指出这张图其实是别的意思时调用。改完之后下次这张图就会用新描述。',
      selector: () => true,
      createTool: () =>
        toolFactory(
          async (input) => {
            const newDesc = String(input?.new_description || '').trim()
            if (!newDesc) return '要给我修正后的描述（new_description）。'

            const found = await locateImage({
              hash: input?.hash,
              oldDesc: input?.old_description,
            })
            if (!found.rows.length) {
              const sample = (await ctx.database.get(TABLE, {}))
                .filter((r) => r.createdAt)
                .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
                .slice(0, 5)
                .map((r) => `${String(r.hash).slice(0, 8)}  ${String(r.description || '').slice(0, 30)}`)
              return (
                `没找到要改的那张图（${found.how}）。` +
                (sample.length ? `\n最近解析过的图：\n${sample.join('\n')}` : '') +
                `\n可以把 old_description 换成更完整的一句，或者用 hash 定位。`
              )
            }
            if (found.rows.length > 1) {
              const list = found.rows
                .slice(0, 8)
                .map((r) => `${String(r.hash).slice(0, 8)}  ${String(r.description || '').slice(0, 40)}`)
              return (
                `匹配到 ${found.rows.length} 张图（${found.how}），不确定是哪张，请用 hash 再指定一次：\n` +
                list.join('\n')
              )
            }

            const row = found.rows[0]
            const old = String(row.description || '')
            const synced = await applyCorrection(row, newDesc, input?.extra_tags, 'tool:vision_correct')
            logger.info('图片描述已修正（%s，同步表情库 %d 条）：%s → %s', found.how, synced, old.slice(0, 40), newDesc.slice(0, 40))
            return (
              `已修正（${found.how}）。\n原描述：${old.slice(0, 60)}\n新描述：${newDesc}` +
              (synced ? `\n表情包库已同步 ${synced} 条。` : '')
            )
          },
          {
            name: 'vision_correct',
            description:
              '修正之前对某张图片的描述（认错了 / 群友纠正了之后用）。' +
              '★ 如果这张图其实就是**你自己**（你的形象，见人设里"你是谁"那段），' +
              '新描述开头请加上 [自己] 这个标记（例：[自己] 大肥鱼趴在桌上睡觉）—— ' +
              '加了标记以后这张图在表情包检索、记忆和日志里都能一眼看出是你，不用再猜。',
            schema: z.object({
              new_description: z
                .string()
                .describe(
                  '修正后的描述，直接写内容，不要加「图/图片/这是一张」；是画你自己的，开头加 [自己]'
                ),
              old_description: z.string().optional().describe('现在那条（错的）描述，尽量原样贴过来用于定位'),
              hash: z.string().optional().describe('图片 hash（sha256 或 pHash）的前几位，知道就填，最准'),
              extra_tags: z.array(z.string()).optional().describe('顺便给表情包库补的标签'),
            }),
          }
        ),
    })
    logger.info('vision_correct 工具已注册（同步表情包库：%s）', config.syncSticker ? '开' : '关')
  }

  // 人工干预：清缓存 / 看统计
  // ★ 点号全名（`vision.stat`），不是 `vision/stat`：斜杠写法的子指令名字只有 `stat`，
  //   而 Commander 按整名查 _aliases（core:1411/1432）→ 用户敲 `/vision.stat` 永远没反应。
  ctx.command('vision.stat', '看图片解析缓存统计', { authority: 3 }).action(async () => {
    const rows = await ctx.database.get(TABLE, {})
    const total = rows.reduce((s, r) => s + (r.bytes || 0), 0)
    const withPhash = rows.filter((r) => r.phash).length
    const stale = rows.filter((r) => !isFreshRow(r)).length
    return [
      `已缓存 ${rows.length} 张图的描述，共 ${(total / 1024 / 1024).toFixed(1)} MB 原图`,
      `其中带 pHash 的 ${withPhash} 条（内存索引 ${phashIndex.size} 条，汉明阈值 ≤${config.phashThreshold}）`,
      `缓存版本 v${CACHE_VERSION}；旧版本 ${stale} 条（会被当未命中自动重解析）`,
      `本次运行：压缩 ${stats.compressed} 张，原样送 ${stats.skipped} 张，解析超时放行 ${stats.timeout} 张`,
      `压缩策略：${
        !config.compress
          ? '关'
          : `长边 > ${config.maxEdge}px 或 > ${(Number(config.compressMinBytes) / 1024).toFixed(0)}KB 才压`
      }；阻塞上限 ${Number(config.blockingTimeoutMs) > 0 ? config.blockingTimeoutMs + 'ms' : '不限'}`,
    ].join('\n')
  })

  ctx
    .command('vision.probe <target:text>', '只跑"下载 → 压缩"这一步并报告判定（不调模型，零 API 消耗）', {
      authority: 3,
    })
    .usage('例：/vision.probe D:/deepseek/QQbot/.scratch/img/big.png')
    .action(async (_a, target) => {
      const t = String(target || '').trim()
      if (!t) return '用法：/vision.probe <图片 URL 或本地文件路径>'
      const t0 = Date.now()
      let buf = null
      let mime = 'image/jpeg'
      let from = ''
      try {
        const fs = require('fs')
        const path = require('path')
        const p = path.resolve(t)
        if (fs.existsSync(p) && fs.statSync(p).isFile()) {
          buf = fs.readFileSync(p)
          from = `本地文件 ${p}`
        } else {
          const got = await download(t)
          buf = got.buf
          mime = got.mime
          from = 'URL/data URL'
        }
      } catch (e) {
        return `取图失败（${e.message}）`
      }
      const tGet = Date.now()

      let meta = ''
      if (sharp) {
        try {
          const m = await sharp(buf).metadata()
          meta = `${m.width}×${m.height}${m.format ? ' ' + m.format : ''}`
        } catch (e) {
          meta = `解不出元数据（${e.message}）`
        }
      } else {
        meta = '没装 sharp'
      }

      const send = await compress(buf, mime)
      const tEnd = Date.now()
      const minBytes = Number(config.compressMinBytes) || 0
      const verdict = {
        small: `★ 未压缩，原样送模型（${buf.length} ≤ ${minBytes} 字节且长边没超 ${config.maxEdge}）`,
        compressed: `已压缩 ${buf.length} → ${send.buf.length} 字节（省 ${(100 - (send.buf.length / buf.length) * 100).toFixed(0)}%）`,
        bigger: `压完反而更大，保留原图`,
        off: '压缩开关是关的',
        empty: '压出 0 字节，保留原图',
        error: '压缩抛错，保留原图',
      }[send.why]

      return [
        `${from}`,
        `原图：${buf.length} 字节（${(buf.length / 1024).toFixed(0)} KB）｜${meta}`,
        `判定：${verdict}`,
        `送模型：${send.buf.length} 字节，mime=${send.mime}`,
        `耗时：取图 ${tGet - t0}ms，压缩+元数据 ${tEnd - tGet}ms`,
        `阈值：compressMinBytes=${minBytes}，maxEdge=${config.maxEdge}`,
      ].join('\n')
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

  ctx
    .command('vision.list [limit:number]', '列出最近解析过的图片描述（含 hash 前缀，便于定点修正）', {
      authority: 3,
    })
    .action(async (_a, limit) => {
      const n = Math.max(1, Math.min(50, Number(limit) || 10))
      const rows = (await ctx.database.get(TABLE, {}))
        .filter((r) => r.createdAt)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, n)
      if (!rows.length) return '缓存是空的'
      return rows
        .map(
          (r, i) =>
            `${i + 1}. ${String(r.hash).slice(0, 8)}${r.phash ? `/` + String(r.phash) : ''}  ${String(
              r.description || ''
            ).slice(0, 50)}`
        )
        .join('\n')
    })

  ctx
    .command('vision.correct <hash:string> <text:text>', '手动把某张图的描述改成指定内容', {
      authority: 2,
    })
    .usage('例：/vision.correct 3f9a2c1b 这是 bot 自己（一条蓝色的鱼）')
    .action(async (_a, hash, text) => {
      const h = String(hash || '').trim()
      const t = String(text || '').trim()
      if (!h || !t) return '用法：/vision.correct <hash前缀> <新描述>'
      const found = await locateImage({ hash: h })
      if (!found.rows.length) return found.how
      if (found.rows.length > 1) {
        return (
          `匹配到 ${found.rows.length} 张，请多给几位 hash：\n` +
          found.rows
            .slice(0, 8)
            .map((r) => `${String(r.hash).slice(0, 12)}  ${String(r.description || '').slice(0, 40)}`)
            .join('\n')
        )
      }
      const synced = await applyCorrection(found.rows[0], t, null, 'command:vision.correct')
      return `已修正。${synced ? `表情包库同步 ${synced} 条。` : ''}`
    })

  // ---------------------------------------------------------------- 看图（只读）
  //
  // 用途：**测试"视觉把它当成了什么"以及"对话模型有没有改对它"**。
  //   引用一张图 + @bot + /vision.this → 打印这张图的缓存描述、自我标记、修正痕迹、
  //   以及它在表情包库里的那条记录。
  //
  // ★ 默认**不调任何模型**（纯读库），因为要测的正是"上一轮对话里模型看到的到底是哪句话"；
  //   如果这条指令自己顺手重解析一次，就把要观察的对象改掉了。
  //   需要现场重认时才加 -f（那是显式的一次 AI 调用）。

  /** 会话里可用的图：引用优先（最常见的用法是引用一张图再发指令），其次本条消息自带的 */
  function imagesInSession(session) {
    const out = []
    const push = (els, from) => {
      for (const el of els || []) {
        if (el?.type !== 'img' && el?.type !== 'image') continue
        const url = imageUrlOf(el)
        if (url) out.push({ url, from })
      }
    }
    push(session?.quote?.elements, '引用的图')
    push(session?.event?.message?.elements, '本条消息的图')
    return out
  }

  /** 与缓存里最接近的那条 pHash 记录的距离（诊断用：没命中时看看差多远） */
  function nearestDistance(phash) {
    if (!phash || !phashReady) return null
    let best = null
    for (const [p] of phashIndex) {
      const d = hamming(phash, p)
      if (best === null || d < best) best = d
    }
    return best
  }

  /** 在表情包库里按 pHash 找同一条（没装 sticker 时表不存在，静默跳过） */
  async function findSticker(phash) {
    if (!phash) return null
    try {
      const metas = await ctx.database.get('sticker_meta', {})
      for (const m of metas) {
        if (!m?.pHash) continue
        if (
          String(m.pHash).toLowerCase() === String(phash).toLowerCase() ||
          hamming(String(m.pHash), String(phash)) <= config.phashThreshold
        ) {
          return m
        }
      }
    } catch {
      /* 没装表情包插件 */
    }
    return null
  }

  function stampOf(d) {
    if (!d) return '—'
    const t = new Date(d)
    const p = (n) => String(n).padStart(2, '0')
    return `${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`
  }

  ctx
    .command('vision.this', '看这张图在视觉/表情包系统里被认成了什么（只读，不调模型）', {
      authority: 2,
    })
    .option('fresh', '-f  现场重新解析一次（★ 会真的调用视觉模型）')
    .option('hash', '--hash  只打印 hash / pHash，不看描述')
    .usage('用法：引用一张图 + @bot + /vision.this；也可以把图和指令发在同一条消息里')
    .example('/vision.this       （引用一张表情包）')
    .example('/vision.this -f    （这张还没被看过时，现场认一次）')
    .action(async ({ session, options }) => {
      const imgs = imagesInSession(session)
      if (!imgs.length) {
        return [
          '没找到图片。用法：**引用一张图**（或把图和指令发在同一条消息里）再发 /vision.this。',
          '这条指令只读数据、不调模型：它打印的是"视觉模型当时把这张图认成了什么"',
          '（描述 + [自己] 标记 + 有没有被 vision_correct 改过 + 在表情包库里的记录）。',
          '要现场重新识别，加 -f（那会调用一次视觉模型）。',
        ].join('\n')
      }

      const out = []
      for (let i = 0; i < imgs.length; i++) {
        const { url, from } = imgs[i]
        out.push(`━━━ ${imgs.length > 1 ? `第 ${i + 1} 张 · ` : ''}${from} ━━━`)
        let buf = null
        let mime = null
        let hash = null
        let phash = null
        try {
          const got = await download(url)
          buf = got.buf
          mime = got.mime
          hash = sha256(buf)
          phash = await computePhash(buf)
        } catch (e) {
          out.push(`取图失败：${e.message}`)
          out.push('（QQ 图片链接带 rkey，有过期时间；引用一条太旧的消息时下载会失败）')
          continue
        }
        out.push(`sha256 ${hash.slice(0, 16)}… ｜ pHash ${phash || '无（没装 imghash）'} ｜ ${buf.length} 字节 ｜ ${mime}`)

        // ---- 查缓存（sha256 → pHash 近似）----
        let row = (await ctx.database.get(TABLE, { hash }))[0] || null
        let how = row ? '命中 sha256' : null
        if (!row && phash) {
          const near = nearestByPhash(phash)
          if (near) {
            row = (await ctx.database.get(TABLE, { hash: near.hash }))[0] || null
            how = `命中 pHash 近似（另一份字节 ${String(near.hash).slice(0, 8)}）`
          }
        }

        // ---- -f：现场重认（唯一会调用模型的分支）----
        if (options?.fresh) {
          try {
            const send = await compress(buf, mime)
            const t0 = Date.now()
            const desc = await describe(send.buf, send.mime)
            await putCached(hash, desc, config.visionModel, buf.length, phash)
            row = (await ctx.database.get(TABLE, { hash }))[0] || row
            how = `本次现场解析（${Date.now() - t0} ms，送模型 ${send.buf.length} 字节）`
            logger.info('vision.this 现场解析 %s：%s', hash.slice(0, 8), desc.slice(0, 60))
          } catch (e) {
            out.push(`现场解析失败：${e.message}`)
          }
        }

        if (options?.hash) {
          const st = await findSticker(phash)
          out.push(`表情包库：${st ? `在库（${String(st.pHash)}，用过 ${st.useCount || 0} 次）` : '不在库'}`)
          continue
        }

        if (!row || !row.description) {
          out.push('缓存：**没有**（这张图还没被视觉模型看过）')
          out.push(`最近的一条 pHash 距离：${nearestDistance(phash) ?? '—'}（≤ ${config.phashThreshold} 就算同一张）`)
          out.push('加 -f 现场认一次（会调用视觉模型）。')
          continue
        }

        const flag = row.selfFlag || selfFlagOf(row.description)
        out.push(
          `缓存：${how}｜版本 v${row.v}｜描述模型 ${row.model || '—'}｜解析于 ${stampOf(row.createdAt)}`
        )
        out.push(
          `自我标记：${
            { yes: '★ [自己] —— 模型认为画的就是 bot 自己', maybe: '[可能自己] —— 拿不准', no: '无（当普通图处理）' }[
              flag
            ] || flag
          }`
        )
        out.push(`描述：${row.description}`)
        if (row.correctedAt) {
          out.push(`修正痕迹：${stampOf(row.correctedAt)} 被 ${row.correctedBy || '?'} 改过`)
          out.push(`  改前：${String(row.correctedFrom || '').slice(0, 120)}`)
        } else {
          out.push('修正痕迹：无（还是视觉模型的原始输出）')
        }
        const st = await findSticker(row.phash || phash)
        if (st) {
          out.push(
            `表情包库：★ 在库（${String(st.pHash)}｜用过 ${st.useCount || 0} 次${st.pinned ? '｜已置顶' : ''}）`
          )
          out.push(`  库内描述：${String(st.description || '').slice(0, 120)}`)
          out.push(`  库内标签：${(st.tags || []).join(' / ') || '（无）'}`)
        } else {
          out.push('表情包库：不在库（还没被收藏成表情包）')
        }
        out.push(`想改描述：/vision.correct ${hash.slice(0, 8)} <新的描述>`)
      }
      const head = options?.fresh ? '' : '（只读：没有调用任何模型）\n'
      return head + out.join('\n')
    })
}

module.exports = { name, inject, Config, apply }
