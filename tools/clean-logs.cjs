#!/usr/bin/env node
/**
 * clean-logs.cjs —— 清掉测试台跑下来堆积的日志。
 *
 * 为什么需要：跑一轮剧本留 200~400 KB，几十轮之后 koishi-app/tools 下就是几 MB，
 * 而且只增不减。默认保留最近 7 天，并永远跳过 last-run.log / prod.log。
 *
 * 用法：
 *   node tools\clean-logs.cjs                # 只列出会删什么（不动手）
 *   node tools\clean-logs.cjs --force        # 真删
 *   node tools\clean-logs.cjs --days 2       # 改成保留 2 天
 *   node tools\clean-logs.cjs --days 0       # 除了受保护的，全删
 *   node tools\clean-logs.cjs --force --all  # 连 koishi-test\ 下的日志一起扫
 */
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const APP_TOOLS = path.join(ROOT, 'koishi-app', 'tools')

const argv = process.argv.slice(2)
const has = (f) => argv.includes('--' + f)
const getArg = (n, d) => {
  const i = argv.indexOf('--' + n)
  return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d
}

const force = has('force')
const days = Number(getArg('days', '7'))
const all = has('all')

// 受保护的：脚本回放和生产日志是排障入口，永远不删
const PROTECTED = new Set(['last-run.log', 'prod.log'])

const dirs = [APP_TOOLS, path.join(APP_TOOLS, 'logs')]
if (all) dirs.push(path.join(ROOT, 'koishi-test'), path.join(ROOT, 'koishi-app'))

function walkLogs(dir, depth = 0) {
  if (!fs.existsSync(dir) || depth > 2) return []
  const out = []
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules') continue
      out.push(...walkLogs(full, depth + 1))
    } else if (ent.name.toLowerCase().endsWith('.log')) {
      try {
        const st = fs.statSync(full)
        out.push({ full, name: ent.name, size: st.size, mtime: st.mtimeMs })
      } catch {}
    }
  }
  return out
}

const cutoff = Date.now() - days * 86400000
const found = [...new Map(dirs.flatMap((d) => walkLogs(d)).map((f) => [f.full, f])).values()]

const keep = []
const kill = []
for (const f of found) {
  if (PROTECTED.has(f.name) || f.mtime >= cutoff) keep.push(f)
  else kill.push(f)
}

const mb = (n) => (n / 1024 / 1024).toFixed(2) + ' MB'
const kb = (n) => (n / 1024).toFixed(0) + ' KB'

console.log(`扫描目录：`)
for (const d of dirs) console.log(`  ${path.relative(ROOT, d)}${fs.existsSync(d) ? '' : '  （不存在）'}`)
console.log(`\n共 ${found.length} 个日志，保留 ${keep.length} 个（最近 ${days} 天 + 受保护的 ${[...PROTECTED].join(' / ')}）`)
console.log(`可删 ${kill.length} 个，合计 ${mb(kill.reduce((a, f) => a + f.size, 0))}\n`)

for (const f of kill.sort((a, b) => b.size - a.size)) {
  console.log(`  ${force ? '删除' : '[dry]'} ${path.relative(ROOT, f.full).padEnd(52)} ${kb(f.size).padStart(9)}`)
}

if (!kill.length) {
  console.log('  没有需要清理的。')
} else if (!force) {
  console.log(`\n这是预演。要真删就加 --force：`)
  console.log(`  node tools\\clean-logs.cjs --force${days !== 7 ? ` --days ${days}` : ''}`)
} else {
  let n = 0
  for (const f of kill) {
    try {
      fs.unlinkSync(f.full)
      n++
    } catch (e) {
      console.log(`  ✗ 删不掉 ${path.relative(ROOT, f.full)}：${e.code}`)
    }
  }
  console.log(`\n✅ 删了 ${n} 个，释放 ${mb(kill.reduce((a, f) => a + f.size, 0))}`)
}

// 删空目录（只删 logs/ 这种自己建的）
for (const d of [path.join(APP_TOOLS, 'logs')]) {
  try {
    if (fs.existsSync(d) && fs.readdirSync(d).length === 0) fs.rmdirSync(d)
  } catch {}
}
