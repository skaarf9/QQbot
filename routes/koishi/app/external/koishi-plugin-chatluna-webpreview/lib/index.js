/**
 * koishi-plugin-chatluna-webpreview —— 网页预览（真实网址 → 浏览器打开 → 截图 + 正文）
 *
 * 需求（用户原话 2026-10-06）：
 *   「我想要给 bot 提供你的网页 preview 插件功能」
 *   即：把 DSH 里那套 `browser_open / browser_screenshot / browser_read` 的能力搬给机器人 ——
 *   给一个**真实网址**，它能用本机浏览器真的打开它，把看到的样子截成图发到会话里，
 *   顺便把**渲染完成之后**的正文交给模型。
 *
 * ---------------------------------------------------------------- 为什么必须自写（硬约束第 0 条）
 *
 * ① 先查本地（本仓库已经装了什么）：
 *    · `koishi-plugin-puppeteer@3.9.0` —— 有 `ctx.puppeteer.page()`，**能力已经在**；
 *    · `chatluna-render`（自写）—— 只会把**模型给的字符串**渲染成图（`page.setContent`），
 *      它**从不去访问网址**，而且默认关 JS、拦掉一切外部请求；
 *    · `chatluna-page`（自写）—— 同上，渲的是指令输出的 Markdown；
 *    · `mcp/websearch-server.cjs` 的 `web_browse` —— 会抓网址，但**没有浏览器**：
 *      纯正则抽正文，JS 渲染的站（React/Vue 客户端渲染）返回
 *      `(正文为空：可能是 JS 渲染页面、需要登录，或被反爬拦截)`（见 `.scratch/mcp-websearch-notes.md` §5.1）。
 *    ⇒ **本地没有任何一个能"访问真实网址并出图"的东西**，缺口就在这里。
 * ② 再查市场（`market.search.endpoint` = koishi-registry.yumetsuki.moe，4727 个包全量关键词搜过）：
 *    见 `docs/30-网页预览.md` 第 2 节的三候选源码对照（`screenshot-links` / `screenshot` / `capture-website`）。
 *    结论：它们都是**消息监听型**（见到链接自动发图），**没有一个给模型的工具**、
 *    **没有一个做内网地址防护**，且各自带自己的配置与依赖。
 * ③ 所以自写，而且只写**最薄的一层适配**（和 `chatluna-render` 同一个套路）：
 *    渲染"能力"继续用市场插件 `koishi-plugin-puppeteer`，这里只做三件事：
 *      ① 网址安全校验（SSRF 防护）+ 渲染 + 截图 + 取正文，包成一个稳定服务 `ctx.chatlunaWebPreview`
 *      ② 注册 ChatLuna 工具 `web_preview`（模型可以自己决定"这个链接我给你截个图看看"）
 *      ③ 注册指令 `webpreview.get / webpreview.text / webpreview.status`（不花 API 的确定性通路）
 *
 * ---------------------------------------------------------------- 安全（网址来自用户与模型，全是不可信输入）
 *
 * 「服务端去访问一个别人给的网址」= SSRF 的教科书场景。这台机器上有 NapCat 的 3001、
 * Koishi 的 5140、NapCat WebUI 6099，全都绑在 127.0.0.1 —— 只要能让机器人去"预览"
 * `http://127.0.0.1:6099/...`，就等于把控制台的面板交给群友。所以：
 *   - 只允许 `http:` / `https:`；
 *   - 主机名是 `localhost` / `*.local` / `*.internal` 或**私有网段字面量** → 直接拒；
 *   - 域名要做 **DNS 解析并逐个 IP 检查**（防"域名解析到内网"与 DNS rebinding）；
 *   - 页面里的**每一个请求**再拦一道（`request` 拦截：非 http(s)、私有主机、媒体流一律 abort）；
 *   - 跳转之后再查一次**最终 URL**（防"公网 URL 302 到内网"）。
 * 另有体积/时长上限：视口宽度、像素密度、整页高度上限、超时、并发闸门。
 * 唯一会放宽这些检查的是 `allowPrivateHosts`（**只给测试台用**，生产必须 false）。
 *
 * ---------------------------------------------------------------- 与既有两个出站插件的关系
 *
 *   - `chatluna-guard` 是出站总闸（屏蔽 + 令牌桶 + 最小间隔）：本插件出的图走正常
 *     `session.send`，因此**天然受限流约束**。指令驱动的回复按 guard 的
 *     `outboundExemptCommands` 规则豁免（用户主动要的，不该排队）。
 *   - `chatluna-page` 只把**纯文本**消息换成图片（它自己注释里写的：
 *     「`render_image` 工具发出来的图、sticker 发的表情包都是非纯文本，天然不受影响」），
 *     本插件返回的是 `h.image(...)`，不会被它二次加工。
 *
 * ---------------------------------------------------------------- 与 websearch MCP 的分工
 *
 *   `web_browse`：便宜、快、纯 HTTP，适合"读一篇文章"。
 *   本插件：贵、慢（要起页面）、能出图，适合"这页面长什么样"和**JS 渲染站**。
 *   两者不冲突：模型先搜、再读；读不出来或者要看样子时调 `web_preview`。
 */

