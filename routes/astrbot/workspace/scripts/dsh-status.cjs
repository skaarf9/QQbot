#!/usr/bin/env node
/**
 * dsh-status.cjs — DSH 自检 / 状态查询（只读）
 *
 * 一条命令回答：这是哪、git 状态、MCP 服务活着没、最近谁超时了、上下文多大。
 * 所有结论都来自本机真实文件 / 进程 / 端口 / 会话记录；读不到就输出「不可用」。
 *
 * 用法：
 *   node scripts/dsh-status.cjs
 *   node scripts/dsh-status.cjs --json
 *   node scripts/dsh-status.cjs --cwd D:\some\project --profile qqbot --days 7
 *
 * 依赖：Node >= 22.15（用到 node:zlib 的 zstd 解压）。Windows 下会调用
 * powershell.exe 查询 Win32_Process，以及 netstat.exe 查询监听端口。
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const net = require('node:net')
const zlib = require('node:zlib')
const { spawnSync } = require('node:child_process')

const IS_WIN = process.platform === 'win32'
const VERSION = '1.0.0'
const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const START = Date.now()

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function run(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    timeout: options.timeout || 20000,
    maxBuffer: options.maxBuffer || 16 * 1024 * 1024,
    windowsHide: true,
    env: options.env || process.env,
  })
  return {
    ok: r.status === 0 && !r.error,
    status: r.status,
    stdout: (r.stdout || '').replace(/\r\n/g, '\n'),
    stderr: (r.stderr || '').replace(/\r\n/g, '\n'),
    error: r.error ? String(r.error.message || r.error) : null,
  }
}

function pad(str, width) {
  const s = String(str == null ? '' : str)
  const w = displayWidth(s)
  return w >= width ? s : s + ' '.repeat(width - w)
}

function displayWidth(str) {
  let w = 0
  for (const ch of String(str)) {
    const c = ch.codePointAt(0)
    if (
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x1f300 && c <= 0x1faff)
    ) {
      w += 2
    } else {
      w += 1
    }
  }
  return w
}

function table(headers, rows, maxWidths = []) {
  const heights = rows.map((r) => r.map((c) => String(c == null ? '' : c)))
  const widths = headers.map((h, i) => {
    let w = displayWidth(h)
    for (const r of heights) w = Math.max(w, displayWidth(r[i] || ''))
    return maxWidths[i] ? Math.min(w, maxWidths[i]) : w
  })
  const line = (cells) =>
    cells
      .map((c, i) => pad(truncateDisplay(c, widths[i]), widths[i]))
      .join('  ')
      .replace(/\s+$/, '')
  const out = [line(headers), line(widths.map((w) => '-'.repeat(w)))]
  for (const row of heights) out.push(line(row))
  return out.join('\n')
}

function truncateDisplay(str, width) {
  let out = ''
  let w = 0
  for (const ch of String(str)) {
    const cw = displayWidth(ch)
    if (w + cw > width) return out.slice(0, Math.max(0, out.length - 1)) + '…'
    out += ch
    w += cw
  }
  return out
}

function oneLine(str, max = 120) {
  let s = String(str == null ? '' : str).replace(/\s+/g, ' ').trim()
  if (s.length > max) s = s.slice(0, max - 1) + '…'
  return s
}

function redactSecrets(str) {
  return String(str == null ? '' : str).replace(
    /\b(token|api[_-]?key|secret|password|passwd|authorization|cookie|bearer)\b\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/gi,
    '$1=***'
  )
}

function commandSummary(label, max = 110) {
  let s = String(label == null ? '' : label).replace(/\r?\n/g, ' ')
  // 去掉 PowerShell 前置赋值（$env:UV_HTTP_TIMEOUT='180' 之类），让“卡在哪一步”更像人话
  s = s.replace(/^(?:\s*\$[A-Za-z_][\w:]*\s*=\s*(?:'[^']*'|"[^"]*"|[^\s;]+)\s*;?\s*)+/, '')
  s = redactSecrets(s.trim())
  return oneLine(s || redactSecrets(label), max)
}

function keywordHint(label) {
  const s = String(label || '')
  const m = s.match(/everything-mcp|everything|godot-ai|godot_ai|uvx|pip\s+install|npm\s+install|pnpm|图片|image|sticker|表情包/i)
  return m ? m[0] : null
}

function fmtTime(ms) {
  if (!ms || !Number.isFinite(ms)) return '不可用'
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return (
    d.getFullYear() +
    '-' +
    p(d.getMonth() + 1) +
    '-' +
    p(d.getDate()) +
    ' ' +
    p(d.getHours()) +
    ':' +
    p(d.getMinutes()) +
    ':' +
    p(d.getSeconds())
  )
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '不可用'
  const s = ms / 1000
  if (s < 60) return s.toFixed(1) + 's'
  const m = Math.floor(s / 60)
  const rs = Math.round(s - m * 60)
  if (m < 60) return m + 'm' + String(rs).padStart(2, '0') + 's'
  const h = Math.floor(m / 60)
  const rm = m - h * 60
  return h + 'h' + String(rm).padStart(2, '0') + 'm'
}

function fmtBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '不可用'
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / (1024 * 1024)).toFixed(1) + ' MB'
}

function fmtNum(n) {
  return Number.isFinite(n) ? n.toLocaleString('en-US') : '不可用'
}

function unquote(s) {
  let v = String(s == null ? '' : s).trim()
  if (!v) return ''
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'")
  if (v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v)
    } catch {
      return v.slice(1, -1)
    }
  }
  return v
}

function stripYamlComment(line) {
  let q = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (q) {
      if (q === "'" && c === "'" && line[i + 1] === "'") {
        i++
        continue
      }
      if (c === q) {
        q = null
      } else if (q === '"' && c === '\\') {
        i++
      }
      continue
    }
    if (c === "'" || c === '"') {
      q = c
      continue
    }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i)
  }
  return line
}

function parseScalar(raw) {
  const v = String(raw == null ? '' : raw).trim()
  if (!v) return ''
  if (v === 'true') return true
  if (v === 'false') return false
  if (v === 'null' || v === '~') return null
  if (v.startsWith('[')) return parseFlowArray(v)
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v)
  return unquote(v)
}

function parseFlowArray(raw) {
  let v = String(raw).trim()
  if (!v.startsWith('[')) return []
  try {
    const j = JSON.parse(v)
    if (Array.isArray(j)) return j.map((x) => (typeof x === 'string' ? x : String(x)))
  } catch {
    /* 继续用宽松解析 */
  }
  const inner = v.slice(1, v.lastIndexOf(']') >= 0 ? v.lastIndexOf(']') : v.length)
  const parts = []
  let cur = ''
  let q = null
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]
    if (q) {
      if (q === "'" && c === "'" && inner[i + 1] === "'") {
        cur += "'"
        i++
        continue
      }
      if (c === q) {
        q = null
        cur += c
      } else {
        cur += c
      }
      continue
    }
    if (c === "'" || c === '"') {
      q = c
      cur += c
      continue
    }
    if (c === ',') {
      parts.push(unquote(cur.trim()))
      cur = ''
      continue
    }
    cur += c
  }
  if (cur.trim()) parts.push(unquote(cur.trim()))
  return parts
}

function safeReadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    cwd: process.cwd(),
    profile: process.env.DSH_PROFILE || null,
    days: 14,
    limit: 12,
    json: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') out.json = true
    else if (a === '--help' || a === '-h') out.help = true
    else if (a === '--cwd') out.cwd = argv[++i]
    else if (a.startsWith('--cwd=')) out.cwd = a.slice(6)
    else if (a === '--profile') out.profile = argv[++i]
    else if (a.startsWith('--profile=')) out.profile = a.slice(10)
    else if (a === '--days') out.days = Number(argv[++i]) || 14
    else if (a.startsWith('--days=')) out.days = Number(a.slice(7)) || 14
    else if (a === '--limit') out.limit = Number(argv[++i]) || 12
    else if (a.startsWith('--limit=')) out.limit = Number(a.slice(8)) || 12
  }
  out.cwd = path.resolve(out.cwd)
  return out
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

