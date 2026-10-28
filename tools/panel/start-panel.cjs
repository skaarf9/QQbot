/**
 * 后台启动面板服务（无窗口、detached），日志追加到 tools/logs/panel.log。
 *
 * 为什么不用 启动面板.cmd：那个脚本会**再要一次 UAC 提权**并开浏览器，
 * 适合"人坐在机器前手动点"的场景；这里只是把服务本身拉起来。
 *
 * ⚠️ 这样起的面板不是管理员，面板里"启动 NapCat"那条路会走 UAC 或失败
 *    （见 tools/panel/README.md 第 9 条）。要完整功能还是双击 启动面板.cmd。
 *
 * 用法：node tools/panel/start-panel.cjs [--port 5152]
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..', '..')
const logDir = path.join(root, 'tools', 'logs')
fs.mkdirSync(logDir, { recursive: true })

const logPath = path.join(logDir, 'panel.log')
const fd = fs.openSync(logPath, 'a')

const args = ['tools/panel/server.cjs', ...process.argv.slice(2)]
const child = spawn(process.execPath, args, {
  cwd: root,
  detached: true,
  windowsHide: true,
  stdio: ['ignore', fd, fd],
  env: { ...process.env },
})
child.unref()
fs.closeSync(fd)
console.log(JSON.stringify({ pid: child.pid, log: logPath }))
