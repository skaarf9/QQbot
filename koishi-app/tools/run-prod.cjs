#!/usr/bin/env node
/**
 * run-prod.cjs —— 带日志保留策略的生产启动器。
 *
 * 为什么需要：生产实例平时是这样起的 ——
 *     node node_modules\koishi\bin.js start *> tools\prod.log
 * `*>` 是**追加**，于是 prod.log 随运行时间单调增长（已经 989 KB，而它只是当天的量）。
 * 这个脚本把输出改成**按天一个文件** + 自动清扫超过 N 天的，日志量就有上界了。
 *
 * 用法：
 *   node tools\run-prod.cjs                 # 前台跑，输出照常打屏，同时写 logs\prod-<本地日期>.log
 *   node tools\run-prod.cjs --log-level 3   # 额外参数原样透传给 koishi start
 *   node tools\run-prod.cjs --keep-days 3   # 覆盖保留天数（默认 7）
 *   node tools\run-prod.cjs --no-prune      # 这次不清扫
 *   node tools\run-prod.cjs --kill-orphans  # 发现有实例还连着 NapCat 时，先替你把它们收掉
 *   node tools\run-prod.cjs --takeover      # 重启用：连正在服务的那个实例一起收掉再起
 *   node tools\run-prod.cjs --check         # 只看现状：端口谁占着、NapCat 上有几个客户端、有没有孤儿
 *
 * ★ 日志按**本地日期**一个文件（`logs\prod-<YYYY-MM-DD>.log`），运行中跨天会自动换文件。
 *   同名的旧日志不会被覆盖：先改名成 `prod-<日期>.prev-<HHMMSS>.log` 存档，再写新的。
 *   （2026-10-06 修：原来用 UTC 日期当文件名，东八区要到早上 08:00 才换日，
 *    于是 `prod-2026-10-05.log` 里混着 `2026-10-06 00:33` 的行；而且流是覆盖模式，
 *    同一天重启一次就把上一段日志抹掉了。）
 * ★ 已有一个实例占着 5140 时直接拒绝启动 —— 重复启动生产实例会"静默半死"（坑 6）。
 * ★ **端口空着也可能是"已经有一个实例在跑"**：koishi 的 worker 会在上一轮没收干净时变成孤儿，
 *   既不听端口、又照样连着 NapCat 收事件，于是每条命令被回答两次。启动前会查 NapCat 的
 *   连接数，发现就拒绝（见坑 57）。
 */
const { spawn, execFileSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const net = require('node:net')
const { pruneLogs, makeRotatingTee, DEFAULT_KEEP_DAYS, localDate } = require('./log-retention.cjs')

const APP = path.resolve(__dirname, '..')
const LOG_DIR = path.join(__dirname, 'logs')
const PORT = 5140

const argv = process.argv.slice(2)
const has = (f) => argv.includes('--' + f)
const getArg = (n, d) => {
  const i = argv.indexOf('--' + n)
  return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d
}
const keepDays = Number(getArg('keep-days', String(DEFAULT_KEEP_DAYS)))

// 透传给 koishi start 的参数：去掉我们自己的
const passthrough = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--no-prune') continue
  if (a === '--kill-orphans') continue
  if (a === '--takeover') continue
  if (a === '--check') continue
  if (a === '--keep-days') {
    i++
    continue
  }
  passthrough.push(a)
}

/** 5140 被占 = 已经有一个生产实例，别再起第二个 */
function portBusy(port) {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', (e) => resolve(e.code === 'EADDRINUSE'))
    s.once('listening', () => s.close(() => resolve(false)))
    s.listen(port, '127.0.0.1')
  })
}

