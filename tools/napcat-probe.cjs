#!/usr/bin/env node
/**
 * NapCat OneBot 诊断探针（独立于 Koishi）
 *
 * 直连 NapCat 的 OneBot WS 服务器观察事件流，或主动调 API 查询/发消息。
 * NapCat 会把事件广播给所有已连接客户端，所以本探针不会抢走 Koishi 的事件。
 *
 * 用法：
 *   node tools/napcat-probe.cjs watch --seconds 120     # 观察事件流（心跳折叠）
 *   node tools/napcat-probe.cjs watch --verbose         # 连心跳一起打印
 *   node tools/napcat-probe.cjs info                    # 账号状态 / 群列表 / 好友列表
 *   node tools/napcat-probe.cjs send-private <QQ> <文本>
 *   node tools/napcat-probe.cjs send-group <群号> <文本>
 */
const fs = require('node:fs')

const CONFIG = 'H:/NapCat.Shell/config/onebot11_2178517838.json'

function loadEndpoint() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'))
  const list = cfg?.network?.websocketServers ?? []
  const srv = list.find((s) => s.name === 'koishi') ?? list[0]
  if (!srv) throw new Error('NapCat 配置里没有 websocketServers')
  const token = srv.token ? `?access_token=${encodeURIComponent(srv.token)}` : ''
  return { url: `ws://${srv.host}:${srv.port}/${token}`, srv }
}

const { url, srv } = loadEndpoint()
const argv = process.argv.slice(2)
const cmd = argv[0] || 'watch'
const verbose = argv.includes('--verbose')
const secondsArg = argv.indexOf('--seconds')
const seconds = secondsArg >= 0 ? Number(argv[secondsArg + 1]) : 120

const stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false })

console.log(`[probe] 连接 ${url.replace(/access_token=.*/, 'access_token=***')}（服务器 "${srv.name}"）`)

const sock = new WebSocket(url)
let echo = 0
const pending = new Map()
let events = 0
let heartbeats = 0
const kinds = new Map()

function call(action, params = {}, timeout = 20000) {
  const id = ++echo
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`${action} 超时（${timeout}ms）`))
    }, timeout)
    pending.set(id, { resolve, reject, timer, action })
    sock.send(JSON.stringify({ action, params, echo: id }))
  })
}

const brief = (s, n = 160) => {
  const t = typeof s === 'string' ? s : JSON.stringify(s)
  return t && t.length > n ? `${t.slice(0, n)}…` : t
}

function describe(ev) {
  const bits = []
  if (ev.post_type === 'message') {
    bits.push(ev.message_type === 'group' ? `群 ${ev.group_id}` : `私聊 ${ev.user_id}`)
    bits.push(`发送者 ${ev.user_id}${ev.sender?.card ? `(${ev.sender.card})` : ev.sender?.nickname ? `(${ev.sender.nickname})` : ''}`)
    bits.push(`内容 ${brief(ev.raw_message ?? ev.message, 200)}`)
  } else if (ev.post_type === 'notice') {
    bits.push(`${ev.notice_type}/${ev.sub_type}`)
    bits.push(`群 ${ev.group_id ?? '-'} 用户 ${ev.user_id ?? '-'}`)
  } else if (ev.post_type === 'request') {
    bits.push(`${ev.request_type} 群 ${ev.group_id ?? '-'} 用户 ${ev.user_id ?? '-'}`)
  } else {
    bits.push(brief(ev, 200))
  }
  return bits.join(' | ')
}

sock.addEventListener('open', async () => {
  console.log('[probe] 已连接')
  try {
    if (cmd === 'info') {
      const status = await call('get_status')
      console.log('[probe] get_status =>', JSON.stringify(status.data))
      const login = await call('get_login_info')
      console.log('[probe] get_login_info =>', JSON.stringify(login.data))
      const ver = await call('get_version_info')
      console.log('[probe] get_version_info =>', JSON.stringify(ver.data))
      const groups = await call('get_group_list')
      const gl = groups.data ?? []
      console.log(`[probe] 群数量 ${gl.length}`)
      for (const g of gl) console.log(`   - ${g.group_id} ${g.group_name}（${g.member_count} 人）`)
      const friends = await call('get_friend_list')
      const fl = friends.data ?? []
      console.log(`[probe] 好友数量 ${fl.length}；前 20 个：`)
      for (const f of fl.slice(0, 20)) console.log(`   - ${f.user_id} ${f.nickname}`)
    } else if (cmd === 'send-private' || cmd === 'send-group') {
      const target = argv[1]
      const text = argv.slice(2).join(' ')
      if (!target || !text) throw new Error('用法：send-private <QQ> <文本> / send-group <群号> <文本>')
      const action = cmd === 'send-private' ? 'send_private_msg' : 'send_group_msg'
      const key = cmd === 'send-private' ? 'user_id' : 'group_id'
      const res = await call(action, { [key]: Number(target), message: text })
      console.log(`[probe] ${action} => ${JSON.stringify(res)}`)
    } else {
      console.log(`[probe] 观察事件流 ${seconds}s（心跳只计数，--verbose 可全看）`)
    }
  } catch (e) {
    console.error('[probe] 调用失败：', e.message)
  }
  if (cmd === 'watch') {
    setTimeout(() => {
      console.log(`\n[probe] 统计：事件 ${events} 条（心跳 ${heartbeats} 条）`)
      for (const [k, n] of [...kinds].sort((a, b) => b[1] - a[1])) console.log(`   ${k} × ${n}`)
      sock.close()
      process.exit(0)
    }, seconds * 1000)
  } else {
    setTimeout(() => {
      sock.close()
      process.exit(0)
    }, 1500)
  }
})

sock.addEventListener('message', (msg) => {
  let ev
  try {
    ev = JSON.parse(msg.data)
  } catch {
    return
  }
  if (ev.echo != null && pending.has(ev.echo)) {
    const p = pending.get(ev.echo)
    pending.delete(ev.echo)
    clearTimeout(p.timer)
    if (ev.status === 'failed' || ev.retcode !== 0) p.reject(new Error(`${p.action} 返回失败：${JSON.stringify(ev)}`))
    else p.resolve(ev)
    return
  }
  if (ev.post_type === 'meta_event' && ev.meta_event_type === 'heartbeat') {
    heartbeats++
    if (verbose) console.log(`${stamp()} [心跳] online=${ev.status?.online} good=${ev.status?.good}`)
    return
  }
  if (ev.post_type === 'meta_event' && ev.meta_event_type === 'lifecycle') {
    console.log(`${stamp()} [生命周期] ${JSON.stringify(ev)}`)
    return
  }
  events++
  const key = `${ev.post_type ?? '?'}/${ev.message_type ?? ev.notice_type ?? ev.request_type ?? ev.meta_event_type ?? '-'}`
  kinds.set(key, (kinds.get(key) ?? 0) + 1)
  console.log(`${stamp()} [事件] ${key} | ${describe(ev)}`)
})

sock.addEventListener('error', (e) => console.error('[probe] WS 错误：', e.message ?? e))
sock.addEventListener('close', (e) => {
  console.log(`[probe] 连接关闭 code=${e.code} reason=${e.reason || '-'}`)
  process.exit(0)
})
