/* ============================================================================
   QQbot 控制面板 —— 前端逻辑（无框架、无依赖）
   三件事：①每 2 秒拉一次 /api/state 刷新状态 ②两条 SSE 收日志并渲染
          ③把按钮映射到 /api/* 的动作上
   ========================================================================== */
'use strict'

const TOKEN = document.querySelector('meta[name="panel-token"]').content
const $ = (sel) => document.querySelector(sel)
const $$ = (sel) => Array.from(document.querySelectorAll(sel))

// ------------------------------------------------------------------ 基础设施
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: Object.assign({ 'X-Panel-Token': TOKEN }, body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  })
  let json = null
  try {
    json = await res.json()
  } catch {
    /* 非 JSON 就当空 */
  }
  if (!res.ok || (json && json.ok === false)) throw new Error((json && json.error) || `HTTP ${res.status}`)
  return json
}

function toast(msg, kind = '') {
  const el = document.createElement('div')
  el.className = 'toast ' + kind
  el.innerHTML = richText(msg) || ''
  $('#toasts').appendChild(el)
  setTimeout(() => {
    el.style.opacity = '0'
    el.style.transition = 'opacity .3s'
    setTimeout(() => el.remove(), 320)
  }, kind === 'err' ? 8000 : 4200)
}

/**
 * 提示文案里的 **粗体** 标记要真的粗起来：对话框/提示是纯文本，直接 textContent 会把
 * 星号原样显示（`**真实**` → "**真实**"）。先转义再放行这一种标记，避免注入。
 */