///
/// ★ 为什么除了端口检查还要查 NapCat 连接（坑 57）：
///   `job_kill` 只杀得掉 pwsh 那一层，koishi 的 CLI → worker 会**变成孤儿活下来**。
///   实测过一次：17:03 起的实例在 18:57 重启后仍连着 NapCat 跑了两个半小时，
///   而它的监听端口早就没了 —— 所以 `portBusy()` 检查完全看不见它。
///   NapCat 的 WS 服务端是**广播**给所有客户端的，于是每条命令会被回答两次、
///   每次插话/回复都是两遍。只有"谁连着 NapCat"才认得出这种孤儿。
///
/** NapCat 的 OneBot WS 端口：从 koishi.yml 的 adapter endpoint 里读，读不到就按默认 3001 */
function napcatPort() {
  try {
    const yml = fs.readFileSync(path.join(APP, 'koishi.yml'), 'utf8')
    const m = /endpoint:\s*ws:\/\/[^\s:]+:(\d+)/.exec(yml)
    return m ? Number(m[1]) : 3001
  } catch {
    return 3001
  }
}

/** 当前**已经**连着 NapCat 那个端口的进程号（ESTABLISHED 才算） */
function napcatClients(port) {
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' })
    const pids = new Set()
    for (const line of out.split(/\r?\n/)) {
      const m = /^\s*TCP\s+\S+:(\d+)\s+\S+:(\d+)\s+ESTABLISHED\s+(\d+)\s*$/.exec(line)
      if (m && Number(m[2]) === port) pids.add(Number(m[3]))
    }
    return [...pids].filter((pid) => pid > 0 && pid !== process.pid)
  } catch {
    return []
  }
}

/** 正在 LISTEN 某个端口的进程号（用来区分"健康实例"和"丢端口的孤儿"） */
function listenPid(port) {
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' })
    for (const line of out.split(/\r?\n/)) {
      const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/.exec(line)
      if (m && Number(m[1]) === port) return Number(m[2])
    }
    return null
  } catch {
    return null
  }
}

/** 这个 pid 是不是 node.exe（自动清理时只敢杀 node） */
function isNodePid(pid) {
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' })
    return /node\.exe/i.test(out)
  } catch {
    return false
  }
}

