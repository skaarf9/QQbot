/**
 * 长期记忆抽取实测：把 koishi-plugin-chatluna-long-memory 里真正用的
 * ENHANCED_MEMORY_PROMPT 抠出来，喂一段仿真聊天记录，看各模型能否返回
 * 它要求的「```yaml  fenced, memories: [...]」格式。
 *
 * 判定标准（照抄插件源码 extractMemoriesFromChat）：
 *   content.match(/```(?:ya?ml)?\s*\r?\n([\s\S]*?)\r?\n```/i)  →  yaml.load → parsed.memories
 *   拿不到 → 插件静默返回 [] → 记忆永远是空的（只有 debug 日志，平时看不到）
 */
const fs = require('fs')
const path = require('path')
const yaml = require(path.join(__dirname, '..', 'koishi-app', 'node_modules', 'js-yaml'))

const KEY = fs.readFileSync(path.join(__dirname, '..', 'key.txt'), 'utf8').split('\n')[0].trim()
const BUNDLE = path.join(
  __dirname,
  '..',
  'koishi-app',
  'node_modules',
  'koishi-plugin-chatluna-long-memory',
  'lib',
  'index.cjs'
)

const src = fs.readFileSync(BUNDLE, 'utf8')
const start = src.indexOf('var ENHANCED_MEMORY_PROMPT = `')
const end = src.indexOf('`;', start + 40)
const PROMPT = src.slice(start + 'var ENHANCED_MEMORY_PROMPT = `'.length, end)

// 一段"真的值得记"的聊天记录（故意混入闲聊，看模型会不会乱抽）
const CHAT = [
  'User: 我最近在打黑神话悟空，卡在第二章了',
  'Assistant: 那你用的是哪套 build？',
  'User: 就棍法流，不玩召唤。我是做后端开发的，平时也爱玩这种硬核动作游戏',
  'Assistant: 后端的话应该挺吃操作的',
  'User: 哈哈还行。对了我在杭州，周末一般去爬山，基本每个月去一次',
  'Assistant: 爬山不错',
  'User: 今天午饭吃了个面条，有点咸',
  'Assistant: 换一家吧',
].join('\n')

const FULL = PROMPT.replaceAll('{user_input}', CHAT)

const MODELS = [
  'inclusionai/ling-3.1-flash:free',
  'deepseek/deepseek-v4.1-flash-fast',
  'deepseek/deepseek-v4-flash-fast',
  'stealth/space-bunny-alpha',
]

async function run(model) {
  const t0 = Date.now()
  let r
  try {
    r = await fetch('https://api.commandcode.ai/provider/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
      body: JSON.stringify({ model, temperature: 0, max_tokens: 1200, messages: [{ role: 'user', content: FULL }] }),
      signal: AbortSignal.timeout(120000),
    })
  } catch (e) {
    return { model, ok: false, note: 'HTTP 失败: ' + e.message }
  }
  const j = await r.json()
  const content = String(j?.choices?.[0]?.message?.content ?? '')
  if (!content) return { model, ok: false, note: 'HTTP ' + r.status + ' 空内容 ' + JSON.stringify(j?.error || {}).slice(0, 120) }

  const m = content.match(/```(?:ya?ml)?\s*\r?\n([\s\S]*?)\r?\n```/i)
  if (!m) return { model, ok: false, ms: Date.now() - t0, note: '没给出 ```yaml 围栏（插件会判为 []）', raw: content.slice(0, 200) }

  let parsed
  try {
    parsed = yaml.load(m[1])
  } catch (e) {
    return { model, ok: false, ms: Date.now() - t0, note: 'YAML 解析失败: ' + e.message, raw: m[1].slice(0, 200) }
  }
  if (!parsed?.memories) return { model, ok: false, ms: Date.now() - t0, note: 'YAML 里没有 memories 键', raw: m[1].slice(0, 200) }
  return { model, ok: true, ms: Date.now() - t0, count: parsed.memories.length, memories: parsed.memories }
}

;(async () => {
  console.log('提示词长度', PROMPT.length, '字符\n')
  for (const m of MODELS) {
    const r = await run(m)
    if (r.ok) {
      console.log(`✔ ${r.model.padEnd(38)} ${String(r.ms).padStart(6)}ms  抽出 ${r.count} 条`)
      for (const x of r.memories) console.log(`     · [${x.type || '?'}/${x.importance ?? '?'}] ${String(x.content || '').slice(0, 90)}`)
    } else {
      console.log(`✘ ${r.model.padEnd(38)} ${r.note}`)
      if (r.raw) console.log(`     原样输出: ${String(r.raw).replace(/\n/g, ' ⏎ ').slice(0, 160)}`)
    }
  }
})()
