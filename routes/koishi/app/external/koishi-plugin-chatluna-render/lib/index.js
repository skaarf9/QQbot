/**
 * koishi-plugin-chatluna-render —— 结构化信息渲染（HTML / Markdown → 图片）
 *
 * 需求（用户原话）：
 *   「想装一个 bot 展示结构化信息的插件，比如展示一部分 html 页面，bot 自己将 html 代码
 *     渲染成图片然后发送出来，又或者是 md 文件转成图片发送出来（解决 QQ 中无法发送
 *     美观的结构化信息问题）。这一条的功能理应由逻辑代码实现，llm 可能可以调用这个功能，
 *     但它不参与实现……这个功能插件市场很有可能已经有了，看看能否适配我们未来的结构化
 *     输出方案，让 ai 也能当成 mcp 调用。」
 *
 * ★ 按 [硬约束 第 0 条](../../../../docs/05-硬约束.md)「先本地 → 再市场 → 最后自写」的结论：
 *   - **本地已装**：无。
 *   - **市场**：渲染"能力"市场里有，而且更成熟——
 *       · `koishi-plugin-puppeteer`   ← **本插件直接复用它提供的 `ctx.puppeteer` 服务**
 *       · `koishi-plugin-shotkit`     ← 不用浏览器的替代（同为 `ctx.puppeteer` 同形 API）
 *       · `koishi-plugin-chatluna-image-renderer` ← 官方的"**把整条回复**渲染成图"的输出模式
 *     但它们都**没有一个"给模型调用的工具"**，也不认"结构化输出里的 type 字段"。
 *   - **自写**：所以这里只写**最薄的一层适配**——不重新实现渲染，只做：
 *       ① 把 `ctx.puppeteer` 包成一个稳定的服务 `ctx.chatlunaRender`
 *       ② 注册 ChatLuna 工具 `render_image`（模型可以自己决定"这段该出图"）
 *       ③ 提供"回复里的渲染块"适配（`%%render:html` … `%%endrender`），
 *          这就是给**未来结构化输出**留的接口：模型吐结构化数据 →
 *          只要里面有 type=html/markdown 的段，这里直接渲染成图发出去。
 *
 * ★ 安全（内容来自模型，模型受用户影响，必须当成不可信输入）：
 *   - 默认**关掉页面 JS**（`allowJavaScript: false`）
 *   - 默认**拦截所有外网请求**（`allowRemoteResources: false`，只放行 data:/about:）
 *     —— 防止模型用一张图去 SSRF 打内网，或把整页 CDN 拉一遍拖慢渲染
 *   - 内容长度上限 `maxContentChars`
 *
 * ★ 与既有两个出站插件的关系（都在 `before-send`）：
 *   - `chatluna-guard` 是"总闸"（屏蔽 + 令牌桶）：本插件渲染出来的图**同样**会经过它，
 *     所以出图天然受限流约束，不需要自己再造一套。
 *   - `chatluna-replyshaper` 是"整形"：它只动文本元素，图片元素原样保留，二者不冲突。
 */

const { Schema, Logger, h } = require('koishi')

const name = 'chatluna-render'
const inject = { required: [], optional: ['puppeteer', 'chatluna'] }
const logger = new Logger('chatluna-render')

// marked 是"把 markdown 变 HTML"的活。宿主里已经有（console 的传递依赖），
// 拿不到就退化成"只做最小转义"的纯文本模式，不让插件整体挂掉。
let marked = null
try {
  marked = require('marked')
  if (typeof marked.marked?.parse === 'function') marked = marked.marked
  else if (typeof marked.parse !== 'function') marked = null
} catch {
  logger.warn('没装 marked，Markdown 渲染会退化成纯文本（只是少了排版，不影响出图）')
}

