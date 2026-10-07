// 一次性搭建测试实例：目录 + node_modules 软链 + 预设目录
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const APP = 'D:/deepseek/QQbot/koishi-app'
const TEST = 'D:/deepseek/QQbot/koishi-test'

fs.mkdirSync(TEST, { recursive: true })
fs.mkdirSync(path.join(TEST, 'data/chathub/presets'), { recursive: true })

// node_modules 用 junction 复用，避免再装一遍几百 MB 依赖
const link = path.join(TEST, 'node_modules')
if (!fs.existsSync(link)) {
  execFileSync('cmd', ['/c', 'mklink', '/J', link, path.join(APP, 'node_modules')], {
    stdio: 'inherit',
  })
  console.log('已建 node_modules junction')
} else {
  console.log('node_modules junction 已存在')
}

// 预设直接复制一份（功能化命名：default-persona.yml）
const preset = path.join(TEST, 'data/chathub/presets/default-persona.yml')
if (!fs.existsSync(preset)) {
  fs.copyFileSync(path.join(APP, 'data/chathub/presets/default-persona.yml'), preset)
  console.log('已复制预设 default-persona.yml')
}

console.log('测试实例目录就绪：' + TEST)
