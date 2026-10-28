/**
 * watch-koishi-db.cjs —— 数据库损坏自愈看护（2026-10-27 第二十二轮加的）
 *
 * 为什么需要它：
 *   这套栈的数据库驱动是 **sql.js（WASM 版 sqlite）**，在真机负载下会偶发
 *   `RuntimeError: null function or function signature mismatch`；一旦发生，
 *   那笔事务就不提交、留下 `koishi.db-journal`，之后**所有写操作**都报
 *   `database disk image is malformed`，表现就是 bot 满嘴「错误码 999/103」，
 *   而模型请求本身其实都是成功的。详见 docs/04-踩坑记录/08 的坑 95。
 *
 *   根治要换原生驱动，而 `@minatojs/driver-sqlite` 4.7.0 只认 sql.js，
 *   原生驱动要 minato^4 / cordis^4（Koishi 4.18.11 够不到）。在那之前，
 *   至少让它**自己爬起来**，而不是等用户发现 bot 不回话。
 *
 * 它做什么：
 *   每 30 秒看一次 `tools/logs/prod-err.log` 的新增内容；出现损坏特征就
 *   按**安全流程**重启 Koishi：
 *     ① 杀 supervisor（连 worker 一起，`*koishi*bin.js*` —— 别用 `*bin.js*`，会误杀 DSH）
 *     ② 等端口释放
 *     ③ 用原生 node:sqlite 打开一次 data/koishi.db（回滚热日志、删 .db-journal）
 *     ④ 重新拉起 Koishi，输出仍接到同一个日志文件
 *   全过程写 `tools/logs/watchdog.log`，带冷却（默认 180 秒内不重复重启）。
 *
 * 用法：
 *   node tools\watch-koishi-db.cjs                 # 前台跑（Ctrl+C 停）
 *   node tools\watch-koishi-db.cjs --interval 20 --cooldown 300 --once
 *
 * 注意：它是**兜底**，不是修复。真出现频繁触发，要回头看是不是又有插件在往库里
 * 写大 blob（坑 95 的真凶就是 sandbox 写 1MB 请求体）。
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const APP = path.resolve(__dirname, '..')
const LOG = path.join(APP, 'tools', 'logs', 'prod-err.log')
const WDLOG = path.join(APP, 'tools', 'logs', 'watchdog.log')

const argv = process.argv.slice(2)
const arg = (n, d) => {
  const i = argv.indexOf('--' + n)
  return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d
}
const INTERVAL_MS = Math.max(5, Number(arg('interval', '30'))) * 1000
const COOLDOWN_MS = Math.max(30, Number(arg('cooldown', '180'))) * 1000
const ONCE = argv.includes('--once')

/** 咬人的特征：出现任意一个就认为这一轮已经不可用了 */
const BAD = [/database disk image is malformed/, /null function or function signature mismatch/]

function log(line) {
  const ts = new Date().toLocaleString('zh-CN', { hour12: false })
  const text = `[${ts}] ${line}\n`
  fs.appendFileSync(WDLOG, text)
  process.stdout.write(text)
}

/** 当前日志文件的读取位置（从末尾开始，只看新东西） */
let offset = 0
try {
  offset = fs.statSync(LOG).size
} catch {
  offset = 0
}

/** 读自上次以来新增的内容 */
function readNew() {
  let size
  try {
    size = fs.statSync(LOG).size
  } catch {
    return ''
  }
  if (size < offset) offset = 0 // 日志被轮转/重写
  if (size === offset) return ''
  const fd = fs.openSync(LOG, 'r')
  const len = size - offset
  const buf = Buffer.alloc(len)
  try {
    fs.readSync(fd, buf, 0, len, offset)
  } finally {
    fs.closeSync(fd)
  }
  offset = size
  return buf.toString('utf8')
}