const escapeHtml = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const richText = (s) => escapeHtml(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')

function confirmBox(title, text, okLabel = '确认') {
  return new Promise((resolve) => {
    const dlg = $('#confirm-dialog')
    $('#confirm-title').textContent = title
    $('#confirm-text').innerHTML = richText(text)
    $('#confirm-ok').textContent = okLabel
    const done = (v) => {
      dlg.close()
      $('#confirm-ok').removeEventListener('click', onOk)
      $('#confirm-cancel').removeEventListener('click', onCancel)
      resolve(v)
    }
    const onOk = () => done(true)
    const onCancel = () => done(false)
    $('#confirm-ok').addEventListener('click', onOk)
    $('#confirm-cancel').addEventListener('click', onCancel)
    dlg.showModal()
  })
}

const fmtDur = (ms) => {
  if (!ms || ms < 1000) return '—'
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return (d ? d + 'd ' : '') + (h ? h + 'h ' : '') + (m ? m + 'm ' : '') + sec + 's'
}
const hhmmss = (ts) => new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
/** 人类可读的"多久之前" */
const fmtAge = (sec) => {
  if (sec < 60) return `${sec} 秒`
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟`
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小时`
  return `${Math.floor(sec / 86400)} 天`
}

// ------------------------------------------------------------------ 状态刷新
let state = null
const last = { qrUrl: '', comment: '' }

async function refreshState() {
  try {
    state = await api('/api/state')
  } catch (e) {
    setStreamState('koishi', '面板连接中断：' + e.message, 'dead')
    return
  }
  renderState(state)
}

function setDot(key, cls) {
  const el = document.querySelector(`[data-dot="${key}"]`)
  if (el) el.className = 'dot ' + cls
}
function setPill(key, text, cls) {
  const el = document.querySelector(`[data-pill="${key}"]`)
  if (!el) return
  el.textContent = text
  el.className = 'pill ' + (cls || '')
}

function renderState(s) {
  const k = s.services.koishi
  const n = s.services.napcat
  const now = Date.now()

  // ---- Koishi
  setDot('koishi', k.running ? 'on' : 'off')
  setPill('koishi', k.running ? (k.ready ? '运行中' : '启动中…') : `已停止${k.lastExit ? `（code=${k.lastExit.code}）` : ''}`, k.running ? 'on' : '')
  $('[data-kv="koishi-pid"]').textContent = k.pid ? k.pid : '—'
  $('[data-kv="koishi-uptime"]').textContent = k.running && k.startedAt ? fmtDur(now - k.startedAt) : '—'
  $('[data-kv="koishi-port"]').textContent = `${k.port} ${k.ready ? '✓ 监听' : '✗ 未监听'}`
  $('[data-kv="koishi-onebot"]').textContent = k.onebotUp ? `ws://127.0.0.1:${k.onebotPort} ✓` : `ws://127.0.0.1:${k.onebotPort} ✗（等 NapCat）`
  setLink('koishi', k.webui.url)

  // ---- NapCat
  setDot('napcat', n.running ? 'on' : n.starting ? 'warn' : 'off')
  setPill(
    'napcat',
    n.running ? (n.webuiUp ? '运行中' : '内核已启，WebUI 未就绪') : n.starting ? '启动中…（等 UAC/QQ 起来）' : '已停止',
    n.running ? (n.webuiUp ? 'on' : 'warn') : n.starting ? 'warn' : '',
  )
  $('[data-kv="napcat-qq"]').textContent = n.qqPids.length ? `${n.qqPids.length} 个${n.uin ? `（账号 ${n.uin}）` : ''}` : '—'
  $('[data-kv="napcat-uptime"]').textContent = n.running && n.startedAt ? fmtDur(now - n.startedAt) : '—'
  $('[data-kv="napcat-webui-port"]').textContent = `${n.ports.webui} ${n.webuiUp ? '✓ 监听' : '✗ 未监听'}`
  $('[data-kv="napcat-onebot-port"]').textContent = n.ports.onebot
    ? `${n.ports.onebot} ${n.onebotUp ? '✓ 监听（已登录）' : '✗ 未监听（未登录）'}`
    : '—'
  setLink('napcat', n.webui.url)
  // 版本选择器：只在用户没在动它的时候同步服务端状态
  const vs = $('#napcat-variant')
  if (vs && document.activeElement !== vs && n.variant && vs.value !== n.variant.key) vs.value = n.variant.key
  if (vs) {
    for (const opt of vs.options) {
      const info = (n.variants || []).find((v) => v.key === opt.value)
      if (info && !info.available) opt.textContent = (info.label || opt.value) + '（不可用）'
    }
  }

  // 提示行：把"上次失败 + 管理员/UAC 现状"说清楚
  const hints = []
  if (state.app && state.app.elevated) {
    hints.push('✔ 面板已经以管理员运行：启动 NapCat 不会再弹 UAC，直接起。')
  } else {
    hints.push(
      '面板不是管理员 → 启动 NapCat 需要提权。本机实测：面板自己那条隐藏的 UAC 请求**弹不出提示**，' +
        '所以先用「控制台启动」（它会开一个真实控制台，走 tools\\start-napcat-shell.bat 自己的提权，' +
        '和你双击脚本完全一样）；' +
        '要彻底免掉 UAC：关掉面板，重新双击 启动面板.cmd —— 它现在会自己请求一次提权，' +
        '面板以管理员跑起来之后，启动 NapCat 就再也不碰 UAC 了。',
    )
  }
  if (n.lastStartError) hints.unshift('上次启动失败：' + n.lastStartError)
  $('#napcat-hint').innerHTML = richText(hints.join(' '))

  // 单实例冲突警告：两个变体**都会启动并注入你已装的那个 QQ**
  const conflict = $('#napcat-conflict')
  if (n.qqPids.length) {
    conflict.innerHTML = richText(
      `⚠ 检测到 ${n.qqPids.length} 个 QQ.exe 正在运行：Shell 与 Framework **都要启动并注入你已装的这个 QQ**` +
        '（本机是 F:\\qq\\QQ.exe），QQNT 是单实例的 —— 主号开着时 NapCat 很可能注入不进去' +
        '（只会把已有窗口切到前台，日志里多几行就没了）。换「版本」解决不了这件事，' +
        '只能：① 先退出主号 QQ 再启动；或 ② 另装一份 QQ 专供 NapCat。',
    )
    conflict.style.color = 'var(--warn)'
    conflict.style.display = ''
  } else {
    conflict.style.display = 'none'
  }
  document.querySelector('[data-copy="napcat-cmd"]').dataset.value = n.variant ? n.variant.bat : ''
  document.querySelector('[data-copy="napcat-token"]').dataset.value = n.webui.token || ''

  // ---- 登录 / 二维码
  const lg = s.login
  const d = lg.checked
  const rawQr = lg.qr && lg.qr.exists ? lg.qr : null
  const qrAge = rawQr ? Math.max(0, Math.round((now - rawQr.mtime) / 1000)) : 0
  // ★ 已登录 / NapCat 没在跑时，cache 里那张图是**旧图**（NapCat 不会删掉它），
  //   直接当"当前二维码"显示会骗人 —— 只有"没登录 + NapCat 在跑或图很新（<3 分钟）"才展示。
  const showQr = !!rawQr && !(d && d.isLogin) && (n.running || qrAge < 180)
  const qrUrl = showQr && lg.qr.url ? lg.qr.url : ''
  if (qrUrl && qrUrl !== last.qrUrl) {
    const img = $('#qr-img')
    img.src = qrUrl
    img.classList.add('show')
    $('#qr-empty').classList.add('hide')
    last.qrUrl = qrUrl
  } else if (!qrUrl && last.qrUrl) {
    $('#qr-img').classList.remove('show')
    $('#qr-empty').classList.remove('hide')
    last.qrUrl = ''
  }
  if (!qrUrl) {
    const box = $('#qr-empty')
    box.classList.remove('hide')
    const main = !n.running ? '等待 NapCat 启动' : d && d.isLogin ? '已经登录，不需要二维码' : '还没有生成二维码'
    const detail = rawQr
      ? `cache/qrcode.png 里有一张 ${fmtAge(qrAge)}前的旧图<br />NapCat 生成新码时会自动换上来`
      : '等服务起来就会出现'
    box.innerHTML = ''
    const b = document.createElement('div')
    b.textContent = main
    const sm = document.createElement('small')
    sm.innerHTML = detail
    box.append(b, sm)
  }

  const phaseMap = {
    waiting_qrcode: ['等待扫码登录', 'warn'],
    generating_qrcode: ['正在生成二维码…', 'warn'],
    qrcode_scanned: ['已扫码，等待手机确认', 'warn'],
    initializing: ['初始化中…', 'warn'],
    ready: ['已登录，运行中', 'on'],
    reconnecting: ['QQ 断线，重连中…', 'err'],
    offline: ['未登录 / 离线', ''],
  }
  let phaseText = '—'
  let phaseCls = ''
  if (lg.ok && d) {
    const p = phaseMap[d.loginPhase] || [d.loginPhase || '未知', '']
    phaseText = p[0]
    phaseCls = p[1]
    if (d.isLogin) phaseText = d.isOffline ? 'QQ 已登录但离线' : 'QQ 已登录，在线'
  } else if (lg.webuiUp === false) {
    phaseText = 'NapCat 未运行'
  } else if (lg.error) {
    phaseText = '读不到登录状态'
  }
  $('#login-phase').innerHTML = ''
  const ph = document.createElement('div')
  ph.innerHTML = '状态：<b></b>'
  ph.querySelector('b').textContent = phaseText
  $('#login-phase').appendChild(ph)
  setDot('login', phaseCls === 'on' ? 'on' : phaseCls === 'warn' ? 'warn' : phaseCls === 'err' ? 'err' : 'off')
  setPill('login', phaseText, phaseCls)

  if (rawQr) {
    const stale = qrAge > 150 && !(d && d.isLogin)
    $('#login-age').textContent =
      `二维码文件刷新于 ${qrAge}s 前（${hhmmss(rawQr.mtime)}，${(rawQr.size / 1024).toFixed(1)} KB）` +
      (showQr ? (stale ? ' · 可能已过期，点「刷新二维码」' : '') : ' · 旧图，未展示')
    $('#login-age').style.color = stale && showQr ? 'var(--warn)' : ''
  } else {
    $('#login-age').textContent = lg.qr ? '二维码文件：' + lg.qr.file + '（不存在）' : ''
    $('#login-age').style.color = ''
  }
  $('#login-error').textContent = lg.ok ? d && d.loginError ? '登录错误：' + d.loginError : '' : lg.error || ''
  $('#card-login').classList.toggle('hot', !!(d && d.loginPhase === 'waiting_qrcode' && !d.isLogin))

  // ---- 按钮可用性
  const busyK = s.busy.koishi
  const busyN = s.busy.napcat
  const setBtn = (act, disabled, label) => {
    const b = document.querySelector(`[data-act="${act}"]`)
    if (!b) return
    b.disabled = !!disabled
    if (label) b.textContent = label
  }
  setBtn('koishi-start', busyK || k.running, busyK === 'start' ? '启动中…' : '启动')
  setBtn('koishi-stop', busyK || !k.running, busyK === 'stop' ? '停止中…' : '停止')
  setBtn('koishi-restart', busyK || !k.running, '重启')
  setBtn('napcat-start', busyN || n.running || n.starting, busyN === 'start' ? '启动中…' : '启动')
  setBtn('napcat-stop', busyN || (!n.running && !n.starting), busyN === 'stop' ? '停止中…' : '停止')
  setBtn('napcat-restart', busyN || (!n.running && !n.starting), '重启')
  setBtn('qr-refresh', !n.webuiUp, '↻ 刷新二维码')
  setBtn('napcat-relogin', !n.webuiUp, '⤾ 重新登录')
  $('#btn-start-all').disabled = !!(busyK || busyN)
  $('#btn-stop-all').disabled = !!(busyK || busyN)

  syncSources('koishi', k)
  syncSources('napcat', n)
}

function setLink(key, url) {
  for (const a of $$(`[data-link="${key}"]`)) a.href = url || '#'
}

/** 日志源下拉：只在集合变化时重建，避免打断用户的选择 */
function syncSources(service, svc) {
  const sel = $('#log-source')
  if (activeService !== service) return
  const ids = svc.sources.map((s) => s.id).join('|')
  if (sel.dataset.ids !== ids) {
    sel.dataset.ids = ids
    const keep = sel.value
    sel.innerHTML = ''
    const auto = document.createElement('option')
    auto.value = 'auto'
    auto.textContent = '自动（推荐）'
    sel.appendChild(auto)
    for (const s of svc.sources) {
      const o = document.createElement('option')
      o.value = s.id
      o.textContent = `${s.label}${s.lines ? ` · ${s.lines} 行` : ''}`
      sel.appendChild(o)
    }
    sel.value = ids.split('|').includes(keep) ? keep : 'auto'
  }
  // "自动"意味着**跟着服务的真实状态走**：面板起 Koishi 前默认看按天日志文件，
  // 起了之后应该切到子进程的实时输出（那里还有启动器自己的话）。
  // 服务端的自动源是在 SSE 建连那一刻算的，所以这里发现该换源就重连一次。
  if (sel.value === 'auto' && metaOf[service] && svc.defaultSource && metaOf[service].source !== svc.defaultSource) {
    openStream(service, 'auto')
  }
}

// ------------------------------------------------------------------ 日志流
const buffers = { koishi: [], napcat: [] }
const streams = { koishi: null, napcat: null }
const metaOf = { koishi: null, napcat: null }
const streamState = { koishi: ['未连接', ''], napcat: ['未连接', ''] }
/** 增量计数：每条都全量扫缓冲会在大刷屏时卡住（2000 行 × 每秒几十条） */
const stats = { koishi: { warn: 0, error: 0 }, napcat: { warn: 0, error: 0 } }
let activeService = 'koishi'
const filter = { levels: new Set(['all']), search: [] }
const BUF_MAX = 3000
const DOM_MAX = 1200

function setStreamState(service, text, cls) {
  streamState[service] = [text, cls || '']
  if (activeService !== service) return
  const el = $('#stream-state')
  el.textContent = text
  el.className = 'stream-state ' + (cls || '')
}

function recount(service) {
  let warn = 0
  let error = 0
  for (const r of buffers[service]) {
    if (r.lvl === 'warn') warn++
    else if (r.lvl === 'error') error++
  }
  stats[service] = { warn, error }
}

function openStream(service, source) {
  const old = streams[service]
  if (old) old.close()
  const qs = new URLSearchParams({ service, token: TOKEN })
  if (source && source !== 'auto') qs.set('source', source)
  const es = new EventSource('/api/logs/stream?' + qs.toString())
  streams[service] = es
  es.addEventListener('open', () => setStreamState(service, '● 实时连接中', 'live'))
  es.addEventListener('error', () => setStreamState(service, '○ 连接中断，重连中…', 'dead'))
  es.addEventListener('meta', (ev) => {
    const meta = JSON.parse(ev.data)
    metaOf[service] = meta
    updateLogStatus()
  })
  es.addEventListener('backlog', (ev) => {
    const arr = JSON.parse(ev.data)
    for (const r of arr) r.svc = service
    buffers[service] = arr.slice(-BUF_MAX)
    recount(service)
    if (activeService === service || activeService === 'merge') renderLog()
    else updateLogStatus()
  })
  es.addEventListener('line', (ev) => {
    const rec = JSON.parse(ev.data)
    rec.svc = service
    const buf = buffers[service]
    buf.push(rec)
    if (buf.length > BUF_MAX) buf.splice(0, buf.length - BUF_MAX)
    if (rec.lvl === 'warn') stats[service].warn++
    else if (rec.lvl === 'error') stats[service].error++
    if (activeService === service || activeService === 'merge') appendLine(rec, service)
    else updateLogStatus()
  })
}

function closeStreams() {
  for (const s of Object.keys(streams)) {
    if (streams[s]) streams[s].close()
    streams[s] = null
  }
}

// ------------------------------------------------------------------ 过滤与渲染
const LEVEL_LETTER = { info: 'I', success: 'S', warn: 'W', error: 'E', debug: 'D', trace: 'T' }

function matches(rec) {
  if (!filter.levels.has('all') && !filter.levels.has(rec.lvl)) return false
  const words = filter.search
  if (words.length) {
    const t = rec.text.toLowerCase()
    for (const w of words) if (!t.includes(w)) return false
  }
  return true
}

const TS_RE = /^(\d{4}-\d{2}-\d{2} (\d{2}:\d{2}:\d{2}))\s/ // Koishi
const TS_RE2 = /^(\d{2}-\d{2} (\d{2}:\d{2}:\d{2}))\s/ // NapCat（winston）
/** NapCat 会把终端二维码打进日志（qrcode-terminal 的块字符），行高压紧才扫得动 */
const QR_BLOCK_RE = /^[\s█▀▄▌▐░▒▓]{16,}$/

function buildLine(rec, service) {
  const el = document.createElement('div')
  let cls = 'line lvl-' + rec.lvl
  for (const t of rec.tags || []) cls += ' tag-' + t
  let text = rec.text
  let stamp = hhmmss(rec.ts)
  let clock = false
  const m = TS_RE.exec(text) || TS_RE2.exec(text)
  if (m) {
    stamp = m[2]
    text = text.slice(m[0].length)
  } else {
    clock = true
  }
  const blocks = (text.match(/[█▀▄▌▐░▒▓]/g) || []).length
  // 阈值取 0.3：终端二维码的行里空格很多（实测一行块字符占比 0.32~0.5）
  if (text.length >= 20 && blocks >= 8 && blocks / text.length >= 0.3 && QR_BLOCK_RE.test(text)) cls += ' qrt'
  el.className = cls
  if (service === 'napcat' && !clock) el.dataset.svc = 'napcat'

  const ts = document.createElement('span')
  ts.className = 'ts'
  ts.textContent = clock ? '· ' + stamp : stamp
  ts.title = new Date(rec.ts).toLocaleString('zh-CN', { hour12: false })

  const lvl = document.createElement('span')
  lvl.className = 'lvl'
  lvl.textContent = LEVEL_LETTER[rec.lvl] || '·'

  const txt = document.createElement('span')
  txt.className = 'txt'
  appendHighlighted(txt, text, filter.search)

  el.append(ts, lvl, txt)
  return el
}

/** 关键字高亮：用 DOM 拼，绝不 innerHTML 用户内容 */
function appendHighlighted(parent, text, words) {
  if (!words || !words.length) {
    parent.textContent = text
    return
  }
  const lower = text.toLowerCase()
  const hits = []
  for (const w of words) {
    let i = lower.indexOf(w)
    while (i >= 0) {
      hits.push([i, i + w.length])
      i = lower.indexOf(w, i + w.length)
    }
  }
  if (!hits.length) {
    parent.textContent = text
    return
  }
  hits.sort((a, b) => a[0] - b[0])
  let cur = 0
  for (const [a, b] of hits) {
    if (a < cur) continue
    if (a > cur) parent.appendChild(document.createTextNode(text.slice(cur, a)))
    const mk = document.createElement('mark')
    mk.textContent = text.slice(a, b)
    parent.appendChild(mk)
    cur = b
  }
  if (cur < text.length) parent.appendChild(document.createTextNode(text.slice(cur)))
}

function nearBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 60
}

