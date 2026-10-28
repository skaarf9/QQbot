/**
 * 用 Node 起 Koishi（绕开 PowerShell 的 Start-Process）。
 *
 * ── 为什么需要它（2026-10-27 实测）──────────────────────────────────────────
 * 本机环境变量里有**大小写重复**的代理键：`HTTP_PROXY` + `http_proxy`、
 * `HTTPS_PROXY` + `https_proxy`、`NO_PROXY` + `no_proxy`。
 * PowerShell 的 `Start-Process` 会把环境变量装进一个**大小写不敏感**的字典，
 * 一碰就抛「已添加项。字典中的关键字:“HTTPS_PROXY”所添加的关键字:“https_proxy”」，
 * 子进程根本没被创建 —— 22:45 那次重启就是这么无声失败的（5140 空了 25 分钟）。
 * Node 的 `process.env` 天然按大小写不敏感去重，`spawn()` 不会踩这个雷。
 *
 * ── 用法 ───────────────────────────────────────────────────────────────────
 *   node tools/launch-koishi.cjs                  # 起 Koishi（后台、detached）
 *   node tools/launch-koishi.cjs --watchdog       # 同时起数据库看护
 *   node tools/launch-koishi.cjs --watchdog-only  # 只起看护（它发现 Koishi 没跑会自己拉）
 *
 * 日志追加到 `tools/logs/prod-restart-<时间戳>.log`。
 * 停：`taskkill /PID <pid> /T /F`（没有控制台窗口，taskkill 不带 /F 停不下来）。
 * 杀掉之后建议跑一次 `node tools/db-integrity-check.cjs` 确认库没坏。
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const app = path.resolve(__dirname, '..')
const logDir = path.join(app, 'tools', 'logs')
fs.mkdirSync(logDir, { recursive: true })

const nodeExe = process.execPath
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outPath = path.join(logDir, `prod-restart-${stamp}.log`)
const fd = fs.openSync(outPath, 'a')

function launch(args, name) {
  const child = spawn(nodeExe, args, {
    cwd: app,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env },
  })
  child.unref()
  console.log(JSON.stringify({ name, pid: child.pid, log: outPath, at: stamp }))
  return child.pid
}

const argv = process.argv.slice(2)
const watchdogOnly = argv.includes('--watchdog-only')
if (argv.includes('--watchdog') || watchdogOnly) {
  launch(['tools/watch-koishi-db.cjs', '--interval', '20', '--cooldown', '120'], 'watchdog')
}
if (!watchdogOnly) launch(['node_modules/koishi/bin.js', 'start'], 'koishi')
fs.closeSync(fd)