function gatherGit(cwd) {
  const base = { isRepo: false, cwd, unavailable: [] }
  const inside = run('git', ['rev-parse', '--is-inside-work-tree'], { cwd, timeout: 8000 })
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    return { ...base, reason: '当前目录不在 git 仓库内' }
  }
  const root = run('git', ['rev-parse', '--show-toplevel'], { cwd, timeout: 8000 })
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeout: 8000 })
  const log = run('git', ['log', '-1', '--format=%h|%ad|%s', '--date=iso-strict'], {
    cwd,
    timeout: 8000,
  })
  const remote = run('git', ['remote', 'get-url', 'origin'], { cwd, timeout: 8000 })
  const status = run('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd,
    timeout: 15000,
    maxBuffer: 32 * 1024 * 1024,
  })
  const upstream = run(
    'git',
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
    { cwd, timeout: 8000 }
  )

  let ahead = null
  let behind = null
  if (upstream.ok && upstream.stdout.trim()) {
    const ab = run('git', ['rev-list', '--left-right', '--count', '@{u}...HEAD'], {
      cwd,
      timeout: 8000,
    })
    if (ab.ok) {
      const m = ab.stdout.trim().match(/^(\d+)\s+(\d+)$/)
      if (m) {
        behind = Number(m[1])
        ahead = Number(m[2])
      }
    }
  }

  const lines = status.ok ? status.stdout.split('\n').filter(Boolean) : []
  const counts = { modified: 0, added: 0, deleted: 0, renamed: 0, untracked: 0, conflict: 0 }
  for (const line of lines) {
    const xy = line.slice(0, 2)
    if (xy === '??') {
      counts.untracked++
      continue
    }
    if (xy.includes('U') || xy === 'AA' || xy === 'DD') {
      counts.conflict++
      continue
    }
    // 重命名优先归类，避免 RM 同时被算进“修改”和“重命名”
    if (xy.includes('R')) {
      counts.renamed++
      continue
    }
    if (xy.includes('M') || xy.includes('T')) counts.modified++
    if (xy.includes('A')) counts.added++
    if (xy.includes('D')) counts.deleted++
  }

  let logInfo = null
  if (log.ok && log.stdout.trim()) {
    const [hash, date, ...subject] = log.stdout.trim().split('|')
    logInfo = { hash, date, subject: subject.join('|') }
  }

  return {
    isRepo: true,
    cwd,
    root: root.ok ? path.normalize(root.stdout.trim()) : cwd,
    rootSource: root.ok ? 'git rev-parse --show-toplevel' : '不可用',
    branch: branch.ok ? branch.stdout.trim() : '不可用',
    log: logInfo,
    remote: remote.ok ? remote.stdout.trim() : null,
    upstream: upstream.ok ? upstream.stdout.trim() : null,
    ahead,
    behind,
    dirtyCount: lines.length,
    counts,
    statusReadable: status.ok,
    unavailable: status.ok ? [] : ['git status 读取失败: ' + oneLine(status.stderr, 160)],
  }
}

// ---------------------------------------------------------------------------
// 进程 / 端口
// ---------------------------------------------------------------------------

function toEpoch(value) {
  if (value == null) return null
  if (typeof value === 'number') return value
  const s = String(value)
  const m = s.match(/\/Date\((\d+)([+-]\d+)?\)\//)
  if (m) return Number(m[1])
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : null
}

function getProcesses() {
  if (IS_WIN) {
    const script =
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CreationDate,CommandLine | ConvertTo-Json -Compress'
    const r = run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      timeout: 30000,
      maxBuffer: 32 * 1024 * 1024,
    })
    if (!r.ok) {
      throw new Error('PowerShell CIM 查询失败: ' + oneLine(r.stderr || r.error, 200))
    }
    let data
    try {
      data = JSON.parse(r.stdout.trim() || '[]')
    } catch (e) {
      throw new Error('PowerShell CIM 输出不是合法 JSON: ' + oneLine(String(e.message), 120))
    }
    if (!Array.isArray(data)) data = [data]
    return data
      .map((p) => ({
        pid: Number(p.ProcessId),
        ppid: Number(p.ParentProcessId),
        name: String(p.Name || ''),
        startedAt: toEpoch(p.CreationDate),
        cmd: String(p.CommandLine || ''),
      }))
      .filter((p) => Number.isFinite(p.pid))
  }

  const r = run('ps', ['-eo', 'pid=,ppid=,lstart=,args='], { timeout: 15000 })
  if (!r.ok) throw new Error('ps 查询失败: ' + oneLine(r.stderr || r.error, 200))
  const out = []
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+(.*)$/)
    if (!m) continue
    const started = Date.parse(m[3])
    const cmd = m[4]
    out.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      name: path.basename(cmd.split(/\s+/)[0] || ''),
      startedAt: Number.isFinite(started) ? started : null,
      cmd,
    })
  }
  return out
}

function getListeningPorts() {
  const map = new Map()
  if (IS_WIN) {
    const r = run('netstat.exe', ['-ano', '-p', 'tcp'], { timeout: 12000, maxBuffer: 8 * 1024 * 1024 })
    if (!r.ok) return { map, error: oneLine(r.stderr || r.error, 160) }
    for (const line of r.stdout.split('\n')) {
      const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i)
      if (!m) continue
      const port = Number(m[1])
      const pid = Number(m[2])
      if (!map.has(port)) map.set(port, [])
      if (!map.get(port).includes(pid)) map.get(port).push(pid)
    }
    return { map, error: null }
  }
  const r = run('ss', ['-ltnp'], { timeout: 12000 })
  if (!r.ok) return { map, error: oneLine(r.stderr || r.error, 160) }
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/LISTEN\s+\d+\s+\d+\s+\S+:(\d+)\s+.*?pid=(\d+)/)
    if (m) {
      const port = Number(m[1])
      const pid = Number(m[2])
      if (!map.has(port)) map.set(port, [])
      if (!map.get(port).includes(pid)) map.get(port).push(pid)
    }
  }
  return { map, error: null }
}