function appendLine(rec, service) {
  if (!matches(rec)) return
  const view = $('#log-view')
  const stick = $('#log-autoscroll').checked && nearBottom(view)
  const el = buildLine(rec, service)
  if (activeService === 'merge') {
    const tag = document.createElement('span')
    tag.className = 'ts'
    tag.style.width = 'auto'
    tag.textContent = service === 'koishi' ? '[K]' : '[N]'
    tag.style.color = service === 'koishi' ? '#6f9bff' : '#ffb0e0'
    el.insertBefore(tag, el.firstChild)
  }
  view.appendChild(el)
  while (view.childElementCount > DOM_MAX) view.removeChild(view.firstChild)
  if (stick) view.scrollTop = view.scrollHeight
  updateLogStatus()
}

let renderTimer = null
function renderLog() {
  clearTimeout(renderTimer)
  renderTimer = setTimeout(doRenderLog, 40)
}

function doRenderLog() {
  const view = $('#log-view')
  const stick = $('#log-autoscroll').checked && nearBottom(view)
  view.innerHTML = ''
  const frag = document.createDocumentFragment()
  if (activeService === 'merge') {
    const all = buffers.koishi.concat(buffers.napcat).sort((a, b) => a.ts - b.ts)
    const picked = all.filter(matches).slice(-DOM_MAX)
    for (const rec of picked) frag.appendChild(buildLine(rec, rec.svc || 'koishi'))
  } else {
    const picked = buffers[activeService].filter(matches).slice(-DOM_MAX)
    for (const rec of picked) frag.appendChild(buildLine(rec, activeService))
  }
  view.appendChild(frag)
  if (stick) view.scrollTop = view.scrollHeight
  updateLogStatus()
}

