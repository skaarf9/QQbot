#!/usr/bin/env node
'use strict'
/**
 * server.cjs —— QQbot 一键启动面板（本地服务端，零依赖）
 *
 * 做什么：一个跑在 127.0.0.1 的小 HTTP 服务，配一个网页控制台，用来
 *   ① 一键启动 / 停止 / 重启 **Koishi**（走 koishi-app/tools/run-prod.cjs，日志按天落盘）
 *   ② 一键启动 / 停止 **NapCat**（走 tools/start-napcat-shell.bat，需要 UAC 提权）
 *   ③ 看两边的日志（带级别着色 / 过滤 / 搜索 / 导出）
 *   ④ 显示 NapCat 的**登录二维码**（抄 NapCat 自己写到 cache/qrcode.png 的那张图），
 *      并轮询它 WebUI 的登录状态（waiting_qrcode / qrcode_scanned / 已登录）
 *   ⑤ 给出两个 WebUI 的跳转链接；NapCat 的链接**自带 token**，点开即登录，不用手填
 *
 * 用法：
 *   node tools\panel\server.cjs            # 起服务（静默），浏览器自己开 http://127.0.0.1:5151
 *   node tools\panel\server.cjs --open     # 起服务并顺手打开浏览器（一键启动 cmd 用的就是这个）
 *   node tools\panel\server.cjs --port 5152
 *
 * ★ 键的取证（都不是猜的，写在这里省得以后重新翻）：
 *   · Koishi 日志格式：`YYYY-MM-DD HH:MM:SS [I] scope message`（实测抓包，见开发期 .scratch/koishi-raw.bin）；
 *     由 `run-prod.cjs` 同时写 stdout 与 `koishi-app/tools/logs/prod-<本地日期>.log`。
 *     **不要给子进程设 FORCE_COLOR** —— 那会把 ANSI 转义写进日志文件，破坏 docs/17 里那套
 *     `Select-String prod-<日期>.log` 的排障流程（实测：正常运行的日志文件是纯文本）。
 *   · NapCat 日志格式（napcat.mjs 内 winston 配置）：`MM-DD HH:mm:ss [level] 昵称 | message`；
 *     文件落在 `NapCat.Shell\logs\<日期>.log`（需要 `NAPCAT_DISABLE_MULTI_PROCESS=1`，start-napcat-shell.bat 已设）。
 *   · NapCat 二维码：napcat.mjs 在收到二维码时 `writeFile(<cachePath>/qrcode.png)` 覆盖写，
 *     所以**盯这个文件的 mtime 就是"二维码有没有刷新"**（路径 napcat.mjs:82511 附近）。
 *   · NapCat WebUI 免密：web_login 分包读 `location.search.token` 后自动 loginWithToken；
 *     WebUI 的 basename 是 `/webui/`，所以链接形如 `http://127.0.0.1:6099/webui/?token=<token>`。
 *   · WebUI 的 API 鉴权（napcat.mjs:49231）：非 /auth/* 的请求要么带 `Authorization: Bearer <Credential>`，
 *     要么带查询参数 `?webui_token=<Credential>`；而 Credential 只能先 POST /api/auth/login 拿，
 *     其 body 是 `{hash: sha256(token + ".napcat").hex}`（napcat.mjs:49218 / 61623）。
 *     本文件按这套流程自己登录，不去改 NapCat 的任何配置。
 *
 * ★ 安全边界：只 bind 127.0.0.1；所有 /api/* 都要面板自己的随机 token（随页面下发，
 *   别的网页读不到我们的 HTML，所以这能挡住"恶意网页打本地端口"这类 CSRF）；
 *   另外校验 Host / Origin 必须是本机面板，防 DNS rebinding。
 */

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn, execFile, execFileSync } = require('node:child_process')

// ============================================================================
// 一、路径与常量
// ============================================================================

const ROOT = path.resolve(__dirname, '..', '..')
const KOISHI_APP = path.join(ROOT, 'koishi-app')
const KOISHI_LOG_DIR = path.join(KOISHI_APP, 'tools', 'logs')
const KOISHI_RUNNER = path.join(KOISHI_APP, 'tools', 'run-prod.cjs')
const PUBLIC_DIR = path.join(__dirname, 'public')
const RUNTIME = path.join(ROOT, '.runtime', 'panel')
const NAPCAT_CONSOLE_LOG = path.join(RUNTIME, 'napcat-console.log')
const NAPCAT_LAUNCHER_CMD = path.join(RUNTIME, 'napcat-launch.cmd')

/** NapCat 目录的候选位置：环境变量优先，然后是仓库内的那个（本项目实际用的） */
const NAPCAT_HOMES = [
  process.env.NAPCAT_HOME,
  path.join(ROOT, 'NapCat.Shell'),
  'H:/NapCat.Shell',
  'D:/NapCat.Shell',
].filter(Boolean)

const argv = process.argv.slice(2)
const argOf = (name, dflt) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] != null ? argv[i + 1] : dflt
}
const PANEL_PORT = Number(process.env.PANEL_PORT || argOf('port', '5151'))
const OPEN_BROWSER = argv.includes('--open')
/** 调试用：不提权、直接在当前会话里跑 NapCat 启动包装器（UAC 弹窗没法在无人值守环境里测） */
const NO_ELEVATE = argv.includes('--no-elevate')
/**
 * 等 UAC 应答的上限。`Start-Process -Verb RunAs` 会一直等着，提示没人应答时它会无限期挂着 ——
 * 2026-10-08 现场就是这样：面板卡在「启动中…」五分钟、日志只有一份旧文件，看起来什么都没发生。
 * 现在默认 60 秒：一直没人应答就早点报错，而不是让人对着"启动中"发呆。
 * （可用 PANEL_ELEVATE_TIMEOUT_MS 覆盖，调试时缩短。）
 */
const ELEVATE_TIMEOUT_MS = Number(process.env.PANEL_ELEVATE_TIMEOUT_MS || 60000)
const PANEL_TOKEN = crypto.randomBytes(16).toString('hex')
const VERSION = '1.0.0'

const KOISHI_PORT = 5140 // koishi.yml 里 server 插件的端口；run-prod.cjs 也是按 5140 做互斥的
const RING_MAX = 2000 // 每个日志源在内存里保留的行数
const TAIL_INITIAL_BYTES = 256 * 1024 // 首次挂到一个文件时，只回读尾部这么多

fs.mkdirSync(RUNTIME, { recursive: true })

const log = (...a) => console.log('[panel]', ...a)

// ============================================================================
// 二、配置读取（Koishi / NapCat）
// ============================================================================

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}
const readText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

function resolveNapcatHome() {
  for (const home of NAPCAT_HOMES) {
    if (fs.existsSync(path.join(home, 'config')) || fs.existsSync(path.join(home, 'napcat.mjs'))) return home
  }
  return NAPCAT_HOMES[0]
}

/**
 * NapCat 侧我们要的三样东西：WebUI 端口/token、OneBot WS 端口/token、账号 uin。
 * 挑 onebot11 配置的规则抄了 tools/napcat-probe.cjs（服务器名叫 koishi 的优先、同档取最近改过的）。
 */
function readNapcatConfig() {
  const home = resolveNapcatHome()
  const configDir = path.join(home, 'config')
  const webuiRaw = readJson(path.join(configDir, 'webui.json')) || {}
  const webui = {
    host: webuiRaw.host || '::',
    port: Number(webuiRaw.port) || 6099,
    token: String(webuiRaw.token || ''),
    disableWebUI: webuiRaw.disableWebUI === true,
    enable2FA: webuiRaw.enable2FA === true,
  }

  let onebot = null
  try {
    const hits = []
    for (const name of fs.readdirSync(configDir)) {
      if (!/^onebot11_.+\.json$/.test(name)) continue
      const file = path.join(configDir, name)
      const cfg = readJson(file)
      if (!cfg) continue
      const enabled = (cfg?.network?.websocketServers ?? []).filter((s) => s.enable !== false)
      if (!enabled.length) continue
      const koishi = enabled.find((s) => s.name === 'koishi')
      hits.push({ file, cfg, srv: koishi || enabled[0], rank: koishi ? 0 : 1, mtime: fs.statSync(file).mtimeMs })
    }
    hits.sort((a, b) => a.rank - b.rank || b.mtime - a.mtime)
    const top = hits[0]
    if (top) {
      const uin = (/^onebot11_(\d+)\.json$/.exec(path.basename(top.file)) || [])[1] || ''
      onebot = {
        host: top.srv.host || '127.0.0.1',
        port: Number(top.srv.port) || 3001,
        token: String(top.srv.token || ''),
        uin,
        configFile: top.file,
      }
    }
  } catch {
    /* config 目录不存在就当没配 */
  }

  return {
    home,
    exists: fs.existsSync(home),
    webui,
    onebot,
    logDir: path.join(home, 'logs'),
    cacheDir: path.join(home, 'cache'),
    qrFile: path.join(home, 'cache', 'qrcode.png'),
  }
}