// ------------------------------------------------------------------ 内置样式
// 浅色底 + 深色字（与前端主题无关，图片是给别人看的，浅色最通用）
const BASE_CSS = `
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:#ffffff;color:#1f2328;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei","PingFang SC",sans-serif;
  font-size:15px;line-height:1.7;-webkit-font-smoothing:antialiased}
body{padding:18px 20px;width:100%}
h1,h2,h3,h4{margin:.9em 0 .45em;line-height:1.3;font-weight:700}
h1{font-size:1.5em;border-bottom:1px solid #d8dee4;padding-bottom:.3em}
h2{font-size:1.28em;border-bottom:1px solid #eaeef2;padding-bottom:.25em}
h3{font-size:1.12em}h4{font-size:1em}
p{margin:.55em 0}
ul,ol{margin:.55em 0;padding-left:1.6em}
li{margin:.2em 0}
a{color:#0969da;text-decoration:none}
code{background:#f0f2f5;padding:.15em .4em;border-radius:5px;font-size:.9em;
  font-family:ui-monospace,SFMono-Regular,Consolas,"Courier New",monospace}
pre{background:#f6f8fa;border:1px solid #e4e8ee;border-radius:8px;padding:12px 14px;overflow:auto}
pre code{background:none;padding:0;font-size:.88em;line-height:1.55}
blockquote{margin:.6em 0;padding:.2em 1em;color:#59636e;border-left:4px solid #d0d7de;background:#fafbfc}
table{border-collapse:collapse;margin:.7em 0;width:100%}
th,td{border:1px solid #d0d7de;padding:7px 11px;text-align:left}
th{background:#f6f8fa;font-weight:600}
tr:nth-child(even) td{background:#fcfcfd}
hr{border:none;border-top:1px solid #d8dee4;margin:1.1em 0}
img{max-width:100%}
.kv{display:flex;flex-wrap:wrap;gap:8px}
`

const Config = Schema.intersect([
  Schema.object({
    enabled: Schema.boolean().default(true).description('总开关'),
    toolEnabled: Schema.boolean()
      .default(true)
      .description('注册 `render_image` 工具，让模型自己决定"这段话该出图"'),
    blockEnabled: Schema.boolean()
      .default(false)
      .description(
        '★ 结构化输出适配（默认关）：模型回复里出现 `%%render:html` … `%%endrender` 时，' +
          '把中间的内容渲染成图片替换掉。默认关是为了不改现有聊天行为，' +
          '等结构化输出方案定了再打开。'
      ),
    blockStart: Schema.string().default('%%render:').description('渲染块起始标记（后面紧接 html 或 markdown）'),
    blockEnd: Schema.string().default('%%endrender').description('渲染块结束标记'),
    maxBlocksPerMessage: Schema.natural().default(2).description('一条回复里最多渲染几块（防刷屏）'),
  }),
  Schema.object({
    viewportWidth: Schema.natural().default(880).description('渲染视口宽度（px），最终宽度 = 它 × deviceScaleFactor'),
    viewportHeight: Schema.natural()
      .default(10)
      .description(
        '★ 视口高度只用来给 fullPage 截图定个「下限」，默认 10 = **贴着内容收边**。' +
          '实测（.scratch/bench-render3.cjs）：短页面从 1320×1350 收到 1320×437，' +
          '长页面（1962px）完全不受影响 —— fullPage 只会向下扩展，不会向上缩。' +
          '以前固定 900，导致每张短图下面拖着约 900px 空白。' +
          '只有当页面用了 `height:100vh` 这类依赖视口的布局时，才需要把它调回 900'
      ),
    deviceScaleFactor: Schema.number().min(1).max(4).default(2).description('像素密度，2 = 高清（图片清晰度）'),
    maxContentChars: Schema.natural().default(30000).description('单次渲染内容字符上限，超了直接拒绝'),
    timeout: Schema.natural().default(30000).description('渲染超时（毫秒）'),
    allowJavaScript: Schema.boolean()
      .default(false)
      .description('是否允许页面执行 JS。★ 内容来自模型，默认关掉最安全（要跑图表库才需要开）'),
    allowRemoteResources: Schema.boolean()
      .default(false)
      .description('是否允许页面加载外部资源（CDN/CSS/图片）。默认关，防止模型用渲染去打内网'),
    extraCss: Schema.string().role('textarea').default('').description('追加的 CSS，用来统一出图风格'),
  }),
  Schema.object({
    debug: Schema.boolean().default(false).description('打印每次渲染的耗时与尺寸'),
  }),
])