function updateLogStatus() {
  const shown = $('#log-view').childElementCount
  const total =
    activeService === 'merge' ? buffers.koishi.length + buffers.napcat.length : buffers[activeService].length
  $('#log-count').textContent = `显示 ${shown} / 缓存的 ${total} 行`
  const meta = metaOf[activeService]
  const stampOf = (m) => (m && m.mtime ? ` · 文件最后更新 ${hhmmss(m.mtime)}（${fmtAge(Math.max(0, Math.round((Date.now() - m.mtime) / 1000)))}前）` : '')
  // ★ 旧文件要显式标出来：否则用户会以为"这就是当前输出"（10-08 那次就是被一份 3 天前的
  //   napcat-framework-console.log 骗了 —— 两行旧内容看起来像"NapCat 什么都没打印"）
  const stale = !!(meta && meta.mtime && Date.now() - meta.mtime > 10 * 60 * 1000)
  $('#log-source-label').textContent =
    activeService === 'merge'
      ? 'Koishi + NapCat 按时间合并'
      : meta
        ? `${stale ? '⚠ 这是旧文件、不是实时输出 · ' : ''}${meta.label}${meta.file ? ' · ' + meta.file : ''}${stampOf(meta)}`
        : ''
  $('#log-source-label').style.color = stale ? 'var(--warn)' : ''
  const warn = activeService === 'merge' ? stats.koishi.warn + stats.napcat.warn : stats[activeService].warn
  const error = activeService === 'merge' ? stats.koishi.error + stats.napcat.error : stats[activeService].error
  $('#log-scan').textContent = `warn ${warn} · error ${error}`
  $('#log-scan').style.color = error ? 'var(--err)' : warn ? 'var(--warn)' : ''
}