/** 用 taskkill /T 收整棵树 —— koishi CLI 会 fork daemon，只杀父进程会留孤儿（坑 6） */
function killTree(pid) {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    else process.kill(pid, 'SIGTERM')
  } catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const np = napcatPort()
  const holder = listenPid(PORT) // 健康的实例：既听 5140，又连着 NapCat
  const clients = napcatClients(np)
  /**
   * **孤儿** = 连着 NapCat、却不持有 5140 的进程。
   * 这个定义很关键：正常重启（先 job_kill 再起）留下的就是这种 —— 它照样收 NapCat 的广播，
   * 于是每条命令被回答两次；而真正健康的实例永远持有端口，所以这个判据**不会误杀**它。
   */
  const orphans = clients.filter((pid) => pid !== holder)
  /**
   * `--takeover` = 连健康实例一起收 —— 这正是"重启"这个动作要做的事。
   * `--kill-orphans` 只收丢端口的孤儿，**永远不碰**持有 5140 的那个实例；这个区别是故意的：
   * 手滑多跑一条命令的代价，不该是"把正在服务的实例杀了"。
   * `--takeover` 还覆盖了"上一轮的实例正占着端口"的情形（那时 orphans 为空、端口却是忙的）。
   */
  const takeover = has('takeover')
  const targets = takeover ? clients : orphans

  // --check：只看现状不动手（排查"是不是有两个实例"时最先跑这条）
  if (has('check')) {
    const busy = await portBusy(PORT)
    console.log(`HTTP 端口 ${PORT}：${busy ? `被占用（PID ${holder ?? '?'}）` : '空闲'}`)
    console.log(`NapCat 端口 ${np}：${clients.length ? `${clients.length} 个进程连着 —— PID ${clients.join(', ')}` : '没有进程连着'}`)
    console.log(`判定：${orphans.length ? `有 ${orphans.length} 个孤儿实例（PID ${orphans.join(', ')}）—— 每条命令会被回答两次（坑 57）` : '没有孤儿'}`)
    console.log(
      '收尾：' +
        (orphans.length
          ? 'node tools\\run-prod.cjs --kill-orphans'
          : busy
            ? 'node tools\\run-prod.cjs --takeover（会一并收掉正在服务的那个实例）'
            : '（干净，直接起）')
    )
    process.exit(0)
  }

  if (targets.length && (takeover || has('kill-orphans'))) {
    // ★ 2026-10-06 修（坑 78）：这里原来是 `if (has('kill-orphans'))`，
    //   而 `targets` 在 `--takeover` 时等于**全部**客户端（含正在服务的那个健康实例）。
    //   于是「--takeover 单独用」会掉进下面的 else，报一句"已经有孤儿实例"（列表还是空的）然后退出 1 ——
    //   docs/17 和本文件头都写着 `--takeover` 一条命令就能重启，实际根本不动手，只能用
    //   `--takeover --kill-orphans`。现在 takeover 自己就具备收的能力，和文档一致。
    if (takeover || has('kill-orphans')) {
      let left = targets
      console.log(`（要收掉 ${left.length} 个${takeover ? '（--takeover）' : '孤儿（--kill-orphans）'}：PID ${left.join(', ')}）`)
      for (let round = 0; round < 3 && left.length; round++) {
        for (const pid of left) {
          if (!isNodePid(pid)) {
            console.error(`✗ PID ${pid} 连着 NapCat 却不是 node.exe —— 不敢动它，请自己确认后再启动。`)
            process.exit(1)
          }
          console.log(`  taskkill /PID ${pid} /T /F`)
          killTree(pid)
        }
        await sleep(1200)
        const now = napcatClients(np)
        left = takeover ? now : now.filter((pid) => pid !== listenPid(PORT))
      }
      if (left.length) {
        console.error(`✗ 收了 3 轮还剩下 PID ${left.join(', ')} —— 自己看一眼再启动。`)
        process.exit(1)
      }
      console.log(takeover ? '（旧实例已清掉）\n' : '（孤儿已清掉）\n')
    } else {
      console.error(`✗ 已经有孤儿实例连着 NapCat（${np} 端口）：PID ${orphans.join(', ')}`)
      console.error('  端口没被占 **不等于** 没有实例在跑：上一次没收干净会留下"孤儿 worker"——')
      console.error('  它不再监听端口，但照样收 NapCat 的广播（NapCat 是发给**所有**客户端的），')
      console.error('  于是每条命令被回答两次、每次主动发言也是两遍（坑 57）。')
      console.error('  先把它整棵树杀掉再启动：')
      for (const pid of orphans) console.error(`    taskkill /PID ${pid} /T /F`)
      console.error('  或者直接让本脚本替你收：node tools\\run-prod.cjs --kill-orphans --log-level 3')
      process.exit(1)
    }
  }

  /**
   * ★ 2026-10-06 补（坑 78 的另一半）："端口被占、但占它的进程没连着 NapCat"。
   *   本文件上面的注释说 `--takeover` 覆盖这种情形，但那时 `clients` 为空 → `targets` 为空
   *   → 上面那段整个跳过 → 掉到下面的端口检查里报错退出，**同样收不掉**。
   *   只有显式 `--takeover` 时才敢动，而且**只动 node.exe**（裸杀别的进程风险太大）。
   */
  if (takeover && (await portBusy(PORT)) && holder && holder !== process.pid) {
    if (!isNodePid(holder)) {
      console.error(`✗ ${PORT} 被 PID ${holder} 占着，而它不是 node.exe —— 不敢动它，请自己确认后再启动。`)
      process.exit(1)
    }
    console.log(`（--takeover：收掉占着 ${PORT} 但没连 NapCat 的 node 进程 PID ${holder}）`)
    killTree(holder)
    await sleep(1200)
  }

  if (await portBusy(PORT)) {
    console.error(`✗ ${PORT} 已经被占用（PID ${holder ?? '?'}）—— 生产实例已经在跑了，不要再起一个（见坑 6）。`)
    console.error(`  要看它在不在：Get-NetTCPConnection -State Listen -LocalPort ${PORT}`)
    console.error('  要"重启"就让它连旧实例一起收掉：node tools\\run-prod.cjs --takeover --log-level 3')
    console.error('  安全停止见 docs/17-常用命令速查.md 里的那段脚本。')
    process.exit(1)
  }

  /**
   * 日志按**本地日期**一个文件（`prod-2026-10-06.log`），运行中跨天会自动换文件。
   *
   * ★ 两个都修过（2026-10-06）：
   *   ① 原来用 `toISOString()` 取日期 = **UTC**，东八区在早上 08:00 才换日，
   *      于是 `prod-2026-10-05.log` 里会出现 `2026-10-06 00:33` 的行。
   *   ② 原来流是 `flags:'w'` 且开机就不再换：跑过半夜只会一直写老文件；
   *      而同一天重启一次又会**覆盖**上一段日志。现在同名文件先存档
   *      （`prod-2026-10-06.prev-013000.log`）再写新的，排障要看"上一段"也拿得到。
   */
  const logPathForDate = (date) => path.join(LOG_DIR, `prod-${date}.log`)
  const tee = makeRotatingTee(logPathForDate)
  // 退出时清扫要把"本次写过的那几个文件"钉住，跨天换过文件则两个都算
  const firstFile = tee.file
  // 有数据进来时顺手看一眼要不要换日（写日志本身足够频繁，不用额外定时器）
  const teeWrite = (line) => {
    tee.rotate()
    tee.write(line)
  }
  console.log(`（这次输出会写到 ${path.relative(process.cwd(), tee.file)}）`)
  console.log(`（跨天会自动换到新文件；同名旧日志先存成 .prev-<HHMMSS>.log；历史日志超过 ${keepDays} 天会在退出时清掉）`)

  const bin = path.join(APP, 'node_modules', 'koishi', 'bin.js')
  const args = [bin, 'start', ...passthrough]
  console.log(`（启动：node ${path.relative(APP, bin)} start ${passthrough.join(' ')}）\n`)

  const child = spawn(process.execPath, args, { cwd: APP, env: process.env, stdio: ['inherit', 'pipe', 'pipe'] })
  const pipe = (stream) => {
    let buf = ''
    stream.on('data', (d) => {
      buf += d.toString()
      const lines = buf.split('\n')
      buf = lines.pop()
      for (const l of lines) {
        process.stdout.write(l + '\n')
        teeWrite(l)
      }
    })
  }
  pipe(child.stdout)
  pipe(child.stderr)

  let done = false
  const finish = async (code) => {
    if (done) return
    done = true
    await tee.end()

    if (!has('no-prune')) {
      const r = pruneLogs({
        dirs: [LOG_DIR, __dirname],
        keepDays,
        keepFiles: [firstFile, tee.file],
      })
      if (r.deleted > 0) {
        console.log(`\n=== 日志保留：删了 ${r.deleted} 个超期日志（>${keepDays} 天），释放 ${(r.freed / 1024).toFixed(0)} KB ===`)
      }
    }
    console.log(`本次日志在 ${path.relative(process.cwd(), tee.file)}`)
    process.exit(code)
  }

  // child 退出 -> 落盘 -> 清扫 -> 退出。exit 处理器里不能 await（会丢输出），统一交给 finish。
  child.on('exit', (code) => {
    console.log(`\n[koishi 退出 code=${code}]`)
    void finish(code ?? 0)
  })

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      console.log(`\n收到 ${sig}，收尾中…`)
      if (child.pid) killTree(child.pid)
      // 不在这里 finish：杀掉 child 会触发上面的 exit 处理器，由它统一收尾
    })
  }
}

void main()
