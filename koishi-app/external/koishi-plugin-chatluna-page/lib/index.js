/**
 * koishi-plugin-chatluna-page —— 页面化输出 + 图片库
 *
 * 需求（用户原话，2026-10-03）：
 *   「我私聊过 bot，可以看到命令主要以文字形式返回，而且不好看，之前不是装了能够将
 *     md 或者 html 转化为图片的插件么，我们将所有的命令展示与说明界面都转化为图片
 *     来发给聊天者（注意图片不要占用过多存储空间，可以是一个单独的图片库，这样需要
 *     重构图片库命令，也可以是一个一次性的图片，这样需要考虑生成速度消耗）」
 *
 * ★ 这个插件只做两件事，**不重新实现渲染**：
 *     ① 页面化输出：把一段 Markdown 交给 `ctx.chatlunaRender` 出图，返回可发送的图片元素
 *     ② 图片库：渲染结果按**内容哈希**落盘缓存，带 LRU + TTL 上限，并配管理指令
 *   渲染能力本身在 `koishi-plugin-chatluna-render`（复用 ctx.puppeteer，关 JS、拦外网）。
 *
 * ------------------------------------------------------------------ 第四轮（2026-10-03 晚）追加
 *
 * 用户：「群聊中的回复有一部分仍是大段文字，将其图片化吧；数据太多可以分页，
 *      指令上添加数字则翻页，类似 /help 那样」。于是这里多了**三条出图规则 + 一个分页器**：
 *   · 名单里的指令            → 无脑出图（老行为）
 *   · 名单外的指令输出        → 不短于 minImageChars 就出图（以前只有 18 条名单有图，观感像坏了）
 *   · 模型自己说的长回复      → ≥longTextMinChars 字符或 ≥longTextMinLines 行就出图
 * 超 `pageMaxChars` 字符的内容自动分页，只发第 1 页 + 页脚 `/more 2`，
 * 其余页留在内存里等 `/more n`（别名 `more`，见 chatluna-alias）。
 * 详细规则与"为什么不一次发完 N 张图"见下面「自动出图」「分页」两节的注释。
 *
 * ------------------------------------------------------------------ 为什么是「内容哈希 + LRU」
 *
 * 用户给了两条路：单独图片库 vs 一次性出图。实测（.scratch/bench-render*.cjs）之后选前者，
 * 但**只对了一半**，理由写清楚免得后人误判：
 *
 *   · 出图本身很便宜：热态 150~330 ms（总览页 150 ms，40 行表格 275 ms）。
 *   · 真正贵的是**体积**：880px 视口下，2.0x 的 40 行表格是 836 KB，1.5x 是 644 KB。
 *     JPEG 并不比 PNG 小（同页 877 KB），所以格式不用换，**像素密度才是那个旋钮**。
 *   · 关键事实：**落盘缓存省的是渲染 CPU，不省上传体积** —— 每次 /help 还是要把
 *     PNG 发给 QQ。所以缓存的价值不是「省流量」，而是「省 CPU + 抗并发 + 让重复访问即时」。
 *   · 因此上限必须**双管**：条目数 + 总字节数。只卡条目数挡不住「50 张 800KB 的表」。
 *
 * 用**内容哈希**当键的好处：指令表一变（装了新插件、改了描述），哈希就变，缓存**自动失效**，
 * 不需要任何手工「刷新」动作，也不会有「改了配置但还在发旧图」这类脏状态。
 *
 * ------------------------------------------------------------------ 给别的插件怎么用
 *
 *   const pg = ctx.get('chatlunaPage')
 *   if (pg) return pg.output(session, md, { title: '情绪状态' })   // 返回图片元素
 *   return md                                                      // 服务不在 → 原样文字
 *
 * `output()` 永远不会抛错：出图失败会**退回文字**，宁可丑也不能把指令搞挂。
 * 另有 `/page.text` 让使用者自己切回文字（调试时要用；出图是给人看的，文字是给手抄的）。
 */

const { Schema, Logger, h } = require('koishi')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const name = 'chatluna-page'
const inject = { required: [], optional: ['puppeteer', 'chatlunaRender'] }
const logger = new Logger('page')

/** 图片库缓存的格式版本：改了页面样式/渲染参数就 +1，让旧图整体作废
 *
 *  v2（2026-10-03）：视口高度改成贴内容收边 + 开启 GFM 硬换行 —— 出图结果变了，
 *  旧缓存必须作废，否则会继续发「下面一大片空白、行还挤在一起」的老图。
 */
const CACHE_VERSION = 2

/** 页面通用样式（叠加在 chatluna-render 的 BASE_CSS 之后）
 *
 *  只加「项目符号/等级徽章/键值行」这几样，不动正文排版 —— 正文风格要和
 *  `render_image` 工具出图保持一致，否则同一个 bot 发出来的图两种长相。
 */
const PAGE_CSS = `
.pg-hd{display:flex;align-items:baseline;flex-wrap:wrap;gap:10px;
  border-bottom:2px solid #d8dee4;padding-bottom:8px;margin:0 0 14px}
.pg-hd h1{border:none;margin:0;padding:0;font-size:1.42em;line-height:1.25}
.pg-sub{color:#59636e;font-size:.84em}
.pg-foot{margin-top:16px;padding-top:9px;border-top:1px solid #eaeef2;
  color:#8b949e;font-size:.78em;line-height:1.55}
.lv{display:inline-block;min-width:3.2em;text-align:center;padding:1px 8px;
  border-radius:10px;font-size:.78em;font-weight:600;color:#fff;white-space:nowrap}
.lv0{background:#8b949e}.lv1{background:#2da44e}.lv2{background:#0969da}
.lv3{background:#bf8700}.lv4{background:#cf222e}.lvx{background:#d0d7de;color:#59636e}
.lv-off{opacity:.45}
.pg-kv{display:grid;grid-template-columns:auto 1fr;gap:5px 14px;margin:.7em 0}
.pg-kv dt{color:#59636e;font-size:.9em;white-space:nowrap}
.pg-kv dd{margin:0}
.pg-note{background:#f6f8fa;border-left:4px solid #d0d7de;padding:7px 12px;
  margin:.7em 0;color:#59636e;font-size:.9em}
table td:first-child{white-space:nowrap}
table code{background:none;padding:0;font-weight:600}
`