// ------------------------------------------------------------------ 动作
/**
 * 启动后的"观察窗"：20 秒内 6099 还没起来、也没有明确报错，就给出诊断。
 * ★ 为什么需要：UAC 提示没被应答时，提权进程会一直挂着，界面看起来只是"启动中"，
 *   用户不知道到底卡在哪 —— 2026-10-08 现场就是这样。
 */
let watchingNapcat = false
async function watchNapcatStart() {
  if (watchingNapcat) return
  watchingNapcat = true
  try {
    for (let i = 0; i < 9; i++) {
      await new Promise((r) => setTimeout(r, 2200))
      await refreshState()
      const n = state?.services?.napcat
      if (!n) return
      if (n.webuiUp || n.running) {
        toast('NapCat 的 WebUI 端口起来了 ✔', 'ok')
        return
      }
      if (n.lastStartError) return // 已有明确失败信息，界面里写着
    }
    const n = state?.services?.napcat
    if (n && !n.running && !n.lastStartError) {
      toast(
        'NapCat 20 秒内没起来。常见三因：① 面板不是管理员、那条隐藏的 UAC 请求弹不出提示' +
          '（改用「控制台启动」，或重新双击 启动面板.cmd 让它自己提权）；' +
          '② UAC 提示没被应答；' +
          '③ 主号 QQ 占着 QQNT 单实例（Shell / Framework 都要注入那个已装的 QQ），注入不进去。' +
          ' 看 NapCat 日志页的「启动控制台捕获」，卡住可以点「复位」。',
        'err',
      )
    }
  } finally {
    watchingNapcat = false
  }
}