const { Schema, Logger, h } = require('koishi')
const dns = require('node:dns').promises
const net = require('node:net')

const name = 'chatluna-webpreview'
const inject = { required: [], optional: ['puppeteer', 'chatluna'] }
const logger = new Logger('chatluna-webpreview')

/** 默认 UA：无头浏览器的 UA 里带 `HeadlessChrome`，一大半站点会直接 403 或给验证页 */
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0'

// ------------------------------------------------------------------ 配置

const Config = Schema.intersect([
  Schema.object({
    enabled: Schema.boolean().default(true).description('总开关'),
    toolEnabled: Schema.boolean()
      .default(true)
      .description('注册 `web_preview` 工具，让模型自己决定"这个链接我给你截个图看看"'),
    groups: Schema.array(String)
      .role('table')
      .default([])
      .description('★ 允许使用本插件的群（群号）。**空数组 = 不限群**；填了就只在这些群里给模型这个工具'),
    toolCooldownSeconds: Schema.natural()
      .default(20)
      .description('同一个群里两次 `web_preview` 之间的最短间隔（秒）——模型连调会把浏览器占满'),
  }),
  Schema.object({
    autoEnabled: Schema.boolean()
      .default(false)
      .description(
        '★ 自动预览（默认关）：群里有人发了个网址就自动截图发出去。' +
          '关着是有理由的 —— 本项目 2026-10-02 刚因为刷屏被腾讯限流过（docs/16），' +
          '「每条链接都出一张图」在活跃群里等于自找限流。要用就显式打开并配好 autoGroups'
      ),
    autoGroups: Schema.array(String)
      .role('table')
      .default([])
      .description('自动预览生效的群（群号）。**空数组 = 哪个群都自动预览**；建议至少限制到具体几个群'),
    autoCooldownSeconds: Schema.natural().default(60).description('同一个群里两次自动预览的最短间隔（秒）'),
    autoIgnorePrefixes: Schema.array(String)
      .role('table')
      .default(['/', '.'])
      .description('以这些前缀开头的消息不自动预览（指令不当链接抓）'),
  }),
  Schema.object({
    viewportWidth: Schema.natural().default(1024).description('视口宽度（px）。实测 1024 更接近桌面站点的排版'),
    viewportHeight: Schema.natural().default(768).description('视口高度（px）：`viewport` 模式就是截这一屏'),
    deviceScaleFactor: Schema.number()
      .min(1)
      .max(3)
      .default(1)
      .description(
        '★ 体积主旋钮（与 chatluna-page 同一个结论）：真实网页 1024px 下 1.0x 是 100~400 KB、' +
          '1.5x 立刻涨到 170~700 KB。网页预览是"看一眼"，1.0x 足够'
      ),
    mode: Schema.union(['viewport', 'full'])
      .default('viewport')
      .description('默认截图模式：viewport = 只截首屏（推荐）；full = 整页（受 maxCaptureHeight 限制）'),
    maxCaptureHeight: Schema.natural().default(3000).description('整页截图的高度上限（px），防止一张图几万像素高'),
    maxBytes: Schema.natural()
      .default(700000)
      .description('字节上限：PNG 超过它就改截 JPEG(q82)，哪个小用哪个（实测新闻类整页 PNG 1.2 MB / JPEG 337 KB）'),
    jpegQuality: Schema.natural().min(40).max(100).default(82).description('JPEG 质量'),
  }),
  Schema.object({
    allowJavaScript: Schema.boolean()
      .default(true)
      .description(
        '★ 与 chatluna-render 相反，这里**默认开** JS —— 真实网页大半是客户端渲染的，' +
          '关掉就只能截到骨架（这正是 web_browse 抓不到正文的原因）。页面跑在 Chromium 沙箱里，' +
          '且所有请求仍过下面的拦截与 SSRF 检查'
      ),
    allowPrivateHosts: Schema.boolean()
      .default(false)
      .description('★★ 允许访问内网/本机地址。**只给自动化测试台用**（测试台要预览 127.0.0.1 上的假页面）。生产必须 false'),
    blockedHosts: Schema.array(String)
      .role('table')
      .default([])
      .description('额外黑名单域名（含子域），例如不想让机器人去截的那些站'),
    blockMedia: Schema.boolean().default(true).description('拦掉 video/audio 等媒体流请求（只影响速度，不影响截图观感）'),
    userAgent: Schema.string().default(DEFAULT_UA).description('浏览器 UA'),
    maxRedirects: Schema.natural().default(5).description('跳转次数上限（跳转后会再查一次最终地址）'),
  }),
  Schema.object({
    timeout: Schema.natural().default(30000).description('打开页面的超时（毫秒）'),
    idleWaitMs: Schema.natural()
      .default(2500)
      .description('等页面安静下来的上限（毫秒）。实测真实站点几乎都会等到超时，所以别调大'),
    settleMs: Schema.natural().default(400).description('安静之后再等一小会儿，给首屏绘制留时间（毫秒）'),
    maxConcurrent: Schema.natural().default(2).description('同时最多几个预览在跑（共用同一个浏览器进程）'),
    queueWaitMs: Schema.natural().default(8000).description('排不上队时最多等多久，超了就回一句"忙"'),
    maxTextChars: Schema.natural().default(6000).description('交给模型的正文上限（字符）'),
  }),
  Schema.object({
    debug: Schema.boolean().default(false).description('打印每次预览的耗时、尺寸、字节数'),
  }),
])

