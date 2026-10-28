// 实测 commandcode 免费模型是否支持视觉输入
// 用法: node _research/test-vision-models.cjs
const zlib = require('node:zlib')

const KEY = require('node:fs').readFileSync(`${__dirname}/../key.txt`, 'utf8').split('\n')[0].trim()
const BASE = 'https://api.commandcode.ai/provider/v1'

// ---- 极简 PNG 编码器（RGB，无过滤）----
const crcTable = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c }
  return t
})()
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0 }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function makePng(w, h, pixelAt) {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  let o = 0
  for (let y = 0; y < h; y++) {
    raw[o++] = 0
    for (let x = 0; x < w; x++) { const [r, g, b] = pixelAt(x, y); raw[o++] = r; raw[o++] = g; raw[o++] = b }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
// 四象限：左上红、右上绿、左下蓝、右下黄  → 能"看见"的模型会说出这四种颜色
const W = 128, H = 128
const png = makePng(W, H, (x, y) => {
  const left = x < W / 2, top = y < H / 2
  if (top && left) return [220, 40, 40]
  if (top && !left) return [40, 180, 60]
  if (!top && left) return [40, 80, 220]
  return [240, 200, 40]
})
require('node:fs').writeFileSync(`${__dirname}/vision-test.png`, png)
const dataUrl = 'data:image/png;base64,' + png.toString('base64')
console.log('测试图已生成:', png.length, 'bytes\n')

const MODELS = [
  ['inclusionai/ling-3.1-flash:free', 'Ling 3.1 Flash', 'FREE'],
  ['inclusionai/ling-3.0-flash-sante:free', 'Ling 3.0 Flash Sante', 'FREE'],
  ['poolside/laguna-s-2.1-free', 'Laguna S 2.1', 'FREE'],
  ['stealth/space-bunny-alpha', 'Space Bunny Alpha', 'FREE'],
  ['deepseek/deepseek-v4-flash-vision-exp', 'DeepSeek V4 Flash Vision (exp)', '现用视觉'],
]

async function tryModel(id, label, tag) {
  const body = {
    model: id,
    max_tokens: 60,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '这张图被分成四个色块，请依次说出四个象限的颜色（左上/右上/左下/右下）。只回颜色。' },
        { type: 'image_url', image_url: { url: dataUrl } },
      ],
    }],
  }
  const t0 = Date.now()
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90000),
    })
    const txt = await res.text()
    const ms = Date.now() - t0
    let j; try { j = JSON.parse(txt) } catch { }
    if (!res.ok) { console.log(`[${tag}] ${label} → HTTP ${res.status} (${ms}ms)\n    ${txt.slice(0, 220)}\n`); return }
    const msg = j?.choices?.[0]?.message
    const out = (msg?.content ?? '').toString().replace(/\s+/g, ' ').slice(0, 160)
    const reasoning = (msg?.reasoning_content ?? '').toString().slice(0, 60)
    console.log(`[${tag}] ${label} → ✅ 200 (${ms}ms)\n    回答: ${out}\n${reasoning ? '    思考: ' + reasoning + '\n' : ''}`)
  } catch (e) {
    console.log(`[${tag}] ${label} → 异常: ${e.message}\n`)
  }
}

;(async () => {
  for (const [id, label, tag] of MODELS) await tryModel(id, label, tag)
})()
