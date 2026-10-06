/**
 * koishi-plugin-chatluna-sticker-admin
 *
 * 给市场插件 koishi-plugin-chatluna-sticker 补上三块它没有的东西：
 *
 *   ① **逻辑预筛**（服务名 `stickerGuard`）
 *      压缩率 / 面积 / 体积 / 长宽比这些是**纯逻辑**信号，不该花一次视觉调用去问模型
 *      「这图像不像表情包」。预筛不过的直接标 rejected：不落盘、不进视觉调用。
 *      （执行点由 `tools/patch-sticker.cjs` 注入到 sticker 的 middleware.js 里）
 *
 *   ② **表情包库的 CRUD 工具**（给 AI 用）
 *      sticker_search / sticker_send_hash / sticker_update / sticker_remove / sticker_learn
 *      市场插件只给了 sticker_send，AI 既看不到库里有什么、也没法改/删/主动收藏。
 *
 *   ③ **常用（pinned）** 与更细的统计指令
 *
 * 为什么是"自写插件 + 一处补丁"而不是纯自写：
 *   见 tools/patch-sticker.cjs 顶部注释 —— 那个插件没有任何对外钩子，
 *   预筛必须插在它的收集中间，只能打补丁；但**逻辑与配置全在这里**，补丁里只有 4 行调用。
 */

const { Schema, Logger, h } = require('koishi')

const name = 'chatluna-sticker-admin'
const inject = { required: ['database', 'http'], optional: ['chatluna'] }

const logger = new Logger('sticker-admin')

let sharp = null
try {
  sharp = require('sharp')
} catch {
  logger.warn('没装 sharp：表情包逻辑预筛被禁用（装了重启即可生效）')
}

let imghash = null
try {
  imghash = require('imghash')
} catch {
  logger.warn('没装 imghash：sticker_learn 不可用')
}

const OCC = 'sticker_occurrence'
const META = 'sticker_meta'
const VISION_CACHE = 'chatluna_image_cache'

const Config = Schema.intersect([
  Schema.object({
    prefilterEnabled: Schema.boolean()
      .default(true)
      .description('★ 逻辑预筛总开关：不达标的图直接标 rejected，不落盘、不烧视觉调用'),
    maxPixels: Schema.natural()
      .default(1_000_000)
      .description('面积上限（像素）。表情包一般 ≤ 500×500；默认 100 万 ≈ 1000×1000，超过就不是表情包了。0 = 不限制'),
    maxBytes: Schema.natural()
      .default(1_200_000)
      .description('体积上限（字节）。高清大图通常 > 1MB。0 = 不限制'),
    maxCompressionRatio: Schema.number()
      .min(0)
      .max(1)
      .default(0.85)
      .description(
        '★ 压缩率上限 = 文件字节 ÷ (宽 × 高 × 通道数)。' +
          '表情包在群里反复流传、被压过很多次，这个值通常很低（0.05~0.4）；' +
          '而截图/原图/无损图接近 1。默认 0.85，只拦"几乎没压过"的图（1 = 关掉这条规则）。' +
          '注意：PNG 是无损格式，天生比值高，所以阈值别调太低，否则会误伤 PNG 表情包'
      ),
    minPixels: Schema.natural()
      .default(0)
      .description('面积下限（像素）。用来拦掉超小的图标/像素点。0 = 不限制'),
    maxAspectRatio: Schema.number()
      .min(1)
      .default(4)
      .description('长宽比上限，用来拦掉长截图（聊天记录截图等）。0 = 不限制'),
    dryRun: Schema.boolean().default(false).description('只记日志不真的拦（调参时用）'),
    debug: Schema.boolean().default(false).description('每张图都打印预筛明细'),
  }),
  Schema.object({
    storageDir: Schema.string().default('data/sticker-library').description('表情包目录（要和 chatluna-sticker 配成一样）'),
    toolsEnabled: Schema.boolean().default(true).description('是否注册表情包 CRUD 工具给 AI 用'),
    learnModel: Schema.string()
      .default('cc/q.vision')
      .description('sticker_learn 主动收藏时用来打标的视觉模型（ChatLuna 完整模型名）'),
    syncVision: Schema.boolean().default(true).description('sticker_update 改描述时，是否同步改 chatluna-vision 的解析缓存'),
    debugTools: Schema.boolean().default(false).description('打印工具调用明细'),
  }),
])