const ACTIONS = {
  async 'koishi-start'() {
    const body = { debug: $('#koishi-debug').checked, takeover: $('#koishi-takeover').checked }
    if (state?.services.koishi.running && !state.services.koishi.managed) {
      const ok = await confirmBox(
        '接管 Koishi',
        '检测到 5140 上已经有一个实例（可能不是本面板起的）。\n启动会调用 run-prod.cjs --takeover：把旧实例整棵树收掉再起新的，避免两条回复。\n继续？',
        '接管并启动',
      )
      if (!ok) return
    }
    await api('/api/koishi/start', { method: 'POST', body })
    toast('已请求启动 Koishi' + (body.debug ? '（debug 日志）' : ''), 'ok')
  },
  async 'koishi-stop'() {
    const ok = await confirmBox('停止 Koishi', '会把 Koishi 的整棵进程树（run-prod → CLI → worker）收掉。\nQQ/NapCat 不受影响。继续？', '停止')
    if (!ok) return
    const r = await api('/api/koishi/stop', { method: 'POST' })
    toast(r.stillListening ? `Koishi 端口还被 PID ${r.stillListening} 占着，请看一眼` : 'Koishi 已停止', r.stillListening ? 'warn' : 'ok')
  },
  async 'koishi-restart'() {
    const ok = await confirmBox('重启 Koishi', '先停再起（会接管旧实例）。继续？', '重启')
    if (!ok) return
    await api('/api/koishi/stop', { method: 'POST' })
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 700))
      await refreshState()
      if (!state.services.koishi.running) break
    }
    await api('/api/koishi/start', { method: 'POST', body: { debug: $('#koishi-debug').checked, takeover: true } })
    toast('Koishi 重启中', 'ok')
  },
  async 'napcat-start'() {
    const quick = $('#napcat-quick').value.trim()
    const variant = $('#napcat-variant').value
    const n = state?.services.napcat
    const elevated = !!state?.app?.elevated
    const wait = Math.round((state?.app?.elevateTimeoutMs || 60000) / 1000)
    const qqRunning = n && n.qqPids.length > 0
    const ok = await confirmBox(
      '启动 NapCat（' + (variant === 'shell' ? 'Shell' : 'Framework') + '）',
      (elevated
        ? '面板已经是管理员：不会再弹 UAC，直接起。\n'
        : `会弹 UAC 提权窗口（提示在**安全桌面**上、屏幕会变暗），请在 ${wait} 秒内点「是」；` +
          '超时的话面板会把提权进程收掉并报错。\n' +
          '· 一直看不到提示 → 关掉这个框，改点旁边的「控制台启动」：那是你双击脚本的同一条路。\n') +
        (quick ? `快速登录账号：${quick}\n` : '未填 QQ 号 → 走扫码登录，二维码会出现在左边面板。\n') +
        (qqRunning
          ? `\n⚠ 现在有 ${n.qqPids.length} 个 QQ.exe 在跑。两个变体都要启动并注入你已装的这个 QQ，` +
            'QQNT 是单实例的 —— 主号开着时很可能**注入不进去**（日志里只会多几行就没了）。\n' +
            '建议先退出主号 QQ 再启动。\n'
          : ''),
      '启动',
    )
    if (!ok) return
    const r = await api('/api/napcat/start', { method: 'POST', body: { quickLogin: quick, variant } })
    // 启动输出（含失败原因）在 NapCat 的日志页，这里把它切到"自动"并重连一次
    if (activeService === 'napcat') {
      $('#log-source').value = 'auto'
      openStream('napcat', 'auto')
    }
    toast(r.elevatedPath ? '面板已提权：NapCat 直接启动（无 UAC），输出看 NapCat 日志页' : '已请求提权启动 NapCat，请在 UAC 窗口点「是」；输出看 NapCat 日志页', 'ok')
    watchNapcatStart()
  },
  async 'napcat-start-console'() {
    const quick = $('#napcat-quick').value.trim()
    const variant = $('#napcat-variant').value
    const n = state?.services.napcat
    const ok = await confirmBox(
      '在控制台里启动 NapCat（' + (variant === 'shell' ? 'Shell' : 'Framework') + '）',
      '会弹出一个**真实的控制台窗口**，里面跑的就是 tools\\start-napcat-' +
        (variant === 'shell' ? 'shell' : 'framework') +
        '.bat —— 和你平时双击那个脚本完全一样：脚本自己会去要 UAC，你在那个窗口/提示里点「是」。\n\n' +
        '· 这条路不需要面板有管理员权限，也是提权提示没弹出来时的备用方案；\n' +
        '· 代价：NapCat 的实时输出在那个控制台窗口里，面板的「启动控制台捕获」只有包装器那几行；\n' +
        '· 那个窗口别关（关了就看不见日志了；NapCat 本体不受影响）。\n' +
        (n && n.qqPids.length ? `\n⚠ 现在有 ${n.qqPids.length} 个 QQ.exe 在跑，主号占着单实例时注入会失败。\n` : ''),
      '控制台启动',
    )
    if (!ok) return
    await api('/api/napcat/start-console', { method: 'POST', body: { quickLogin: quick, variant } })
    toast('已弹出控制台窗口，请在弹出的窗口里应答 UAC', 'ok')
    watchNapcatStart()
  },
  async 'napcat-stop'() {
    // 面板知道 NapCat 是不是自己起的（记着启动时间）：
    //   自己起的 → 只收"启动时间在那之后"的 QQ.exe，你原本开着的主号 QQ 不会被动
    //   不知道谁起的 → 只能照仓库里 KillQQ.bat 的做法全杀，这里必须把话说清楚
    const managed = !!state?.services.napcat.managed
    const text = managed
      ? '会收掉【NapCat 自己拉起来的】QQ.exe（按进程启动时间识别），你原本开着的其它 QQ 不受影响。\n\n确定要停吗？'
      : '★ 面板不知道这个 NapCat 是谁起的，只能 taskkill /F /IM QQ.exe ——\n会连【主号 QQ】一起强杀（仓库里的 KillQQ.bat 就是这个）。\n\n确定要停吗？'
    const ok = await confirmBox('停止 NapCat', text, managed ? '停止 NapCat' : '强杀所有 QQ.exe')
    if (!ok) return
    const r = await api('/api/napcat/stop', { method: 'POST', body: { force: !managed } })
    toast(
      r.mode === 'new'
        ? `已收掉 NapCat 起的 QQ.exe ${r.killedQq.length} 个（原有 ${r.leftQq.length} 个未动）`
        : `已强杀 QQ.exe ${r.killedQq.length} 个（剩余 ${r.leftQq.length} 个）`,
      r.mode === 'new' ? 'ok' : 'warn',
    )
    if (r.webuiStillUp) toast('WebUI 端口还在监听 —— 用「重启」或手动再停一次', 'warn')
  },
  async 'napcat-reset'() {
    const r = await api('/api/napcat/reset', { method: 'POST' })
    toast(r.killed && r.killed.length ? `已收掉卡住的提权进程 ${r.killed.length} 个，状态已复位` : '状态已复位（没找到卡住的提权进程）', 'ok')
    setTimeout(refreshState, 400)
  },
  async 'napcat-restart'() {
    const managed = !!state?.services.napcat.managed
    const variant = $('#napcat-variant').value
    const ok = await confirmBox(
      '重启 NapCat',
      (managed ? '会先收掉 NapCat 起的 QQ.exe（不动其它 QQ），' : '会先强杀所有 QQ.exe（含主号），') +
        `再重新提权启动（${variant === 'shell' ? 'Shell' : 'Framework'}）。继续？`,
      '重启',
    )
    if (!ok) return
    await api('/api/napcat/stop', { method: 'POST', body: { force: !managed } })
    await new Promise((r) => setTimeout(r, 1500))
    await api('/api/napcat/start', { method: 'POST', body: { quickLogin: $('#napcat-quick').value.trim(), variant } })
    toast('已请求重新启动 NapCat', 'ok')
    watchNapcatStart()
  },
  async 'qr-refresh'() {
    await api('/api/napcat/refresh-qr', { method: 'POST' })
    toast('已请求 NapCat 刷新二维码', 'ok')
  },
  async 'napcat-relogin'() {
    const ok = await confirmBox('重新登录', '会让 NapCat 重启内核、重新走登录流程（掉登录时用）。\n期间 OneBot 会短暂断开，Koishi 会自动重连。继续？', '重新登录')
    if (!ok) return
    await api('/api/napcat/relogin', { method: 'POST' })
    toast('已请求 NapCat 重新登录', 'ok')
  },
  async 'open-folder'(el) {
    await api('/api/open-folder', { method: 'POST', body: { which: el.dataset.openFolder } })
    toast('已用资源管理器打开', 'ok')
  },
  async copy(el) {
    const v = el.dataset.value || ''
    if (!v) return toast('还没有拿到 token', 'warn')
    const isPath = /\.(bat|cmd)$/i.test(v)
    try {
      await navigator.clipboard.writeText(isPath ? '"' + v + '"' : v)
      toast(isPath ? '启动脚本路径已复制 —— 粘到「以管理员身份运行」的 cmd 里回车即可' : 'token 已复制', 'ok')
    } catch {
      toast((isPath ? '脚本：' : 'token：') + v, 'warn')
    }
  },
}

