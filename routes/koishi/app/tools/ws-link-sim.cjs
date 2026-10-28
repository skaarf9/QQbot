#!/usr/bin/env node
/**
 * ws-link-sim.cjs —— **链路断线模拟器**：一个可控的 TCP 代理 + HTTP 控制口。
 *
 * 为什么要它：验证 `koishi-plugin-onebot-watchdog` 必须**真实复现两种断线**，
 * 而这两种都不能拿真 NapCat 试（杀掉 NapCat 会让 QQ 掉登录、要重新扫码，还可能连累生产）。
 * 所以插一个代理在中间，用字节层面的操作精确制造断线：
 *
 *   - `cut`    ：**干净断开 + 端口消失**（对端进程死掉的样子）→ 触发 socket `close`
 *   - `freeze` ：**半开连接**：socket 不断、但两个方向都不再转发一个字节
 *                → **永远不会触发 `close`**，状态一直停在 ONLINE，只有主动探活才发现
 *
 * 它协议无关（只搬字节），所以后面接 `fake-onebot.mjs` 或任何 OneBot 服务端都行。
 *
 * 用法：
 *   node tools\ws-link-sim.cjs --listen 3012 --target 3002 --control 3013
 *
 * 控制（HTTP，默认 3013）：
 *   GET  /state                  看当前状态（是否冻结、活连接数、是否在听）
 *   POST /freeze                 冻结：不再转发任何字节，但**保持连接**（半开）
 *   POST /resume                 解冻：恢复转发
 *   POST /cut?down=12000         砍断所有连接并**停止监听** 12 秒（之后自动重新监听）
 *   POST /cut                    只砍断现有连接，立刻继续监听
 */
const net = require('node:net')
const http = require('node:http')

const argv = process.argv.slice(2)
const getArg = (n, d) => {
  const i = argv.indexOf('--' + n)
  return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d
}
const LISTEN = +getArg('listen', '3012')
const TARGET = +getArg('target', '3002')
const CONTROL = +getArg('control', '3013')

const stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '.' +
  String(new Date().getMilliseconds()).padStart(3, '0')
const log = (msg) => console.log(`[link-sim ${stamp()}] ${msg}`)

let frozen = false
let listening = false
/** @type {Set<{client: net.Socket, upstream: net.Socket}>} */
const pairs = new Set()
let connSeq = 0

function closePair(p, why) {
  if (!pairs.has(p)) return
  pairs.delete(p)
  log(`连接 #${p.id} 关闭（${why}）｜剩余 ${pairs.size}`)
  p.client.destroy()
  p.upstream.destroy()
}

function cutAll(why) {
  for (const p of [...pairs]) closePair(p, why)
}

const server = net.createServer((client) => {
  const id = ++connSeq
  const upstream = net.connect(TARGET, '127.0.0.1')
  const p = { id, client, upstream }
  pairs.add(p)
  log(`连接 #${id} 建立 → 127.0.0.1:${TARGET}｜活动 ${pairs.size}${frozen ? '（当前处于冻结态，先不转发）' : ''}`)

  client.on('error', () => closePair(p, '#client error'))
  upstream.on('error', () => closePair(p, '#upstream error'))
  client.on('close', () => closePair(p, '#client close'))
  upstream.on('close', () => closePair(p, '#upstream close'))

  if (frozen) {
    client.pause()
    upstream.pause()
  } else {
    client.pipe(upstream)
    upstream.pipe(client)
  }
})

function startListen() {
  if (listening) return
  server.listen(LISTEN, '127.0.0.1', () => {
    listening = true
    log(`开始监听 127.0.0.1:${LISTEN} → 127.0.0.1:${TARGET}`)
  })
}

function stopListen() {
  if (!listening) return
  listening = false
  server.close()
  log(`停止监听 ${LISTEN}（新的连接会被拒绝）`)
}

startListen()

const control = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const send = (obj) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(obj))
  }
  if (req.method === 'GET' && url.pathname === '/state') {
    return send({ frozen, listening, connections: pairs.size, listen: LISTEN, target: TARGET })
  }
  if (req.method === 'POST' && url.pathname === '/freeze') {
    frozen = true
    for (const p of pairs) {
      p.client.pause()
      p.upstream.pause()
    }
    log(`★ 冻结：${pairs.size} 条连接保持打开，但两个方向都不再转发（半开连接）`)
    return send({ ok: true, frozen, connections: pairs.size })
  }
  if (req.method === 'POST' && url.pathname === '/resume') {
    frozen = false
    for (const p of pairs) {
      p.client.resume()
      p.upstream.resume()
    }
    log(`解冻：恢复转发（${pairs.size} 条连接）`)
    return send({ ok: true, frozen, connections: pairs.size })
  }
  if (req.method === 'POST' && url.pathname === '/cut') {
    const down = Number(url.searchParams.get('down') ?? '0')
    const n = pairs.size
    cutAll('被 /cut 砍断')
    if (down > 0) {
      stopListen()
      log(`★ 端口下线 ${down}ms（模拟对端进程消失）`)
      setTimeout(() => {
        startListen()
        log(`端口恢复，等待对端重连`)
      }, down)
    }
    return send({ ok: true, cut: n, down, listening })
  }
  res.writeHead(404)
  res.end('not found')
})

control.listen(CONTROL, '127.0.0.1', () => {
  log(`控制口 http://127.0.0.1:${CONTROL}  （GET /state、POST /freeze|/resume|/cut?down=ms）`)
})

process.on('SIGINT', () => {
  log('收到 SIGINT，退出')
  process.exit(0)
})
