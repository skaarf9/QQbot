// 清理 koishi.yml 里 healthCheckUrl 折行残留的孤儿 base64 行
const fs = require('node:fs')
const f = 'D:/deepseek/QQbot/koishi-app/koishi.yml'
let y = fs.readFileSync(f, 'utf8')
const lines = y.split(/\r?\n/)
const out = lines.filter((l) => !/^\s+data:image\/png;base64,/.test(l))
fs.writeFileSync(f, out.join('\n'))
console.log('删除行数:', lines.length - out.length)
