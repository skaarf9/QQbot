// 用真实表情包对比免费视觉模型 vs 现用模型的描述质量
const fs = require('node:fs')
const KEY = fs.readFileSync(`${__dirname}/../key.txt`, 'utf8').split('\n')[0].trim()
const BASE = 'https://api.commandcode.ai/provider/v1'

const IMG = process.argv[2] || `${__dirname}/../koishi-app/data/sticker-library/02/027fcd8392b6929e.png`
const ext = IMG.endsWith('.jpg') || IMG.endsWith('.jpeg') ? 'jpeg' : 'png'
const dataUrl = `data:image/${ext};base64,${fs.readFileSync(IMG).toString('base64')}`
console.log('图片:', IMG, `(${fs.statSync(IMG).size} bytes)\n`)

const PROMPT = '用一两句中文直述这张图的内容（画的是什么、有什么文字）。不要出现「图/图片/图中/这是一张」这类说明性字眼。'
const MODELS = [
  ['stealth/space-bunny-alpha', 'Space Bunny Alpha（免费）'],
  ['poolside/laguna-s-2.1-free', 'Laguna S 2.1（免费）'],
  ['deepseek/deepseek-v4-flash-vision-exp', 'DeepSeek V4 Flash Vision（现用）'],
]

;(async () => {
  for (const [id, label] of MODELS) {
    const t0 = Date.now()
    try {
      const r = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ model: id, max_tokens: 400, messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }, { type: 'image_url', image_url: { url: dataUrl } }] }] }),
        signal: AbortSignal.timeout(120000),
      })
      const t = await r.text(); const ms = Date.now() - t0
      if (!r.ok) { console.log(`【${label}】HTTP ${r.status} (${ms}ms)\n  ${t.slice(0, 200)}\n`); continue }
      const j = JSON.parse(t); const m = j.choices?.[0]?.message
      console.log(`【${label}】✅ (${ms}ms)\n  ${(m?.content || '(空)').toString().replace(/\n+/g, ' ')}\n`)
    } catch (e) { console.log(`【${label}】异常 ${e.message}\n`) }
  }
})()