// ------------------------------------------------------------------ SSRF 判定（纯函数，可单独测）

function isPrivateIPv4(ip) {
  const p = String(ip).split('.')
  if (p.length !== 4) return true
  const n = p.map((x) => Number(x))
  if (n.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return true
  const [a, b] = n
  if (a === 0 || a === 10 || a === 127) return true // 0.0.0.0/8、10/8、127/8
  if (a === 169 && b === 254) return true // 链路本地（含云元数据 169.254.169.254）
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16/12
  if (a === 192 && b === 168) return true // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64/10
  if (a === 192 && b === 0) return true // 192.0.0/24、192.0.2/24
  if (a === 198 && (b === 18 || b === 19)) return true // 基准测试网段
  if (a >= 224) return true // 组播 + 保留
  return false
}

function isPrivateIPv6(ip) {
  const s = String(ip).toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]
  if (s === '::' || s === '::1') return true
  if (/^f[cd]/.test(s)) return true // fc00::/7 唯一本地地址
  if (/^fe[89ab]/.test(s)) return true // fe80::/10 链路本地
  if (s.startsWith('2001:db8')) return true // 文档示例
  const m = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (m) return isPrivateIPv4(m[1]) // IPv4 映射地址
  return false
}

/** 主机名字面量判定：不看 DNS，只看"这个名字本身是不是就是内网/本机" */
function isPrivateHostLiteral(host) {
  const s = String(host || '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '')
  if (!s) return true
  if (s === 'localhost' || s.endsWith('.localhost')) return true
  if (s.endsWith('.local') || s.endsWith('.internal') || s.endsWith('.lan') || s.endsWith('.home')) return true
  if (/^\d+$/.test(s)) return true // 十进制整数形式的 IP（http://2130706433/ = 127.0.0.1）
  if (/^0x[0-9a-f]+$/i.test(s)) return true
  if (net.isIPv4(s)) return isPrivateIPv4(s)
  if (net.isIPv6(s)) return isPrivateIPv6(s)
  return false
}

// ------------------------------------------------------------------ 小工具

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 把 URL 里的控制字符/中文标点尾巴剪掉（群里复制来的链接常带「，」「）」） */
function cleanUrlText(s) {
  return String(s || '')
    .trim()
    .replace(/[\u0000-\u001f<>"`\u3000]/g, '')
    .replace(/[)\]}>，。；：！？、）】》」』"'.,;:!?]+$/, '')
}

/**
 * 从聊天文本里认链接。
 * ★ 必须把**中文标点**也算作分隔符：群里发的「看这个 https://a.com/x），挺好的」
 *   如果只按空白切，抽出来的会是 `https://a.com/x），挺好的`（实测踩过），
 *   于是 `new URL()` 直接把后面那串中文当成路径，预览必然失败。
 */
const URL_RE = /https?:\/\/[^\s\u3000<>"'`，。；：！？、（）【】《》「」『』…·]+/gi

function pickFirstUrl(text) {
  const m = String(text || '').match(URL_RE)
  if (!m || !m.length) return null
  return cleanUrlText(m[0]) || null
}

const hostOf = (u) => {
  try {
    return new URL(u).hostname
  } catch {
    return String(u)
  }
}

// ------------------------------------------------------------------ apply

function apply(ctx, config) {
  const cfg = {
    enabled: true,
    toolEnabled: true,
    groups: [],
    toolCooldownSeconds: 20,
    autoEnabled: false,
    autoGroups: [],
    autoCooldownSeconds: 60,
    autoIgnorePrefixes: ['/', '.'],
    viewportWidth: 1024,
    viewportHeight: 768,
    deviceScaleFactor: 1,
    mode: 'viewport',
    maxCaptureHeight: 3000,
    maxBytes: 700000,
    jpegQuality: 82,
    allowJavaScript: true,
    allowPrivateHosts: false,
    blockedHosts: [],
    blockMedia: true,
    userAgent: DEFAULT_UA,
    maxRedirects: 5,
    timeout: 30000,
    idleWaitMs: 2500,
    settleMs: 400,
    maxConcurrent: 2,
    queueWaitMs: 8000,
    maxTextChars: 6000,
    debug: false,
    ...(config ?? {}),
  }

  const debug = (...a) => cfg.debug && logger.info(...a)

  const stats = {
    ok: 0,
    fail: 0,
    lastMs: 0,
    lastBytes: 0,
    byCommand: 0,
    byTool: 0,
    byAuto: 0,
    lastUrl: '',
    lastError: '',
  }

  // ---------------------------------------------------------------- 并发闸门
  // 共用一个 Chromium：不做闸门的话，群里几个人同时发链接就会同时开一堆页面，
  // 内存和 CPU 一起炸（chatluna-render 那边是串行渲染，同一个道理）。

  let active = 0
  const waiters = []

  function pump() {
    while (active < cfg.maxConcurrent && waiters.length) {
      const w = waiters.shift()
      if (w.timer) clearTimeout(w.timer)
      active++
      w.resolve()
    }
  }

  function acquire() {
    if (active < cfg.maxConcurrent) {
      active++
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const w = { resolve, reject, timer: null }
      w.timer = setTimeout(() => {
        const i = waiters.indexOf(w)
        if (i >= 0) waiters.splice(i, 1)
        reject(new Error('预览队列满了，稍等一下再试'))
      }, cfg.queueWaitMs)
      waiters.push(w)
    })
  }

  function release() {
    active = Math.max(0, active - 1)
    pump()
  }

  // ---------------------------------------------------------------- 网址校验

  function blockedByConfig(host) {
    const s = String(host || '').toLowerCase()
    return (cfg.blockedHosts || []).some((raw) => {
      const b = String(raw || '')
        .trim()
        .toLowerCase()
        .replace(/\.$/, '')
      if (!b) return false
      return s === b || s.endsWith('.' + b)
    })
  }

  /** 校验一个网址能不能访问；返回 URL 对象，不通过就抛（消息是给用户看的中文） */
  async function checkUrl(raw) {
    const text = cleanUrlText(raw)
    if (!text) throw new Error('没给网址。用法：/webpreview.get <网址>')
    let u
    try {
      u = new URL(text)
    } catch {
      throw new Error('这不是一个合法的网址（要以 http:// 或 https:// 开头）')
    }
    if (!/^https?:$/.test(u.protocol)) throw new Error(`只支持 http / https 网址，不支持 ${u.protocol}`)
    const host = u.hostname
    if (blockedByConfig(host)) throw new Error(`这个域名在黑名单里（${host}），不预览`)
    if (cfg.allowPrivateHosts) return u
    if (isPrivateHostLiteral(host)) throw new Error(`这个地址指向本机或内网（${host}），已拒绝 —— 这是防 SSRF 的硬规则`)
    let addrs = []
    try {
      addrs = await dns.lookup(host, { all: true, verbatim: true })
    } catch (e) {
      throw new Error(`域名解析失败（${host}）：${e.code || e.message}`)
    }
    if (!addrs.length) throw new Error(`域名解析不到地址（${host}）`)
    const bad = addrs.find((a) => isPrivateHostLiteral(a.address))
    if (bad) throw new Error(`这个域名解析到了内网地址（${host} → ${bad.address}），已拒绝`)
    return u
  }

  // ---------------------------------------------------------------- 渲染核心

  function assertPuppeteer() {
    const pp = ctx.puppeteer
    if (!pp || typeof pp.page !== 'function') {
      throw new Error('没找到 ctx.puppeteer：请先启用 koishi-plugin-puppeteer')
    }
    return pp
  }

  async function hasPuppeteer() {
    return !!ctx.puppeteer && typeof ctx.puppeteer.page === 'function'
  }

  /**
   * 打开网址 → 截图 + 取正文。
   * @returns {Promise<{buf: Buffer, mime: string, title: string, desc: string, text: string,
   *                     url: string, host: string, width: number, height: number, ms: number}>}
   */
  async function capture(rawUrl, opts = {}) {
    if (!cfg.enabled) throw new Error('网页预览插件已关闭')
    const pp = assertPuppeteer()
    const u = await checkUrl(rawUrl)
    const mode = opts.mode === 'full' || opts.mode === 'viewport' ? opts.mode : cfg.mode
    const width = Number(opts.viewportWidth) > 0 ? Number(opts.viewportWidth) : cfg.viewportWidth
    const dsf = Number(opts.deviceScaleFactor) > 0 ? Number(opts.deviceScaleFactor) : cfg.deviceScaleFactor
    const timeout = Number(opts.timeout) > 0 ? Number(opts.timeout) : cfg.timeout

    await acquire()
    const t0 = Date.now()
    const page = await pp.page()
    // ★ request 拦截的回调必须在 page.close 之前摘掉，否则监听器会挂在已关闭的页面上
    const onRequest = (req) => {
      try {
        const url = req.url()
        if (/^(data:|blob:|about:)/i.test(url)) return void req.continue().catch(() => {})
        let parsed
        try {
          parsed = new URL(url)
        } catch {
          return void req.abort().catch(() => {})
        }
        if (!/^https?:$/.test(parsed.protocol)) {
          debug('拦掉非 http(s) 请求：%s', url.slice(0, 120))
          return void req.abort().catch(() => {})
        }
        if (!cfg.allowPrivateHosts && isPrivateHostLiteral(parsed.hostname)) {
          logger.warn('拦掉指向内网的子请求：%s', url.slice(0, 160))
          return void req.abort().catch(() => {})
        }
        if (cfg.blockMedia && ['media'].includes(req.resourceType())) {
          return void req.abort().catch(() => {})
        }
        return void req.continue().catch(() => {})
      } catch {
        return void req.continue().catch(() => {})
      }
    }

    try {
      if (typeof page.setViewport === 'function') {
        await page.setViewport({ width, height: cfg.viewportHeight, deviceScaleFactor: dsf })
      }
      if (typeof page.setJavaScriptEnabled === 'function') {
        await page.setJavaScriptEnabled(!!cfg.allowJavaScript)
      }
      if (cfg.userAgent && typeof page.setUserAgent === 'function') await page.setUserAgent(cfg.userAgent)
      if (typeof page.setExtraHTTPHeaders === 'function') {
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' })
      }
      if (typeof page.setRequestInterception === 'function') {
        await page.setRequestInterception(true)
        page.on('request', onRequest)
      }

      let resp
      try {
        resp = await page.goto(u.href, { waitUntil: 'domcontentloaded', timeout })
      } catch (e) {
        if (/timeout/i.test(e.message)) throw new Error(`打开超时（${timeout / 1000}s）：这个站可能很慢或被墙`)
        throw new Error(`打不开这个网址：${e.message}`)
      }
      const status = resp ? resp.status() : 0

      // ★ 跳转之后再查一次 —— 否则「公网 URL 302 到 127.0.0.1」就绕过了前面所有检查
      if (!cfg.allowPrivateHosts) {
        const finalUrl = page.url()
        if (finalUrl && !/^(about:|data:)/i.test(finalUrl)) await checkUrl(finalUrl)
      }

      if (status >= 400) {
        throw new Error(
          `目标返回 HTTP ${status}` + (status === 403 || status === 429 ? '（多半是反爬/限流，无头浏览器被认出来了）' : '')
        )
      }

      if (cfg.allowJavaScript) {
        try {
          await page.waitForNetworkIdle({ idleTime: 500, timeout: cfg.idleWaitMs })
        } catch {
          /* 真实站点几乎都会等到超时，静默继续 */
        }
      }
      if (cfg.settleMs > 0) await sleep(cfg.settleMs)

      let info = { title: '', desc: '', text: '', w: width, h: cfg.viewportHeight }
      if (cfg.allowJavaScript) {
        try {
          info = await page.evaluate(() => {
            const meta = (n) => {
              const el = document.querySelector(`meta[property="${n}"], meta[name="${n}"]`)
              return el ? String(el.getAttribute('content') || '').trim() : ''
            }
            const clean = (s) =>
              String(s || '')
                .replace(/\u00a0/g, ' ')
                .replace(/[ \t]+/g, ' ')
                .replace(/\n{3,}/g, '\n\n')
                .trim()
            return {
              title: String(document.title || '').trim() || meta('og:title'),
              desc: meta('og:description') || meta('description'),
              text: clean(document.body ? document.body.innerText : ''),
              w: Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0),
              h: Math.max(
                document.documentElement.scrollHeight,
                document.body ? document.body.scrollHeight : 0
              ),
            }
          })
        } catch (e) {
          debug('取正文失败（不影响出图）：%s', e.message)
        }
      }

      // 截图：viewport = 首屏；full = 整页但截到 maxCaptureHeight 为止
      // ★ `clip` 与 `fullPage` 在 puppeteer 22 里是**互斥**的（实测报
      //   `'clip' and 'fullPage' are mutually exclusive`），所以整页模式用
      //   `clip + captureBeyondViewport` 自己裁高度。
      const clip = {
        x: 0,
        y: 0,
        width,
        height: mode === 'full' ? Math.min(Math.max(info.h || 0, cfg.viewportHeight), cfg.maxCaptureHeight) : cfg.viewportHeight,
      }

      let mime = 'image/png'
      let buf = Buffer.from(
        await page.screenshot(
          mode === 'full'
            ? { type: 'png', clip, captureBeyondViewport: true }
            : { type: 'png' }
        )
      )
      if (buf.length > cfg.maxBytes) {
        const jpg = Buffer.from(
          await page.screenshot(
            mode === 'full'
              ? { type: 'jpeg', quality: cfg.jpegQuality, clip, captureBeyondViewport: true }
              : { type: 'jpeg', quality: cfg.jpegQuality }
          )
        )
        debug('PNG %d 字节超过上限，JPEG 是 %d 字节', buf.length, jpg.length)
        if (jpg.length < buf.length) {
          buf = jpg
          mime = 'image/jpeg'
        }
      }

      const ms = Date.now() - t0
      stats.ok++
      stats.lastMs = ms
      stats.lastBytes = buf.length
      stats.lastUrl = page.url() || u.href
      debug(
        '预览完成：%s ｜ %s 模式 ｜ %d×%d ｜ 正文 %d 字符 ｜ %d 字节 ｜ %d ms',
        stats.lastUrl,
        mode,
        width,
        clip.height,
        (info.text || '').length,
        buf.length,
        ms
      )
      return {
        buf,
        mime,
        title: info.title || '',
        desc: info.desc || '',
        text: info.text || '',
        url: stats.lastUrl,
        host: hostOf(stats.lastUrl),
        width,
        height: clip.height,
        ms,
      }
    } catch (e) {
      stats.fail++
      stats.lastError = e.message
      throw e
    } finally {
      try {
        page.off?.('request', onRequest)
      } catch {}
      try {
        await page.close()
      } catch {}
      release()
    }
  }

  /** 统一的"出图 + 配文"元素组装：
   *  模型给了配文就以配文开头，否则用页面标题；第二行永远写域名（图片里看不出来的信息）。 */
  function buildElements(result, caption) {
    const head = String(caption || '').trim() || result.title || result.host
    const meta = result.host + (result.title && caption ? ` ｜ ${result.title}` : '')
    return [h('text', { content: `${head}\n${meta}\n` }), h.image(result.buf, result.mime)]
  }

  /** 给模型看的文字摘要（模型要"讲得出这页写了啥"，光有图不行） */
  function briefForModel(result, max) {
    const n = max || cfg.maxTextChars
    const text = result.text.length > n ? result.text.slice(0, n) + '\n…（正文已截断）' : result.text
    return [
      `URL：${result.url}`,
      `标题：${result.title || '(无)'}`,
      result.desc ? `摘要：${result.desc}` : '',
      `正文（浏览器渲染后，共 ${result.text.length} 字符）：`,
      text || '(正文为空：可能是画布应用、需要登录，或被反爬挡住了)',
    ]
      .filter(Boolean)
      .join('\n')
  }

  // ---------------------------------------------------------------- 服务：给别的插件/未来的结构化输出复用

  ctx.provide('chatlunaWebPreview', {
    capture,
    checkUrl,
    pickFirstUrl,
    available: hasPuppeteer,
    config: () => ({ ...cfg }),
    stats: () => ({ ...stats }),
  })

  // ---------------------------------------------------------------- ① 指令（零 API 的确定性通路）

  ctx
    .command('webpreview.get <url:string>', '把网址渲染成图片发出来（网页预览）')
    .option('full', '-f 截整页（默认只截首屏）')
    .action(async ({ session, options }, url) => {
      if (!cfg.enabled) return '网页预览插件已关闭。'
      try {
        const r = await capture(url, { mode: options?.full ? 'full' : undefined })
        stats.byCommand++
        logger.info('指令出图：%s ｜ %d 字节 ｜ %d ms', r.url, r.buf.length, r.ms)
        return buildElements(r, '')
      } catch (e) {
        logger.warn('指令预览失败（%s）：%s', url, e.message)
        return `预览失败：${e.message}`
      }
    })

  ctx
    .command('webpreview.text <url:string>', '抓一个网址的正文（浏览器渲染后，纯文字）')
    .action(async ({ session }, url) => {
      if (!cfg.enabled) return '网页预览插件已关闭。'
      try {
        const r = await capture(url, { mode: 'viewport' })
        stats.byCommand++
        // 走 page 插件那一套：长文本会被它自动换成图片（如果开着）
        return `【${r.host}】${r.title || '(无标题)'}\n${r.text.slice(0, cfg.maxTextChars) || '(正文为空)'}`
      } catch (e) {
        logger.warn('指令取正文失败（%s）：%s', url, e.message)
        return `抓取失败：${e.message}`
      }
    })

  ctx.command('webpreview.status', '看网页预览插件的状态', { authority: 3 }).action(async () => {
    return [
      `网页预览：${cfg.enabled ? '开' : '关'}｜浏览器：${(await hasPuppeteer()) ? 'ctx.puppeteer 就绪' : '**没找到 ctx.puppeteer**'}`,
      `工具 web_preview：${cfg.toolEnabled ? '开' : '关'}｜自动预览：${cfg.autoEnabled ? `开（${cfg.autoGroups.length ? cfg.autoGroups.join('、') : '所有群'}）` : '关'}`,
      `截图：${cfg.mode} 模式 · 视口 ${cfg.viewportWidth}×${cfg.viewportHeight} · ${cfg.deviceScaleFactor}x · 整页上限 ${cfg.maxCaptureHeight}px · 字节上限 ${(cfg.maxBytes / 1024).toFixed(0)} KB`,
      `页面 JS：${cfg.allowJavaScript ? '允许' : '禁止'}｜内网地址：${cfg.allowPrivateHosts ? '**允许（测试台专用！）**' : '拒绝'}｜媒体流：${cfg.blockMedia ? '拦' : '放'}`,
      `限群：${cfg.groups.length ? cfg.groups.join('、') : '不限'}｜工具冷却 ${cfg.toolCooldownSeconds}s｜自动冷却 ${cfg.autoCooldownSeconds}s｜并发 ${active}/${cfg.maxConcurrent}`,
      `累计成功 ${stats.ok} / 失败 ${stats.fail}（指令 ${stats.byCommand} · 工具 ${stats.byTool} · 自动 ${stats.byAuto}）`,
      `上次：${stats.lastMs} ms、${(stats.lastBytes / 1024).toFixed(1)} KB${stats.lastUrl ? `（${hostOf(stats.lastUrl)}）` : ''}`,
      stats.lastError ? `上次失败原因：${stats.lastError}` : '',
    ]
      .filter(Boolean)
      .join('\n')
  })

  ctx
    .command('webpreview.test <url:string>', '预览自检：走完整链路抓一个网址（不经过模型）', { authority: 3 })
    .action(async ({ session }, url) => {
      const target = url || 'https://example.com'
      try {
        const r = await capture(target, { mode: 'viewport' })
        if (session) await session.send([h.image(r.buf, r.mime)])
        return `自检通过：${r.host} ｜ ${r.title || '(无标题)'} ｜ ${(r.buf.length / 1024).toFixed(1)} KB ｜ ${r.ms} ms`
      } catch (e) {
        return `自检失败：${e.message}`
      }
    })

  // ---------------------------------------------------------------- ② 工具：模型自己调

  if (cfg.toolEnabled) {
    ctx.inject(['chatluna'], (ctx2) => {
      const platform = ctx2.chatluna?.platform
      if (!platform || typeof platform.registerTool !== 'function') {
        logger.warn('platform.registerTool 不可用，web_preview 工具未注册')
        return
      }

      const desc =
        '打开一个真实网址，把页面**渲染后的样子截成图片**发到当前会话，同时把页面正文返回给你。' +
        '什么时候用：群友给了一个链接而你确实需要"看看这页写了什么/长什么样"；' +
        '或者用 web_browse 抓不到正文时（那说明是 JS 渲染的站，这里带浏览器，能渲染出来）。' +
        '什么时候不要用：链接一眼就知道内容、或者只是闲聊提到网址 —— 每次预览都要起浏览器，很贵。' +
        '普通聊天不要用它。一次回复里最多调一次。'

      let toolFactory = null
      try {
        toolFactory = require('@langchain/core/tools').tool
      } catch (e) {
        logger.warn('拿不到 @langchain/core/tools，web_preview 未注册：%s', e.message)
        return
      }
      const z = require('zod')

      const lastToolAt = new Map()

      platform.registerTool('web_preview', {
        selector: () => true,
        // ★ ChatLuna 会用它过滤"这个会话看得见哪些工具"（llm-core/agent/index.cjs:1687）。
        //   不限群（cfg.groups 为空）就永远可见；填了群号就只有那些群能看见。
        authorization: (session) => {
          if (!cfg.enabled) return false
          if (!cfg.groups || !cfg.groups.length) return true
          const gid = session?.guildId ?? session?.channelId ?? ''
          return cfg.groups.map(String).includes(String(gid))
        },
        description: desc,
        createTool: () =>
          toolFactory(
            async (input, runnableConfig) => {
              const session = runnableConfig?.configurable?.session
              const url = cleanUrlText(input?.url)
              const caption = typeof input?.caption === 'string' ? input.caption.trim() : ''
              const full = !!input?.full
              if (!url) return '没给网址。请用文字回答，或补上 url 再调一次。'

              // 群闸门（authorization 已经过滤过一次，这里再兜一次底：模型可能拿到别的会话的 schema）
              const gid = String(session?.guildId ?? session?.channelId ?? '')
              if (cfg.groups?.length && !cfg.groups.map(String).includes(gid)) {
                return '当前会话不允许网页预览，请直接用文字回答。'
              }

              const now = Date.now()
              const last = lastToolAt.get(gid) || 0
              const gap = now - last
              if (gap < cfg.toolCooldownSeconds * 1000) {
                return `刚刚才预览过一次（${Math.round(gap / 1000)}s 前），${
                  cfg.toolCooldownSeconds - Math.round(gap / 1000)
                }s 后才能再来。请直接用文字回答，不要重复调用。`
              }
              if (!session) return '拿不到当前会话，图片发不出去。请改用文字回复。'

              lastToolAt.set(gid, now)
              try {
                const r = await capture(url, { mode: full ? 'full' : undefined })
                stats.byTool++
                logger.info(
                  'web_preview 被模型调用：%s ｜ %s ｜ %d 字节 ｜ %d ms（%s）',
                  r.url,
                  r.title || '(无标题)',
                  r.buf.length,
                  r.ms,
                  gid || '?'
                )
                await session.send(buildElements(r, caption))
                return (
                  `已经把「${r.title || r.host}」渲染成图片发到当前会话${caption ? `（配文：${caption}）` : ''}。` +
                  '不要再重复发送同一张图。\n\n' +
                  briefForModel(r)
                )
              } catch (e) {
                stats.fail++
                logger.warn('web_preview 失败（%s）：%s', url, e.message)
                lastToolAt.delete(gid) // 失败不该占冷却，让模型能换个网址重试
                return `网页预览失败（${e.message}）。请用文字回答，不要反复重试同一个网址。`
              }
            },
            {
              name: 'web_preview',
              description: desc,
              schema: z.object({
                url: z.string().describe('要预览的完整网址（http:// 或 https:// 开头）'),
                caption: z.string().optional().describe('可选：图片前面配一句话'),
                full: z.boolean().optional().describe('可选：true = 截整页（默认只截首屏）'),
              }),
            }
          ),
      })

      logger.info('web_preview 工具已注册（模型可自己决定"这个链接截个图看看"）')
    })
  }

  // ---------------------------------------------------------------- ③ 自动预览（默认关）

  const autoLastAt = new Map()

  ctx.on('message', async (session) => {
    if (!cfg.enabled || !cfg.autoEnabled || !session) return
    // 自己的消息不预览（reportSelfMessage=false 时根本收不到，这里兜个底）
    if (session.userId && session.userId === session.selfId) return
    const gid = String(session.guildId ?? '')
    if (cfg.autoGroups?.length && !cfg.autoGroups.map(String).includes(gid)) return
    const content = String(session.content || '')
    if (!content) return
    if (cfg.autoIgnorePrefixes.some((p) => p && content.startsWith(p))) return
    const url = pickFirstUrl(content)
    if (!url) return
    // 只认"这一条里除了链接没别的东西/或者链接就是主角"的情形，避免把聊天里夹的链接都抓一遍
    const now = Date.now()
    if (now - (autoLastAt.get(gid) || 0) < cfg.autoCooldownSeconds * 1000) {
      debug('自动预览冷却中，跳过 %s', url)
      return
    }
    autoLastAt.set(gid, now)
    try {
      const r = await capture(url, { mode: 'viewport' })
      stats.byAuto++
      logger.info('自动预览出图：%s ｜ %d 字节 ｜ %d ms（群 %s）', r.url, r.buf.length, r.ms, gid || '私聊')
      await session.send([h.image(r.buf, r.mime)])
    } catch (e) {
      // ★ 自动预览失败**必须安静**：群里没人要它做这件事，报错就是刷屏
      logger.warn('自动预览失败（%s）：%s', url, e.message)
    }
  })

  // ---------------------------------------------------------------- 启动自检

  ctx.inject(['puppeteer'], () => {
    logger.info('网页预览服务已就绪（ctx.puppeteer 可用）')
    // ★ 代理这件事很容易被忽略，而"网页预览"恰恰是最依赖外网的功能：
    //   koishi-plugin-puppeteer 的启动代码里写着 —— 若 `ctx.http.config.proxyAgent` 存在，
    //   它会**自动**追加 `--proxy-server=<那个代理>` 当浏览器启动参数（src/index.ts:37-41）。
    //   本机实测：不加也能打开 example.com / baidu（走系统代理），但**配了更稳**。
    //   这里只负责"把事实说出来"，不去改别人的配置。
    const proxy = ctx.http?.config?.proxyAgent
    if (proxy) {
      logger.info('浏览器会经代理出网（koishi-plugin-puppeteer 自动加的 --proxy-server=%s）', proxy)
    } else {
      logger.info(
        '没检测到全局 http 代理（proxy-agent 段为空）—— 浏览器将走系统代理/直连。' +
          '若预览外网站点大面积超时，就在 puppeteer 配置里显式加 args: ["--proxy-server=http://127.0.0.1:7890"]'
      )
    }
  })

  logger.info(
    '网页预览已挂载（指令 webpreview.get/.text/.status；工具 %s；自动预览 %s；内网地址 %s）',
    cfg.toolEnabled ? '开' : '关',
    cfg.autoEnabled ? `开（${cfg.autoGroups.length ? cfg.autoGroups.join('、') : '所有群'}）` : '关',
    cfg.allowPrivateHosts ? '★ 允许（测试台专用）' : '拒绝'
  )

  if (cfg.allowPrivateHosts) {
    logger.warn('★ allowPrivateHosts = true：任何能发消息的人都能让机器人去访问本机/内网服务（SSRF）。只应在测试实例里出现')
  }
}

module.exports = { name, inject, Config, apply }
module.exports.isPrivateHostLiteral = isPrivateHostLiteral
module.exports.isPrivateIPv4 = isPrivateIPv4
module.exports.isPrivateIPv6 = isPrivateIPv6
module.exports.cleanUrlText = cleanUrlText
module.exports.pickFirstUrl = pickFirstUrl
