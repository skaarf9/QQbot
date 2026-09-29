/**
 * 给生产配置加/更新 qqbot-auth 插件段（保留原有注释与格式）。
 *
 *   node tools\patch-prod-config.cjs
 *
 * 为什么用脚本而不是手写：koishi.yml 里 API Key 是折叠块（>-），手抄容易出错；
 * 而且这个文件会被 Koishi 自己重写，格式必须和它一致（2 空格缩进）。
 */
const fs = require('node:fs')
const path = require('node:path')

const FILE = path.resolve(__dirname, '../koishi-app/koishi.yml')
let yml = fs.readFileSync(FILE, 'utf8')

const BLOCK = `  qqbot-auth:auth01:
    ownerIds:
      - '2791932480'
    adminIds: []
    trustedIds: []
    blockedIds: []
    raiseDangerousCommands: true
    scanSeconds: 120
    debug: true
`

if (/^ {2}qqbot-auth:/m.test(yml)) {
  // 已存在 → 整段替换
  yml = yml.replace(/^ {2}qqbot-auth:[\s\S]*?(?=^ {2}\S|\Z)/m, BLOCK)
  console.log('已替换现有的 qqbot-auth 段')
} else {
  // 插到 adapter-onebot 之前（插件顺序：能力类在前，适配器最后）
  const anchor = /^ {2}adapter-onebot:/m
  if (!anchor.test(yml)) throw new Error('找不到 adapter-onebot 段，无法定位插入点')
  yml = yml.replace(anchor, BLOCK + '\n$&')
  console.log('已在 adapter-onebot 之前插入 qqbot-auth 段')
}

fs.writeFileSync(FILE, yml, 'utf8')
console.log('\n--- 改后的 plugins 段 ---')
console.log(
  yml
    .split('\n')
    .filter((l) => /^ {2}\S/.test(l))
    .join('\n')
)