function apply(ctx, config) {
  const cfg = {
    enabled: true,
    toolEnabled: true,
    blockEnabled: false,
    blockStart: '%%render:',
    blockEnd: '%%endrender',
    maxBlocksPerMessage: 2,
    viewportWidth: 880,
    viewportHeight: 10,
    deviceScaleFactor: 2,
    maxContentChars: 30000,
    timeout: 30000,
    allowJavaScript: false,
    allowRemoteResources: false,
    extraCss: '',
    debug: false,
    ...(config ?? {}),
  }

  const log = (...a) => cfg.debug && logger.info(...a)

  // 统计（给 /render.status 看）
  const stats = { ok: 0, fail: 0, lastMs: 0, lastBytes: 0 }

  // ---------------------------------------------------------------- 渲染核心

  /** 把内容包成一个完整 HTML 文档
   *
   *  ★ 第三参 `extraCss` 是给 `chatluna-page` 用的（2026-10-03 加）：页面类输出要自己
   *    的一套徽章/表格样式，但又不想污染 `render_image` 工具出图的风格。传空 = 完全一样。
   *
   *  ★ 第四参 `breaks`：把**单个换行**当成硬换行（GFM 的 `<br>`）。
   *    默认 false = CommonMark 行为 —— 一个 `\n` 会被折成一个空格，整段挤成一行。
   *    `chatluna-page` 传 true，因为指令的状态输出是「一行一条」，折平之后完全没法读。
   */
  function buildHtml(kind, content, extraCss, breaks) {
    const css = BASE_CSS + (cfg.extraCss || '') + (extraCss || '')

    if (kind === 'html') {
      // 已经是完整文档就原样用，只补样式
      if (/<html[\s>]/i.test(content)) {
        return /<\/head>/i.test(content)
          ? content.replace(/<\/head>/i, `<style>${css}</style></head>`)
          : content.replace(/<html([^>]*)>/i, `<html$1><head><style>${css}</style></head>`)
      }
      // 片段 → 塞进 body
      return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${content}</body></html>`
    }

    // markdown
    let body
    if (marked) {
      try {
        body = marked.parse(content, { async: false, breaks: !!breaks })
      } catch (e) {
        logger.warn('Markdown 解析失败，按纯文本渲染：%s', e.message)
        body = `<pre>${escapeHtml(content)}</pre>`
      }
    } else {
      body = `<pre>${escapeHtml(content)}</pre>`
    }
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${body}</body></html>`
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
  }

  /** 渲染成 PNG Buffer；失败抛错
   *
   *  ★ 第三参 `opts`（2026-10-03 加，**完全向后兼容**，不传就是老行为）：
   *    - `viewportWidth` / `deviceScaleFactor` / `timeout`：覆盖单次渲染的参数。
   *      `chatluna-page` 用它把「指令帮助页」降到 1.5x —— 实测 40 行表格
   *      2.0x 是 836 KB、1.5x 是 644 KB，而 1.5x 在手机上已经足够清晰。
   *    - `css`：给这一次渲染追加减样式。
   */
  async function renderToBuffer(kind, content, opts = {}) {
    if (!cfg.enabled) throw new Error('渲染插件已关闭')
    const pp = ctx.puppeteer
    if (!pp || typeof pp.page !== 'function') {
      throw new Error('没找到 ctx.puppeteer：请先启用 koishi-plugin-puppeteer（或同形渲染服务）')
    }
    if (typeof content !== 'string' || !content.trim()) throw new Error('内容为空')
    if (content.length > cfg.maxContentChars) {
      throw new Error(`内容太长（${content.length} > ${cfg.maxContentChars} 字符），先精简一下`)
    }

    const width = Number(opts.viewportWidth) > 0 ? Number(opts.viewportWidth) : cfg.viewportWidth
    const dsf = Number(opts.deviceScaleFactor) > 0 ? Number(opts.deviceScaleFactor) : cfg.deviceScaleFactor
    const timeout = Number(opts.timeout) > 0 ? Number(opts.timeout) : cfg.timeout
    const vpHeight = Number(opts.viewportHeight) > 0 ? Number(opts.viewportHeight) : cfg.viewportHeight

    const k = kind === 'markdown' ? 'markdown' : 'html'
    const html = buildHtml(k, content, opts.css, opts.breaks)
    const t0 = Date.now()
    const page = await pp.page()
    try {
      if (typeof page.setViewport === 'function') {
        await page.setViewport({ width, height: vpHeight, deviceScaleFactor: dsf })
      }
      if (!cfg.allowJavaScript && typeof page.setJavaScriptEnabled === 'function') {
        await page.setJavaScriptEnabled(false)
      }
      if (!cfg.allowRemoteResources && typeof page.setRequestInterception === 'function') {
        await page.setRequestInterception(true)
        page.on('request', (req) => {
          const u = String(req.url() || '')
          if (/^(data:|about:)/i.test(u) || u === '') return req.continue().catch(() => {})
          return req.abort().catch(() => {})
        })
      }
      await page.setContent(html, { waitUntil: 'load', timeout })
      // 等字体就绪，否则中文偶尔会缺字形
      try {
        await page.evaluate(() => (document.fonts ? document.fonts.ready : true))
      } catch {}
      const shot = await page.screenshot({ type: 'png', fullPage: true })
      const buf = Buffer.isBuffer(shot) ? shot : Buffer.from(shot)
      stats.ok++
      stats.lastMs = Date.now() - t0
      stats.lastBytes = buf.length
      log('渲染完成：%s / %d 字符 → %d 字节，耗时 %d ms', k, content.length, buf.length, stats.lastMs)
      return buf
    } catch (e) {
      stats.fail++
      throw e
    } finally {
      try {
        await page.close()
      } catch {}
    }
  }

  /** 渲染成可直接发送的图片元素（opts 同 renderToBuffer） */
  async function renderElement(kind, content, opts) {
    const buf = await renderToBuffer(kind, content, opts)
    return h.image(buf, 'image/png')
  }

  // 给别的插件（未来的结构化输出链）复用的稳定接口
  ctx.provide('chatlunaRender', {
    renderToBuffer,
    renderElement,
    buildHtml,
    available: () => !!ctx.puppeteer && typeof ctx.puppeteer.page === 'function',
    config: () => ({ ...cfg }),
    stats: () => ({ ...stats }),
  })

  // ---------------------------------------------------------------- ① 工具：模型自己调

  if (cfg.toolEnabled) {
    ctx.inject(['chatluna'], (ctx2) => {
      const platform = ctx2.chatluna?.platform
      if (!platform || typeof platform.registerTool !== 'function') {
        logger.warn('platform.registerTool 不可用，render_image 工具未注册')
        return
      }

      const desc =
        '把一段 HTML 或 Markdown 渲染成一张图片发出去。' +
        'QQ 里发不了好看的结构化东西（表格、卡片、代码块、榜单、对比表），这时候就用它：' +
        '你写 HTML/Markdown，bot 会渲染成图直接发到当前会话。' +
        'kind=markdown 适合表格/列表/代码/公式外的文档；kind=html 适合要精细排版的卡片、榜单、对比图。' +
        '普通聊天**不要**用它——只在你确实要把一段结构化信息"漂亮地"呈现出来时才调用。' +
        '渲染出来的图片会走正常发送通道（受限流约束），所以别在一个回合里连调很多次。'

      let toolFactory = null
      try {
        toolFactory = require('@langchain/core/tools').tool
      } catch (e) {
        logger.warn('拿不到 @langchain/core/tools，render_image 未注册：%s', e.message)
        return
      }
      const z = require('zod')

      platform.registerTool('render_image', {
        selector: () => true,
        description: desc,
        createTool: () =>
          toolFactory(
            async (input, runnableConfig) => {
              const session = runnableConfig?.configurable?.session
              const kind = input?.kind === 'markdown' ? 'markdown' : 'html'
              const content = String(input?.content ?? '')
              const caption = typeof input?.caption === 'string' ? input.caption.trim() : ''

              if (!content.trim()) return '内容为空，没有渲染。请用文字回复，或补上内容再调用一次。'

              try {
                // ★ 用 renderToBuffer 而不是 renderElement：要拿到真实字节数才能记日志。
                //   （第一版写的是 `el.attrs.file.length`，实测打出来永远是 0 —— `h.image(buf)`
                //    把 Buffer 放在 `attrs.src` 上，`file` 是 OneBot 编码时才有的东西。rig 50 踩到）
                const buf = await renderToBuffer(kind, content)
                const el = h.image(buf, 'image/png')
                const payload = caption ? [h('text', { content: caption + '\n' }), el] : [el]
                if (!session) {
                  // 拿不到会话时不能丢东西：把失败讲清楚，让模型自己用文字兜底
                  return '拿不到当前会话，图片发不出去。请改用文字回复。'
                }
                // ★ 这一行是给"模型到底会不会用这个工具"留的证据（2026-10-03 第四轮）。
                //   出图本身由 page 的图片库和这里的 renderToBuffer 各自记日志，但**没有一行**
                //   能说明"这次是模型自己决定的"。上线后要回答"AI 能自己出图吗"，就看它。
                logger.info(
                  'render_image 被模型调用：%s / %d 字符 → %d 字节（%s）',
                  kind,
                  content.length,
                  buf.length,
                  session.channelId ?? session.userId ?? '?'
                )
                await session.send(payload)
                return `已经把${kind === 'markdown' ? ' Markdown' : ' HTML'} 渲染成图片发到当前会话${caption ? `（配文：${caption}）` : ''}。不要再重复发送同一张图。`
              } catch (e) {
                stats.fail++
                logger.warn('render_image 失败：%s', e.message)
                return `渲染失败（${e.message}）。请直接用文字回复，不要重试同一段内容。`
              }
            },
            {
              name: 'render_image',
              description: desc,
              schema: z.object({
                kind: z
                  .enum(['html', 'markdown'])
                  .describe('渲染类型：markdown 或 html。拿不准就用 markdown'),
                content: z.string().describe('要渲染的内容本体（markdown 源文，或 HTML 片段/完整文档）'),
                caption: z.string().optional().describe('可选：图片前面配一句话'),
              }),
            }
          ),
      })

      logger.info('render_image 工具已注册（模型可自己决定把结构化内容渲染成图）')
    })
  }

  // ---------------------------------------------------------------- ② 回复里的渲染块（结构化输出适配）

  /** 把一段文本按 `%%render:kind` … `%%endrender` 切成 [文本 | 待渲染段] 列表 */
  function splitBlocks(text) {
    const out = []
    let rest = String(text)
    let guard = 0
    const startTag = cfg.blockStart
    while (guard++ < 10) {
      const i = rest.indexOf(startTag)
      if (i < 0) break
      const nl = rest.indexOf('\n', i)
      if (nl < 0) break
      const kind = rest.slice(i + startTag.length, nl).trim().toLowerCase()
      const j = rest.indexOf(cfg.blockEnd, nl)
      if (j < 0) break
      const body = rest.slice(nl + 1, j)
      const before = rest.slice(0, i)
      if (before.trim()) out.push({ type: 'text', text: before })
      out.push({ type: 'render', kind: kind === 'html' ? 'html' : 'markdown', content: body })
      rest = rest.slice(j + cfg.blockEnd.length)
    }
    if (rest.trim()) out.push({ type: 'text', text: rest })
    return out
  }

  const textOf = (el) => (el?.type === 'text' ? String(el?.attrs?.content ?? '') : null)

  ctx.on('before-send', async (session) => {
    if (!cfg.enabled || !cfg.blockEnabled || !session) return
    try {
      const els = session.elements
      if (!Array.isArray(els) || els.length === 0) return

      const anyBlock = els.some((el) => {
        const t = textOf(el)
        return t !== null && t.includes(cfg.blockStart)
      })
      if (!anyBlock) return

      const next = []
      let blocks = 0
      for (const el of els) {
        const t = textOf(el)
        if (t === null) {
          next.push(el)
          continue
        }
        if (!t.includes(cfg.blockStart)) {
          next.push(el)
          continue
        }
        const parts = splitBlocks(t)
        for (const p of parts) {
          if (p.type === 'text') {
            next.push(h('text', { content: p.text }))
            continue
          }
          if (blocks >= cfg.maxBlocksPerMessage) {
            // 超量：原样保留（宁可丑，也不要丢内容）
            next.push(h('text', { content: `${cfg.blockStart}${p.kind}\n${p.content}\n${cfg.blockEnd}` }))
            continue
          }
          blocks++
          try {
            next.push(await renderElement(p.kind, p.content))
            log('渲染块已出图（%s，%d 字符）', p.kind, p.content.length)
          } catch (e) {
            logger.warn('渲染块出图失败（保留原文）：%s', e.message)
            next.push(h('text', { content: p.content }))
          }
        }
      }
      if (!blocks) return
      session.elements = next
    } catch (e) {
      logger.warn('渲染块处理出错（放行原样）：%s', e.message)
    }
  })

  // ---------------------------------------------------------------- 指令（英文点号命名）

  ctx
    .command('render.status', '看渲染插件的状态', { authority: 3 })
    .action(() => {
      const available = !!ctx.puppeteer && typeof ctx.puppeteer.page === 'function'
      return [
        `渲染：${cfg.enabled ? '开' : '关'}｜puppeteer 服务：${available ? '就绪' : '**没找到**'}`,
        `工具 render_image：${cfg.toolEnabled ? '开' : '关'}｜渲染块（结构化输出）：${cfg.blockEnabled ? '开' : '关'}`,
        `视口 ${cfg.viewportWidth}px × ${cfg.deviceScaleFactor}x｜内容上限 ${cfg.maxContentChars} 字符`,
        `页面 JS：${cfg.allowJavaScript ? '允许' : '禁止'}｜外部资源：${cfg.allowRemoteResources ? '允许' : '禁止'}`,
        `Markdown 解析：${marked ? 'marked 就绪' : '没装 marked（退化为纯文本）'}`,
        `累计成功 ${stats.ok} / 失败 ${stats.fail}｜上次 ${stats.lastMs} ms、${(stats.lastBytes / 1024).toFixed(1)} KB`,
      ].join('\n')
    })

  ctx
    .command('render.test [kind:string] [content:text]', '渲染一张测试图（验证渲染链路）', { authority: 3 })
    .action(async ({ session }, kind, content) => {
      const k = kind === 'html' ? 'html' : 'markdown'
      const demoMd = [
        '# 渲染自检',
        '',
        '| 项目 | 结果 |',
        '| --- | --- |',
        '| HTML | 支持 |',
        '| Markdown | 支持 |',
        '',
        '```js',
        'console.log("hello")',
        '```',
      ].join('\n')
      const body = content && content.trim() ? content : k === 'markdown' ? demoMd : '<h1>渲染自检</h1><p>HTML 通路正常。</p>'
      try {
        const el = await renderElement(k, body)
        if (session) {
          await session.send(el)
          return '已发送渲染自检图。'
        }
        return '渲染成功（但没有会话可发）。'
      } catch (e) {
        return `渲染失败：${e.message}`
      }
    })

  // puppeteer 是可选依赖：它可能比本插件晚就绪，就绪时再报一次，避免启动日志误导
  ctx.inject(['puppeteer'], () => {
    logger.info('渲染服务已就绪（ctx.puppeteer 可用）')
  })

  logger.info(
    '结构化渲染已挂载（工具 %s；渲染块 %s；Markdown %s）',
    cfg.toolEnabled ? '开' : '关',
    cfg.blockEnabled ? '开' : '关',
    marked ? 'marked' : '纯文本'
  )
}

module.exports = { name, inject, Config, apply }