function checkPort(port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    let done = false
    const finish = (v) => {
      if (done) return
      done = true
      socket.destroy()
      resolve(v)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

// ---------------------------------------------------------------------------
// DSH 实例
// ---------------------------------------------------------------------------

function findDshInstances(procs) {
  const instances = []
  for (const p of procs) {
    const cmd = p.cmd || ''
    if (!/@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js|(?:^|[\\/\s])dsh[\\/]lib[\\/]bin\.js/i.test(cmd)) continue
    if (!/\bnode(\.exe)?\b/i.test(p.name) && !/node\.exe/i.test(cmd)) continue
    const profileMatch = cmd.match(/--profile\s+([^\s"']+)/i)
    let profile = profileMatch ? profileMatch[1] : null
    if (!profile) profile = /(?:^|\s)web(?:\s|$)/.test(cmd) ? 'web' : 'default'
    const portMatch = cmd.match(/--port\s+(\d+)/i)
    let pkgVersion = null
    const binMatch = cmd.match(/^"?([^"]*?)[\\/]lib[\\/]bin\.js/i)
    if (binMatch) {
      const pkg = binMatch[1].replace(/[\\/]lib$/, '')
      const j = safeReadJson(path.join(pkg, 'package.json'))
      if (j && j.version) pkgVersion = j.version
    }
    instances.push({
      pid: p.pid,
      profile,
      port: portMatch ? Number(portMatch[1]) : null,
      version: pkgVersion,
      cmd,
      startedAt: p.startedAt,
    })
  }
  // 同一个 profile 可能被拉起多次；保留全部（端口不同/重复启动都值得看见）
  instances.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0))
  return instances
}

function instanceLabel(inst) {
  return inst ? `${inst.profile}#${inst.pid}` : '未知实例'
}

function detectOwnInstance(procs, instances) {
  if (!instances.length) return null
  const byPid = new Map(procs.map((p) => [p.pid, p]))
  const byInstance = new Map(instances.map((i) => [i.pid, i]))
  let cur = byPid.get(process.pid)
  for (let depth = 0; depth < 20 && cur; depth++) {
    if (byInstance.has(cur.pid)) return byInstance.get(cur.pid)
    cur = byPid.get(cur.ppid)
  }
  return null
}

// ---------------------------------------------------------------------------
// MCP 配置
// ---------------------------------------------------------------------------

function parseYamlEntries(text, source) {
  const lines = text.split('\n')
  const entries = []
  let cur = null
  let inConfig = false
  let configIndent = 0
  let inEnv = false
  let envIndent = 0

  const flush = () => {
    if (!cur) return
    entries.push(cur)
    cur = null
    inConfig = false
    inEnv = false
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = stripYamlComment(lines[i])
    if (!raw.trim()) continue
    const indent = raw.match(/^\s*/)[0].length

    const idm = raw.match(/^(\s*)-\s+id:\s*(.+?)\s*$/)
    if (idm) {
      flush()
      cur = {
        id: unquote(idm[2]),
        name: '',
        disabled: false,
        config: {},
        source,
        line: i + 1,
        indent: idm[1].length,
      }
      continue
    }
    if (!cur) continue

    // 新的列表项（非 id）开始，结束当前块
    if (indent <= cur.indent && /^\s*-\s+/.test(raw)) {
      flush()
      continue
    }

    const km = raw.match(/^(\s*)([A-Za-z0-9_@.\-/]+):\s*(.*)$/)
    if (!km) continue
    const key = km[2]
    const val = km[3].trim()

    if (inEnv && indent <= envIndent) inEnv = false
    if (inConfig && indent <= configIndent) inConfig = false

    if (key === 'config' && val === '') {
      inConfig = true
      configIndent = indent
      continue
    }
    if (!inConfig) {
      if (key === 'name') cur.name = unquote(val)
      else if (key === 'disabled') cur.disabled = /^true$/i.test(unquote(val))
      else if (key === 'id') cur.id = unquote(val)
      continue
    }

    if (key === 'env' && val === '') {
      cur.config.env = cur.config.env || {}
      inEnv = true
      envIndent = indent
      continue
    }
    if (inEnv && indent > envIndent) {
      cur.config.env[key] = unquote(val)
      continue
    }
    if (key === 'args') {
      let v = val
      if (v.startsWith('[')) {
        let depth = bracketDepth(v)
        while (depth > 0 && i + 1 < lines.length) {
          i++
          const next = stripYamlComment(lines[i])
          v += '\n' + next
          depth += bracketDepth(next)
        }
      }
      cur.config.args = parseFlowArray(v)
      continue
    }
    cur.config[key] = parseScalar(val)
  }
  flush()
  return entries
}

function bracketDepth(s) {
  let d = 0
  let q = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (q) {
      if (c === q && s[i - 1] !== '\\') q = null
      continue
    }
    if (c === "'" || c === '"') q = c
    else if (c === '[') d++
    else if (c === ']') d--
  }
  return d
}

function gatherMcpConfig(profile) {
  const layers = [
    { kind: 'global', file: path.join(HOME, 'cordis.patch.yml') },
    { kind: 'profile', file: path.join(HOME, 'profiles', profile, 'cordis.patch.yml') },
  ]
  const files = []
  const entries = []
  const unavailable = []
  const seenServers = new Map()

  for (const layer of layers) {
    if (!fs.existsSync(layer.file)) {
      unavailable.push(`配置不存在: ${layer.file}`)
      files.push({ ...layer, exists: false })
      continue
    }
    files.push({ ...layer, exists: true })
    let text
    try {
      text = fs.readFileSync(layer.file, 'utf8')
    } catch (e) {
      unavailable.push(`读取失败 ${layer.file}: ${oneLine(e.message, 120)}`)
      continue
    }
    const parsed = parseYamlEntries(text, layer.file)
    for (const e of parsed) {
      if (!/dsh-mcp-client/.test(e.name || '') && !e.config.serverName) continue
      if (e.disabled) continue
      const key = String(e.config.serverName || e.id)
      const normalized = { ...e, layer: layer.kind }
      if (seenServers.has(key)) {
        const prev = seenServers.get(key)
        prev.overriddenBy = layer.file
        Object.assign(prev, normalized, { layer: prev.layer, source: prev.source })
      } else {
        seenServers.set(key, normalized)
        entries.push(normalized)
      }
    }
  }
  return { files, entries, unavailable }
}

function mcpSignatures(entry) {
  const strong = new Set()
  const weak = new Set()
  const generic = new Set([
    'node',
    'node.exe',
    'python',
    'python.exe',
    'pythonw',
    'pythonw.exe',
    'python3',
    'cmd',
    'cmd.exe',
    'powershell',
    'powershell.exe',
    'pwsh',
    'pwsh.exe',
    'sh',
    'bash',
    'uv',
    'uv.exe',
    'uvx',
    'uvx.exe',
    'npx',
    'npx.cmd',
    'npm',
    'npm.cmd',
  ])
  const serverName = String(entry.config.serverName || '').toLowerCase()
  if (serverName) weak.add(serverName)

  const command = String(entry.config.command || '').replace(/"/g, '')
  const base = path.basename(command.replace(/\\/g, '/')).toLowerCase()
  if (base && !generic.has(base) && base.length >= 5) {
    strong.add(base.replace(/\.exe$/, ''))
  }

  for (const raw of entry.config.args || []) {
    const t = String(raw).toLowerCase()
    if (!t || t.startsWith('-')) continue
    const pieces = t.split(/[=<>~!]+/)
    for (const piece of pieces) {
      if (piece.length < 5) continue
      if (!/^[a-z0-9][a-z0-9._-]+$/.test(piece)) continue
      if (/^(https?|stdio|attach|port|from|index|copy|first|build)$/.test(piece)) continue
      if (piece.includes('-') || piece.includes('_') || piece.includes('.')) strong.add(piece)
    }
  }
  if (!strong.size && serverName.length >= 6) weak.add(serverName)
  return { strong: [...strong], weak: [...weak] }
}

function mcpPorts(entry) {
  const ports = []
  const args = entry.config.args || []
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i])
    const m = a.match(/^--(ws-)?port=(\d+)$/)
    if (m) {
      ports.push(Number(m[2]))
      continue
    }
    if (/^--(ws-)?port$/.test(a) && args[i + 1] && /^\d+$/.test(String(args[i + 1]))) {
      ports.push(Number(args[i + 1]))
    }
  }
  return [...new Set(ports)]
}

function isInstallerName(name) {
  return /^(uv|uvx|pip|pip3|npm|npx|pnpm|yarn|git|winget|choco)(\.exe|\.cmd)?$/i.test(String(name))
}

function isLauncherProcess(p) {
  const name = String(p.name || '').toLowerCase()
  const cmd = String(p.cmd || '').toLowerCase()
  if (/^(uv|uvx|npm|npx|pnpm|yarn)(\.exe|\.cmd)?$/.test(name)) return true
  if (/[\\/](uv|uvx)\.exe\b/.test(cmd)) return true
  if (/\buv\s+tool\s+uvx\b/.test(cmd)) return true
  if (/\bnpx(\.cmd)?\b/.test(cmd) && !/\bnpx\b.*\s-c\b/.test(cmd)) return true
  return false
}