/** Koishi 侧：控制台端口（固定 5140）+ OneBot 端点端口（从 koishi.yml 里读，给"链路通不通"用） */
function readKoishiConfig() {
  const yml = readText(path.join(KOISHI_APP, 'koishi.yml'))
  const m = /endpoint:\s*ws:\/\/[^\s:]+:(\d+)/.exec(yml)
  return { app: KOISHI_APP, port: KOISHI_PORT, onebotPort: m ? Number(m[1]) : 3001, runner: KOISHI_RUNNER }
}

// ============================================================================
// 三、Windows 进程 / 端口探测
// ============================================================================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** netstat 快照：{ listening: Map<port,pid>, established: [{lport,rport,pid}] } */
function netstatSnapshot() {
  const listening = new Map()
  const established = []
  let out = ''
  try {
    out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true })
  } catch {
    return { listening, established }
  }
  for (const line of out.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/)
    if (cols[0] !== 'TCP' || cols.length < 5) continue
    const lport = Number((/.*:(\d+)$/.exec(cols[1]) || [])[1])
    const rport = Number((/.*:(\d+)$/.exec(cols[2]) || [])[1])
    const pid = Number(cols[4])
    if (cols[3] === 'LISTENING') listening.set(lport, pid)
    else if (cols[3] === 'ESTABLISHED') established.push({ lport, rport, pid })
  }
  return { listening, established }
}

/** QQ.exe 进程数（NapCat 是注入进 QQ.exe 的，所以这也是它的"本体"计数） */
function qqProcessList() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq QQ.exe', '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
    })
    return out
      .split(/\r?\n/)
      .map((l) => /^"QQ\.exe","(\d+)"/i.exec(l))
      .filter(Boolean)
      .map((m) => Number(m[1]))
  } catch {
    return []
  }
}

/** 进程表（只在真要收进程时调，约 200ms）。CreationDate 用来区分"谁是新起的 QQ" */
function processTable() {
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate | ConvertTo-Json -Compress -Depth 2',
      ],
      { encoding: 'utf8', timeout: 20000, windowsHide: true },
    )
    const parsed = JSON.parse(out)
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return []
  }
}