// ------------------------------------------------------------------ 工具函数

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

function apply(ctx, config) {
  const log = (...a) => config.debug && logger.info(...a)

  // chatluna-sticker 的表可能还没建（插件加载顺序不定），补两个我们自己的列
  try {
    ctx.model.extend(META, {
      pinned: { type: 'boolean', initial: false },
      note: { type: 'string', initial: '' },
      learnedBy: { type: 'string', initial: '' },
    })
  } catch (e) {
    logger.debug('扩展 sticker_meta 失败（不影响运行）：%s', e.message)
  }

  const path = require('node:path')
  const fs = require('node:fs/promises')

  function filePath(pHash) {
    return path.join(config.storageDir, pHash.slice(0, 2), pHash + '.png')
  }

  // ---------------------------------------------------------------- ① 预筛

  const stats = { checked: 0, rejected: 0, skipped: 0, byReason: {} }

  /**
   * 逻辑预筛：只看"这张图的物理属性"，不看内容。
   * @returns {{ok:boolean, reason?:string, metrics?:object}}
   */
  async function check(buf) {
    if (!config.prefilterEnabled || config.dryRun) return { ok: true }
    if (!sharp) return { ok: true }
    if (!buf || !buf.length) return { ok: true }

    let meta
    try {
      meta = await sharp(buf).metadata()
    } catch (e) {
      // 解不开的图（畸形/罕见格式）不拦，交给模型判断
      return { ok: true, reason: '解不开：' + e.message }
    }
    const w = Number(meta.width) || 0
    const h = Number(meta.height) || 0
    if (!w || !h) return { ok: true }

    const pixels = w * h
    const bytes = buf.length
    const channels = meta.hasAlpha ? 4 : 3
    const ratio = bytes / (pixels * channels)
    const edgeRatio = Math.max(w, h) / Math.min(w, h)

    const reasons = []
    if (config.maxPixels && pixels > config.maxPixels) {
      reasons.push(`面积 ${w}×${h} 超过 ${config.maxPixels}`)
    }
    if (config.maxBytes && bytes > config.maxBytes) {
      reasons.push(`体积 ${(bytes / 1024).toFixed(0)}KB 超过 ${(config.maxBytes / 1024).toFixed(0)}KB`)
    }
    if (config.maxCompressionRatio && config.maxCompressionRatio < 1 && ratio > config.maxCompressionRatio) {
      reasons.push(`压缩率 ${ratio.toFixed(2)} 超过 ${config.maxCompressionRatio}`)
    }
    if (config.minPixels && pixels < config.minPixels) {
      reasons.push(`面积 ${pixels} 小于 ${config.minPixels}`)
    }
    if (config.maxAspectRatio && edgeRatio > config.maxAspectRatio) {
      reasons.push(`长宽比 ${edgeRatio.toFixed(1)} 超过 ${config.maxAspectRatio}`)
    }

    stats.checked++
    const metrics = { w, h, bytes, ratio: Number(ratio.toFixed(3)), format: meta.format }
    if (!reasons.length) {
      log('预筛通过 %d×%d %dKB 压缩率 %s', w, h, (bytes / 1024) | 0, metrics.ratio)
      return { ok: true, metrics }
    }
    for (const r of reasons) stats.byReason[r.replace(/[\d.]+/g, 'N')] = (stats.byReason[r.replace(/[\d.]+/g, 'N')] || 0) + 1
    stats.rejected++
    log('预筛淘汰 %d×%d %dKB 压缩率 %s → %s', w, h, (bytes / 1024) | 0, metrics.ratio, reasons.join('；'))
    return { ok: false, reason: reasons.join('；'), metrics }
  }

  const guardService = {
    check,
    stats: () => ({ ...stats, byReason: { ...stats.byReason }, dryRun: config.dryRun }),
    /** 供人工复核：给一段字节算一遍指标，不产生副作用 */
    inspect: async (buf) => {
      const m = await sharp(buf).metadata()
      const pixels = (m.width || 0) * (m.height || 0)
      const channels = m.hasAlpha ? 4 : 3
      return {
        width: m.width,
        height: m.height,
        format: m.format,
        hasAlpha: !!m.hasAlpha,
        bytes: buf.length,
        pixels,
        ratio: pixels ? Number((buf.length / (pixels * channels)).toFixed(3)) : null,
      }
    },
  }

  // ctx.root 上的属性会被所有子 ctx 继承（cordis 的 ctx 是原型链），
  // 所以补丁里读 `ctx.stickerGuard` 就能拿到。
  ctx.root.stickerGuard = guardService
  ctx.stickerGuard = guardService

  // ---------------------------------------------------------------- 数据访问

  async function allMeta() {
    try {
      return await ctx.database.get(META, {})
    } catch {
      return []
    }
  }

  async function findMeta(key) {
    const k = String(key || '').trim().toLowerCase()
    if (!k) return null
    const rows = await allMeta()
    let hit = rows.find((r) => String(r.pHash).toLowerCase() === k)
    if (hit) return hit
    const pref = rows.filter((r) => String(r.pHash).toLowerCase().startsWith(k))
    if (pref.length === 1) return pref[0]
    return pref.length ? { __ambiguous: pref } : null
  }

  async function readImage(pHash) {
    try {
      return await fs.readFile(filePath(pHash))
    } catch {
      return null
    }
  }

  async function saveImage(pHash, buf) {
    const fp = filePath(pHash)
    await fs.mkdir(path.dirname(fp), { recursive: true })
    await fs.writeFile(fp, buf)
  }

  async function removeImageFile(pHash) {
    try {
      await fs.unlink(filePath(pHash))
    } catch {}
  }

  async function markUsed(pHash) {
    try {
      const rows = await ctx.database.get(META, { pHash })
      if (rows.length) {
        await ctx.database.set(META, { pHash }, {
          useCount: (rows[0].useCount || 0) + 1,
          lastUsedAt: Date.now(),
        })
      }
    } catch {}
  }

  /** 按魔数判断真实格式（市场插件发图时写死 image/png，GIF/JPEG 会解不出来） */
  function mimeOf(buf) {
    if (!buf || buf.length < 12) return 'image/png'
    if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif'
    if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png'
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57 && buf[9] === 0x45) return 'image/webp'
    if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp'
    return 'image/png'
  }

  function fmtSticker(r, idx) {
    const tags = Array.isArray(r.tags) && r.tags.length ? r.tags.join(',') : '-'
    return (
      `${idx != null ? idx + '. ' : ''}${r.pHash}${r.pinned ? ' ★' : ''} | ` +
      `${String(r.description || '（无描述）').slice(0, 48)} | ${tags.slice(0, 40)} | 用过 ${r.useCount || 0} 次`
    )
  }

  // ---------------------------------------------------------------- ② AI 工具

  function registerTools(ctx2) {
    if (!config.toolsEnabled) return
    const platform = ctx2.chatluna?.platform
    if (!platform || typeof platform.registerTool !== 'function') {
      logger.warn('platform.registerTool 不可用，表情包工具未注册')
      return
    }
    let toolFactory
    let z
    try {
      toolFactory = require('@langchain/core/tools').tool
      z = require('zod').z
    } catch (e) {
      logger.warn('缺少 @langchain/core 或 zod，表情包工具未注册：%s', e.message)
      return
    }

    const sessionOf = (runnableConfig) => runnableConfig?.configurable?.session

    // ---- sticker_search：把库里有什么告诉模型（这是"AI 自己检索"的关键）
    platform.registerTool('sticker_search', {
      description:
        '在本地表情包里按关键词检索，返回候选列表（含编号 pHash 和描述）。' +
        '想发一张贴合当前气氛的表情时，先用它看看库里有什么，再用 sticker_send_hash 发出去。',
      selector: () => true,
      createTool: () =>
        toolFactory(
          async (input) => {
            const rows = await allMeta()
            if (!rows.length) return '表情库还是空的，先用文字回复吧。'
            const kw = String(input?.query || '')
              .toLowerCase()
              .split(/[\s,，、]+/)
              .filter(Boolean)
            const tag = String(input?.tag || '').trim().toLowerCase()
            const limit = Math.max(1, Math.min(30, Number(input?.limit) || 10))

            let pool = rows
            if (tag) {
              pool = pool.filter((r) =>
                (r.tags || []).some((t) => String(t).toLowerCase().includes(tag))
              )
            }
            const scored = pool.map((r) => {
              const hay = [r.description || '', r.usageHint || '', ...(r.tags || [])]
                .join(' ')
                .toLowerCase()
              let score = 0
              for (const k of kw) if (k && hay.includes(k)) score++
              return { r, score, rank: score * 100 + (r.useCount || 0) + (r.pinned ? 50 : 0) }
            })
            scored.sort((a, b) => b.rank - a.rank)
            const top = scored.slice(0, limit)
            if (config.debugTools) {
              logger.info('sticker_search query=%s tag=%s → %d 条', input?.query, input?.tag, top.length)
            }
            return (
              `库里共 ${rows.length} 张，命中 ${pool.length} 张，前 ${top.length} 个候选：\n` +
              top.map((x, i) => fmtSticker(x.r, i + 1)).join('\n') +
              `\n\n要发出去就调 sticker_send_hash，pHash 填上面那一串。`
            )
          },
          {
            name: 'sticker_search',
            description: '按关键词/标签检索本地表情包，返回候选 pHash 列表',
            schema: z.object({
              query: z.string().optional().describe('想表达的情绪/场景关键词，如「无语」「狂笑」「点赞」'),
              tag: z.string().optional().describe('限定标签，如「猫」「二次元」'),
              limit: z.number().optional().describe('返回几条，默认 10'),
            }),
          }
        ),
    })

    // ---- sticker_send_hash：发指定的那一张
    platform.registerTool('sticker_send_hash', {
      description: '把本地表情库里指定 pHash 的那张图发出去。pHash 一般来自 sticker_search 的结果。',
      selector: () => true,
      createTool: () =>
        toolFactory(
          async (input, runnableConfig) => {
            const session = sessionOf(runnableConfig)
            if (!session) return '拿不到当前会话，请用文字回复。'
            const found = await findMeta(input?.pHash)
            if (!found) return `库里没有 pHash 以 ${input?.pHash} 开头的图，可以用 sticker_search 再找找。`
            if (found.__ambiguous) {
              return (
                `有 ${found.__ambiguous.length} 张以它开头，请多给几位：\n` +
                found.__ambiguous.slice(0, 8).map((r, i) => fmtSticker(r, i + 1)).join('\n')
              )
            }
            const buf = await readImage(found.pHash)
            if (!buf) {
              await ctx.database.remove(META, { pHash: found.pHash })
              return '这张图的文件丢了（已清掉记录），换一张吧。'
            }
            await session.send(h.image(`data:${mimeOf(buf)};base64,${buf.toString('base64')}`))
            await markUsed(found.pHash)
            if (config.debugTools) logger.info('sticker_send_hash %s', found.pHash)
            return `已发送：${String(found.description || found.pHash).slice(0, 40)}`
          },
          {
            name: 'sticker_send_hash',
            description: '发送指定 pHash 的表情包',
            schema: z.object({
              pHash: z.string().describe('要发送的表情的 pHash（或它的前几位）'),
            }),
          }
        ),
    })

    // ---- sticker_update：改（U）
    platform.registerTool('sticker_update', {
      description:
        '修改一张表情包的描述 / 标签 / 使用场景 / 常用标记。' +
        '当你对某张表情有了新的理解（比如发现它其实是自己的形象），用这个把它改对。',
      selector: () => true,
      createTool: () =>
        toolFactory(
          async (input) => {
            const found = await findMeta(input?.pHash)
            if (!found) return `库里没有 pHash 以 ${input?.pHash} 开头的图。`
            if (found.__ambiguous) return `有 ${found.__ambiguous.length} 张以它开头，请多给几位。`
            const patch = {}
            if (input?.description != null) patch.description = String(input.description)
            if (input?.usageHint != null) patch.usageHint = String(input.usageHint)
            if (input?.pinned != null) patch.pinned = !!input.pinned
            if (Array.isArray(input?.tags)) {
              const next = input.replaceTags
                ? input.tags.map(String)
                : [...new Set([...(found.tags || []), ...input.tags.map(String)])]
              patch.tags = next
            }
            if (!Object.keys(patch).length) return '没给要改的字段（description / tags / usageHint / pinned）。'
            await ctx.database.set(META, { pHash: found.pHash }, patch)

            // 顺手同步 vision 的解析缓存（同一张图，描述不该两套）
            let synced = 0
            if (config.syncVision && patch.description) {
              try {
                const rows = await ctx.database.get(VISION_CACHE, {})
                for (const r of rows) {
                  if (!r.phash) continue
                  if (hamming(String(r.phash), String(found.pHash)) > 5) continue
                  await ctx.database.set(VISION_CACHE, { hash: r.hash }, { description: patch.description })
                  synced++
                }
              } catch {}
            }
            return `已更新 ${found.pHash}：${Object.keys(patch).join(', ')}${synced ? `（vision 缓存同步 ${synced} 条）` : ''}`
          },
          {
            name: 'sticker_update',
            description: '修改表情包的描述/标签/使用场景/常用标记',
            schema: z.object({
              pHash: z.string().describe('目标表情的 pHash'),
              description: z.string().optional().describe('新的描述'),
              tags: z.array(z.string()).optional().describe('要补的标签'),
              replaceTags: z.boolean().optional().describe('true = 用 tags 整个替换，默认是追加'),
              usageHint: z.string().optional().describe('适合什么场景用'),
              pinned: z.boolean().optional().describe('是否设为常用（检索时加权）'),
            }),
          }
        ),
    })

    // ---- sticker_remove：删（D）
    platform.registerTool('sticker_remove', {
      description: '把一张表情包从库里彻底删掉（记录 + 本地文件）。发现某张图不合适时调用。',
      selector: () => true,
      createTool: () =>
        toolFactory(
          async (input) => {
            const found = await findMeta(input?.pHash)
            if (!found) return `库里没有 pHash 以 ${input?.pHash} 开头的图。`
            if (found.__ambiguous) return `有 ${found.__ambiguous.length} 张以它开头，请多给几位。`
            await ctx.database.remove(META, { pHash: found.pHash })
            await ctx.database.remove(OCC, { pHash: found.pHash })
            await removeImageFile(found.pHash)
            logger.info('sticker_remove %s（原因：%s）', found.pHash, input?.reason || '未说明')
            return `已删除 ${found.pHash}（${String(found.description || '').slice(0, 30)}）`
          },
          {
            name: 'sticker_remove',
            description: '从表情库彻底删除一张表情',
            schema: z.object({
              pHash: z.string().describe('要删除的表情的 pHash'),
              reason: z.string().optional().describe('为什么删（只记日志）'),
            }),
          }
        ),
    })

    // ---- sticker_learn：主动收藏（C）
    platform.registerTool('sticker_learn', {
      description:
        '把当前消息（或它引用的消息）里的图片收进自己的表情库。' +
        '当你觉得群里这张图很好用、以后想自己发出来时调用。',
      selector: () => true,
      createTool: () =>
        toolFactory(
          async (input, runnableConfig) => {
            if (!imghash) return '宿主没装 imghash，暂时不能主动收藏。'
            const session = sessionOf(runnableConfig)
            const urls = []
            const collect = (els) => {
              for (const el of els || []) {
                if (el?.type !== 'img') continue
                const a = el.attrs || {}
                const u = a.src || a.url || a.file
                if (u) urls.push(String(u))
              }
            }
            if (input?.image_url) urls.unshift(String(input.image_url))
            collect(session?.elements)
            collect(session?.quote?.elements)

            if (!urls.length) {
              return '这条消息里没看到图片。可以让对方把图发出来（或引用那张图）再让我收藏。'
            }

            const url = urls[0]
            let buf
            try {
              if (url.startsWith('base64://')) {
                buf = Buffer.from(url.slice('base64://'.length), 'base64')
              } else if (url.startsWith('data:')) {
                buf = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')
              } else {
                const res = await ctx.http.file(url, { timeout: 20000 })
                buf = Buffer.isBuffer(res?.data) ? res.data : Buffer.from(res?.data)
              }
            } catch (e) {
              return `图下载失败（${e.message}），过一会儿再试。`
            }
            if (!buf || !buf.length) return '图下载下来是空的，换一张吧。'

            // 预筛还是要过的——不能因为"主动收藏"就绕过画质门槛
            const gate = await check(buf)
            if (gate.ok === false && !config.dryRun) {
              return `这张图不太适合当表情包（${gate.reason}）。`
            }

            const pHash = String(await imghash.hash(buf, 8, 'hex')).toLowerCase()
            await saveImage(pHash, buf)

            const judged = await labelImage(buf, input?.hint)
            await ctx.database.upsert(META, [
              {
                pHash,
                tags: judged.tags || [],
                description: judged.description || '',
                usageHint: judged.usageHint || '',
                useCount: 0,
                collectedAt: Date.now(),
                pinned: false,
                learnedBy: String(session?.userId || ''),
              },
            ])
            await ctx.database.upsert(OCC, [
              {
                pHash,
                count: 1,
                status: 'collected',
                firstSeenAt: Date.now(),
                lastSeenAt: Date.now(),
                judgeError: '',
                judgeStartedAt: 0,
                judgeToken: '',
              },
            ])
            logger.info('sticker_learn 收藏 %s：%s', pHash, judged.description)
            return `已收进表情库（${pHash}）：${judged.description || '（没打出描述）'}`
          },
          {
            name: 'sticker_learn',
            description: '把当前消息里的图片收进表情库',
            schema: z.object({
              hint: z.string().optional().describe('对这张图的说明，帮助打标'),
              image_url: z.string().optional().describe('也可以直接给图片地址'),
            }),
          }
        ),
    })

    logger.info('表情包工具已注册：sticker_search / sticker_send_hash / sticker_update / sticker_remove / sticker_learn')
  }

  /** 用视觉模型给图片打标（sticker_learn 用） */
  async function labelImage(buf, hint) {
    try {
      const { HumanMessage } = require('@langchain/core/messages')
      const ref = await ctx.chatluna.createChatModel(config.learnModel)
      const model = ref?.value
      if (!model) throw new Error('拿不到模型 ' + config.learnModel)
      // ★ 人设卡片：让打标模型知道"这个角色是谁"。
      //   没有这段时，一张 bot 自己的形象图会被打成"蓝色头发的女孩"，
      //   而对话模型检索表情包时看到这句完全认不出是自己（2026-10-04 之前一直如此）。
      let selfBlock = ''
      try {
        selfBlock = ctx.get('chatluna_persona')?.block?.('sticker') || ''
      } catch {
        /* 没装人设卡片插件就退回原行为 */
      }
      const res = await model.invoke(
        [
          new HumanMessage({
            content: [
              {
                type: 'text',
                text:
                  (selfBlock ? `${selfBlock}\n\n` : '') +
                  '给这张表情包打标，只回 JSON 不要解释：' +
                  '{"description":"一句话内容描述","tags":["标签1","标签2"],"usageHint":"适合什么场景用"}' +
                  (hint ? `\n补充信息：${hint}` : ''),
              },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${buf.toString('base64')}` } },
            ],
          }),
        ],
        { timeout: 60000 }
      )
      const text =
        typeof res?.content === 'string'
          ? res.content
          : Array.isArray(res?.content)
            ? res.content.map((c) => c?.text || '').join('')
            : ''
      const m = String(text).match(/\{[\s\S]*\}/)
      if (!m) throw new Error('模型没按 JSON 回')
      const j = JSON.parse(m[0])
      return {
        description: String(j.description || ''),
        tags: Array.isArray(j.tags) ? j.tags.map(String) : [],
        usageHint: String(j.usageHint || ''),
      }
    } catch (e) {
      logger.warn('打标失败（仍会收藏）：%s', e.message)
      return { description: '', tags: [], usageHint: '' }
    }
  }

  ctx.inject(['chatluna'], (ctx2) => {
    registerTools(ctx2)
  })

  // ---------------------------------------------------------------- 指令

  ctx
    .command('sticker.admin.stat', '看表情包逻辑预筛的统计', { authority: 2 })
    .action(() => {
      const s = stats
      const reasons = Object.entries(s.byReason).sort((a, b) => b[1] - a[1])
      return [
        `预筛：共检查 ${s.checked} 次，淘汰 ${s.rejected} 次${config.dryRun ? '（当前是 dryRun，只记不拦）' : ''}`,
        `上限：面积 ≤ ${config.maxPixels || '∞'}｜体积 ≤ ${config.maxBytes ? (config.maxBytes / 1024).toFixed(0) + 'KB' : '∞'}｜压缩率 ≤ ${config.maxCompressionRatio}｜长宽比 ≤ ${config.maxAspectRatio}`,
        reasons.length ? '淘汰原因分布：\n' + reasons.map(([k, v]) => `  ${k} × ${v}`).join('\n') : '（还没有淘汰记录）',
      ].join('\n')
    })

  ctx
    .command('sticker.admin.inspect <pHash:string>', '复核某张已收藏表情的物理指标', { authority: 2 })
    .action(async (_a, pHash) => {
      const found = await findMeta(pHash)
      if (!found) return `库里没有以 ${pHash} 开头的图`
      if (found.__ambiguous) return `有 ${found.__ambiguous.length} 张，多给几位`
      const buf = await readImage(found.pHash)
      if (!buf) return '文件丢了'
      if (!sharp) return '没装 sharp，看不了'
      const m = await guardService.inspect(buf)
      return [
        `${m.width}×${m.height}（${m.pixels} 像素）`,
        `格式 ${m.format}${m.hasAlpha ? ' / 带透明' : ''}，体积 ${(m.bytes / 1024).toFixed(1)}KB`,
        `压缩率 ${m.ratio}`,
      ].join('\n')
    })

  ctx
    .command('sticker.admin.pin <pHash:string>', '把某张表情设为/取消「常用」', { authority: 2 })
    .action(async (_a, pHash) => {
      const found = await findMeta(pHash)
      if (!found) return `库里没有以 ${pHash} 开头的图`
      if (found.__ambiguous) return `有 ${found.__ambiguous.length} 张，多给几位`
      const next = !found.pinned
      await ctx.database.set(META, { pHash: found.pHash }, { pinned: next })
      return `${found.pHash} ${next ? '已设为常用 ★' : '已取消常用'}`
    })

  ctx
    .command('sticker.admin.tag <pHash:string> <tags:text>', '给某张表情补标签（逗号分隔）', { authority: 2 })
    .action(async (_a, pHash, tags) => {
      const found = await findMeta(pHash)
      if (!found) return `库里没有以 ${pHash} 开头的图`
      if (found.__ambiguous) return `有 ${found.__ambiguous.length} 张，多给几位`
      const add = String(tags || '')
        .split(/[,，、\s]+/)
        .filter(Boolean)
      if (!add.length) return '要给标签，逗号分隔'
      const merged = [...new Set([...(found.tags || []), ...add])]
      await ctx.database.set(META, { pHash: found.pHash }, { tags: merged })
      return `标签已更新：${merged.join(', ')}`
    })

  ctx.on('ready', () => {
    logger.info(
      '表情包管理已挂载（预筛 %s：面积≤%s / 体积≤%s / 压缩率≤%s / 长宽比≤%s%s；工具 %s）',
      config.prefilterEnabled ? '开' : '关',
      config.maxPixels || '∞',
      config.maxBytes ? ((config.maxBytes / 1024) | 0) + 'KB' : '∞',
      config.maxCompressionRatio,
      config.maxAspectRatio,
      config.dryRun ? '；dryRun 只记不拦' : '',
      config.toolsEnabled ? '开' : '关'
    )
  })
}

module.exports = { name, inject, Config, apply }
