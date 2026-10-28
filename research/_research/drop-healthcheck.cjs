// 临时工具：移除 koishi.yml 里 chatluna-vision 的 healthCheckUrl（自检已完成）
const fs = require('node:fs')
const f = 'D:/deepseek/QQbot/koishi-app/koishi.yml'
let y = fs.readFileSync(f, 'utf8')
const before = y.length
y = y.replace(/^ {4}healthCheckUrl: .*$\r?\n/m, '')
fs.writeFileSync(f, y)
console.log(before, '->', y.length, '已移除 healthCheckUrl:', !/healthCheckUrl/.test(y))