function matchMcpProcesses(entry, procs) {
  const sig = mcpSignatures(entry)
  const out = []
  for (const p of procs) {
    const cmd = String(p.cmd || '').toLowerCase().replace(/\\/g, '/')
    if (!cmd) continue
    if (cmd.includes('dsh-status.cjs')) continue
    if (/^(powershell|pwsh|cmd|conhost|windowsterminal|openconsole)(\.exe)?$/i.test(p.name)) continue
    if (String(p.name || '').toLowerCase() === 'everything.exe') continue
    if (sig.strong.some((s) => cmd.includes(s))) {
      out.push(p)
      continue
    }
    // 弱匹配只接受明确的运行时进程，避免把 PowerShell 命令行/mcp 配置文本算进去
    if (
      sig.weak.length &&
      /^(node|python|pythonw|python3|everything-mcp|bun|deno|java|dotnet|ruby|go)(\.exe)?$/i.test(
        p.name
      ) &&
      sig.weak.some((s) => s && cmd.includes(s))
    ) {
      out.push(p)
    }
  }
  return out
}

function ownerOf(p, procsByPid, dshByPid) {
  let cur = p
  for (let depth = 0; depth < 12 && cur; depth++) {
    if (dshByPid.has(cur.pid)) return dshByPid.get(cur.pid)
    cur = procsByPid.get(cur.ppid)
  }
  return null
}

async function buildMcpReport(profile, procs, portsInfo, instances) {
  const cfg = gatherMcpConfig(profile)
  const unavailable = [...cfg.unavailable]
  const entries = cfg.entries
  const procsByPid = new Map(procs.map((p) => [p.pid, p]))
  const dshByPid = new Map(instances.map((i) => [i.pid, i]))

  const allPorts = [...new Set(entries.flatMap((e) => mcpPorts(e)))]
  const portConnect = new Map()
  await Promise.all(
    allPorts.map(async (port) => {
      portConnect.set(port, await checkPort(port))
    })
  )

  const rows = []
  const warnings = []
  for (const entry of entries) {
    const matched = matchMcpProcesses(entry, procs)
    const grouped = new Map()
    for (const p of matched) {
      const owner = ownerOf(p, procsByPid, dshByPid)
      const key = owner ? owner.pid : 0
      if (!grouped.has(key)) grouped.set(key, { owner, procs: [] })
      grouped.get(key).procs.push(p)
    }

    const targets = instances.length ? instances.slice() : [null]
    for (const inst of targets) {
      const key = inst ? inst.pid : 0
      const group = grouped.get(key)
      const ps = group ? group.procs : []
      const servers = ps.filter((p) => !isLauncherProcess(p))
      const launchers = ps.filter((p) => isLauncherProcess(p))
      const fixedPorts = mcpPorts(entry)
      let status = '未运行'
      let evidence = '无进程'
      let detail = { servers: servers.map((p) => p.pid), launchers: launchers.map((p) => p.pid) }

      if (servers.length) {
        const starts = servers.map((p) => p.startedAt).filter((x) => Number.isFinite(x))
        const startedAt = starts.length ? Math.min(...starts) : null
        const age = startedAt ? START - startedAt : null
        const pids = servers.map((p) => p.pid).join(',')
        if (age != null && age < 20000) {
          status = '启动中'
          evidence = `pid ${pids} 刚拉起 ${fmtDuration(age)}`
        } else {
          const portBits = []
          let missing = 0
          let listening = 0
          for (const port of fixedPorts) {
            const ok = portConnect.get(port)
            const owners = portsInfo.map.get(port) || []
            const own = owners.some((pid) => servers.some((p) => p.pid === pid))
            if (ok) {
              listening++
              portBits.push(`${port} 监听${own ? '（本实例）' : owners.length ? `（pid ${owners.join(',')}）` : ''}`)
            } else {
              missing++
              portBits.push(`${port} 未监听`)
            }
          }
          if (fixedPorts.length && listening === 0) {
            status = '卡住'
            evidence = `pid ${pids} 存活 ${fmtDuration(age)}；${portBits.join('，')}（上游未连上）`
          } else if (missing > 0) {
            status = '卡住'
            evidence = `pid ${pids} 存活 ${fmtDuration(age)}；${portBits.join('，')}（端口部分不通）`
          } else {
            status = '已连接'
            evidence =
              `pid ${pids} 存活 ${fmtDuration(age)}` +
              (portBits.length ? `；${portBits.join('，')}` : '；stdio 进程存活')
          }
        }
      } else if (launchers.length) {
        const starts = launchers.map((p) => p.startedAt).filter((x) => Number.isFinite(x))
        const startedAt = starts.length ? Math.min(...starts) : null
        const age = startedAt ? START - startedAt : null
        status = age != null && age > 60000 ? '卡住' : '启动中'
        evidence =
          `启动器 pid ${launchers.map((p) => p.pid).join(',')} 存活 ${fmtDuration(age)}` +
          '；服务进程未出现'
      } else if (inst) {
        const command = String(entry.config.command || '').replace(/"/g, '')
        const looksPath = /[\\/]/.test(command)
        if (looksPath && !fs.existsSync(command)) {
          status = '失败'
          evidence = `启动器不存在: ${command}`
        } else {
          status = '未运行'
          evidence = '无进程（stdio MCP 可能尚未被首次调用）'
        }
      }

      // 依赖检查：Everything 的索引器与 es.exe
      if (entry.config.env && entry.config.env.EVERYTHING_ES_PATH) {
        const es = String(entry.config.env.EVERYTHING_ES_PATH)
        const esOk = fs.existsSync(es)
        const ev = procs.find((p) => /^Everything\.exe$/i.test(p.name))
        evidence += ev ? `；Everything.exe 运行中` : `；警告: Everything.exe 未运行`
        evidence += esOk ? `；es.exe 存在` : `；警告: es.exe 不存在`
        if (!esOk) warnings.push(`everything MCP 的 es.exe 不存在: ${es}`)
        if (!ev) warnings.push('everything MCP 进程在，但 Everything.exe 未运行，搜索结果可能为空')
      }

      rows.push({
        server: entry.config.serverName || entry.id,
        instance: inst ? instanceLabel(inst) : '-',
        status,
        evidence,
        detail,
        source: entry.source,
      })
    }
  }

  if (!entries.length) {
    unavailable.push(
      `未在 ${cfg.files
        .filter((f) => f.exists)
        .map((f) => f.file)
        .join(' / ') || '配置路径'} 找到 @deepseek-ai/dsh-mcp-client 定义`
    )
  }

  return { files: cfg.files, entries, rows, warnings, unavailable }
}

// ---------------------------------------------------------------------------
// 会话记录（zstd 多帧）
// ---------------------------------------------------------------------------

function decompressSessionBuffer(buf) {
  if (typeof zlib.zstdDecompressSync !== 'function') {
    throw new Error('当前 Node 不支持 zstd（需要 Node >= 22.15）')
  }
  const magic = [0x28, 0xb5, 0x2f, 0xfd]
  const offsets = []
  for (let i = 0; i + 3 < buf.length; i++) {
    if (
      buf[i] === magic[0] &&
      buf[i + 1] === magic[1] &&
      buf[i + 2] === magic[2] &&
      buf[i + 3] === magic[3]
    ) {
      offsets.push(i)
    }
  }
  if (!offsets.length) throw new Error('文件不是 zstd 帧（没有 magic）')
  const chunks = []
  let bad = 0
  for (let i = 0; i < offsets.length; i++) {
    const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length
    try {
      chunks.push(zlib.zstdDecompressSync(buf.subarray(offsets[i], end)))
    } catch {
      bad++
    }
  }
  if (!chunks.length) throw new Error('zstd 解压失败')
  return { text: Buffer.concat(chunks).toString('utf8'), frames: offsets.length, bad }
}

function parseSession(file) {
  const stat = fs.statSync(file)
  const buf = fs.readFileSync(file)
  const dec = decompressSessionBuffer(buf)
  const lines = dec.text.split('\n').filter((l) => l.trim())
  const records = []
  let badLines = 0
  for (const line of lines) {
    try {
      records.push(JSON.parse(line))
    } catch {
      badLines++
    }
  }
  const meta = records.find((r) => r.type === 'session') || null
  const titles = records.filter((r) => r.type === 'session/title')
  const title = titles.length ? titles[titles.length - 1].data.title : null

  const calls = new Map()
  const results = new Map()
  const registered = new Map()
  const settled = []
  const usages = []
  let contextWindow = null
  let model = null
  let lastActivity = meta && meta.createdAt ? meta.createdAt : stat.mtimeMs

  for (const r of records) {
    if (!r || typeof r !== 'object') continue
    if (r.time) lastActivity = Math.max(lastActivity, r.time)
    if (r.type === 'request/context') {
      if (Number.isFinite(r.data && r.data.contextWindow)) contextWindow = r.data.contextWindow
      if (r.data && r.data.model) model = r.data.model
    } else if (r.type === 'request/header') {
      const cfg = r.data && r.data.header && r.data.header.config
      if (cfg && cfg.model) model = cfg.model
    } else if (r.type === 'tool/call') {
      calls.set(r.data.callId, {
        callId: r.data.callId,
        name: r.data.name,
        args: r.data.arguments,
        turn: r.data.turn,
        step: r.data.step,
        time: r.time,
      })
    } else if (r.type === 'tool/result') {
      const msg = r.data && r.data.message
      let text = ''
      if (msg && Array.isArray(msg.content)) {
        text = msg.content.map((c) => (c && c.text) || '').join('\n')
      }
      results.set(r.data.message.toolCallId || (msg && msg.toolCallId), {
        isError: Boolean(msg && msg.isError),
        text,
        time: r.time,
      })
    } else if (r.type === 'job/registered') {
      registered.set(r.data.jobId, {
        jobId: r.data.jobId,
        kind: r.data.kind,
        label: r.data.label,
        startedAt: r.data.startedAt,
        callId: r.data.toolCall && r.data.toolCall.callId,
        owner: r.data.owner,
      })
    } else if (r.type === 'job/settled') {
      settled.push(r.data)
    } else if (r.type === 'assistant/message') {
      if (r.data && r.data.usage && r.data.turn != null) {
        usages.push({ time: r.time, usage: r.data.usage, step: r.data.step })
      }
    }
  }

  const jobs = []
  for (const s of settled) {
    const reg = registered.get(s.jobId) || {}
    const call = calls.get((s.toolCall && s.toolCall.callId) || reg.callId)
    const duration = s.finishedAt && s.startedAt ? s.finishedAt - s.startedAt : null
    jobs.push({
      jobId: s.jobId,
      kind: s.kind || reg.kind,
      label: s.label || reg.label,
      status: s.status,
      cause: s.cause,
      detail: s.detail,
      startedAt: s.startedAt || reg.startedAt,
      finishedAt: s.finishedAt,
      duration,
      callName: call ? call.name : null,
      turn: call ? call.turn : null,
      step: call ? call.step : null,
    })
  }
  const settledIds = new Set(settled.map((s) => s.jobId))
  const running = []
  for (const [id, reg] of registered) {
    if (settledIds.has(id)) continue
    running.push({
      ...reg,
      age: START - (reg.startedAt || START),
    })
  }

  return {
    file,
    stat,
    meta,
    title,
    jobs,
    running,
    calls,
    results,
    usages,
    contextWindow,
    model,
    lastActivity,
    frames: dec.frames,
    badFrames: dec.bad,
    badLines,
    sizeCompressed: stat.size,
    sizeDecompressed: Buffer.byteLength(dec.text, 'utf8'),
  }
}

function sessionDirForCwd(cwd) {
  const name = '--' + cwd.replace(/[:\\/]+/g, '-') + '--'
  return path.join(HOME, 'sessions', name)
}

function scanSessions(cwd, days) {
  const unavailable = []
  const cutoff = START - days * 24 * 3600 * 1000
  let dir = sessionDirForCwd(cwd)
  if (!fs.existsSync(dir)) {
    const all = path.join(HOME, 'sessions')
    if (!fs.existsSync(all)) {
      return { sessions: [], dir, unavailable: ['会话目录不存在: ' + all], totalDirs: 0 }
    }
    // 回退：扫描所有 workspace，找 meta.cwd 匹配的
    const matches = []
    for (const name of fs.readdirSync(all)) {
      const d = path.join(all, name)
      try {
        if (!fs.statSync(d).isDirectory()) continue
        const files = fs.readdirSync(d).filter((f) => f.startsWith('session') && f.endsWith('.zstd'))
        if (!files.length) continue
        const candidate = path.join(d, files[0])
        if (fs.statSync(candidate).mtimeMs < cutoff) continue
        const parsed = parseSession(candidate)
        if (
          parsed.meta &&
          String(parsed.meta.cwd || '').toLowerCase() === cwd.toLowerCase()
        ) {
          matches.push(parsed)
        }
      } catch {
        /* 单个目录坏了不影响其它 */
      }
    }
    return { sessions: matches.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs), dir: all, unavailable }
  }

  const sessions = []
  let totalDirs = 0
  for (const name of fs.readdirSync(dir)) {
    const d = path.join(dir, name)
    let st
    try {
      st = fs.statSync(d)
    } catch {
      continue
    }
    if (!st.isDirectory()) continue
    totalDirs++
    const file = path.join(d, 'session.v4.jsonl.zstd')
    if (!fs.existsSync(file)) {
      unavailable.push('没有 session.v4.jsonl.zstd: ' + d)
      continue
    }
    try {
      const stFile = fs.statSync(file)
      if (stFile.mtimeMs < cutoff) continue
      sessions.push(parseSession(file))
    } catch (e) {
      unavailable.push(`会话不可读 ${name}: ${oneLine(e.message, 140)}`)
    }
  }
  sessions.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
  return { sessions, dir, unavailable, totalDirs }
}