const Config = Schema.intersect([
  Schema.object({
    enabled: Schema.boolean().default(true).description('总开关。关掉后所有页面化指令退回文字'),
    viewportWidth: Schema.natural().default(880).description('渲染视口宽度（px）'),
    deviceScaleFactor: Schema.number()
      .min(1)
      .max(4)
      .default(1.5)
      .description(
        '像素密度。★ 这是**体积**的主旋钮：实测 40 行表格 2.0x 是 836 KB、1.5x 是 644 KB、1.0x 是 211 KB。' +
          '1.5 在手机上已经够清晰，默认不用 2'
      ),
    timeout: Schema.natural().default(30000).description('单张渲染超时（毫秒）'),
    maxContentChars: Schema.natural().default(30000).description('单张内容字符上限'),
    markdownBreaks: Schema.boolean()
      .default(true)
      .description(
        '把**单个换行**当成硬换行。★ 默认必须开：指令的状态输出是「一行一条」，' +
          '按标准 Markdown 会把一个换行折成一个空格，整段挤在一起没法读（rig 实测踩到）'
      ),
  }),
  Schema.object({
    cacheEnabled: Schema.boolean().default(true).description('图片库缓存总开关'),
    cacheDir: Schema.string().default('data/page-cache').description('图片库目录（相对 koishi-app 根目录）'),
    cacheMaxEntries: Schema.natural().default(80).description('图片库最多存几张'),
    cacheMaxMB: Schema.natural().default(40).description('图片库总字节上限（MB）。★ 只卡条数挡不住大图'),
    cacheTTLHours: Schema.natural().default(168).description('闲置多久算过期（小时）。0 = 不过期'),
  }),
  Schema.object({
    autoRenderEnabled: Schema.boolean()
      .default(true)
      .description(
        '★ 自动出图：名单里的指令，**文字输出会被自动换成图片**。不需要改那些插件一行代码 —— ' +
          '所有出站消息都过 before-send，而 `session.argv.command` 告诉我们这条消息是哪条指令产生的'
      ),
    autoRenderCommands: Schema.array(String)
      .role('table')
      .default([
        'emotion',
        'emotion.list',
        'guard',
        'guard.status',
        'guard.list',
        'guard.limit',
        'vision.stat',
        'render.status',
        'scene',
        'proactive',
        'followup',
        'localemb',
        'selfext.requests',
        'sticker.admin.stat',
        'qqbot.auth',
        'qqbot.auth.list',
        'page.status',
        'page.list',
      ])
      .description('要出图的指令名（精确匹配，逗号分隔一行一个）'),
    autoRenderPatterns: Schema.array(String)
      .role('table')
      .default([])
      .description('正则名单，命中指令名也出图（例：`\\\\.(stat|status)$`）。默认空，名单制更可预测'),
    autoRenderTitle: Schema.boolean().default(true).description('在图片顶部加上指令名与它的说明当标题'),
    allowTextMode: Schema.boolean().default(true).description('允许用 /page.text 把输出切回文字（调试用）'),
    debug: Schema.boolean().default(false).description('打印每次渲染/命中缓存的明细'),
  }),
  Schema.object({
    autoRenderAllCommands: Schema.boolean()
      .default(true)
      .description(
        '★ 名单之外的指令输出**也出图**（2026-10-03 第四轮，用户原话：「群聊中的回复有一部分仍是' +
          '大段文字，将其图片化吧」）。开着才算真的"一致"：以前只有名单里那 18 条出图，' +
          '用户敲 /pics、/room 就只能看到文字，观感上像是坏了。' +
          '不想出图的指令写进 keepTextCommands'
      ),
    minImageChars: Schema.natural()
      .default(40)
      .description('比这还短的指令输出就不折腾了，直接发文字（「没有待审图片」这种没必要做成图）'),
    keepTextCommands: Schema.array(String)
      .role('table')
      .default(['cmdname.scan', 'page.text', 'guard.mute', 'guard.allow', 'guard.reset', 'guard.refill'])
      .description(
        '这些指令的输出**永远留文字**：输出里有要抄进下一条指令的标识符、或者是调试/开关回执。' +
          '★ guard 那四条是「开关回执」（好，群 X 我闭嘴了…），是对话里的确认，不是给人看的数据 —— ' +
          'rig 49 实测：测试台把 minImageChars 压到 1 之后，连「我恢复了」都被做成了图。' +
          '★ 曾经的默认里还有 `vision.list`（图片描述 + hash 前缀，便于复制去 /vision.correct），' +
          '2026-10-03 用户明确要求长文本一律图片化，就把它放开了 —— 想改回来加一行即可'
      ),
  }),
  Schema.object({
    longTextEnabled: Schema.boolean()
      .default(true)
      .description(
        '★ 模型自己说的长回复也出图（这才是"把话变成图片"的自动档：模型什么都不用做）。' +
          '短句闲聊不受影响，见 longTextMinChars / longTextMinLines'
      ),
    longTextGroupsOnly: Schema.boolean().default(true).description('只管群聊；私聊保持文字（用户只提了群聊）'),
    longTextMinChars: Schema.natural()
      .default(180)
      .description('超过这么多字符就出图。0 = 不按字符数判'),
    longTextMinLines: Schema.natural().default(6).description('或者超过这么多行就出图（小作文通常是行多）。0 = 不按行数判'),
    escapeBodyHtml: Schema.boolean()
      .default(true)
      .description(
        '把正文里的裸 HTML 转义后再交给 Markdown 渲染。★ 默认开：' +
          '模型随口打一个 `<`（「3<5」）会被 marked 当成标签，轻则吃掉后面一整段，重则打乱整页排版。' +
          '要的就是 HTML 时请让模型走 render_image 工具，那条路不转义'
      ),
  }),
  Schema.object({
    pageMaxChars: Schema.natural()
      .default(1200)
      .description(
        '单张图最多放多少字符，超了就**分页**。实测参考：880px×1.5x 下 1008 字符 ≈ 100KB、' +
          '2107 字符 ≈ 218KB —— 1000~1200 是清晰度与体积的平衡点'
      ),
    pagerTTLMinutes: Schema.natural().default(15).description('分页记录保留多久（分钟），过期后 /more 就说没有了'),
  }),
])

