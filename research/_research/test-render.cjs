/**
 * 渲染链路实测：完全照抄 external/koishi-plugin-chatluna-render 的渲染步骤，
 * 用本机 Edge 跑一遍，验证：
 *   1. puppeteer-core + Edge 能否启动
 *   2. marked 解析 markdown
 *   3. 请求拦截（禁外网）不影响内联内容
 *   4. fullPage 截图产出多大、耗时多少
 * 产出：_research/render-out/*.png
 */
const fs = require('fs')
const path = require('path')
const NM = path.join(__dirname, '..', 'koishi-app', 'node_modules')
const puppeteer = require(path.join(NM, 'puppeteer-core'))
const finder = require(path.join(NM, 'puppeteer-finder'))

const OUT = path.join(__dirname, 'render-out')
fs.mkdirSync(OUT, { recursive: true })

// 直接从插件源码里抠出 BASE_CSS，保证测的就是线上那套样式
const pluginSrc = fs.readFileSync(
  path.join(__dirname, '..', 'koishi-app', 'external', 'koishi-plugin-chatluna-render', 'lib', 'index.js'),
  'utf8'
)
const m = /const BASE_CSS = `([\s\S]*?)`\n/.exec(pluginSrc)
if (!m) throw new Error('没抠到 BASE_CSS')
const BASE_CSS = m[1]

let marked = require(path.join(__dirname, '..', 'koishi-app', 'node_modules', 'marked'))
marked = marked.marked || marked

const MD_DOC = [
  '# 星源的能力清单',
  '',
  '这张图由 **bot 自己渲染**，不是模型画的。',
  '',
  '| 能力 | 状态 | 备注 |',
  '| --- | --- | --- |',
  '| 识图 | ✅ | 免费视觉模型 |',
  '| 长期记忆 | ⚠️ | 图谱还是空的 |',
  '| 结构化渲染 | ✅ | 就是你现在看的这张 |',
  '',
  '```js',
  'const x = 1 + 1  // 代码块也支持',
  '```',
  '',
  '> 引用块：QQ 里发不了这种排版，只能出图。',
  '',
  '- 列表项一',
  '- 列表项二',
].join('\n')

const HTML_DOC = `<div style="padding:6px 0">
  <h2 style="margin-top:0">对比卡片</h2>
  <table><tr><th>方案</th><th>价格</th><th>额度</th></tr>
  <tr><td>v4-flash-vision-exp</td><td>$0.15/$0.60</td><td>51,300/月</td></tr>
  <tr><td>v4.1-flash</td><td>$0.15/$0.60</td><td>154,000/月</td></tr></table>
</div>`

function buildHtml(kind, content) {
  const css = BASE_CSS
  if (kind === 'html') {
    if (/<html[\s>]/i.test(content)) return content
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${content}</body></html>`
  }
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${marked.parse(content, { async: false })}</body></html>`
}

async function render(browser, kind, content, name) {
  const html = buildHtml(kind, content)
  const page = await browser.newPage()
  const t0 = Date.now()
  try {
    await page.setViewport({ width: 880, height: 900, deviceScaleFactor: 2 })
    await page.setJavaScriptEnabled(false)
    await page.setRequestInterception(true)
    let aborted = 0
    page.on('request', (req) => {
      const u = String(req.url() || '')
      if (/^(data:|about:)/i.test(u) || u === '') return req.continue().catch(() => {})
      aborted++
      return req.abort().catch(() => {})
    })
    await page.setContent(html, { waitUntil: 'load', timeout: 30000 })
    try {
      await page.evaluate(() => (document.fonts ? document.fonts.ready : true))
    } catch {}
    const shot = await page.screenshot({ type: 'png', fullPage: true })
    const buf = Buffer.isBuffer(shot) ? shot : Buffer.from(shot)
    const f = path.join(OUT, name + '.png')
    fs.writeFileSync(f, buf)
    const dim = await page.evaluate(() => ({
      w: document.body.scrollWidth,
      h: document.body.scrollHeight,
    }))
    console.log(
      `✔ ${name.padEnd(10)} ${String(buf.length).padStart(7)} 字节  ${String(Date.now() - t0).padStart(4)} ms  内容 ${dim.w}×${dim.h}  被拦外网请求 ${aborted}`
    )
    return f
  } finally {
    await page.close()
  }
}

;(async () => {
  const exe = typeof finder === 'function' ? finder() : finder.default()
  console.log('浏览器:', exe)
  const browser = await puppeteer.launch({ headless: true, executablePath: exe, args: [] })
  try {
    await render(browser, 'markdown', MD_DOC, 'markdown')
    await render(browser, 'html', HTML_DOC, 'html')
    await render(browser, 'html', '<link rel="stylesheet" href="https://evil.example/x.css"><p>外网资源应被拦截，这句仍然要能渲染出来。</p>', 'blocked-cdn')
  } finally {
    await browser.close()
  }
  console.log('产出目录:', OUT)
})().catch((e) => {
  console.error('渲染失败:', e.message)
  process.exit(1)
})
