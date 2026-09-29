// 枚举 ChatLuna 注册的指令及其 authority 门槛
const fs = require('node:fs')
const path = require('node:path')

const file = path.resolve(__dirname, '../node_modules/koishi-plugin-chatluna/lib/index.cjs')
const lines = fs.readFileSync(file, 'utf8').split('\n')

// 找形如 ctx.command("name", { authority: N ... }) 或 ctx.command("name").option(... {authority:N})
const re = /\.command\(\s*(["'`])([^"'`]+)\1((?:.|\n){0,400}?)\)/g
const out = []
let m
while ((m = re.exec(lines.join('\n')))) {
  const name = m[2]
  const tail = m[3]
  const a = /authority:\s*(\d+)/.exec(tail)
  const slashFalse = /slash:\s*false/.test(tail)
  out.push({ name, authority: a ? +a[1] : 1, slash: slashFalse ? false : true })
}
const seen = new Set()
for (const c of out) {
  const k = c.name + '|' + c.authority
  if (seen.has(k)) continue
  seen.add(k)
}
out.sort((a, b) => a.authority - b.authority || a.name.localeCompare(b.name))
console.log('指令数:', out.length)
for (const c of out) console.log(`  a=${c.authority} ${c.slash ? ' ' : '无斜线'} ${c.name}`)