/** 找 Koishi 的 supervisor：必须同时含 koishi 与 bin.js，别用 *bin.js*（会误杀 DSH，坑 96） */
function findKoishiPids() {
  // ★ windowsHide 必须有：不带它，spawnSync 会给 console 程序开一个**可见**的窗口，
  //   于是每隔一个 tick 屏幕上就闪一下 pwsh/PowerShell（2026-10-27 用户报告的"pwsh 窗口一闪而过"）。
  const ps = spawnSync('powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*koishi*bin.js*' } | ForEach-Object { $_.ProcessId }",
  ], { encoding: 'utf8', windowsHide: true })
  return String(ps.stdout || '')
    .split(/\s+/)
    .map((s) => Number(s.trim()))
    .filter(Boolean)
}

function killKoishi() {
  const pids = findKoishiPids()
  if (!pids.length) return 0
  for (const pid of pids) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true })
  }
  return pids.length
}

/** 用原生 sqlite 打开一次再关：回滚热日志、删掉 .db-journal */
function recoverDb() {
  const script = `
const fs = require('fs'); const { DatabaseSync } = require('node:sqlite');
const p = 'data/koishi.db';
const had = fs.existsSync(p + '-journal');
const d = new DatabaseSync(p);
const ic = d.prepare('pragma integrity_check').all();
d.close();
console.log(JSON.stringify({ had, integrity: ic[0] && ic[0].integrity_check, journalAfter: fs.existsSync(p + '-journal') }));
`
  const r = spawnSync(process.execPath, ['-e', script], { cwd: APP, encoding: 'utf8', windowsHide: true })
  return String(r.stdout || '').trim() || String(r.stderr || '').trim().slice(0, 200)
}

let child = null
let lastRestart = 0

function startKoishi() {
  const out = fs.openSync(LOG, 'a')
  child = spawn(process.execPath, ['node_modules/koishi/bin.js', 'start'], {
    cwd: APP,
    stdio: ['ignore', out, out],
    detached: false,
    windowsHide: true,
  })
  child.on('exit', (code) => {
    log(`Koishi 退出 code=${code}`)
    child = null
  })
  offset = fs.existsSync(LOG) ? fs.statSync(LOG).size : 0
  log(`Koishi 已启动 pid=${child.pid}`)
}

function restart(reason) {
  if (Date.now() - lastRestart < COOLDOWN_MS) {
    log(`冷却中，跳过重启（${reason}）`)
    return
  }
  lastRestart = Date.now()
  log(`检测到损坏特征，开始自愈：${reason}`)

  const killed = killKoishi()
  log(`已停 ${killed} 个 Koishi 进程，等 4 秒让端口释放`)

  setTimeout(() => {
    const rec = recoverDb()
    log(`数据库恢复：${rec}`)
    startKoishi()
  }, 4000)
}

function tick() {
  // ① 进程没了也要拉起来：原先只盯日志特征，Koishi 被外部杀掉（比如 DSH 自己
  //    按 AGENTS.md 去"重启 Koishi"）时会静默死在半路，谁都不管。
  if (findKoishiPids().length === 0) {
    if (Date.now() - lastRestart < COOLDOWN_MS) {
      log('Koishi 不在跑，但还在冷却期内，先不拉起')
      return
    }
    lastRestart = Date.now()
    log('发现 Koishi 不在跑（可能被外部杀掉），直接按安全流程拉起')
    const rec = recoverDb()
    log(`数据库恢复：${rec}`)
    startKoishi()
    return
  }

  const text = readNew()
  if (!text) return
  const hit = BAD.find((re) => re.test(text))
  if (!hit) return
  restart(String(hit))
}

log(`看护启动：间隔 ${INTERVAL_MS / 1000}s，冷却 ${COOLDOWN_MS / 1000}s，日志 ${LOG}`)
if (!child && findKoishiPids().length === 0) {
  log('没有发现正在跑的 Koishi，先起一个')
  startKoishi()
}

tick()
if (ONCE) process.exit(0)
setInterval(tick, INTERVAL_MS)
