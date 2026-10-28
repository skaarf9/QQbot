const fs = require('fs')
const p = require('path')

const roots = ['node_modules', 'external']
const seen = new Map() // name -> {file, kind}

function fileTag(f) {
  const s = f.split(p.sep).join('/')
  const i = s.lastIndexOf('node_modules/')
  if (i >= 0) return 'nm:' + s.slice(i + 'node_modules/'.length)
  const j = s.lastIndexOf('external/')
  if (j >= 0) return 'ext:' + s.slice(j + 'external/'.length)
  return s
}

function add(name, file, kind) {
  if (!name) return
  const key = kind + '|' + name
  if (!seen.has(key)) seen.set(key, fileTag(file))
}

function scan(dir, depth) {
  if (depth > 5) return
  let ents
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of ents) {
    const f = p.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === '.git' || e.name === '.github') continue
      scan(f, depth + 1)
      continue
    }
    if (!/\.(cjs|js|mjs|ts)$/.test(e.name) || /\.d\.ts$/.test(e.name) || /\.map$/.test(e.name)) continue
    let s
    try { s = fs.readFileSync(f, 'utf8') } catch { continue }
    if (s.length > 14e6) continue

    let m
    const reCmd = /(?:\.command|\.cmd)\(\s*([`'"][^`'"]+[`'"])/g
    while ((m = reCmd.exec(s))) add(m[1].slice(1, -1), f, 'name')

    const reAlias = /\.alias\(\s*([^)\n]{0,200})/g
    while ((m = reAlias.exec(s))) {
      const seg = m[1]
      const reStr = /[`'"]([^`'"]+)[`'"]/g
      let mm
      while ((mm = reStr.exec(seg))) add(mm[1], f, 'alias')
    }

    const reCmd2 = /command\s*:\s*([`'"][^`'"]+[`'"])/g
    while ((m = reCmd2.exec(s))) add(m[1].slice(1, -1), f, 'name?')
  }
}

for (const r of roots) scan(r, 0)

const all = [...seen.entries()]
const nonAscii = all.filter(([k]) => /[^\x00-\x7F]/.test(k))
console.log('条目总数', all.length, '| 含非 ASCII', nonAscii.length)
console.log('=== 非 ASCII 指令/别名 ===')
for (const [k, f] of nonAscii.sort()) console.log('  ' + k.padEnd(34), f)
console.log()
console.log('=== 全部别名 ===')
for (const [k, f] of all.filter(([k]) => k.startsWith('alias|')).sort()) console.log('  ' + k.slice(6).padEnd(30), f)