function apply(ctx, config) {
  const cfg = {
    enabled: true,
    viewportWidth: 880,
    deviceScaleFactor: 1.5,
    timeout: 30000,
    maxContentChars: 30000,
    markdownBreaks: true,
    cacheEnabled: true,
    cacheDir: 'data/page-cache',
    cacheMaxEntries: 80,
    cacheMaxMB: 40,
    cacheTTLHours: 168,
    autoRenderEnabled: true,
    autoRenderCommands: [],
    autoRenderPatterns: [],
    autoRenderTitle: true,
    allowTextMode: true,
    autoRenderAllCommands: true,
    minImageChars: 40,
    keepTextCommands: ['cmdname.scan', 'page.text', 'guard.mute', 'guard.allow', 'guard.reset', 'guard.refill'],
    longTextEnabled: true,
    longTextGroupsOnly: true,
    longTextMinChars: 180,
    longTextMinLines: 6,
    escapeBodyHtml: true,
    pageMaxChars: 1200,
    pagerTTLMinutes: 15,
    debug: false,
    ...(config ?? {}),
  }

  const log = (...a) => cfg.debug && logger.info(...a)

  // 统计
  const stats = { render: 0, hit: 0, fail: 0, bytes: 0, lastMs: 0, evicted: 0 }

  /** 切回文字输出的会话（内存态即可 —— 这是调试开关，不需要跨重启记住） */
  const textMode = new Set()
  const scopeOf = (session) => String(session?.guildId ?? session?.channelId ?? session?.userId ?? '')

  // ------------------------------------------------------------------ 图片库

  // ★ 相对路径按 **进程工作目录** 解析（Koishi 跑在 koishi-app/ 下），
  //   `Context` 上没有 baseDir；`chatluna-sticker` 的 storageDir 也是这个约定（library.js:171）。
  const absDir = path.resolve(cfg.cacheDir)
  /** key -> { file, bytes, at } */
  const index = new Map()
  let totalBytes = 0
  /** key -> Promise，防止同一页并发渲染多次 */
  const inflight = new Map()

  function keyOf(kind, content, width, dsf, css, breaks) {
    return crypto
      .createHash('sha1')
      .update(
        JSON.stringify([CACHE_VERSION, kind, width, dsf, breaks ? 1 : 0, cfg.maxContentChars, css || '', content])
      )
      .digest('hex')
      .slice(0, 20)
  }

  /** 启动时扫盘重建索引：不额外维护 meta 文件，避免索引与文件不一致 */
  async function loadIndex() {
    index.clear()
    totalBytes = 0
    if (!cfg.cacheEnabled) return
    try {
      await fs.promises.mkdir(absDir, { recursive: true })
      const files = await fs.promises.readdir(absDir)
      for (const f of files) {
        if (!f.endsWith('.png')) continue
        const full = path.join(absDir, f)
        try {
          const st = await fs.promises.stat(full)
          const key = f.slice(0, -4)
          index.set(key, { file: full, bytes: st.size, at: st.atimeMs || st.mtimeMs })
          totalBytes += st.size
        } catch {}
      }
      logger.info('图片库已载入：%d 张 / %s（目录 %s）', index.size, mb(totalBytes), absDir)
    } catch (e) {
      logger.warn('图片库载入失败（当作空库继续）：%s', e.message)
    }
  }

  const mb = (b) => `${(b / 1024 / 1024).toFixed(2)} MB`

  async function readCache(key) {
    const it = index.get(key)
    if (!it) return null
    try {
      const buf = await fs.promises.readFile(it.file)
      it.at = Date.now()
      return buf
    } catch {
      // 文件被外部删了：把它从索引里摘掉，别一直报错
      index.delete(key)
      totalBytes -= it.bytes
      return null
    }
  }

  async function writeCache(key, buffer) {
    if (!cfg.cacheEnabled) return
    const full = path.join(absDir, `${key}.png`)
    try {
      await fs.promises.mkdir(absDir, { recursive: true })
      await fs.promises.writeFile(full, buffer)
      const old = index.get(key)
      if (old) totalBytes -= old.bytes
      index.set(key, { file: full, bytes: buffer.length, at: Date.now() })
      totalBytes += buffer.length
      await evict()
    } catch (e) {
      logger.warn('写图片库失败（不影响本次发送）：%s', e.message)
    }
  }

  /** 按 TTL 过期 + LRU 淘汰，直到落回上限之内 */
  async function evict() {
    const now = Date.now()
    const ttlMs = cfg.cacheTTLHours > 0 ? cfg.cacheTTLHours * 3600_000 : 0
    const doomed = []

    if (ttlMs) {
      for (const [k, it] of index) if (now - it.at > ttlMs) doomed.push(k)
    }
    // 还在超限就按最久未用继续淘汰
    if (index.size - doomed.length > cfg.cacheMaxEntries || totalBytes > cfg.cacheMaxMB * 1024 * 1024) {
      const rest = [...index.entries()]
        .filter(([k]) => !doomed.includes(k))
        .sort((a, b) => a[1].at - b[1].at)
      let size = index.size - doomed.length
      let bytes = totalBytes - doomed.reduce((s, k) => s + (index.get(k)?.bytes ?? 0), 0)
      for (const [k, it] of rest) {
        if (size <= cfg.cacheMaxEntries && bytes <= cfg.cacheMaxMB * 1024 * 1024) break
        doomed.push(k)
        size--
        bytes -= it.bytes
      }
    }

    for (const k of doomed) {
      const it = index.get(k)
      if (!it) continue
      index.delete(k)
      totalBytes -= it.bytes
      stats.evicted++
      try {
        await fs.promises.unlink(it.file)
      } catch {}
    }
    if (doomed.length) log('图片库淘汰 %d 张，现有 %d 张 / %s', doomed.length, index.size, mb(totalBytes))
  }

  // ------------------------------------------------------------------ 渲染

  function renderer() {
    return ctx.get('chatlunaRender')
  }

  function available() {
    const r = renderer()
    return !!(cfg.enabled && r && typeof r.renderToBuffer === 'function' && r.available?.())
  }

  /**
   * 渲染一段 Markdown → PNG Buffer（带图片库缓存）
   * @returns {Promise<{buffer:Buffer,key:string,cached:boolean,ms:number}>}
   */
  async function render(content, opts = {}) {
    if (!cfg.enabled) throw new Error('页面插件已关闭')
    const r = renderer()
    if (!r || typeof r.renderToBuffer !== 'function') {
      throw new Error('没找到 ctx.chatlunaRender：请先启用 koishi-plugin-chatluna-render')
    }
    if (typeof content !== 'string' || !content.trim()) throw new Error('内容为空')
    if (content.length > cfg.maxContentChars) {
      throw new Error(`内容太长（${content.length} > ${cfg.maxContentChars} 字符）`)
    }

    const kind = opts.kind === 'html' ? 'html' : 'markdown'
    const width = Number(opts.viewportWidth) > 0 ? Number(opts.viewportWidth) : cfg.viewportWidth
    const dsf = Number(opts.deviceScaleFactor) > 0 ? Number(opts.deviceScaleFactor) : cfg.deviceScaleFactor
    const css = PAGE_CSS + (opts.css || '')
    // ★ 单个换行必须是硬换行：指令的状态输出是「一行一条」，
    //   按 CommonMark 折成空格之后会挤成一整段，完全没法读（rig 实测踩到）。
    const breaks = cfg.markdownBreaks && opts.breaks !== false
    const key = keyOf(kind, content, width, dsf, css, breaks)
    const useCache = cfg.cacheEnabled && opts.cache !== false

    if (useCache) {
      const hit = await readCache(key)
      if (hit) {
        stats.hit++
        log('图片库命中 %s（%d 字节）', key, hit.length)
        return { buffer: hit, key, cached: true, ms: 0 }
      }
      // 同一页并发请求：只渲染一次，其余等同一个 Promise
      const pending = inflight.get(key)
      if (pending) return pending
    }

    const job = (async () => {
      const t0 = Date.now()
      try {
        const buffer = await r.renderToBuffer(kind, content, {
          viewportWidth: width,
          deviceScaleFactor: dsf,
          timeout: cfg.timeout,
          css,
          breaks,
        })
        const ms = Date.now() - t0
        stats.render++
        stats.lastMs = ms
        stats.bytes += buffer.length
        // ★ 走 logger.info 而不是 debug 门控的 log()：出图是低频事件（有缓存），
        //   而生产 debug=false —— 用 log() 的话生产日志里**看不到任何出图记录**，
        //   出了排版问题没法回查是哪个键、多大、多久。命中缓存那条仍然留在 debug。
        logger.info('出图 %s：%d 字符 → %d 字节，%d ms', key, content.length, buffer.length, ms)
        if (useCache) await writeCache(key, buffer)
        return { buffer, key, cached: false, ms }
      } catch (e) {
        stats.fail++
        throw e
      }
    })()

    if (useCache) {
      inflight.set(key, job)
      try {
        return await job
      } finally {
        inflight.delete(key)
      }
    }
    return job
  }

  function isTextMode(session) {
    return cfg.allowTextMode && textMode.has(scopeOf(session))
  }

  /**
   * 把「给浏览器看的 Markdown」（里面混着 `<div class="pg-foot">`、`<br>`、`<span>`）
   * 压成能直接当消息发的纯文本。
   *
   * ★ 为什么必须有这一步（rig 47 实测，2026-10-03）
   *   文字模式下 `output()` 会把 md **原样 return** 给调用方，而调用方的返回值最终走
   *   `session.send(string)` → `h.parse`。`h.parse` 把 `<br>` 解析成一个元素，
   *   而 OneBot 编码器**不认识 br，会连它的子节点一起丢掉** ——
   *   于是 `<br>` 之后的内容整段消失：帮助页的表格、页脚第二三行全没了。
   *   出图路径看不出来（marked 会把 `<br>` 正常渲染成换行），只有文字模式才暴露。
   *
   * ○ 不是"删掉 HTML 就完事"：`<br>` 要变成真换行，`</div>` 要收尾成换行，
   *   否则表格和页脚会挤成一坨。
   *
   * ★ 反过来的一步：`&lt;别名&gt;` 这类实体**必须原样留着**，不能反转义成 `<别名>`。
   *   压完的文本还是要过 `h.parse`，而它只把**实体**当成普通字符；
   *   真写成尖括号就又被当成标签吃掉了（rig 47 第二轮实测：
   *   页脚「单条详情：/help 」后面那个占位符直接没了）。
   *   留在实体态，`h.parse` 会在文本节点里把它还原成 `<别名>` 显示出来 —— 这才是我们要的。
   */
  function plainify(content) {
    return String(content ?? '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:div|p|li|tr|h[1-6])>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }

  /**
   * 给别的插件用的主入口：把 Markdown 变成「可以直接 return 的东西」。
   * 成功 → 图片元素；关了 / 没服务 / 出图失败 / 用户切了文字 → 压成纯文本返回。
   * **永远不会抛错。**
   */
  async function output(session, content, opts = {}) {
    if (!content) return content
    try {
      if (!cfg.enabled) return plainify(content)
      if (isTextMode(session)) return plainify(content)
      if (!available()) return plainify(content)
      const { buffer } = await render(content, opts)
      return h.image(buffer, 'image/png')
    } catch (e) {
      logger.warn('出图失败，退回文字：%s', e.message)
      return plainify(content)
    }
  }

  // 给别的插件复用的稳定接口
  ctx.provide('chatlunaPage', {
    available,
    render,
    output,
    isTextMode,
    plainify,
    setTextMode: (session, on) => {
      const s = scopeOf(session)
      if (!s) return
      if (on) textMode.add(s)
      else textMode.delete(s)
    },
    stats: () => ({ ...stats, entries: index.size, bytes: totalBytes, dir: absDir }),
    clear: async () => {
      let n = 0
      for (const [, it] of index) {
        try {
          await fs.promises.unlink(it.file)
        } catch {}
        n++
      }
      index.clear()
      totalBytes = 0
      return n
    },
    prune: evict,
  })

  // ------------------------------------------------------------------ 自动出图
  //
  // 把「状态/说明类指令」的文字输出自动换成图片 —— **不需要改那些插件一行代码**。
  // 原理：所有出站消息都经过 `before-send`（@satorijs/core 用 app.serial 调），而
  // `session.argv.command` 告诉我们这条消息是哪条指令产生的（Koishi 只在消息真被解析成
  // 指令时才往 session 上挂 argv，见 @koishijs/core:1285 / 1443-1478）。
  //
  // ★ 为什么不在 12 个插件里各写一遍
  //   那样是 12 处重复，而且**将来装的插件不会自动覆盖**。挂在这里是单点改动，
  //   新指令只要加进名单就有图。这和 `chatluna-cmdname` 用运行期净化而不是改
  //   node_modules 是同一个思路。
  //
  // ★ 三条出图规则（2026-10-03 第四轮定稿，按优先级从上到下）
  //   ① **名单里的指令**（autoRenderCommands / autoRenderPatterns）→ 无脑出图，多短都出。
  //      `/emotion`、`/guard.status`、`/scene` 这类"状态卡"就在这一档。
  //   ② **名单外的指令输出**（autoRenderAllCommands，默认开）→ 只要不短于 minImageChars
  //      就出图。用户第四轮的原话是「群聊中的回复有一部分仍是大段文字，将其图片化吧」——
  //      他敲 /pics、/room 时看到的是文字，而 /mood 是图，观感上像坏了。
  //      例外看 keepTextCommands（要抄的标识符、调试回执）。
  //   ③ **模型自己说的长回复**（longTextEnabled，默认开）→ 超过 longTextMinChars 字符
  //      或 longTextMinLines 行就出图。这才是"AI 把自己的话变成图"的**自动档**：
  //      模型什么都不用做，也不需要它愿意。短句闲聊（"在"、"嗯？"）不受影响。
  //
  // ★ 只挑「给人看的」，不碰「给人抄的」
  //   `cmdname.scan` 这类纯诊断输出、以及 `/page.text` 自己的开关回执留在文字里
  //   （见 keepTextCommands）。判据一句话：**输出里有要抄进下一条指令的标识符 → 留文字**。
  //
  // ★ 只在「整条消息都是纯文本」时才动手
  //   带 at / 图片 / 引用 的消息一律放行原样 —— 那些是语义元素，包成图会丢信息。
  //   宁可偶尔不出图，也不要把消息改坏。
  //   （`render_image` 工具发出来的图、sticker 发的表情包都是"非纯文本"，天然不受影响。）

  const textOf = (el) => (el?.type === 'text' ? String(el?.attrs?.content ?? '') : null)

  /** 正文转义：裸 `<` 交给 marked 会被当成标签，轻则吃掉后面一段，重则打乱整页 */
  const escapeBody = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  // ★ 为什么**不能**在 before-send 里读 `session.argv`（这是本插件最容易写错的地方）
  //
  //   实测（rig 42-autorender-probe）：`before-send` 收到的 session 里**根本没有 argv**，
  //   直接读 `session.argv?.command` 永远是 undefined，自动出图一次都不会触发。
  //
  //   根因在 @satorijs/core 的编码器：出站时它 new 了一个 session，然后把原 session 上
  //   **可枚举**的键逐个拷过去（lib/index.cjs:739-742）：
  //       for (const key in this.options.session || {}) {
  //         if (key === 'id' || key === 'event') continue
  //         this.session[key] = this.options.session[key]
  //       }
  //   而 `argv` 是 Koishi 用 `defineProperty` 挂上去的（@koishijs/core:1285）——**不可枚举**，
  //   于是被这个循环漏掉。`chatluna-guard` 的 `__guardControl` 之所以一直有效，正是因为它
  //   是一次普通赋值（可枚举）。
  //
  //   所以照抄那个已被生产验证过的做法：在 `command/execute`（指令真的要执行的那一刻）
  //   往 session 上打一个**普通赋值**的标记，出站时它自然会被复制过去。
  ctx.before('command/execute', (argv) => {
    const s = argv?.session
    if (s && argv?.command) s.__pageCommand = argv.command
  })

  function autoWanted(cmd) {
    if (!cmd?.name) return false
    if ((cfg.autoRenderCommands ?? []).includes(cmd.name)) return true
    return (cfg.autoRenderPatterns ?? []).some((p) => {
      try {
        return new RegExp(p).test(cmd.name)
      } catch {
        return false
      }
    })
  }

  // ------------------------------------------------------------------ 分页
  //
  // 用户第四轮的原话：「数据太多可以分页，指令上添加数字则翻页，类似 /help 那样」。
  // 于是这里做一个**通用的分页器**：任何一段长文本 → 每 pageMaxChars 字符一张图，
  // 只发第 1 页 + 页脚写着 `/more 2`，其余页留在内存里等 `/more n` 取。
  //
  // ★ 为什么不是"一次把 N 张图都发出去"：那正好撞上 guard 的出站限流（token 桶 + 最小间隔），
  //   3 张图要排 6 秒队，还容易被桶丢掉几张 —— 用户看到的会是"图发了一半"。
  //   一页一图、要看自己翻，才是既省流量又不会被限流打脸的形态。

  /** scope -> { pages, kind, head, page, at }：每个会话只留最近一次可翻页的内容 */
  const pager = new Map()
  const PAGER_MAX_SCOPES = 40

  function pagerSet(scope, data) {
    pager.set(scope, { ...data, page: data.page ?? 1, at: Date.now() })
    const ttl = cfg.pagerTTLMinutes * 60_000
    if (ttl > 0) {
      for (const [k, v] of pager) if (Date.now() - v.at > ttl) pager.delete(k)
    }
    while (pager.size > PAGER_MAX_SCOPES) pager.delete(pager.keys().next().value)
  }

  function pagerGet(scope) {
    const v = pager.get(scope)
    if (!v) return null
    const ttl = cfg.pagerTTLMinutes * 60_000
    if (ttl > 0 && Date.now() - v.at > ttl) {
      pager.delete(scope)
      return null
    }
    return v
  }

  /**
   * 按行切页：优先在**行边界**切（表格、列表、一行一条的状态输出都不会被劈开），
   * 单行本身超长时才硬切（模型偶尔会吐一整段没有换行的长文）。
   */
  function splitPages(text, maxChars) {
    // 下限 20：测试台会把 pageMaxChars 压到很小来验分页，别在这里把它顶回去
    const limit = Math.max(Number(maxChars) || 1200, 20)
    const pages = []
    let cur = ''
    const flush = () => {
      if (cur.trim()) pages.push(cur.replace(/\s+$/, ''))
      cur = ''
    }
    for (const rawLine of String(text).split('\n')) {
      let line = rawLine
      while (line.length > limit) {
        flush()
        pages.push(line.slice(0, limit))
        line = line.slice(limit)
      }
      if ((cur ? cur.length + 1 : 0) + line.length > limit) flush()
      cur = cur ? `${cur}\n${line}` : line
    }
    flush()
    return pages.length ? pages : ['']
  }

  /** 拼一页的 Markdown：正文 + 页脚（翻页提示 / 切回文字） */
  function pageMarkdown(body, info) {
    const { page, pages, head, kind } = info
    const foot = []
    if (pages > 1) {
      if (page < pages) foot.push(`下一页：<code>/more ${page + 1}</code>`)
      if (page > 1) foot.push(`上一页：<code>/more ${page - 1}</code>`)
      foot.push(`共 <b>${pages}</b> 页 · 第 <b>${page}</b> 页`)
    }
    foot.push(
      kind === 'command'
        ? `指令输出 · 发 <code>/page.text on</code> 可切回文字`
        : `长回复自动出图 · 发 <code>/page.text on</code> 之后不再出图`
    )
    return `${head || ''}${body}\n\n<div class="pg-foot">${foot.join('　·　')}</div>`
  }

  /** 渲染第 n 页（1 起），返回图片元素 */
  async function renderPage(session, info, page) {
    const total = info.pages.length
    const p = Math.min(Math.max(Number(page) || 1, 1), total)
    const md = pageMarkdown(info.pages[p - 1], { page: p, pages: total, head: info.head, kind: info.kind })
    const { buffer } = await render(md)
    return { el: h.image(buffer, 'image/png'), page: p, pages: total }
  }

  /** 指令标题（`# 名称` + 它的 i18n 说明） */
  function commandHead(cmd) {
    if (!cfg.autoRenderTitle || !cmd?.name) return ''
    // ★ 别用 `cmd.toJSON().description`：Koishi 的 `I18n.get()` 返回的是
    //   locale → 文案 的映射**对象**（@koishijs/core:1648），toJSON 直接把它当
    //   description，String() 出来就是 `[object Object]`。照框架 help 的做法用
    //   i18n.render 渲染（详见 chatluna-help 里的同名注释）。
    let desc = ''
    try {
      desc = ctx.i18n.render([], [`commands.${cmd.name}.description`, ''], cmd.config?.params ?? {}).join('')
    } catch {}
    return `# ${cmd.displayName || cmd.name}\n\n${desc ? desc + '\n\n' : ''}`
  }

  ctx.on('before-send', async (session) => {
    try {
      if (!cfg.enabled || !cfg.autoRenderEnabled) return
      if (!session) return
      // `__pageCommand` 是上面 command/execute 打的标记（可枚举、能被编码器复制过来）；
      // `session.argv` 是保险丝 —— 万一 Koishi 哪天改成拷贝不可枚举键，这里还能兜住。
      const cmd = session.__pageCommand ?? session.argv?.command
      const listed = autoWanted(cmd)
      if (cfg.debug) {
        log('before-send 判定：指令=%s 名单命中=%s', cmd?.name ?? '(没有标记)', cmd ? listed : '-')
      }
      // 名单本身就是"要出图"的意思，这里先放行；名单外的还要看下面的长度/白名单规则
      if (!listed && !cmd && !cfg.longTextEnabled) return
      if (!listed && cmd && !cfg.autoRenderAllCommands) return
      if (isTextMode(session)) return

      const els = session.elements
      if (!Array.isArray(els) || !els.length) return

      // ★ 跳过开头的 quote / at「前缀」
      //   真实形态是 `[CQ:reply][CQ:at] <正文>`（chatluna-reply-style 加的），
      //   那两个是**语义元素**，不能包进图里 —— 但也**不该因此放弃出图**。
      //   早先的写法是"有一个非 text 就整条放行"，于是只要回复带了引用，
      //   自动出图就**静默失效**（开关还开着、日志里连一行都没有）。
      //   现在的规则：前缀照原样留在外面，只把后面那一段纯文本换成图。
      let prefixLen = 0
      while (
        prefixLen < els.length &&
        (els[prefixLen]?.type === 'quote' || els[prefixLen]?.type === 'at')
      ) {
        prefixLen++
      }
      const prefix = els.slice(0, prefixLen)
      const body = els.slice(prefixLen)
      if (!body.length) return
      // 正文必须全是文本才动手（有图 / 其它元素就原样放行）
      if (body.some((el) => textOf(el) === null)) return

      const text = body
        .map((el) => textOf(el))
        .join('\n')
        .trim()
      if (!text) return

      // ---- 决定这条要不要出图 ----
      let kind = null
      if (listed) {
        kind = 'command'
      } else if (cmd) {
        // 名单外的指令输出：guard 的开关回执、要抄的标识符、短回执都留文字
        if (session.__guardControl) return
        if ((cfg.keepTextCommands ?? []).includes(cmd.name)) return
        if (text.length < Math.max(Number(cfg.minImageChars) || 0, 1)) return
        kind = 'command'
      } else {
        // 模型 / 其它插件直接发出来的文本
        if (cfg.longTextGroupsOnly && session.isDirect) return
        const minChars = Number(cfg.longTextMinChars) || 0
        const minLines = Number(cfg.longTextMinLines) || 0
        const chars = text.length
        const lines = text.split('\n').length
        if (!(minChars > 0 && chars >= minChars) && !(minLines > 0 && lines >= minLines)) return
        kind = 'reply'
      }

      if (!available()) return

      const scope = scopeOf(session)
      // ★ 正文转义：裸 `<` 会被 marked 当成 HTML 标签（见 escapeBody 注释）。
      //   页脚那点 `<div class="pg-foot">` 是我们自己在 pageMarkdown 里加的，不受影响。
      const safe = cfg.escapeBodyHtml ? escapeBody(text) : text
      const info = {
        pages: splitPages(safe, cfg.pageMaxChars),
        kind,
        head: kind === 'command' ? commandHead(cmd) : '',
      }
      if (info.pages.length > 1 && scope) pagerSet(scope, info)

      const { el, page, pages } = await renderPage(session, info, 1)
      logger.info(
        '%s出图：%s → 第 %d/%d 页（正文 %d 字符）',
        kind === 'command' ? '指令自动' : '长回复',
        cmd?.name ?? '模型回复',
        page,
        pages,
        text.length
      )
      // 前缀（引用 / @）原样保留在最前面，只替换正文
      session.elements = [...prefix, el]
    } catch (e) {
      logger.warn('自动出图失败（保留原文字）：%s', e.message)
    }
  })

  // ------------------------------------------------------------------ 指令

  const LV = { 0: '拉黑', 1: '普通', 2: '信任', 3: '管理员', 4: '主人' }

  /** 图片库状态卡 */
  function cacheMarkdown() {
    const s = stats
    const total = s.hit + s.render
    const rate = total ? ((s.hit / total) * 100).toFixed(1) : '0.0'
    const lines = [
      `# 图片库`,
      '',
      `<div class="pg-kv">`,
      `<dt>目录</dt><dd><code>${cfg.cacheDir}</code></dd>`,
      `<dt>存量</dt><dd>${index.size} 张 / ${mb(totalBytes)}（上限 ${cfg.cacheMaxEntries} 张、${cfg.cacheMaxMB} MB）</dd>`,
      `<dt>过期</dt><dd>${cfg.cacheTTLHours > 0 ? `闲置 ${cfg.cacheTTLHours} 小时后淘汰` : '不按时间过期'}</dd>`,
      `<dt>渲染</dt><dd>${s.render} 次（上次 ${s.lastMs} ms，累计出图 ${mb(s.bytes)}）</dd>`,
      `<dt>命中</dt><dd>${s.hit} 次，命中率 ${rate}%</dd>`,
      `<dt>淘汰</dt><dd>${s.evicted} 张</dd>`,
      `<dt>分页</dt><dd>${pager.size} 个会话有可翻页的长内容（保留 ${cfg.pagerTTLMinutes} 分钟，单页 ≤ ${cfg.pageMaxChars} 字符）</dd>`,
      `<dt>失败</dt><dd>${s.fail} 次</dd>`,
      `</div>`,
      '',
      `渲染参数：视口 ${cfg.viewportWidth}px × ${cfg.deviceScaleFactor}x｜超时 ${cfg.timeout} ms`,
      '',
      `<div class="pg-foot">图片库按**内容哈希**存图：指令表或配置一变，哈希就变，旧图自动作废，` +
        `不需要手工刷新。淘汰顺序是「先过期、再最久未用」。<br>` +
        `缓存省的是渲染 CPU，**不省上传体积** —— 每次出图还是要发给 QQ。</div>`,
    ]
    return lines.join('\n')
  }

  ctx
    .command('page.status', '看图片库状态', { authority: 3 })
    .action(async ({ session }) => output(session, cacheMarkdown(), { cache: false }))

  ctx
    .command('page.list [limit:number]', '列出图片库里最近用过的图', { authority: 3 })
    .action(async ({ session }, limit) => {
      const n = Math.min(Math.max(Number(limit) || 15, 1), 50)
      const rows = [...index.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, n)
      if (!rows.length) return '图片库是空的。'
      const md = [
        `# 图片库内容`,
        '',
        `最近用过的 ${rows.length} 张（共 ${index.size} 张 / ${mb(totalBytes)}）：`,
        '',
        '| 键 | 大小 | 最后使用 |',
        '| --- | --- | --- |',
        ...rows.map(([k, it]) => `| \`${k}\` | ${(it.bytes / 1024).toFixed(0)} KB | ${ago(it.at)} |`),
      ].join('\n')
      return output(session, md, { cache: false })
    })

  ctx
    .command('page.prune', '按 TTL/上限清理图片库', { authority: 3 })
    .action(async () => {
      const before = index.size
      await evict()
      return `图片库清理完成：${before} → ${index.size} 张（${mb(totalBytes)}）。`
    })

  ctx
    .command('page.clear', '清空图片库', { authority: 4 })
    .action(async () => {
      const n = await ctx.chatlunaPage.clear()
      logger.info('图片库已清空：删了 %d 张', n)
      return `图片库已清空（删掉 ${n} 张）。下次出图会重新渲染。`
    })

  ctx
    .command('page.text [value:string]', '把页面化输出切回文字（调试用）', { authority: 1 })
    .action(({ session }, value) => {
      if (!cfg.allowTextMode) return '文字模式已被配置关掉。'
      const scope = scopeOf(session)
      const v = String(value ?? '').trim().toLowerCase()
      const on = v === 'on' || v === '1' || v === 'true' || v === '开'
      const off = v === 'off' || v === '0' || v === 'false' || v === '关'
      // 没给参数 = 切换
      const next = on ? true : off ? false : !textMode.has(scope)
      if (next) textMode.add(scope)
      else textMode.delete(scope)
      return next
        ? '好，这个会话里的状态/说明类指令改成**文字**输出了。要恢复发 `/page.text off`。'
        : '好，恢复**图片**输出。'
    })

  /**
   * 长内容分页的翻页入口（别名 `/more`，见 chatluna-alias）。
   *
   * 用户第四轮原话：「数据太多可以分页，指令上添加数字则翻页，类似 /help 那样」。
   * 不带数字 = 看下一页，带数字 = 跳到第 n 页；越界自动夹到 [1, 总页数]。
   *
   * ★ 记录只存在内存里、只留**每个会话最近一次**可翻页的内容（pagerTTLMinutes 分钟），
   *   因为它是"我刚才那条长回复的续页"，不是历史归档。要翻很久以前的，只能重发。
   */
  ctx
    .command('page.more [page:number]', '翻到长回复 / 长输出的下一页', { authority: 1 })
    .action(async ({ session }, page) => {
      const scope = scopeOf(session)
      const rec = scope ? pagerGet(scope) : null
      if (!rec) {
        return `这里没有可翻页的内容了（只保留最近 ${cfg.pagerTTLMinutes} 分钟内的那一条）。`
      }
      const total = rec.pages.length
      const want = Number(page) > 0 ? Math.floor(Number(page)) : (rec.page || 1) + 1
      const p = Math.min(Math.max(want, 1), total)
      rec.page = p
      rec.at = Date.now()

      // 出不了图（关了 / 没渲染服务 / 渲染失败 / 用户切了文字）就退回文字 —— 翻页不该因为渲染问题失效
      if (isTextMode(session) || !available()) return plainify(rec.pages[p - 1])
      try {
        const { el } = await renderPage(session, rec, p)
        logger.info('分页查看：第 %d/%d 页（%s）', p, total, rec.kind === 'command' ? '指令输出' : '模型回复')
        return el
      } catch (e) {
        logger.warn('翻页出图失败，退回文字：%s', e.message)
        return plainify(rec.pages[p - 1])
      }
    })

  function ago(ts) {
    const d = Date.now() - ts
    if (d < 60_000) return '刚刚'
    if (d < 3600_000) return `${Math.floor(d / 60_000)} 分钟前`
    if (d < 86400_000) return `${Math.floor(d / 3600_000)} 小时前`
    return `${Math.floor(d / 86400_000)} 天前`
  }

  // ------------------------------------------------------------------ 启动

  ctx.on('ready', () => {
    loadIndex().then(() => {
      const r = renderer()
      logger.info(
        '页面化输出已挂载（渲染服务 %s；图片库 %s；%dpx × %sx）',
        r ? '就绪' : '**没找到 chatluna-render**',
        cfg.cacheEnabled ? `${cfg.cacheDir} 上限 ${cfg.cacheMaxEntries} 张 / ${cfg.cacheMaxMB} MB` : '关',
        cfg.viewportWidth,
        cfg.deviceScaleFactor
      )
      const list = cfg.autoRenderCommands ?? []
      logger.info(
        '自动出图：%s，名单 %d 条%s；正则 %d 条',
        cfg.autoRenderEnabled ? '开' : '关',
        list.length,
        list.length ? `（${list.slice(0, 6).join(' / ')}${list.length > 6 ? ' …' : ''}）` : '（空！检查 Schema 默认值有没有生效）',
        (cfg.autoRenderPatterns ?? []).length
      )
      logger.info(
        '长文本出图：%s｜名单外指令 %s（短于 %d 字符留文字，留文字名单 %s）｜模型长回复 %s（≥%d 字符或 ≥%d 行，%s）｜超 %d 字符分页，翻页 /more',
        cfg.longTextEnabled ? '开' : '关',
        cfg.autoRenderAllCommands ? '也出图' : '只有名单',
        cfg.minImageChars,
        (cfg.keepTextCommands ?? []).join('/') || '（空）',
        cfg.longTextEnabled ? '出图' : '留文字',
        cfg.longTextMinChars,
        cfg.longTextMinLines,
        cfg.longTextGroupsOnly ? '仅群聊' : '私聊也算',
        cfg.pageMaxChars
      )
      if (!r) logger.warn('没有 ctx.chatlunaRender，所有页面化指令会退回文字输出')
    })
  })

  ctx.on('dispose', () => {
    index.clear()
    inflight.clear()
  })
}

module.exports = { name, inject, Config, apply }