document.addEventListener('click', async (ev) => {
  const actEl = ev.target.closest('[data-act]')
  if (actEl) {
    ev.preventDefault()
    const fn = ACTIONS[actEl.dataset.act]
    if (!fn || actEl.disabled) return
    actEl.disabled = true
    try {
      await fn()
    } catch (e) {
      toast('操作失败：' + e.message, 'err')
    } finally {
      actEl.disabled = false
      setTimeout(refreshState, 400)
    }
    return
  }
  const folder = ev.target.closest('[data-open-folder]')
  if (folder) {
    ev.preventDefault()
    try {
      await ACTIONS['open-folder'](folder)
    } catch (e) {
      toast('打不开目录：' + e.message, 'err')
    }
    return
  }
  const copyEl = ev.target.closest('[data-copy]')
  if (copyEl) {
    ev.preventDefault()
    await ACTIONS.copy(copyEl)
  }
})

$('#log-tabs').addEventListener('click', (ev) => {
  const tab = ev.target.closest('.tab')
  if (!tab) return
  for (const t of $$('#log-tabs .tab')) t.classList.toggle('active', t === tab)
  activeService = tab.dataset.service
  $('#log-source').disabled = activeService === 'merge'
  const [text, cls] = streamState[activeService === 'merge' ? 'koishi' : activeService]
  setStreamState(activeService === 'merge' ? 'koishi' : activeService, text, cls)
  if (state && state.services[activeService]) syncSources(activeService, state.services[activeService])
  renderLog()
})