function flagJob(job) {
  const text = `${job.status || ''} ${job.cause || ''} ${job.detail || ''}`
  if (/timeout|timed out|超时|ETIMEDOUT/i.test(text)) return '超时'
  if (/^(killed|cancelled|canceled|aborted)$/i.test(String(job.status || ''))) return '中断'
  if (/^failed$/i.test(String(job.status || ''))) return '失败'
  if (job.duration && job.duration > 300000) return '超过300s'
  return null
}

function isSelfJob(label) {
  return /dsh-status(?:\.cjs|\.cmd)?/i.test(String(label || ''))
}

function collectTaskEvents(sessions) {
  const events = []
  let totalSettled = 0
  let totalRunning = 0
  for (const s of sessions) {
    const sid = s.meta && s.meta.id ? s.meta.id : path.basename(path.dirname(s.file))
    for (const job of s.jobs) {
      totalSettled++
      const flag = flagJob(job)
      if (!flag) continue
      events.push({
        time: job.finishedAt || job.startedAt || s.lastActivity,
        sessionId: sid,
        sessionTitle: s.title,
        flag,
        duration: job.duration,
        status: job.status,
        cause: job.cause,
        detail: job.detail,
        tool: job.callName || job.kind,
        turn: job.turn,
        step: job.step,
        label: job.label,
        running: false,
      })
    }
    for (const job of s.running) {
      if (isSelfJob(job.label)) continue
      totalRunning++
      if (job.age > 300000) {
        events.push({
          time: job.startedAt || s.lastActivity,
          sessionId: sid,
          sessionTitle: s.title,
          flag: '运行中>300s',
          duration: job.age,
          status: 'running',
          cause: '',
          detail: '会话记录里没有对应的 job/settled',
          tool: job.kind,
          turn: null,
          step: null,
          label: job.label,
          running: true,
        })
      }
    }
  }
  events.sort((a, b) => (b.time || 0) - (a.time || 0))
  return { events, totalSettled, totalRunning }
}

