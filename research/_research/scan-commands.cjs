const fs = require('fs')
const p = require('path')

const roots = ['node_modules', 'external']
const seen = new Map()

function fileTag(f) {
  const s = f.split(p.sep).join('/')
  const i = s.lastIndexOf('node_modules/')
  if (i >= 0) return 'nm:' + s.slice(i + 'node_modules/'.length)
  const j = s.lastIndexOf('external/')
  if (j >= 0) return 'ext:' + s.slice(j + 'external/'.length)
  return s
}

function scan(dir, depth) {
  if (depth > 4) return
  let ents
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of ents) {
    const f = p.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue
      scan(f, depth + 1)
      continue
    }
    if (!/\.(cjs|js|mjs)$/.test(e.name) || /\.map$/.test(e.name)) continue
    let s
    try { s = fs.readFileSync(f, 'utf8') } catch { continue }
    if (s.length > 12e6) continue
    const re = /(?:\.command|\.cmd)\(\s*([`'"][^`'"]+[`'"])/g
    let m
    while ((m = re.exec(s))) {
      const n = m[1].slice(1, -1)
      if (!seen.has(n)) seen.set(n, fileTag(f))
    }
    // also catch ctx.command('a.b', ...) style already covered; catch name lists
    const re3 = /command:\s*([`'"][^`'"]+[`'"])/g
    while ((m = re3.exec(s))) {
      const n = m[1].slice(1, -1)
      if (!seen.has(n)) seen.set(n, fileTag(f))
    }
  }
}

for (const r of roots) scan(r, 0)

const all = [...seen.entries()]
const cjk = all.filter(([n]) => /[^\x00-\x7F]/.test(n))
console.log('总指令数', all.length, '| 含非 ASCII', cjk.length)
console.log('--- 非 ASCII 指令 ---')
for (const [n, f] of cjk.sort((a, b) => a[0].localeCompare(b[0]))) console.log('  ' + n.padEnd(30), f)
console.log('--- 点号指令 ---')
const dots = all.filter(([n]) => /\./.test(n) && !/[^\x00-\x7F]/.test(n))
for (const [n, f] of dots.sort((a, b) => a[0].localeCompare(b[0]))) console.log('  ' + n.padEnd(34), f)
console.log('--- 单段英文指令 ---')
const singles = all.filter(([n]) => !/\./.test(n) && !/[^\x00-\x7F]/.test(n))
console.log(singles.map(([n, f]) => n + ' <' + f + '>').sort().join('\n'))