$('#log-source').addEventListener('change', (ev) => {
  if (activeService === 'merge') return
  openStream(activeService, ev.target.value)
})

for (const chip of $$('#log-levels .chip')) {
  chip.addEventListener('click', () => {
    const lvl = chip.dataset.lvl
    if (lvl === 'all') {
      filter.levels = new Set(['all'])
    } else {
      filter.levels.delete('all')
      if (filter.levels.has(lvl)) filter.levels.delete(lvl)
      else filter.levels.add(lvl)
      if (!filter.levels.size) filter.levels = new Set(['all'])
    }
    for (const c of $$('#log-levels .chip')) {
      c.classList.toggle('active', c.dataset.lvl === 'all' ? filter.levels.has('all') : filter.levels.has(c.dataset.lvl))
    }
    renderLog()
  })
}

let searchTimer = null
$('#log-search').addEventListener('input', (ev) => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    filter.search = ev.target.value.trim().toLowerCase().split(/\s+/).filter(Boolean)
    renderLog()
  }, 180)
})

$('#log-wrap').addEventListener('change', (ev) => {
  $('#log-view').classList.toggle('nowrap', !ev.target.checked)
})
$('#log-view').classList.add('nowrap')

$('#log-clear').addEventListener('click', async () => {
  const src = metaOf[activeService]?.source
  if (src) await api('/api/logs/clear?source=' + encodeURIComponent(src), { method: 'POST' }).catch(() => {})
  if (activeService === 'merge') buffers.koishi = buffers.napcat = []
  else buffers[activeService] = []
  renderLog()
})

$('#log-export').addEventListener('click', () => {
  const src = metaOf[activeService]?.source
  if (!src) return toast('没有可导出的日志源', 'warn')
  window.open('/api/logs/download?source=' + encodeURIComponent(src) + '&token=' + TOKEN, '_blank')
})

$('#btn-start-all').addEventListener('click', async () => {
  const btn = $('#btn-start-all')
  btn.disabled = true
  try {
    if (!state?.services.koishi.running) {
      await api('/api/koishi/start', { method: 'POST', body: { debug: $('#koishi-debug').checked, takeover: $('#koishi-takeover').checked } })
      toast('Koishi 启动中…', 'ok')
    }
    if (!state?.services.napcat.running) {
      await api('/api/napcat/start', {
        method: 'POST',
        body: { quickLogin: $('#napcat-quick').value.trim(), variant: $('#napcat-variant').value },
      })
      toast('已请求提权启动 NapCat，请在 UAC 窗口点「是」', 'ok')
      watchNapcatStart()
    }
    if (state?.services.koishi.running && state?.services.napcat.running) toast('两个服务都已经在跑了', 'warn')
  } catch (e) {
    toast('启动失败：' + e.message, 'err')
  } finally {
    setTimeout(refreshState, 600)
  }
})

$('#btn-stop-all').addEventListener('click', async () => {
  const managed = !!state?.services.napcat.managed
  const ok = await confirmBox(
    '全部停止',
    '停 Koishi（整棵进程树收掉）+ 停 NapCat（' +
      (managed ? '只收 NapCat 起的 QQ.exe，不动其它 QQ' : '强杀所有 QQ.exe，含主号') +
      '）。继续？',
    '全部停止',
  )
  if (!ok) return
  try {
    if (state?.services.koishi.running) await api('/api/koishi/stop', { method: 'POST' })
    if (state?.services.napcat.running || state?.services.napcat.starting) {
      await api('/api/napcat/stop', { method: 'POST', body: { force: !managed } })
    }
    toast('已全部停止', 'ok')
  } catch (e) {
    toast('停止出错：' + e.message, 'err')
  } finally {
    setTimeout(refreshState, 600)
  }
})

$('#btn-exit').addEventListener('click', async () => {
  const ok = await confirmBox('退出面板', '只关掉这个面板进程（网页服务），Koishi / NapCat 继续跑。\n下次启动：双击仓库根的「启动面板.cmd」。继续？', '退出面板')
  if (!ok) return
  try {
    await api('/api/panel/exit', { method: 'POST' })
  } catch {
    /* 服务已经走了也会报错，无所谓 */
  }
  closeStreams()
  document.body.innerHTML =
    '<div style="display:grid;place-items:center;height:100vh;color:#93a0b8;font:14px/1.8 \'Microsoft YaHei UI\',sans-serif">' +
    '<div style="text-align:center"><h2 style="color:#dfe6f3">面板已退出</h2>' +
    '<p>Koishi / NapCat 不受影响，还在继续跑。<br>要重新打开：双击仓库根目录的「启动面板.cmd」。</p></div></div>'
})

// 键盘：Ctrl+K 聚焦搜索，Esc 清空
document.addEventListener('keydown', (ev) => {
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k') {
    ev.preventDefault()
    $('#log-search').focus()
  }
})

// ------------------------------------------------------------------ 启动
$('#log-tabs').insertAdjacentHTML('beforeend', '<button class="tab" data-service="merge">合并</button>')
$('#log-search').placeholder = '过滤关键字…（空格分隔 = 全部命中，Ctrl+K 聚焦）'

openStream('koishi', 'auto')
openStream('napcat', 'auto')
void refreshState()
setInterval(() => void refreshState(), 2000)
window.addEventListener('beforeunload', closeStreams)