function collectRunningJobs(sessions) {
  const out = []
  for (const s of sessions) {
    const sid = s.meta && s.meta.id ? s.meta.id : path.basename(path.dirname(s.file))
    for (const job of s.running) {
      if (isSelfJob(job.label)) continue
      out.push({
        sessionId: sid,
        sessionTitle: s.title,
        age: job.age,
        kind: job.kind,
        label: job.label,
        startedAt: job.startedAt,
        stale: s.lastActivity < START - 3600000,
      })
    }
  }
  return out
}

function contextReport(sessions) {
  const envId = process.env.DSH_SESSION_ID || null
  let session = null
  let isCurrent = false
  if (envId) {
    session = sessions.find((s) => s.meta && s.meta.id === envId) || null
    isCurrent = Boolean(session)
  }
  if (!session && sessions.length) {
    session = sessions[0]
    isCurrent = false
  }
  if (!session) {
    return { available: false, reason: '未找到会话记录：sessions 目录为空或不可读', isCurrent }
  }
  const lastUsage = session.usages.length ? session.usages[session.usages.length - 1] : null
  const usage = lastUsage ? lastUsage.usage : null
  const window = session.contextWindow || null
  const input = usage && Number.isFinite(usage.inputTokens) ? usage.inputTokens : null
  const cacheRead = usage && Number.isFinite(usage.cacheReadTokens) ? usage.cacheReadTokens : 0
  const cacheWrite = usage && Number.isFinite(usage.cacheWriteTokens) ? usage.cacheWriteTokens : 0
  const output = usage && Number.isFinite(usage.outputTokens) ? usage.outputTokens : null
  const promptTokens =
    usage && Number.isFinite(usage.totalTokens) && output != null
      ? usage.totalTokens - output
      : usage && input != null
        ? input + cacheRead + cacheWrite
        : null
  const pct = promptTokens != null && window ? (promptTokens / window) * 100 : null
  return {
    available: Boolean(usage),
    reason: usage ? null : '该会话记录里没有 assistant/message usage 字段',
    isCurrent,
    sessionId: session.meta && session.meta.id,
    title: session.title,
    model: session.model,
    contextWindow: window,
    usage,
    promptTokens,
    pct,
    sizeCompressed: session.sizeCompressed,
    sizeDecompressed: session.sizeDecompressed,
    lastActivity: session.lastActivity,
  }
}

// ---------------------------------------------------------------------------
// 等待中的安装 / 启动
// ---------------------------------------------------------------------------

