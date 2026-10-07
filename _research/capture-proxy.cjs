// 临时抓包代理：把 ChatLuna 发给 commandcode 的请求体原样记录下来
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const UP = 'https://api.commandcode.ai'
const LOG = path.join(__dirname, 'capture.log')
try { fs.unlinkSync(LOG) } catch {}

const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', async () => {
    const raw = Buffer.concat(chunks)
    let pretty = raw.toString('utf8')
    try {
      const j = JSON.parse(pretty)
      // 图片 base64 太长，截断显示
      const s = JSON.stringify(j, (k, v) => (typeof v === 'string' && v.length > 120 ? v.slice(0, 80) + `…(${v.length}字)` : v), 2)
      pretty = s
    } catch {}
    fs.appendFileSync(LOG, `\n===== ${req.method} ${req.url} =====\n${pretty}\n`)

    const upstream = await fetch(UP + req.url, {
      method: req.method,
      headers: { 'content-type': 'application/json', authorization: req.headers.authorization || '' },
      body: raw.length ? raw : undefined,
    })
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json' })
    for await (const chunk of upstream.body) res.write(chunk)
    res.end()
  })
})
server.listen(8899, '127.0.0.1', () => console.log('capture proxy on 127.0.0.1:8899 -> ' + UP))