/** CIM 的时间：PS5.1 是 `/Date(1791400457024)/`，PS7 是 ISO 串 —— 两种都认 */
function parseCimTime(v) {
  if (v == null) return 0
  const s = String(v)
  const m = /\/Date\((\d+)/.exec(s)
  if (m) return Number(m[1])
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : 0
}

const isNodeName = (n) => /^node(\.exe)?$/i.test(String(n ?? ''))
/** 认得出是 Koishi 那几层的 node 命令行（照抄 run-prod.cjs 的边界，防止误认 dsh runner） */
const KOISHI_NODE_SCRIPTS = [
  /node(\.exe)?"?\s+"?[^"]*koishi[\\/]lib[\\/]worker/i,
  /node(\.exe)?"?\s+"?[^"]*koishi[\\/]bin\.js/i,
]
const RUNNER_SCRIPT = /node(\.exe)?"?\s+"?[^"]*run-prod\.cjs/i

/**
 * ★ 抄自 koishi-app/tools/run-prod.cjs 的坑 84 结论：
 *   "谁持有 5140"不等于"谁是树根" —— 只杀 holder，看护它的 `bin.js start` 会再 fork 一个。
 *   所以要顺着父子关系往上走一层，把看护进程一起收；但只敢认 node.exe + 命令行真的是我们那几个脚本。
 */
function collectKoishiTree(pid) {
  const list = [Number(pid)]
  const table = processTable()
  if (!table.length) return list
  const byId = new Map(table.map((p) => [Number(p.ProcessId), p]))
  let cur = byId.get(Number(pid))
  for (let i = 0; i < 2 && cur; i++) {
    const parent = byId.get(Number(cur.ParentProcessId))
    if (!parent || !isNodeName(parent.Name)) break
    const cl = String(parent.CommandLine ?? '')
    if (RUNNER_SCRIPT.test(cl)) break
    if (!KOISHI_NODE_SCRIPTS.some((re) => re.test(cl))) break
    list.push(Number(parent.ProcessId))
    cur = parent
  }
  return list
}

function killTree(pid) {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    return true
  } catch {
    return false
  }
}

/**
 * 面板自己的小状态：目前只存"NapCat 是什么时候被本面板拉起来的"。
 * 为什么落盘：停 NapCat 时靠这个时间点区分"NapCat 拉起来的 QQ.exe"和"你原本开着的主号 QQ"
 * （见 stopNapcat）。面板重启一次就把它忘了的话，安全路径就退化成全杀。
 */
const PANEL_STATE_FILE = path.join(RUNTIME, 'state.json')
function loadPanelState() {
  const j = readJson(PANEL_STATE_FILE)
  if (!j) return
  if (Number(j.napcatStartedAt) > 0) state.napcat.startedAt = Number(j.napcatStartedAt)
  state.napcat.quickLogin = String(j.quickLogin || '')
  if (j.napcatVariant) state.napcat.variant = String(j.napcatVariant)
}
function savePanelState() {
  try {
    fs.writeFileSync(
      PANEL_STATE_FILE,
      JSON.stringify(
        {
          napcatStartedAt: state.napcat.startedAt || 0,
          quickLogin: state.napcat.quickLogin || '',
          napcatVariant: state.napcat.variant || 'shell',
        },
        null,
        2,
      ),
      'utf8',
    )
  } catch {
    /* 写不进去不影响主流程 */
  }
}

// ============================================================================
// 四、日志：line parser + tailer
// ============================================================================

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g
const CTRL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

const KOISHI_LEVEL = { I: 'info', W: 'warn', E: 'error', D: 'debug', S: 'success', F: 'error', V: 'trace', T: 'trace' }
const WINSTON_LEVEL = {
  error: 'error',
  warn: 'warn',
  info: 'info',
  http: 'info',
  verbose: 'trace',
  debug: 'debug',
  silly: 'trace',
}
const FALLBACK_LEVELS = [
  ['error', /\[(error|fatal)\]/i, /(^|\s)(error|failed|failure|fatal|panic|exception|unauthorized)(\s|:|$)/i, /✗/],
  ['warn', /\bwarn(ing)?\b|\[warn\]|重试|警告/i, /⚠/],
  ['debug', /\b(debug|verbose|silly|trace)\b/i],
]

/**
 * 一行原始文本 -> { lvl, text, tags[] }；tags 给前端做高亮/联动
 * ★ 认出级别后把那个级别标记本身从正文里摘掉 —— 前端左侧已经有级别列了，
 *   正文再留一个 `[I]`/`[info]` 只是噪音（匹配时带着前面的空白一起吃掉，免得留下双空格）。
 */
function parseLine(raw) {
  let text = String(raw).replace(ANSI_RE, '').replace(CTRL_RE, '')
  let lvl = ''
  let m = /^(\s*\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s*\[([a-zA-Z]+)\]\s?/.exec(text) // NapCat（winston）
  if (m) {
    lvl = WINSTON_LEVEL[m[2].toLowerCase()] || ''
    if (lvl) text = text.replace(m[0], m[1] + ' ')
  }
  if (!lvl) {
    const head = text.slice(0, 200)
    const km = /(\s*)\[([IWEDSFVT])\]\s?/.exec(head) // Koishi
    if (km) {
      lvl = KOISHI_LEVEL[km[2]] || ''
      if (lvl) text = text.slice(0, km.index) + km[1] + text.slice(km.index + km[0].length)
    }
  }
  if (!lvl) {
    for (const [name, ...res] of FALLBACK_LEVELS) {
      if (res.some((re) => re.test(text))) {
        lvl = name
        break
      }
    }
  }
  const tags = []
  if (/二维码|qrcode/i.test(text)) tags.push('qr')
  if (/登录成功|Logined|Login Success|已登录/i.test(text)) tags.push('login-ok')
  if (/扫码|扫描|scanned/i.test(text)) tags.push('scan')
  if (/错误|失败|failed/i.test(text)) tags.push('bad')
  return { lvl: lvl || 'info', text, tags }
}

const decoderFor = () => new TextDecoder('utf-8', { fatal: false })

/**
 * Tailer：一个日志源。两种来源 ——
 *   kind='proc'：挂在子进程的 stdout/stderr 上（只有面板自己起的 Koishi 才有）
 *   kind='file'：轮询文件的 size/mtime，读增量（支持被重命名/截断）
 * 每个 tailer 有自己的环形缓冲，SSE 订阅者先收缓冲再收实时。
 */
class Tailer {
  constructor(id, service, label, kind, file) {
    this.id = id
    this.service = service
    this.label = label
    this.kind = kind
    this.file = file || null
    this.ring = []
    this.seq = 0
    this.subs = new Set()
    this.active = false
    this.offset = 0
    this.pending = ''
    this.decoder = decoderFor()
    this.lastError = ''
    this.lastLineAt = 0
    this.procAttached = false
    this.streams = []
  }

  /** 第一次被需要时：回读文件尾部，让用户一打开就有上下文 */
  activate() {
    if (this.active) return
    this.active = true
    if (this.kind === 'file' && this.file && fs.existsSync(this.file)) {
      try {
        const size = fs.statSync(this.file).size
        const from = Math.max(0, size - TAIL_INITIAL_BYTES)
        const fd = fs.openSync(this.file, 'r')
        const buf = Buffer.alloc(size - from)
        fs.readSync(fd, buf, 0, buf.length, from)
        fs.closeSync(fd)
        this.offset = size
        const text = this.decoder.decode(buf, { stream: true })
        const lines = (this.pending + text).split(/\r?\n/)
        this.pending = lines.pop() ?? ''
        for (const l of lines) this.push(l)
      } catch (e) {
        this.lastError = e.message
      }
    }
  }

  attachProc(stream) {
    this.active = true
    this.streams.push(stream)
  }

  push(rawLine) {
    const parsed = parseLine(rawLine)
    const rec = { n: ++this.seq, ts: Date.now(), lvl: parsed.lvl, text: parsed.text, tags: parsed.tags }
    this.ring.push(rec)
    if (this.ring.length > RING_MAX) this.ring.splice(0, this.ring.length - RING_MAX)
    this.lastLineAt = rec.ts
    if (!this.subs.size) return
    const payload = `event: line\ndata: ${JSON.stringify(rec)}\n\n`
    for (const res of this.subs) {
      try {
        res.write(payload)
      } catch {
        this.subs.delete(res)
      }
    }
  }

  /** 子进程数据块 -> 行（处理跨块的半行与 UTF-8 边界） */
  onChunk(buf) {
    const text = this.decoder.decode(buf, { stream: true })
    const lines = (this.pending + text).split(/\r?\n/)
    this.pending = lines.pop() ?? ''
    for (const l of lines) this.push(l)
  }

  /** 文件增量轮询 */
  poll() {
    if (this.kind !== 'file' || !this.file) return
    let st
    try {
      st = fs.statSync(this.file)
    } catch {
      return // 文件还没出现
    }
    if (st.size < this.offset) {
      // 被截断或换了文件（日志轮转）：从头再来，并把解码器的半行状态丢掉
      this.offset = 0
      this.pending = ''
      this.decoder = decoderFor()
      this.push('—— 日志文件被轮转/截断，从新内容继续 ——')
    }
    if (st.size === this.offset) return
    try {
      const len = st.size - this.offset
      const fd = fs.openSync(this.file, 'r')
      const buf = Buffer.alloc(len)
      fs.readSync(fd, buf, 0, len, this.offset)
      fs.closeSync(fd)
      this.offset = st.size
      this.onChunk(buf)
    } catch (e) {
      this.lastError = e.message
    }
  }

  snapshot(limit) {
    return limit && limit < this.ring.length ? this.ring.slice(-limit) : this.ring
  }

  subscribe(res) {
    this.activate()
    this.subs.add(res)
  }
  unsubscribe(res) {
    this.subs.delete(res)
  }
}

/** 所有 tailer：id -> Tailer */
const tailers = new Map()
function ensureTailer(id, service, label, kind, file) {
  let t = tailers.get(id)
  if (!t) {
    t = new Tailer(id, service, label, kind, file)
    tailers.set(id, t)
    t.activate()
  }
  return t
}

// ============================================================================
// 五、服务状态 / 启停
// ============================================================================

const state = {
  startedAt: Date.now(),
  koishi: { child: null, pid: null, startedAt: 0, lastExit: null, debug: false, takeover: true, starting: false },
  napcat: { startedAt: 0, launcherCmd: null, quickLogin: '', variant: 'shell', starting: false, lastStartError: '' },
  net: { at: 0, listening: new Map(), established: [] },
  qqPids: [],
  napcatStatus: { at: 0, ok: false, error: '', data: null, webuiUp: false, qr: null, info: null },
  busy: { koishi: null, napcat: null }, // 正在进行的动作，前端用来禁用按钮
  panelElevated: false, // 面板自己是管理员时，启动 NapCat 不需要 UAC
}
loadPanelState()

/**
 * 面板自己是不是管理员：是的话子进程直接继承提权，启动 NapCat 不再有 UAC。
 * ★ 两条判据：`net session` 最快，但它依赖 LanmanServer 服务；服务没开时管理员也会失败，
 *   所以再加一条令牌完整性级别的兜底（High = S-1-16-12288，System = S-1-16-16384）。
 */
function detectElevated() {
  try {
    execFileSync('net', ['session'], { stdio: 'ignore', windowsHide: true })
    return true
  } catch {
    /* 继续看令牌 */
  }
  try {
    const out = execFileSync('whoami', ['/groups'], { encoding: 'utf8', windowsHide: true })
    return /S-1-16-(12288|16384)\b/.test(out)
  } catch {
    return false
  }
}
state.panelElevated = detectElevated()

function netSnapshot() {
  const now = Date.now()
  if (now - state.net.at > 1200) {
    const s = netstatSnapshot()
    state.net = { at: now, listening: s.listening, established: s.established }
  }
  return state.net
}

// 后台刷新：端口快照 / QQ 进程 / NapCat 登录状态
setInterval(() => {
  const s = netstatSnapshot()
  state.net = { at: Date.now(), listening: s.listening, established: s.established }
}, 1500)
setInterval(() => {
  state.qqPids = qqProcessList()
}, 4000)

/** Koishi 的日志源：proc（面板起的那个子进程）+ run-prod 写的按天日志文件 */
function koishiSources() {
  const list = []
  const proc = tailers.get('koishi:proc')
  if (proc && (proc.ring.length || (state.koishi.child && state.koishi.pid))) {
    list.push({ id: proc.id, label: '启动器输出（实时）', kind: 'proc', lines: proc.ring.length, active: proc.active })
  }
  let files = []
  try {
    files = fs
      .readdirSync(KOISHI_LOG_DIR)
      .filter((n) => /^prod-.*\.log$/.test(n))
      .map((n) => ({ n, m: fs.statSync(path.join(KOISHI_LOG_DIR, n)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
      .slice(0, 5)
  } catch {
    files = []
  }
  for (const f of files) {
    const id = 'koishi:file:' + f.n
    list.push({
      id,
      label: f.n,
      kind: 'file',
      mtime: f.m,
      lines: tailers.get(id)?.ring.length ?? 0,
      active: !!tailers.get(id)?.active,
    })
  }
  return list
}

/** NapCat 的日志源：控制台捕获（我们自己的重定向）+ NapCat 自己写的按天日志 */
function napcatSources() {
  const list = []
  if (fs.existsSync(NAPCAT_CONSOLE_LOG)) {
    let m = 0
    try {
      m = fs.statSync(NAPCAT_CONSOLE_LOG).mtimeMs
    } catch {
      /* ignore */
    }
    list.push({
      id: 'napcat:console',
      label: '启动控制台捕获（面板起 NapCat 的输出）',
      kind: 'file',
      mtime: m,
      lines: tailers.get('napcat:console')?.ring.length ?? 0,
      active: !!tailers.get('napcat:console')?.active,
    })
  }
  const cfg = napcatConfigCache
  let files = []
  try {
    files = fs
      .readdirSync(cfg.logDir)
      .filter((n) => n.endsWith('.log'))
      .map((n) => ({ n, m: fs.statSync(path.join(cfg.logDir, n)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
      .slice(0, 5)
  } catch {
    files = []
  }
  for (const f of files) {
    const id = 'napcat:file:' + f.n
    list.push({
      id,
      label: 'NapCat 日志 · ' + f.n,
      kind: 'file',
      mtime: f.m,
      lines: tailers.get(id)?.ring.length ?? 0,
      active: !!tailers.get(id)?.active,
    })
  }
  return list
}

function freshTailerFor(id) {
  // 文件类 tailer 按需创建（列表里给的是"存在但可能还没挂过"的 id）
  if (tailers.has(id)) return tailers.get(id)
  const cfg = napcatConfigCache
  if (id === 'napcat:console') return ensureTailer(id, 'napcat', '启动控制台捕获', 'file', NAPCAT_CONSOLE_LOG)
  let m = /^napcat:file:(.+)$/.exec(id)
  if (m) return ensureTailer(id, 'napcat', 'NapCat 日志 · ' + m[1], 'file', path.join(cfg.logDir, m[1]))
  m = /^koishi:file:(.+)$/.exec(id)
  if (m) return ensureTailer(id, 'koishi', m[1], 'file', path.join(KOISHI_LOG_DIR, m[1]))
  return null
}

/**
 * "自动"日志源：谁在跑就用谁 ——
 *   Koishi：面板起的那个子进程有实时输出就用它（里面还有启动器自己的话），否则用最新那份按天日志。
 *   NapCat：优先它自己写的按天日志（winston，debug 级，5 分钟内有更新才算"活的"），
 *           否则用我们的控制台捕获（提权 cmd 的启停信息只在里面）。
 * ★ 刻意只依赖"文件 mtime + 子进程是否存在"这两个可观测事实，不做状态机推断，
 *   否则用户每次点启动/停止都可能让日志视图自己跳源，很难解释。
 */
function defaultSource(service) {
  if (service === 'koishi') {
    const proc = tailers.get('koishi:proc')
    if (state.koishi.child && state.koishi.pid && proc && proc.ring.length) return 'koishi:proc'
    const srcs = koishiSources()
    return srcs.length ? srcs[0].id : null
  }
  const cfg = napcatConfigCache
  /**
   * ★ 面板刚把 NapCat 拉起来的这几分钟，最有价值的是"启动输出"（UAC 被拒、注入失败、
   *   QQ 单实例冲突，报错都在这里面），所以优先钉到控制台捕获。
   *   2026-10-08 那次"点了启动什么都没发生"的现场就是：默认源选到了 NapCat 自己那份
   *   **几天前的旧日志**（`napcat-framework-console.log`，10-05 写的两行），用户以为面板没输出。
   */
  if (state.napcat.startedAt && Date.now() - state.napcat.startedAt < 5 * 60 * 1000 && fs.existsSync(NAPCAT_CONSOLE_LOG)) {
    return 'napcat:console'
  }
  let best = null
  try {
    for (const n of fs.readdirSync(cfg.logDir)) {
      if (!n.endsWith('.log')) continue
      const m = fs.statSync(path.join(cfg.logDir, n)).mtimeMs
      if (!best || m > best.m) best = { n, m }
    }
  } catch {
    best = null
  }
  if (best && Date.now() - best.m < 5 * 60 * 1000) return 'napcat:file:' + best.n
  if (fs.existsSync(NAPCAT_CONSOLE_LOG)) return 'napcat:console'
  return best ? 'napcat:file:' + best.n : null
}

// ---- Koishi -----------------------------------------------------------------

const koishiConfig = readKoishiConfig()

/**
 * Koishi 是否在跑。
 * ★ 只看 5140（Koishi 自己的 server/console 端口）+ 我们自己起的子进程还活着。
 *   不要拿 OneBot 端口（3001）当判据 —— 那是 **NapCat** 的 WS 服务端端口，
 *   只起 NapCat 时它也在监听，拿它判断会得出"Koishi 在跑"的错误结论。
 */
function koishiRunning() {
  if (state.koishi.child && state.koishi.pid) return true
  return netSnapshot().listening.has(koishiConfig.port)
}

async function startKoishi({ debug = false, takeover = true } = {}) {
  if (state.busy.koishi) throw new Error('Koishi 正在处理上一个操作，请稍候')
  if (state.koishi.child && state.koishi.pid) throw new Error('Koishi 已经由本面板启动了（要重启请点重启）')
  if (!fs.existsSync(KOISHI_RUNNER)) throw new Error('找不到 ' + KOISHI_RUNNER)
  state.busy.koishi = 'start'
  try {
    const args = [KOISHI_RUNNER]
    if (debug) args.push('--log-level', '3')
    if (takeover) args.push('--takeover')
    const child = spawn(process.execPath, args, {
      cwd: KOISHI_APP,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    state.koishi.child = child
    state.koishi.pid = child.pid
    state.koishi.startedAt = Date.now()
    state.koishi.lastExit = null
    state.koishi.debug = debug
    state.koishi.takeover = takeover

    const t = ensureTailer('koishi:proc', 'koishi', '启动器输出（实时）', 'proc', null)
    t.ring.length = 0
    t.seq = 0
    t.attachProc(child.stdout)
    t.attachProc(child.stderr)
    child.stdout.on('data', (d) => t.onChunk(d))
    child.stderr.on('data', (d) => t.onChunk(d))
    child.on('exit', (code) => {
      state.koishi.child = null
      state.koishi.pid = null
      state.koishi.lastExit = { code, at: Date.now() }
      t.push(`—— Koishi 进程退出（code=${code}）——`)
    })
    child.on('error', (e) => {
      state.koishi.child = null
      state.koishi.pid = null
      state.koishi.lastExit = { code: null, at: Date.now(), error: e.message }
      t.push('—— 启动失败：' + e.message + ' ——')
    })
    log('koishi start, pid=' + child.pid, args.slice(1).join(' '))
    return { pid: child.pid }
  } finally {
    state.busy.koishi = null
  }
}

async function stopKoishi() {
  if (state.busy.koishi) throw new Error('Koishi 正在处理上一个操作，请稍候')
  state.busy.koishi = 'stop'
  try {
    const killed = new Set()
    const child = state.koishi.child
    if (child && state.koishi.pid) {
      killTree(state.koishi.pid)
      killed.add(state.koishi.pid)
    }
    // 端口持有者 + 它的看护父进程（坑 84）
    for (let round = 0; round < 4; round++) {
      const holder = netstatSnapshot().listening.get(koishiConfig.port)
      if (!holder) break
      if (killed.has(holder)) {
        await sleep(800)
        continue
      }
      for (const pid of collectKoishiTree(holder).reverse()) {
        killTree(pid)
        killed.add(pid)
      }
      await sleep(900)
    }
    const still = netstatSnapshot().listening.get(koishiConfig.port)
    return { killed: [...killed], stillListening: still || null }
  } finally {
    state.busy.koishi = null
  }
}

// ---- NapCat ----------------------------------------------------------------

function napcatWebuiUrl(token) {
  const cfg = napcatConfigCache
  const host = !cfg.webui.host || cfg.webui.host === '::' || cfg.webui.host === '0.0.0.0' ? '127.0.0.1' : cfg.webui.host
  const base = `http://${host}:${cfg.webui.port}/webui/`
  return token ? `${base}?token=${encodeURIComponent(token)}` : base
}

/**
 * NapCat 是否在跑。
 * ★ 主判据是 **WebUI 端口（默认 6099）在监听**：这是 NapCat 自己的 HTTP 服务，起不来就没有它。
 *   OneBot 端口（3001）只能当**兜底**，而且必须配上"有 QQ.exe" —— 因为测试台的伪 OneBot
 *   也监听 3001（`koishi-test` 那套），单独看它会把测试台误判成 NapCat。
 */
function napcatRunning() {
  const cfg = napcatConfigCache
  const net = netSnapshot()
  if (cfg.webui.disableWebUI) {
    return (cfg.onebot ? net.listening.has(cfg.onebot.port) : false) && state.qqPids.length > 0
  }
  return net.listening.has(cfg.webui.port)
}

/**
 * NapCat 的两个变体。★ 取证（2026-10-08，别凭印象）：
 *
 *   两个变体**都要管理员、都会去启动并注入你已装的那个 QQ** —— 区别只在注入方式：
 *   shell     `NapCat.Shell`：`NapCatWinBootMain.exe <QQ.exe> <NapCatWinBootHook.dll>` + JS 加载
 *                            （`loadNapCat.js` → `napcat.mjs`），配置在 `NapCat.Shell\config`。
 *   framework `NapCat.Framework`：`napimain.exe <QQ.exe> <napiloader.dll> <nativeLoader.cjs>`
 *                            原生加载。`napiLoader.bat` 同样从注册表读 QQ 路径，
 *                            `napimain.exe` 里的字符串是 `launcher.exe <QQ> [DLL]`。
 *
 *   ⚠ 所以"换成 Framework 就不会和主号 QQ 抢单实例"是**错的**（我一开始就是这么以为的）：
 *     QQNT 单实例 → 主号开着时两个变体都注入不进去。变体只影响**对不同 QQ 版本的兼容性**
 *     与注入方式，不影响"要不要提权""会不会撞主号"。
 *     真正的解法只有两条：① 先退出主号 QQ；② 另装一份 QQ 专供 NapCat（这两个 bat 都写死了
 *     注册表路径，要走这条路得让启动器接受一个显式的 QQ 路径 —— 面板目前没做）。
 *
 *   （`NapCat.Framework\config` 与 `\logs` 都是指向 `NapCat.Shell` 的 junction，
 *     所以两个变体共用同一份登录态与 OneBot 配置，切换不需要重新扫码。）
 */
const NAPCAT_VARIANTS = {
  shell: {
    key: 'shell',
    label: 'Shell（NapCatWinBootMain 注入）',
    bat: path.join(ROOT, 'tools', 'start-napcat-shell.bat'),
    needs: ['NapCat.Shell/napcat.mjs', 'NapCat.Shell/NapCatWinBootMain.exe', 'NapCat.Shell/NapCatWinBootHook.dll'],
    touchInstalledQq: true,
  },
  framework: {
    key: 'framework',
    label: 'Framework（napimain + napiloader 注入）',
    bat: path.join(ROOT, 'tools', 'start-napcat-framework.bat'),
    needs: ['NapCat.Framework/napimain.exe', 'NapCat.Framework/napiloader.dll', 'NapCat.Framework/nativeLoader.cjs'],
    touchInstalledQq: true,
  },
}

function variantInfo(key) {
  const v = NAPCAT_VARIANTS[key] || NAPCAT_VARIANTS.shell
  const missing = v.needs.filter((rel) => !fs.existsSync(path.join(ROOT, rel)))
  return {
    key: v.key,
    label: v.label,
    bat: v.bat,
    batExists: fs.existsSync(v.bat),
    missing,
    available: fs.existsSync(v.bat) && missing.length === 0,
    touchInstalledQq: v.touchInstalledQq,
  }
}

function currentVariant() {
  const key = state.napcat.variant && NAPCAT_VARIANTS[state.napcat.variant] ? state.napcat.variant : 'shell'
  return variantInfo(key)
}

/** 写一个只干一件事的提权包装器：把所选变体的启动脚本输出重定向到我们的捕获文件 */
function writeNapcatLauncher(quickLogin, variant) {
  const v = NAPCAT_VARIANTS[variant] || NAPCAT_VARIANTS.shell
  const bat = process.env.PANEL_NAPCAT_BAT || v.bat
  const lines = [
    '@echo off',
    'chcp 65001 >nul',
    `>>"${NAPCAT_CONSOLE_LOG}" echo ================ panel launch [${v.key}] %DATE% %TIME% ================`,
    `call "${bat}"${quickLogin ? ` -q ${quickLogin}` : ''} 1>>"${NAPCAT_CONSOLE_LOG}" 2>&1`,
    `>>"${NAPCAT_CONSOLE_LOG}" echo ================ panel: launcher exited code=%ERRORLEVEL% ================`,
    'exit /b %ERRORLEVEL%',
  ]
  fs.writeFileSync(NAPCAT_LAUNCHER_CMD, lines.join('\r\n') + '\r\n', 'utf8')
  return { launcher: NAPCAT_LAUNCHER_CMD, bat }
}

/** PowerShell 单引号字符串：内部单引号要写成两个（路径里基本不会有，但不能靠运气） */
const psq = (s) => "'" + String(s).replace(/'/g, "''") + "'"

/**
 * 请求 UAC 去跑包装器的那条 PowerShell 命令行。
 *
 * ★ 2026-10-08 真坑（用户报「还是不行，NapCat 启动不了」）：
 *   这里以前是 `Start-Process -FilePath '<包装器>.cmd' -WorkingDirectory ... -Verb RunAs`，
 *   结果 powershell 一直卡在等应答、60/100 秒后被我们超时收掉，**包装器一行都没跑过**
 *   （取证：`.runtime/panel/napcat-console.log` 压根没生成；/api/state 的
 *   lastStartError = "UAC 提权窗口等了 100 秒没有回应"；面板进程没提权所以走的正是这条路）。
 *   而 tools\start-napcat-shell.bat 里那条被用户验证过无数次的提权写法是：
 *     Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','"<脚本>"' -Verb RunAs
 *   —— **提权目标是一个真正的 exe（cmd.exe），批处理只当参数传进去**。
 *   所以这里照抄它：和我们"双击脚本"的路径完全一致，别再自己发明。
 */
function elevateCommand(launcher) {
  // 路径里没有空格就别加引号：多一层引号就多一层解析风险（cmd 不认 `\"`，见下面 startNapcatConsole 的坑）。
  const arg = /\s/.test(launcher) ? `"${launcher}"` : launcher
  return (
    `Start-Process -FilePath 'cmd.exe' -WorkingDirectory ${psq(ROOT)} ` +
    `-ArgumentList '/c','${arg}' -Verb RunAs`
  )
}

async function startNapcat({ quickLogin = '', variant = '' } = {}) {
  if (state.busy.napcat) throw new Error('NapCat 正在处理上一个操作，请稍候')
  const v = variantInfo(variant || state.napcat.variant || 'shell')
  if (!v.batExists && !process.env.PANEL_NAPCAT_BAT) throw new Error('找不到启动脚本 ' + v.bat)
  if (v.missing.length) throw new Error(`${v.label} 的文件不全，缺：${v.missing.join('、')}`)
  state.busy.napcat = 'start'
  try {
    const { launcher } = writeNapcatLauncher(quickLogin.replace(/[^\d]/g, ''), v.key)
    ensureTailer('napcat:console', 'napcat', '启动控制台捕获', 'file', NAPCAT_CONSOLE_LOG).activate()
    let err = ''
    let code = 0
    let timedOut = false
    /**
     * 三条路：
     *   1) 面板**自己已经是管理员**（用户右键「以管理员身份运行 启动面板.cmd」）：
     *      直接 CreateProcess 跑包装器 —— 子进程继承提权令牌，**根本不碰 UAC**。这是最稳的路。
     *   2) `--no-elevate`：调试用，同上但不要求面板提权。
     *   3) 默认：ShellExecuteEx `-Verb RunAs` 去要 UAC —— 提示是在**安全桌面**上的，
     *      没人应答时它会一直等，所以必须配超时（见下）。
     */
    const directLaunch = NO_ELEVATE || state.panelElevated
    if (directLaunch) {
      const child = spawn('cmd.exe', ['/c', launcher], { cwd: ROOT, windowsHide: !NO_ELEVATE, stdio: 'ignore' })
      await sleep(900)
      code = child.exitCode === null ? 0 : child.exitCode
    } else {
      const psCmd = elevateCommand(launcher)
      log('请求 UAC 提权:', psCmd)
      const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCmd], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      ps.stderr.on('data', (d) => (err += d.toString()))
      ps.stdout.on('data', () => {})
      // spawn 本身失败（powershell.exe 找不到之类）不会 throw，只会发 'error'；
      // 不接这个事件就是 uncaught exception，整个面板会直接挂掉。
      ps.on('error', (e) => (err += String(e && e.message ? e.message : e)))
      /**
       * ★ 2026-10-08 踩到的真坑：`Start-Process -Verb RunAs` **会一直等 UAC 的应答**。
       *   如果那个提示没被看见/没被应答（安全桌面上的提示被忽略，或提示压根没弹出来），
       *   这个 powershell 会**无限期挂着** —— 而以前这里是裸 await，于是面板永远停在
       *   「启动中…」，日志里还只有一份旧文件的内容，看起来就是"什么都没发生"。
       *   所以：给一个上限，超时就把提权进程收掉并按"失败"报出来（前端会写明怎么办）。
       */
      code = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          timedOut = true
          try {
            ps.kill()
          } catch {
            /* ignore */
          }
          resolve('timeout')
        }, ELEVATE_TIMEOUT_MS)
        ps.on('exit', (c) => {
          clearTimeout(timer)
          resolve(c)
        })
      })
    }
    if (timedOut) {
      // ★ 失败/超时要把 startedAt 清掉：不清的话界面会一直显示"启动中…"，
      //   而且 managed=true 会让下一次"停止 NapCat"按时间窗口去收 QQ.exe ——
      //   那个时间点根本没起过 NapCat，可能误伤你后来自己开的 QQ。
      //   变体也一样：失败时别把 state 里的变体改成这次试的那个，否则界面上的下拉框
      //   会跟着跳（用户以为"我明明没改"，下次启动就跑到另一个变体上去了）。
      state.napcat.startedAt = 0
      const msg =
        `UAC 提权窗口等了 ${Math.round(ELEVATE_TIMEOUT_MS / 1000)} 秒没有回应，已经把提权进程收掉了。\n` +
        '· 提权提示是弹在**安全桌面**上的（屏幕会变暗、其它窗口都点不动），看到就点「是」；\n' +
        '· 一直没看到提示 → 改点 NapCat 卡片上的「控制台启动」：那会开一个真实控制台窗口，' +
        '走 tools\\start-napcat-' +
        (v.key === 'framework' ? 'framework' : 'shell') +
        '.bat 自己的提权流程，和你平时双击脚本**完全同一条路**；\n' +
        '· 或者关掉面板，右键 启动面板.cmd →「以管理员身份运行」——面板自己是管理员时，\n' +
        '  启动 NapCat 走的是直接创建进程，**不再需要 UAC**。'
      state.napcat.lastStartError = msg.split('\n')[0]
      throw new Error(msg)
    }
    if (code !== 0) {
      state.napcat.startedAt = 0
      const msg = err.trim() || `提权启动失败（退出码 ${code}）`
      state.napcat.lastStartError = msg
      throw new Error(msg + '（多半是你在 UAC 窗口点了"否"）')
    }
    state.napcat.startedAt = Date.now()
    state.napcat.quickLogin = quickLogin
    state.napcat.variant = v.key
    state.napcat.launcherCmd = launcher
    state.napcat.lastStartError = ''
    savePanelState()
    log('napcat launcher fired:', v.key, launcher, directLaunch ? (state.panelElevated ? '(面板已是管理员，直接起)' : '(no-elevate)') : '(已请求 UAC)')
    return {
      launcher,
      quickLogin,
      variant: v.key,
      elevatedPath: directLaunch,
      touchInstalledQq: v.touchInstalledQq,
      qqPidsBefore: state.qqPids.slice(),
    }
  } finally {
    state.busy.napcat = null
  }
}

/**
 * 备用启动路：开一个**真实控制台窗口**，让 tools\start-napcat-*.bat 自己去要 UAC。
 *
 * ★ 为什么要有它：面板自己那条提权（elevateCommand）万一在你机器上弹不出提示，
 *   这条路和"你双击 tools\start-napcat-shell.bat"是**完全同一条链** ——
 *   脚本自己的 powershell Start-Process cmd.exe … -Verb RunAs 是被验证过的。
 * 代价：真正的 NapCat 输出落在那个提权出来的控制台窗口里，我们的捕获文件只有包装器
 *   自己那三行 —— 所以它是"备用"，不是默认。
 */
async function startNapcatConsole({ quickLogin = '', variant = '' } = {}) {
  if (state.busy.napcat) throw new Error('NapCat 正在处理上一个操作，请稍候')
  const v = variantInfo(variant || state.napcat.variant || 'shell')
  if (!v.batExists && !process.env.PANEL_NAPCAT_BAT) throw new Error('找不到启动脚本 ' + v.bat)
  if (v.missing.length) throw new Error(`${v.label} 的文件不全，缺：${v.missing.join('、')}`)
  state.busy.napcat = 'start-console'
  try {
    const { launcher } = writeNapcatLauncher(quickLogin.replace(/[^\d]/g, ''), v.key)
    ensureTailer('napcat:console', 'napcat', '启动控制台捕获', 'file', NAPCAT_CONSOLE_LOG).activate()
    // `cmd /c start "" cmd /k <包装器>`：start 那个空标题不能省，否则带引号的路径会被当成窗口标题。
    // ★ 路径这里**不能自己加引号**：Node 会把内层引号转义成 `\"`，而 cmd.exe 不认这种转义
    //   （实测 cmd 拿到的是 `cmd /k "\"D:\...\napcat-launch.cmd\""`，包装器一行都没跑）。
    //   路径没空格就直接裸传；有空格时 Node 会自己用引号包好，那也是 cmd 认的写法。
    const child = spawn('cmd.exe', ['/c', 'start', '', 'cmd', '/k', launcher], {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    })
    child.on('error', () => {})
    child.unref()
    await sleep(700)
    state.napcat.startedAt = Date.now()
    state.napcat.quickLogin = quickLogin
    state.napcat.variant = v.key
    state.napcat.launcherCmd = launcher
    state.napcat.lastStartError = ''
    savePanelState()
    log('napcat console launch fired:', v.key, launcher)
    return { launcher, quickLogin, variant: v.key, console: true, touchInstalledQq: v.touchInstalledQq }
  } finally {
    state.busy.napcat = null
  }
}

/** 卡住时的逃生口：把提权进程收掉、清掉"启动中"标记（不动已经跑起来的服务） */
function resetNapcatBusy() {
  const table = processTable()
  let killed = []
  for (const p of table) {
    const cl = String(p.CommandLine ?? '')
    if (/Start-Process/i.test(cl) && /napcat-launch\.cmd/i.test(cl)) {
      killTree(Number(p.ProcessId))
      killed.push(Number(p.ProcessId))
    }
  }
  state.busy.napcat = null
  state.napcat.starting = false
  return { killed }
}

/**
 * 停 NapCat。
 *
 * ★ NapCat 注入在 QQ.exe 里，没有独立进程可杀 —— 但它**不是**只能 `taskkill /IM QQ.exe`：
 *   我们记着"这次是什么时候把 NapCat 拉起来的"（startedAt，且落盘到 .runtime/panel/state.json），
 *   于是可以只收**启动时间在那之后**的 QQ.exe（= NapCat 自己拉起来的那个），
 *   你原本开着的**主号 QQ 不会被牵连**。
 *   只有"面板不知道是谁起的 NapCat"（managed=false）时才退回仓库里 KillQQ.bat 那套全杀，
 *   而且必须由前端显式带 force=true —— 前端那个二次确认框会把"会连主号一起杀"写清楚。
 */
async function stopNapcat({ force = false } = {}) {
  if (state.busy.napcat) throw new Error('NapCat 正在处理上一个操作，请稍候')
  state.busy.napcat = 'stop'
  try {
    const table = processTable()
    const startedAt = state.napcat.startedAt
    const inNapcatWindow = (p) => /^QQ\.exe$/i.test(String(p.Name ?? '')) && parseCimTime(p.CreationDate) >= startedAt - 15000

    // 先收"NapCat 自己的进程"：注入器 + 我们生成的提权包装器
    const helpers = table
      .filter(
        (p) =>
          /^NapCatWinBootMain\.exe$/i.test(String(p.Name ?? '')) ||
          /(napcat-launch\.cmd|start-napcat-shell\.bat)/i.test(String(p.CommandLine ?? '')),
      )
      .map((p) => Number(p.ProcessId))
      .filter((pid) => pid && pid !== process.pid)

    let mode = 'all'
    let killedQq = []
    if (startedAt && !force) {
      mode = 'new'
      const targets = table.filter(inNapcatWindow).map((p) => Number(p.ProcessId))
      for (const pid of targets) {
        killTree(pid)
        killedQq.push(pid)
      }
    } else {
      const before = qqProcessList()
      try {
        execFileSync('taskkill', ['/F', '/IM', 'QQ.exe'], { stdio: 'ignore', windowsHide: true })
        killedQq = before
      } catch {
        /* 一个 QQ 进程都没有时 taskkill 会 exit 1 */
      }
    }
    for (const pid of helpers) killTree(pid)
    await sleep(500)
    state.napcat.startedAt = 0
    state.napcat.quickLogin = ''
    savePanelState()
    return {
      mode,
      killedQq,
      leftQq: qqProcessList(),
      webuiStillUp: netSnapshot().listening.has(napcatConfigCache.webui.port),
    }
  } finally {
    state.busy.napcat = null
  }
}

// ---- NapCat WebUI API（拿登录状态 / 刷新二维码） -----------------------------

let napcatCredential = { value: '', at: 0, port: 0, token: '' }

/** 直接走 node:http 打 127.0.0.1 —— 不用 fetch，免得被 HTTP_PROXY 之类的环境变量搅和 */
function httpJson({ port, pathname, method = 'POST', body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8')
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers: Object.assign(
          { Accept: 'application/json' },
          data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
          headers,
        ),
        timeout: 6000,
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json = null
          try {
            json = JSON.parse(text)
          } catch {
            return reject(new Error(`响应不是 JSON（HTTP ${res.statusCode}）：${text.slice(0, 200)}`))
          }
          if (json && json.code !== undefined && json.code !== 0) {
            return reject(new Error(String(json.message || `code=${json.code}`)))
          }
          resolve(json)
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error('请求 NapCat WebUI 超时')))
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

async function napcatCredentialValue() {
  const cfg = napcatConfigCache
  const token = cfg.webui.token
  if (!token) throw new Error('NapCat 的 webui.json 里没有 token')
  if (cfg.webui.enable2FA) throw new Error('NapCat WebUI 开了两步验证，面板拿不到 Credential（请先关掉 2FA）')
  const fresh = napcatCredential.value && napcatCredential.token === token && napcatCredential.port === cfg.webui.port && Date.now() - napcatCredential.at < 50 * 60 * 1000
  if (fresh) return napcatCredential.value
  const hash = crypto.createHash('sha256').update(token + '.napcat').digest('hex')
  const res = await httpJson({ port: cfg.webui.port, pathname: '/api/auth/login', body: { hash } })
  const cred = res?.data?.Credential
  if (!cred) throw new Error('登录 NapCat WebUI 失败：响应里没有 Credential')
  napcatCredential = { value: cred, at: Date.now(), port: cfg.webui.port, token }
  return cred
}

async function napcatApi(pathname, body = {}) {
  const cfg = napcatConfigCache
  const cred = await napcatCredentialValue()
  return httpJson({
    port: cfg.webui.port,
    pathname: `/api${pathname}?webui_token=${encodeURIComponent(cred)}`,
    body,
  })
}

function qrStat() {
  const cfg = napcatConfigCache
  try {
    const st = fs.statSync(cfg.qrFile)
    return { exists: true, mtime: st.mtimeMs, size: st.size, file: cfg.qrFile }
  } catch {
    return { exists: false, mtime: 0, size: 0, file: cfg.qrFile }
  }
}

async function pollNapcatStatus() {
  const cfg = napcatConfigCache
  const net = netSnapshot()
  const webuiUp = net.listening.has(cfg.webui.port)
  const next = { at: Date.now(), ok: false, error: '', data: null, info: null, webuiUp, qr: qrStat() }
  if (webuiUp && !cfg.webui.disableWebUI) {
    try {
      const res = await napcatApi('/QQLogin/CheckLoginStatus', {})
      next.data = res?.data ?? null
      next.ok = true
      if (next.data?.isLogin) {
        try {
          const info = await napcatApi('/QQLogin/GetQQLoginInfo', {})
          next.info = info?.data ?? null
        } catch {
          /* 拿不到账号信息不影响主流程 */
        }
      }
    } catch (e) {
      next.error = e.message
    }
  } else if (!webuiUp) {
    next.error = 'NapCat WebUI 端口未监听（NapCat 没在跑）'
  }
  state.napcatStatus = next
}

setInterval(() => {
  void pollNapcatStatus()
}, 3000)

// 文件类 tailer 的轮询（200ms 足够跟手，读的都是增量）
setInterval(() => {
  for (const t of tailers.values()) if (t.kind === 'file') t.poll()
}, 400)

// ============================================================================
// 六、给前端的聚合状态
// ============================================================================

/** 会被频繁读，缓 5 秒（webui.json / onebot11 配置不会秒变） */
let napcatConfigCache = readNapcatConfig()
setInterval(() => {
  napcatConfigCache = readNapcatConfig()
}, 5000)

function buildState() {
  const cfg = napcatConfigCache
  const net = netSnapshot()
  const ks = state.koishi
  const nap = state.napcat
  const ns = state.napcatStatus
  const kSources = koishiSources()
  const nSources = napcatSources()

  const onebotUp = cfg.onebot ? net.listening.has(cfg.onebot.port) : false
  const napcatLink = cfg.webui.token ? napcatWebuiUrl(cfg.webui.token) : napcatWebuiUrl('')

  return {
    app: {
      version: VERSION,
      startedAt: state.startedAt,
      port: PANEL_PORT,
      root: ROOT,
      elevated: state.panelElevated,
      elevateTimeoutMs: ELEVATE_TIMEOUT_MS,
    },
    busy: { koishi: state.busy.koishi, napcat: state.busy.napcat },
    services: {
      koishi: {
        key: 'koishi',
        label: 'Koishi',
        running: koishiRunning(),
        managed: !!ks.pid,
        pid: ks.pid || net.listening.get(koishiConfig.port) || null,
        startedAt: ks.startedAt || 0,
        lastExit: ks.lastExit,
        debug: ks.debug,
        takeover: ks.takeover,
        port: koishiConfig.port,
        onebotPort: koishiConfig.onebotPort,
        onebotUp,
        ready: net.listening.has(koishiConfig.port),
        sources: kSources,
        defaultSource: defaultSource('koishi'),
        webui: { url: `http://127.0.0.1:${koishiConfig.port}/` },
      },
      napcat: {
        key: 'napcat',
        label: 'NapCat',
        running: napcatRunning(),
        /** 刚点过启动、端口还没起来：前端显示"启动中…"，并且别让人手滑再点一次 */
        starting: !!nap.startedAt && !napcatRunning() && Date.now() - nap.startedAt < 120000,
        managed: !!nap.startedAt,
        startedAt: nap.startedAt || 0,
        quickLogin: nap.quickLogin,
        lastStartError: nap.lastStartError,
        webuiUp: net.listening.has(cfg.webui.port),
        onebotUp,
        ports: { webui: cfg.webui.port, onebot: cfg.onebot?.port ?? null },
        qqPids: state.qqPids,
        uin: cfg.onebot?.uin || '',
        variant: currentVariant(),
        variants: Object.keys(NAPCAT_VARIANTS).map(variantInfo),
        sources: nSources,
        defaultSource: defaultSource('napcat'),
        webui: { url: napcatLink, raw: napcatWebuiUrl(''), token: cfg.webui.token, loginUrl: napcatLink },
        home: cfg.home,
        exists: cfg.exists,
      },
    },
    login: {
      at: ns.at,
      ok: ns.ok,
      error: ns.error,
      webuiUp: ns.webuiUp,
      checked: ns.data,
      info: ns.info,
      qr: ns.qr
        ? Object.assign({}, ns.qr, { url: ns.qr.exists ? `/api/napcat/qr.png?v=${Math.round(ns.qr.mtime)}&token=${PANEL_TOKEN}` : '' })
        : null,
    },
  }
}

// ============================================================================
// 七、HTTP
// ============================================================================

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

const send = (res, code, body, headers = {}) => {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8')
  res.writeHead(code, Object.assign({ 'Content-Length': buf.length }, headers))
  res.end(buf)
}
const sendJson = (res, code, obj) =>
  send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > 1e6) return reject(new Error('body too large'))
      chunks.push(c)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text) return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch {
        resolve({})
      }
    })
    req.on('error', reject)
  })
}

/** 面板自己的 token：页面里下发，别的网页读不到 → 能挡住本地 CSRF */
function tokenOk(req, url) {
  const t = req.headers['x-panel-token'] || url.searchParams.get('token')
  return typeof t === 'string' && t.length === PANEL_TOKEN.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(PANEL_TOKEN))
}

/** Host / Origin 必须是本机面板端口，防 DNS rebinding */
function originOk(req) {
  const host = String(req.headers.host || '')
  const okHost = new RegExp(`^(127\\.0\\.0\\.1|localhost|\\[::1\\]):${PANEL_PORT}$`).test(host)
  if (!okHost) return false
  const origin = req.headers.origin
  if (!origin) return true
  try {
    const u = new URL(origin)
    return (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1') && Number(u.port || 80) === PANEL_PORT
  } catch {
    return false
  }
}

const routes = {
  'GET /api/ping': (req, res) => sendJson(res, 200, { app: 'qqbot-panel', version: VERSION }),

  'GET /api/state': (req, res) => sendJson(res, 200, buildState()),

  'POST /api/koishi/start': async (req, res, url, body) => {
    const r = await startKoishi({ debug: body.debug === true, takeover: body.takeover !== false })
    sendJson(res, 200, { ok: true, ...r })
  },
  'POST /api/koishi/stop': async (req, res) => {
    const r = await stopKoishi()
    sendJson(res, 200, { ok: true, ...r })
  },
  'POST /api/napcat/start': async (req, res, url, body) => {
    const r = await startNapcat({ quickLogin: String(body.quickLogin || ''), variant: String(body.variant || '') })
    sendJson(res, 200, { ok: true, ...r })
  },
  'POST /api/napcat/start-console': async (req, res, url, body) => {
    const r = await startNapcatConsole({ quickLogin: String(body.quickLogin || ''), variant: String(body.variant || '') })
    sendJson(res, 200, { ok: true, ...r })
  },
  'POST /api/napcat/reset': (req, res) => {
    // 卡住时的逃生口（提权进程挂着不动、面板一直显示"启动中"）
    const r = resetNapcatBusy()
    sendJson(res, 200, { ok: true, ...r })
  },
  'POST /api/napcat/stop': async (req, res, url, body) => {
    const r = await stopNapcat({ force: body.force === true })
    sendJson(res, 200, { ok: true, ...r })
  },
  'POST /api/napcat/refresh-qr': async (req, res) => {
    const r = await napcatApi('/QQLogin/RefreshQRcode', {})
    setTimeout(() => void pollNapcatStatus(), 800)
    sendJson(res, 200, { ok: true, data: r?.data ?? null })
  },
  'POST /api/napcat/relogin': async (req, res) => {
    // 让 NapCat 重新走一遍登录流程（掉登录时用）：先重启 NapCat 内核
    const r = await napcatApi('/QQLogin/RestartNapCat', {})
    sendJson(res, 200, { ok: true, data: r?.data ?? null })
  },
  'POST /api/panel/exit': (req, res) => {
    sendJson(res, 200, { ok: true })
    log('面板退出（网页点了退出）')
    setTimeout(() => process.exit(0), 300)
  },
  'POST /api/open-folder': (req, res, url, body) => {
    const allow = {
      koishiLogs: KOISHI_LOG_DIR,
      napcatLogs: napcatConfigCache.logDir,
      root: ROOT,
      panelLogs: RUNTIME,
    }
    const target = allow[String(body.which || '')]
    if (!target) return sendJson(res, 400, { ok: false, error: '不允许打开这个目录' })
    spawn('explorer.exe', [target], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    sendJson(res, 200, { ok: true, path: target })
  },
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1:' + PANEL_PORT}`)
  const pathname = decodeURIComponent(url.pathname)

  try {
    if (!originOk(req)) return sendJson(res, 403, { ok: false, error: 'Host/Origin 校验失败' })

    // ---- 静态资源 ----
    if (pathname === '/' || pathname === '/index.html') {
      const html = readText(path.join(PUBLIC_DIR, 'index.html')).replace('__PANEL_TOKEN__', PANEL_TOKEN)
      return send(res, 200, html, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' })
    }
    if (pathname.startsWith('/assets/')) {
      const rel = pathname.slice('/assets/'.length)
      if (rel.includes('..') || rel.includes('/') || rel.includes('\\')) return send(res, 403, 'no')
      const file = path.join(PUBLIC_DIR, rel)
      if (!fs.existsSync(file)) return send(res, 404, 'not found')
      return send(res, 200, fs.readFileSync(file), {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      })
    }

    // ---- 二维码图片（<img> 带不了 header，所以允许用 query 里的 token） ----
    if (pathname === '/api/napcat/qr.png') {
      if (!tokenOk(req, url)) return send(res, 403, 'forbidden')
      const cfg = napcatConfigCache
      if (!fs.existsSync(cfg.qrFile)) return send(res, 404, 'no qr')
      return send(res, 200, fs.readFileSync(cfg.qrFile), {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      })
    }

    // ---- 日志 SSE ----
    if (pathname === '/api/logs/stream') {
      if (!tokenOk(req, url)) return send(res, 403, 'forbidden')
      const service = url.searchParams.get('service') === 'napcat' ? 'napcat' : 'koishi'
      let id = url.searchParams.get('source') || ''
      if (!id || id === 'auto') id = defaultSource(service) || ''
      const t = id ? freshTailerFor(id) : null
      if (!t) return sendJson(res, 404, { ok: false, error: '没有可用的日志源' })

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      res.write('retry: 2000\n\n')
      const srcMeta = (service === 'koishi' ? koishiSources() : napcatSources()).find((s) => s.id === t.id)
      const meta = {
        source: t.id,
        label: t.label,
        service: t.service,
        kind: t.kind,
        file: t.file || '',
        // 文件类源把 mtime 一起给前端：这样"看到的是几小时前的旧日志"一眼就能看出来
        mtime: srcMeta?.mtime || (t.file && fs.existsSync(t.file) ? fs.statSync(t.file).mtimeMs : 0),
      }
      res.write(`event: meta\ndata: ${JSON.stringify(meta)}\n\n`)
      const backlog = t.snapshot(400)
      if (backlog.length) res.write(`event: backlog\ndata: ${JSON.stringify(backlog)}\n\n`)
      t.subscribe(res)
      const hb = setInterval(() => {
        try {
          res.write(': ping\n\n')
        } catch {
          /* 下面 close 会收拾 */
        }
      }, 15000)
      const cleanup = () => {
        clearInterval(hb)
        t.unsubscribe(res)
      }
      req.on('close', cleanup)
      res.on('close', cleanup)
      return
    }

    // ---- 日志快照 / 清屏 / 下载 ----
    if (pathname === '/api/logs/snapshot') {
      if (!tokenOk(req, url)) return sendJson(res, 403, { ok: false, error: 'forbidden' })
      const service = url.searchParams.get('service') === 'napcat' ? 'napcat' : 'koishi'
      const id = url.searchParams.get('source') || defaultSource(service) || ''
      const t = id ? freshTailerFor(id) : null
      return sendJson(res, 200, {
        ok: true,
        source: t?.id ?? null,
        label: t?.label ?? '',
        lines: t ? t.snapshot(Number(url.searchParams.get('limit')) || 400) : [],
      })
    }
    if (pathname === '/api/logs/clear' && req.method === 'POST') {
      if (!tokenOk(req, url)) return sendJson(res, 403, { ok: false, error: 'forbidden' })
      const id = url.searchParams.get('source') || ''
      const t = tailers.get(id)
      if (t) {
        t.ring.length = 0
        t.push('—— 视图已清屏（磁盘上的日志文件不受影响）——')
      }
      return sendJson(res, 200, { ok: true })
    }
    if (pathname === '/api/logs/download') {
      if (!tokenOk(req, url)) return sendJson(res, 403, { ok: false, error: 'forbidden' })
      const id = url.searchParams.get('source') || ''
      const t = tailers.get(id)
      if (!t) return sendJson(res, 404, { ok: false, error: '没有这个日志源' })
      const body = t.ring.map((r) => r.text).join('\r\n')
      return send(res, 200, body, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="panel-${t.service}-${Date.now()}.log"`,
      })
    }

    // ---- 其它 API ----
    const handler = routes[`${req.method} ${pathname}`]
    if (handler) {
      // /api/ping 故意不鉴权：它是"这个端口上是不是本面板"的探针，
      // 只回 app 名与版本，用来处理"重复启动 → 只开一个浏览器标签"（见 server.on('error')）。
      if (pathname !== '/api/ping' && !tokenOk(req, url)) return sendJson(res, 403, { ok: false, error: 'forbidden' })
      const body = req.method === 'POST' ? await readBody(req) : {}
      const result = await handler(req, res, url, body)
      return result
    }

    sendJson(res, 404, { ok: false, error: 'not found: ' + pathname })
  } catch (e) {
    log('请求出错', pathname, e && e.stack ? e.stack : e)
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: String((e && e.message) || e) })
    else res.end()
  }
})

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    // 端口被占：先问一句"是不是已经有一个面板在跑"，是就开浏览器，不是就报错退出
    const req = http.request(
      { host: '127.0.0.1', port: PANEL_PORT, path: '/api/ping', method: 'GET', timeout: 1500 },
      (r) => {
        const chunks = []
        r.on('data', (c) => chunks.push(c))
        r.on('end', () => {
          let j = null
          try {
            j = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          } catch {
            /* 不是我们的面板 */
          }
          if (j && j.app === 'qqbot-panel') {
            const u = `http://127.0.0.1:${PANEL_PORT}/`
            log('面板已经在运行：' + u)
            if (OPEN_BROWSER) spawn('cmd', ['/c', 'start', '', u], { windowsHide: true, detached: true }).unref()
            process.exit(0)
          }
          console.error(`[panel] 端口 ${PANEL_PORT} 被别的程序占了（/? 不是本面板）。换一个：node server.cjs --port 5152`)
          process.exit(1)
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', () => {
      console.error(`[panel] 端口 ${PANEL_PORT} 被别的程序占了，且它不是本面板。用 --port 换一个。`)
      process.exit(1)
    })
    req.end()
    return
  }
  console.error('[panel] 服务出错：', e)
  process.exit(1)
})

server.listen(PANEL_PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PANEL_PORT}/`
  log(`QQbot 面板已启动：${url}`)
  log(`日志源目录：Koishi=${KOISHI_LOG_DIR}`)
  log(`            NapCat=${napcatConfigCache.logDir}`)
  if (!fs.existsSync(path.join(PUBLIC_DIR, 'index.html'))) log('★ 警告：找不到 public/index.html，页面会是空的')
  if (OPEN_BROWSER) spawn('cmd', ['/c', 'start', '', url], { windowsHide: true, detached: true }).unref()
  void pollNapcatStatus()
})

// 面板自己退出时，把日志订阅者收干净（子进程不杀：Koishi 是独立的生产进程）
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('收到 ' + sig + '，面板退出（Koishi / NapCat 不会被停）')
    process.exit(0)
  })
}