function installTarget(cmd) {
  const s = String(cmd || '')
  let m = s.match(/--from\s+([^\s"']+)/i)
  if (m) return m[1]
  m = s.match(/(?:pip3?|npm|pnpm|yarn)\s+(?:install|i|add|update|upgrade)\s+([\s\S]*)$/i)
  if (m) {
    const tokens = m[1]
      .split(/\s+/)
      .filter(Boolean)
      .filter((t) => !t.startsWith('-') && !t.startsWith('$') && !/^\d+$/.test(t))
    return tokens.length ? tokens[tokens.length - 1] : null
  }
  m = s.match(/git\s+clone\s+(?:-{1,2}\S+\s+)*([^\s"']+)/i)
  if (m) return m[1]
  m = s.match(/(?:winget|choco)\s+install\s+(?:-{1,2}\S+\s+)*([^\s"']+)/i)
  if (m) return m[1]
  return null
}

function looksLikeInstall(p) {
  const name = String(p.name || '').toLowerCase()
  const cmd = String(p.cmd || '')
  if (/dsh-status\.cjs/i.test(cmd)) return false
  if (!isInstallerName(name) && !/\b(pip3?|npm|pnpm|yarn|winget|choco)\b/i.test(cmd)) return false
  if (/\b(install|add|upgrade|update|clone|sync|tool\s+install)\b/i.test(cmd)) return true
  if (/\s-m\s+pip3?\s+install\b/i.test(cmd)) return true
  return false
}

function buildPendingReport(procs, mcpReport, sessions) {
  const procsByPid = new Map(procs.map((p) => [p.pid, p]))
  const children = new Map()
  for (const p of procs) {
    if (!children.has(p.ppid)) children.set(p.ppid, [])
    children.get(p.ppid).push(p)
  }
  const descendants = (pid) => {
    const out = []
    const stack = [pid]
    const seen = new Set()
    while (stack.length) {
      const cur = stack.pop()
      for (const ch of children.get(cur) || []) {
        if (seen.has(ch.pid)) continue
        seen.add(ch.pid)
        out.push(ch)
        stack.push(ch.pid)
      }
    }
    return out
  }

  const entries = mcpReport.entries || []
  const entryTokens = entries.map((e) => ({
    entry: e,
    tokens: [
      String(e.config.serverName || ''),
      ...(e.config.args || []).map(String),
      String(e.config.command || ''),
    ]
      .join(' ')
      .toLowerCase(),
  }))
  const relatedEntry = (text) => {
    const t = String(text || '').toLowerCase()
    if (!t) return null
    for (const item of entryTokens) {
      const name = String(item.entry.config.serverName || '').toLowerCase()
      if (name && t.includes(name)) return item.entry
      const base = path.basename(String(item.entry.config.command || '').replace(/\\/g, '/')).toLowerCase()
      if (base && !/^(node|python|pythonw|uvx?|npx)(\.exe)?$/.test(base) && t.includes(base.replace(/\.exe$/, ''))) {
        return item.entry
      }
    }
    return null
  }

  const installers = []
  for (const p of procs) {
    if (!looksLikeInstall(p)) continue
    const age = p.startedAt ? START - p.startedAt : null
    if (age != null && age < 20000) continue
    const kids = descendants(p.pid)
    const hasServerChild = kids.some((k) => {
      const cmd = String(k.cmd || '').toLowerCase()
      return entries.some((e) => {
        const sig = mcpSignatures(e)
        return sig.strong.some((s) => cmd.includes(s))
      })
    })
    if (hasServerChild) continue
    const target = installTarget(p.cmd)
    const entry = relatedEntry(`${target || ''} ${p.cmd}`)
    const mcpRelated =
      Boolean(entry) || /mcp|everything|godot[-_]ai/i.test(`${target || ''} ${p.cmd}`)
    installers.push({
      pid: p.pid,
      name: p.name,
      age,
      target,
      entry: entry ? entry.config.serverName || entry.id : null,
      mcpRelated,
      cmd: p.cmd,
      likelyStuck: age != null && age > 180000,
    })
  }

  const missingLaunchers = []
  for (const e of entries) {
    const cmd = String(e.config.command || '').replace(/"/g, '')
    if (/[\\/]/.test(cmd) && !fs.existsSync(cmd)) {
      missingLaunchers.push({
        server: e.config.serverName || e.id,
        command: cmd,
        entry: e,
      })
    }
  }

  const running = collectRunningJobs(sessions)
  const pendingJobs = running
    .filter((j) => j.age > 30000)
    .map((j) => ({
      ...j,
      mcpRelated: /mcp|everything|godot|uvx|pip|npm|install|安装/i.test(String(j.label || '')),
      entry: relatedEntry(j.label),
    }))

  const waiting = []
  for (const i of installers) {
    if (!i.mcpRelated) continue
    waiting.push({
      kind: '安装进程',
      text: `${i.name} pid ${i.pid} 已运行 ${fmtDuration(i.age)}` +
        (i.target ? `；目标 ${redactSecrets(i.target)}` : '') +
        (i.entry ? `；关联 MCP: ${i.entry}` : '') +
        (i.likelyStuck ? '；超过 180s，可能卡住' : ''),
    })
  }
  for (const m of missingLaunchers) {
    waiting.push({
      kind: '启动器缺失',
      text: `${m.server} 的启动器不存在: ${m.command}`,
    })
  }
  for (const j of pendingJobs) {
    if (!j.mcpRelated) continue
    waiting.push({
      kind: '任务等待',
      text: `${j.kind} 已运行 ${fmtDuration(j.age)}` +
        (j.entry ? `；关联 MCP: ${j.entry}` : '') +
        `；${commandSummary(j.label, 90)}`,
    })
  }

  return {
    installers,
    missingLaunchers,
    pendingJobs,
    waiting,
    hasWaiting: waiting.length > 0,
  }
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

function printReport(report) {
  const L = []
  const add = (s = '') => L.push(s)

  add(`DSH 自检 / dsh-status v${VERSION}`)
  add(`生成时间: ${fmtTime(report.generatedAt)}（本机时区）`)
  add(
    `运行环境: DSH ${report.dshVersion || '不可用'} · profile ${report.profile}` +
      (report.ownInstance ? `（当前实例 ${instanceLabel(report.ownInstance)}）` : '') +
      ` · node ${process.version} · ${process.platform} ${process.arch}`
  )
  add(`DSH home: ${HOME}`)
  add('')

  // 1. 工作区
  add('[1] 工作区 / Git')
  add(`  工作目录 : ${report.cwd}`)
  if (report.git.isRepo) {
    add(`  项目根   : ${report.git.root}`)
    add(
      `  仓库状态 : git 仓库 · 分支 ${report.git.branch}` +
        (report.git.log
          ? ` · 最近提交 ${report.git.log.hash} ${report.git.log.date || ''} ${oneLine(report.git.log.subject, 60)}`
          : '')
    )
    const c = report.git.counts
    add(
      `  未提交   : ${report.git.dirtyCount > 0 ? '有' : '无'} · ${report.git.dirtyCount} 处` +
        `（修改 ${c.modified} / 新增 ${c.added} / 删除 ${c.deleted} / 重命名 ${c.renamed} / 未跟踪 ${c.untracked} / 冲突 ${c.conflict}）`
    )
    if (report.git.remote) {
      add(
        `  远端     : ${report.git.remote}` +
          (report.git.upstream
            ? ` · 上游 ${report.git.upstream}` +
              (report.git.ahead != null ? ` · 领先 ${report.git.ahead} / 落后 ${report.git.behind}` : '')
            : ' · 上游: 不可用（未设置 upstream）')
      )
    } else {
      add('  远端     : 不可用（未配置 origin）')
    }
  } else {
    add(`  项目根   : 不可用（${report.git.reason || '不是 git 仓库'}）`)
    add('  仓库状态 : 不是 git 仓库（当前目录可能只是普通工作目录）')
  }
  add('')

  // 2. MCP
  add('[2] MCP 服务')
  if (report.mcp.files.some((f) => f.exists)) {
    add('  配置来源:')
    for (const f of report.mcp.files) {
      add(`    - ${f.file}${f.exists ? `（${f.kind}）` : '（不存在）'}`)
    }
  } else {
    add('  配置来源: 不可用（未找到 cordis.patch.yml）')
  }
  if (report.mcp.rows.length) {
    const rows = report.mcp.rows.map((r) => [r.server, r.instance, r.status, r.evidence])
    add(
      table(['服务', '实例', '状态', '证据'], rows, [16, 18, 10, 96])
        .split('\n')
        .map((l) => '  ' + l)
        .join('\n')
    )
  } else {
    add('  服务清单: 不可用（配置里没有可识别的 MCP 服务）')
  }
  add('  等待中的 MCP 安装/启动: ' + (report.pending.hasWaiting ? '有' : '未发现'))
  for (const w of report.pending.waiting) {
    add(`    ! ${w.kind}: ${w.text}`)
  }
  if (!report.pending.hasWaiting) {
    add('    （没有检测到 MCP 安装进程、缺失的启动器，或等待 MCP 的未结算任务）')
  }
  const otherInstallers = report.pending.installers.filter((i) => !i.mcpRelated)
  if (otherInstallers.length) {
    add('  其它安装进程（未关联 MCP，仅供参考）:')
    for (const i of otherInstallers) {
      add(
        `    - ${i.name} pid ${i.pid} 已运行 ${fmtDuration(i.age)}` +
          (i.target ? '；目标 ' + redactSecrets(i.target) : '')
      )
    }
  }
  for (const w of report.mcp.warnings) add(`  ! ${w}`)
  add('  判定说明: “已连接”= 匹配到服务进程且存活 >20s（stdio MCP 没有独立握手探针）；')
  add('             “卡住”= 进程在但上游端口不通，或启动器 >60s 仍未拉起服务进程；')
  add('             “未运行”= 配置存在但当前实例没有进程（stdio MCP 可能按需启动）。')
  add('')

  // 3. 任务
  add('[3] 最近任务 / 超时')
  add(
    `  扫描: ${report.sessions.count} 个会话（${report.sessions.dir}，近 ${report.days} 天）` +
      (report.sessions.bad ? `；${report.sessions.bad} 个会话读取失败` : '')
  )
  const flagCounts = {}
  for (const e of report.tasks.events) flagCounts[e.flag] = (flagCounts[e.flag] || 0) + 1
  const flagText = Object.entries(flagCounts)
    .map(([k, v]) => `${k} ${v}`)
    .join(' / ')
  add(
    `  汇总: 结算任务 ${report.tasks.totalSettled} · 异常 ${report.tasks.events.length}` +
      (flagText ? `（${flagText}）` : '') +
      ` · 运行中未结算 ${report.tasks.totalRunning}`
  )
  if (report.tasks.events.length) {
    const resultLabel = (e) => {
      if (e.flag === '超过300s') return '超300s(完成)'
      if (e.flag === '中断') return '中断(被杀)'
      if (e.flag === '运行中>300s') return '运行中>300s'
      if (e.flag === '失败') return '失败'
      return e.flag
    }
    const rows = report.tasks.events.slice(0, report.limit).map((e) => {
      const sid = String(e.sessionId || '').replace(/^session-/, '').slice(0, 8)
      const title = e.sessionTitle ? ` ${oneLine(e.sessionTitle, 18)}` : ''
      const hint = e.running ? null : keywordHint(e.label)
      const where =
        `${e.tool || '?'}` +
        (e.step != null ? ` · step ${e.step}` : '') +
        (e.turn != null ? ` · turn ${e.turn}` : '') +
        ` · ${hint ? `[${hint}] ` : ''}${commandSummary(e.label || e.detail || '', 95)}`
      return [
        fmtTime(e.time),
        sid + title,
        resultLabel(e),
        fmtDuration(e.duration),
        where,
      ]
    })
    add(
      table(['时间', '会话', '结果', '耗时', '卡在哪一步'], rows, [19, 24, 12, 9, 95])
        .split('\n')
        .map((l) => '  ' + l)
        .join('\n')
    )
    if (report.tasks.events.length > report.limit) {
      add(`  … 还有 ${report.tasks.events.length - report.limit} 条，用 --limit N 调整`)
    }
    add('  说明: “中断(被杀)”可能是超时保护/看门狗/手动取消；耗时按 job 实际等待时长计算。')
  } else {
    add('  未发现超时 / 中断 / 超过 300s 的任务。')
  }
  const stuckRunning = report.tasks.events.filter((e) => e.running && e.duration > 300000)
  if (stuckRunning.length) {
    add(`  ! 运行中 >300s: ${stuckRunning.length} 个（可能卡住，建议先看它卡在哪一步）`)
    for (const e of stuckRunning.slice(0, 5)) {
      add(`    - ${fmtDuration(e.duration)}  ${e.tool} · ${commandSummary(e.label, 90)}`)
    }
  }
  const currentJobs = report.pending.pendingJobs.filter((j) => j.age <= 300000)
  if (currentJobs.length) {
    add('  其它运行中任务（<300s，仅供参考）:')
    for (const j of currentJobs.slice(0, 8)) {
      add(
        `    - ${j.kind} 已运行 ${fmtDuration(j.age)}${j.stale ? '（会话已 1h 无更新，可能失联）' : ''} · ${commandSummary(j.label, 80)}`
      )
    }
  }
  add('')

  // 4. 上下文
  add('[4] 上下文占用')
  const ctx = report.context
  if (!ctx.available) {
    add(`  近似大小: 不可用（${ctx.reason}）`)
    if (ctx.sessionId) add(`  会话    : ${ctx.sessionId}`)
  } else {
    const u = ctx.usage
    add(
      `  会话    : ${ctx.sessionId}${ctx.title ? ` 「${ctx.title}」` : ''}${ctx.isCurrent ? '（当前）' : '（最近会话，非当前运行会话）'}`
    )
    add(
      `  模型    : ${ctx.model || '不可用'} · 窗口 ${ctx.contextWindow ? fmtNum(ctx.contextWindow) : '不可用'} tokens`
    )
    add(
      `  最近调用: 上下文约 ${fmtNum(ctx.promptTokens)} tokens` +
        (u.inputTokens != null ? `（未缓存输入 ${fmtNum(u.inputTokens)}` : '') +
        (u.cacheReadTokens ? ` + 缓存命中 ${fmtNum(u.cacheReadTokens)}` : '') +
        (u.inputTokens != null ? '）' : '') +
        ` · 输出 ${fmtNum(u.outputTokens)}` +
        (ctx.pct != null ? ` → 占窗口 ${ctx.pct.toFixed(1)}%` : '')
    )
    add(
      `  本地记录: ${fmtBytes(ctx.sizeCompressed)}（压缩） / ${fmtBytes(ctx.sizeDecompressed)}（解压） · 最后写入 ${fmtTime(ctx.lastActivity)}`
    )
    add('  说明    : 输入 tokens 来自最近一次模型调用的真实 usage，不是对全文的估算。')
    if (ctx.pct != null && ctx.pct >= 80) add('  ! 已超过窗口 80%，建议尽快压缩或新开会话。')
  }
  add('')

  // 5. 数据来源
  add('[5] 数据来源 / 不可用项')
  add('  数据来源:')
  add(`    - git: 在 ${report.cwd} 执行 git rev-parse/status/log（${report.git.isRepo ? '成功' : '失败'}）`)
  add(`    - MCP 配置: ${report.mcp.files.map((f) => f.file).join(' / ')}`)
  add(`    - 进程: Win32_Process（PowerShell CIM）${report.procError ? '失败: ' + report.procError : '成功'}`)
  add(`    - 端口: netstat -ano ${report.portError ? '失败: ' + report.portError : '成功'}`)
  add(`    - 会话: ${report.sessions.dir}（${report.sessions.count} 个可读）`)
  if (report.dshInstances.length) {
    add(
      '    - DSH 实例: ' +
        report.dshInstances
          .map((i) => `${instanceLabel(i)}${i.port ? ' :' + i.port : ''}${i.version ? ' v' + i.version : ''}`)
          .join(' / ')
    )
  } else {
    add('    - DSH 实例: 不可用（未发现 dsh/lib/bin.js 进程）')
  }
  const unavailable = [...report.unavailable]
  if (unavailable.length) {
    add('  不可用:')
    for (const u of unavailable) add(`    - ${u}`)
  } else {
    add('  不可用: 无（本次所有数据项均读取成功）')
  }
  add('')
  add(`完成，用时 ${fmtDuration(Date.now() - START)}。`)

  process.stdout.write(L.join('\n') + '\n')
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(
      `dsh-status ${VERSION}\n\n` +
        `用法: node scripts/dsh-status.cjs [选项]\n\n` +
        `  --cwd <path>      要检查的工作目录（默认当前目录）\n` +
        `  --profile <name>  DSH profile（默认 $DSH_PROFILE，否则按进程推断 / qqbot）\n` +
        `  --days <n>        会话回溯天数（默认 14）\n` +
        `  --limit <n>       任务表最多显示几条（默认 12）\n` +
        `  --json            输出 JSON（便于别的脚本消费）\n` +
        `  --help            显示本帮助\n`
    )
    return
  }

  const unavailable = []
  let procs = []
  let procError = null
  try {
    procs = getProcesses()
  } catch (e) {
    procError = oneLine(e.message, 220)
    unavailable.push('进程列表不可用: ' + procError)
  }

  const instances = findDshInstances(procs)
  const ownInstance = detectOwnInstance(procs, instances)
  const detectedProfile = ownInstance
    ? ownInstance.profile
    : instances.length
      ? instances[instances.length - 1].profile
      : null
  const profile = args.profile || detectedProfile || 'qqbot'

  let portsInfo = { map: new Map(), error: null }
  try {
    portsInfo = getListeningPorts()
  } catch (e) {
    portsInfo = { map: new Map(), error: oneLine(e.message, 180) }
    unavailable.push('端口表不可用: ' + portsInfo.error)
  }

  const git = gatherGit(args.cwd)
  if (git.unavailable) unavailable.push(...git.unavailable)
  if (!git.isRepo) unavailable.push('项目根 / git 状态不可用: ' + git.reason)

  const mcp = await buildMcpReport(profile, procs, portsInfo, instances)
  unavailable.push(...mcp.unavailable)

  const scan = scanSessions(args.cwd, args.days)
  unavailable.push(...scan.unavailable)
  const context = contextReport(scan.sessions)
  if (!context.available) unavailable.push('上下文大小不可用: ' + context.reason)
  if (!scan.sessions.length) {
    unavailable.push('最近任务记录不可用: 没有找到该工作目录的会话记录')
  }
  const tasks = collectTaskEvents(scan.sessions)
  const pending = buildPendingReport(procs, mcp, scan.sessions)

  let dshVersion = null
  for (const i of instances) if (i.version) dshVersion = i.version
  if (!dshVersion) {
    try {
      const logs = fs
        .readdirSync(path.join(HOME, 'logs'))
        .filter((f) => f.endsWith('.log'))
        .sort()
      if (logs.length) {
        const text = fs.readFileSync(path.join(HOME, 'logs', logs[logs.length - 1]), 'utf8')
        const m = text.match(/dshVersion:\s*'([^']+)'/)
        if (m) dshVersion = m[1]
      }
    } catch {
      /* 忽略 */
    }
  }

  const report = {
    tool: 'dsh-status',
    version: VERSION,
    generatedAt: START,
    cwd: args.cwd,
    profile,
    ownInstance,
    dshVersion,
    dshInstances: instances,
    git,
    mcp,
    sessions: {
      dir: scan.dir,
      count: scan.sessions.length,
      bad: scan.unavailable.filter((x) => /会话不可读/.test(x)).length,
    },
    tasks,
    pending,
    context,
    procError,
    portError: portsInfo.error,
    unavailable,
    days: args.days,
    limit: args.limit,
  }

  if (args.json) {
    const json = {
      ...report,
      mcp: {
        files: report.mcp.files,
        entries: report.mcp.entries.map((e) => ({
          id: e.id,
          serverName: e.config.serverName,
          command: e.config.command,
          args: e.config.args,
          transport: e.config.transport,
          source: e.source,
        })),
        rows: report.mcp.rows,
        warnings: report.mcp.warnings,
      },
      sessions: { ...report.sessions },
      tasks: {
        totalSettled: report.tasks.totalSettled,
        totalRunning: report.tasks.totalRunning,
        events: report.tasks.events.slice(0, report.limit),
      },
    }
    process.stdout.write(JSON.stringify(json, null, 2) + '\n')
    return
  }

  printReport(report)
}

main().catch((e) => {
  process.stderr.write('dsh-status 失败: ' + (e && e.stack ? e.stack : String(e)) + '\n')
  process.exit(1)
})
