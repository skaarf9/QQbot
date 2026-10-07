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
const path = require('node:path')

/**
 * ★ 2026-10-04：这里原来写死 `H:/NapCat.Shell/config/onebot11_2178517838.json`。
 *   NapCat 后来搬到了 D 盘，于是**排障第一步直接 ENOENT 崩掉**（docs/23 那套五分钟定位流程
 *   第一句就跑不动）—— 是查「两条回复」时顺带撞见的（坑 70）。
 *   现在自动找：优先挑"有启用的 websocketServers、且服务器名是 koishi"的那份配置。
 *   想手工指定：NAPCAT_CONFIG=<onebot11_xxx.json 全路径>，或 NAPCAT_HOME=<NapCat.Shell 目录>。
 */
const CANDIDATE_ROOTS = [
  process.env.NAPCAT_HOME,
  'D:/deepseek/QQbot/NapCat.Shell',
  'H:/NapCat.Shell',
  'D:/NapCat.Shell',
].filter(Boolean)

/** 在候选根目录里挑一份可用的 onebot11_*.json */
function findConfig() {
  if (process.env.NAPCAT_CONFIG) {
    return { file: process.env.NAPCAT_CONFIG, cfg: JSON.parse(fs.readFileSync(process.env.NAPCAT_CONFIG, 'utf8')) }
  }
  const hits = []
  for (const root of CANDIDATE_ROOTS) {
    const dir = path.join(root, 'config')
    if (!fs.existsSync(dir)) continue
    for (const name of fs.readdirSync(dir)) {
      if (!/^onebot11_.+\.json$/.test(name)) continue
      const file = path.join(dir, name)
      let cfg
      try {
        cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
      } catch {
        continue
      }
      const enabled = (cfg?.network?.websocketServers ?? []).filter((s) => s.enable !== false)
      if (!enabled.length) continue
      const koishi = enabled.find((s) => s.name === 'koishi')
      hits.push({ file, cfg, rank: koishi ? 0 : 1, mtime: fs.statSync(file).mtimeMs })
    }
  }
  if (!hits.length) {
    throw new Error(
      `找不到带启用 websocketServers 的 NapCat onebot11 配置。找过：${CANDIDATE_ROOTS.join(' / ')}；` +
        '可用 NAPCAT_CONFIG=<文件全路径> 直接指定。',
    )
  }
  // 服务器名叫 koishi 的优先；同档取最近改过的
  hits.sort((a, b) => a.rank - b.rank || b.mtime - a.mtime)
  return hits[0]
}

function loadEndpoint() {
  const { file, cfg } = findConfig()
  const list = cfg?.network?.websocketServers ?? []
  const srv = list.find((s) => s.name === 'koishi' && s.enable !== false) ?? list.find((s) => s.enable !== false) ?? list[0]
  if (!srv) throw new Error('NapCat 配置里没有 websocketServers')
  const token = srv.token ? `?access_token=${encodeURIComponent(srv.token)}` : ''
  return { url: `ws://${srv.host}:${srv.port}/${token}`, srv, file }
}

const { url, srv, file: configFile } = loadEndpoint()
const argv = process.argv.slice(2)
const cmd = argv[0] || 'watch'
const verbose = argv.includes('--verbose')
const secondsArg = argv.indexOf('--seconds')
const seconds = secondsArg >= 0 ? Number(argv[secondsArg + 1]) : 120

const stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false })

console.log(`[probe] 连接 ${url.replace(/access_token=.*/, 'access_token=***')}（服务器 "${srv.name}"，配置 ${configFile}）`)

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
    } else if (cmd === 'call') {
      // 通用调用：call <action> [JSON 参数]，排查时不用改代码
      const action = argv[1]
      if (!action) throw new Error('用法：call <action> [JSON 参数]，例如 call get_recent_contact / call get_group_msg_history {"group_id":454444539,"count":5}')
      const params = argv[2] ? JSON.parse(argv.slice(2).join(' ')) : {}
      const res = await call(action, params)
      const body = JSON.stringify(res.data ?? res)
      console.log(`[probe] ${action} => ${body.length > 4000 ? `${body.slice(0, 4000)}…` : body}`)
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
