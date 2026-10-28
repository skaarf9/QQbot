/**
 * 一次性迁移脚本（2026-10-27）：把 ChatLuna 从 commandcode 中转切到 DeepSeek 官方。
 *
 * 为什么写成文件而不是内联 node -e：内联要过 bash 的双引号 + `$` + 反引号三层转义，
 * 实测 `\n` 拼出来的多行块匹配不上（命中 0 次），排查成本高于直接落盘。
 *
 * 用法：node tools/migrate-chatluna-to-deepseek.cjs [--dry-run]
 * 幂等：已经是目标形态时每条替换命中 0 次，脚本会自行判定为"已迁移"并跳过。
 */
const fs = require('node:fs')
const path = require('node:path')

const APP = path.resolve(__dirname, '..')
const FILE = path.join(APP, 'koishi.yml')
const dry = process.argv.includes('--dry-run')

let s = fs.readFileSync(FILE, 'utf8')
const before = s
const report = []

/** @type {[string, string, number, string][]} from / to / 期望命中次数 / 说明 */
const RULES = [
  [
    'fallbackModel: deepseek/deepseek/deepseek-v4.1-flash',
    'fallbackModel: cc/q.dialogue',
    1,
    'chatluna-vision.fallbackModel 换成模型组（官方只有两个模型 id，三段式的厂商段不好猜）',
  ],
  [
    'https://api.commandcode.ai/provider/v1',
    'https://api.deepseek.com',
    3,
    '三个适配器的端点（deepseek-adapter / openai-like / multi-adapter）',
  ],
  [
    '${{ env.CC_API_KEY }}',
    '${{ env.DEEPSEEK_API_KEY }}',
    3,
    '同上三处的 key 引用',
  ],
  [
    'model: deepseek/deepseek-v4.1-flash-fast',
    'model: deepseek-v4-pro',
    3,
    'fast 版官方没有，降级位改成 v4-pro（不同模型才算真兜底）',
  ],
  [
    'model: deepseek/deepseek-v4.1-flash',
    'model: deepseek-flash',
    4,
    '主力模型（dialogue/sticker/memory + q.memory 那条）',
  ],
]

/** 整块删除的模型条目：官方没有对应物 */
const DROP_BLOCKS = [
  {
    name: 'Qwen/Qwen3.8-Flash（q.vision / q.sticker）',
    text: [
      '          - model: Qwen/Qwen3.8-Flash',
      '            modelCapabilities:',
      '              - text_input',
      '              - tool_call',
      '              - image_input',
      '            contextSize: 1000000',
      '',
    ].join('\n'),
    expect: 2,
  },
  {
    name: 'inclusionai/ling-3.1-flash:free（q.memory）',
    text: [
      '          - model: inclusionai/ling-3.1-flash:free',
      '            modelCapabilities:',
      '              - text_input',
      '              - tool_call',
      '            contextSize: 262144',
      '',
    ].join('\n'),
    expect: 1,
  },
  {
    name: 'inclusionai/ling-3.0-flash-sante:free（q.memory）',
    text: [
      '          - model: inclusionai/ling-3.0-flash-sante:free',
      '            modelCapabilities:',
      '              - text_input',
      '              - tool_call',
      '            contextSize: 262144',
      '',
    ].join('\n'),
    expect: 1,
  },
]

const problems = []
let touched = 0

for (const [from, to, expect, why] of RULES) {
  const n = s.split(from).length - 1
  if (n === expect) {
    s = s.split(from).join(to)
    touched++
    report.push(`✅ 命中 ${n} 次  ${why}`)
  } else if (n === 0) {
    // 幂等：已经是目标形态
    const already = s.includes(to)
    report.push(`${already ? '⏭  已在位' : '⚠️ 命中 0 次'}  ${why}`)
    if (!already) problems.push(`${why}：from 与 to 都没找到（文件里可能已经被人改过）`)
  } else {
    problems.push(`${why}：命中 ${n} 次，期望 ${expect}`)
  }
}

for (const blk of DROP_BLOCKS) {
  const n = s.split(blk.text).length - 1
  if (n === blk.expect) {
    s = s.split(blk.text).join('')
    touched++
    report.push(`✅ 删除 ${n} 块  ${blk.name}`)
  } else if (n === 0) {
    report.push(`⏭  已删除  ${blk.name}`)
  } else {
    problems.push(`${blk.name}：命中 ${n} 次，期望 ${blk.expect}`)
  }
}

console.log(report.join('\n'))

if (problems.length) {
  console.error('\n有问题，未写入：')
  for (const p of problems) console.error('  · ' + p)
  process.exit(2)
}

if (s === before) {
  console.log('\n文件没有变化（已经迁移过）')
  process.exit(0)
}

if (dry) {
  console.log(`\n--dry-run：本来要写 ${before.length} → ${s.length} 字节，已跳过`)
  process.exit(0)
}

fs.writeFileSync(FILE, s)
console.log(`\n已写入 koishi.yml：${before.length} → ${s.length} 字节（${touched} 组改动）`)
