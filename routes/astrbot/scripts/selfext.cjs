#!/usr/bin/env node
/**
 * selfext.cjs — AstrBot 自我扩展助手（供 DSH QQ agent 调用）
 *
 *   node selfext.cjs status
 *   node selfext.cjs plugins list
 *   node selfext.cjs plugins search <关键词>
 *   node selfext.cjs plugins install <市场 id | GitHub 仓库地址>
 *   node selfext.cjs plugins reload <插件名>
 *   node selfext.cjs plugins update <插件名>
 *   node selfext.cjs upgrade [--check]
 *   node selfext.cjs restart [--delay 15]
 *   node selfext.cjs logs [80]
 *   node selfext.cjs allowlist list
 *   node selfext.cjs allowlist add <qq>
 *   node selfext.cjs allowlist remove <qq>
 *
 * 只读写 routes/astrbot 下的东西；不碰 Koishi 生产实例。
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const REPO = path.resolve(__dirname, '..', '..', '..')
const ROUTE = path.join(REPO, 'routes', 'astrbot')
const APP = path.join(ROUTE, 'app')
const ENV_FILE = path.join(ROUTE, '.env')
const LOG_DIR = path.join(ROUTE, 'logs')
const LOG_FILE = path.join(LOG_DIR, 'selfext.log')
const PLUGIN_CONFIG = path.join(APP, 'data', 'config', 'astrbot_plugin_dsh_config.json')
const BRIDGE_PLUGIN = 'astrbot_plugin_dsh'
const ASTRBOT_BIN = path.join(ROUTE, 'bin', 'astrbot.exe')
const UV_ENV = {
  UV_TOOL_DIR: path.join(ROUTE, '.uv-tools'),
  UV_TOOL_BIN_DIR: path.join(ROUTE, 'bin'),
  UV_CACHE_DIR: path.join(ROUTE, '.uv-cache'),
}

function readEnv() {
  const out = {}
  try {
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
      if (!m) continue
      out[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch {}
  return out
}

function log(entry) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    fs.appendFileSync(LOG_FILE, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n')
  } catch {}
}

function installedVersion() {
  try {
    const dir = path.join(ROUTE, '.uv-tools', 'astrbot', 'Lib', 'site-packages')
    const meta = fs.readdirSync(dir).find((n) => /^astrbot-.*\.dist-info$/.test(n))
    if (!meta) return '?'
    const text = fs.readFileSync(path.join(dir, meta, 'METADATA'), 'utf8')
    const m = /^Version:\s*(.+)$/m.exec(text)
    return m ? m[1].trim() : '?'
  } catch {
    return '?'
  }
}

async function call(pathname, { method = 'GET', body, token } = {}) {
  const headers = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`http://127.0.0.1:6186${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  if (!res.ok) throw new Error(`HTTP ${res.status} ${pathname}: ${(json && json.message) || text.slice(0, 300)}`)
  return json
}

async function login() {
  const env = readEnv()
  const username = env.ASTRBOT_DASHBOARD_USER || 'astrbot'
  const password = env.ASTRBOT_DASHBOARD_PASSWORD
  if (!password) throw new Error('缺少 ASTRBOT_DASHBOARD_PASSWORD（routes/astrbot/.env）')
  const r = await call('/api/auth/login', { method: 'POST', body: { username, password } })
  const token = r && r.data && r.data.token
  if (!token) throw new Error('AstrBot 登录失败：响应里没有 token')
  return token
}

function print(obj) {
  console.log(typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2))
}

async function cmdStatus() {
  const version = installedVersion()
  let plugins = []
  let authed = false
  try {
    const token = await login()
    authed = true
    const r = await call('/api/v1/plugins', { token })
    plugins = (r.data || []).map((p) => p.name)
  } catch {}
  let health = null
  try {
    const r = await fetch('http://127.0.0.1:3188/health', { signal: AbortSignal.timeout(4000) })
    health = await r.json()
  } catch {}
  print({
    astrbot_version: version,
    dashboard: authed ? 'ok' : 'down / auth failed',
    plugins,
    ingress: health ? health.ok : false,
    ingress_version: health ? health.plugin : null,
  })
}

async function cmdPluginsList() {
  const token = await login()
  const r = await call('/api/v1/plugins', { token })
  print(
    (r.data || []).map((p) => ({
      name: p.name,
      version: p.version,
      author: p.author,
      enabled: p.activated !== false,
    })),
  )
}

async function marketMap(token) {
  const r = await call('/api/v1/plugins/market', { token })
  const data = r.data || {}
  const out = []
  for (const [id, v] of Object.entries(data)) {
    if (id === '$meta' || !v || typeof v !== 'object') continue
    out.push({ market_id: id, ...v })
  }
  return out
}

async function cmdPluginsSearch(query) {
  const token = await login()
  const all = await marketMap(token)
  const q = String(query || '').trim().toLowerCase()
  const hits = all
    .filter((p) => {
      const hay = `${p.market_id} ${p.name || ''} ${p.desc || ''} ${p.repo || ''}`.toLowerCase()
      return !q || hay.includes(q)
    })
    .slice(0, 12)
    .map((p) => ({
      market_id: p.market_id,
      name: p.name,
      version: p.version,
      author: p.author,
      desc: String(p.desc || '').replace(/\s+/g, ' ').slice(0, 120),
      repo: p.repo,
    }))
  print(hits)
}

async function cmdPluginsInstall(spec) {
  const token = await login()
  const all = await marketMap(token)
  const needle = String(spec || '').trim()
  const market =
    all.find((p) => p.market_id === needle) ||
    all.find((p) => p.name === needle) ||
    all.find((p) => p.market_id.toLowerCase() === needle.toLowerCase())

  let res
  if (market) {
    res = await call('/api/v1/plugins/install/url', {
      method: 'POST',
      token,
      body: { install_method: 'market', market_plugin_id: market.market_id },
    })
  } else if (/^https?:\/\//i.test(needle)) {
    res = await call('/api/v1/plugins/install/github', {
      method: 'POST',
      token,
      body: { repository: needle },
    })
  } else {
    throw new Error(`市场里找不到「${needle}」，也不是 http(s) 仓库地址`)
  }

  const installedName =
    (res.data && (res.data.name || res.data.plugin_name || res.data.id)) ||
    (market && market.name) ||
    needle
  await new Promise((r) => setTimeout(r, 1500))
  let listed = null
  try {
    const l = await call('/api/v1/plugins', { token })
    listed = (l.data || []).find((p) => p.name === installedName || p.name === needle)
  } catch {}
  print({
    ok: true,
    message: res.message || '安装成功',
    installed: installedName,
    verified: Boolean(listed),
    version: listed && listed.version,
  })
}

async function cmdPluginsReload(name) {
  const token = await login()
  const r = await call('/api/v1/plugins/reload', { method: 'POST', token, body: { plugin_id: name } })
  print({ ok: true, message: r.message || '已重载', plugin: name })
}

async function cmdPluginsUpdate(name) {
  const token = await login()
  const r = await call('/api/v1/plugins/update', { method: 'POST', token, body: { plugin_id: name } })
  print({ ok: true, message: r.message || '已更新', plugin: name })
}

async function latestVersion() {
  try {
    const r = await call('/api/v1/updates/check', { token: await login() })
    const d = r.data || {}
    return d.latest_version || d.latest || d.version || null
  } catch {
    return null
  }
}

async function cmdUpgrade(checkOnly) {
  const current = installedVersion()
  const latest = await latestVersion()
  if (checkOnly) {
    const norm = (x) => String(x || '').replace(/^v/i, '').trim();
    print({ current, latest: latest || 'unknown', update_available: latest ? norm(latest) !== norm(current) : null })
    return
  }
  if (!fs.existsSync(ASTRBOT_BIN)) throw new Error(`找不到 ${ASTRBOT_BIN}`)
  const r = spawnSync('uv', ['tool', 'upgrade', 'astrbot', '--python', '3.12'], {
    cwd: ROUTE,
    env: { ...process.env, ...UV_ENV },
    encoding: 'utf8',
    timeout: 300000,
  })
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim()
  print({
    ok: r.status === 0,
    exit: r.status,
    from: current,
    output: out.slice(-3000),
    note: r.status === 0 ? '升级完成。需要重启 AstrBot 才会生效：再执行 restart --delay 15。' : '升级失败，见 output。',
  })
}

function cmdRestart(delaySec) {
  const taskCmd = path.join(__dirname, 'restart-task.cmd')
  if (!fs.existsSync(taskCmd)) throw new Error(`缺少 ${taskCmd}`)
  // 用独立的计划任务：会话里的 detached 子进程可能被 DSH 的 job 对象一起收掉，
  // 计划任务不受影响。任务名带时间戳，避免删除正在跑 AstrBot 的旧任务（那等于立刻杀掉）。
  const taskName = `QQbotAstrBotRestart${Date.now()}`.slice(0, 60)
  const at = new Date(Date.now() + 60_000)
  const hh = String(at.getHours()).padStart(2, '0')
  const mm = String(at.getMinutes()).padStart(2, '0')
  const run = (args) =>
    spawnSync('schtasks.exe', args, { encoding: 'utf8', timeout: 30000, windowsHide: true })
  const created = run([
    '/create', '/tn', taskName,
    '/tr', `${taskCmd} ${delaySec}`,
    '/sc', 'once', '/st', `${hh}:${mm}`, '/f',
  ])
  if (created.status !== 0) {
    throw new Error(`创建计划任务失败：${(created.stderr || created.stdout || '').trim()}`)
  }
  const started = run(['/run', '/tn', taskName])
  if (started.status !== 0) {
    throw new Error(`启动计划任务失败：${(started.stderr || started.stdout || '').trim()}`)
  }
  print({
    ok: true,
    message: `已安排在 ${delaySec} 秒后重启 AstrBot（计划任务 ${taskName}）`,
    delayed_seconds: delaySec,
    task: taskName,
  })
}

function cmdLogs(n) {
  const count = Math.max(1, Math.min(500, Number(n) || 80))
  const candidates = [
    path.join(LOG_DIR, 'astrbot-run.log'),
    path.join(LOG_DIR, 'astrbot.log'),
    path.join(APP, 'data', 'logs', 'astrbot.log'),
  ]
  const file = candidates.find((f) => fs.existsSync(f))
  if (!file) {
    print('还没有日志文件')
    return
  }
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  print(lines.slice(-count).join('\n'))
}

async function reloadBridge() {
  try {
    const token = await login()
    await call('/api/v1/plugins/reload', { method: 'POST', token, body: { plugin_id: BRIDGE_PLUGIN } })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) }
  }
}

function readPluginConfig() {
  try {
    return JSON.parse(fs.readFileSync(PLUGIN_CONFIG, 'utf8'))
  } catch (err) {
    throw new Error(`读不到桥插件配置 ${PLUGIN_CONFIG}：${err.message}`)
  }
}

function writePluginConfig(cfg) {
  fs.writeFileSync(PLUGIN_CONFIG, `${JSON.stringify(cfg, null, 4)}\n`, 'utf8')
}

function allowlistOf(cfg) {
  const owners = (Array.isArray(cfg.owner_users) && cfg.owner_users.length
    ? cfg.owner_users
    : ['2791932480']).map(String)
  const maintainers = (Array.isArray(cfg.maintainer_users) ? cfg.maintainer_users : []).map(String)
  return { owners, maintainers: [...new Set([...owners, ...maintainers])] }
}

/**
 * 维护者白名单：名单里的人能让 bot 装插件、升级、改项目、派子进程。
 * 写的是 AstrBot 桥插件的运行配置；写完顺手重载，马上生效。
 */
async function cmdAllowlist(sub, arg) {
  const cfg = readPluginConfig()
  const { owners, maintainers } = allowlistOf(cfg)
  const qq = String(arg || '').trim()
  if (!sub || sub === 'list') {
    print({
      owners,
      maintainers,
      note: 'owners 全权限；maintainers 可让 bot 装插件/升级/改项目/派子进程；名单外只能聊天。',
    })
    return
  }
  if (sub !== 'add' && sub !== 'remove') {
    throw new Error('allowlist 子命令：list | add <qq> | remove <qq>')
  }
  if (!/^\d{5,12}$/.test(qq)) throw new Error(`QQ 号格式不对：${qq || '(空)'}`)
  const isOwner = owners.includes(qq)
  if (sub === 'add') {
    if (maintainers.includes(qq)) {
      print({ ok: true, unchanged: true, qq, maintainers })
      return
    }
    cfg.owner_users = owners
    cfg.maintainer_users = [...maintainers, qq]
    writePluginConfig(cfg)
    const reload = await reloadBridge()
    print({ ok: true, added: qq, maintainers: cfg.maintainer_users, reload })
    return
  }
  if (isOwner) throw new Error(`${qq} 是所有者，不能从白名单移除（要改先动 owner_users）`)
  if (!maintainers.includes(qq)) {
    print({ ok: true, unchanged: true, qq, maintainers })
    return
  }
  cfg.owner_users = owners
  cfg.maintainer_users = maintainers.filter((x) => x !== qq)
  writePluginConfig(cfg)
  const reload = await reloadBridge()
  print({ ok: true, removed: qq, maintainers: cfg.maintainer_users, reload })
}

async function main() {
  const [cmd, sub, ...rest] = process.argv.slice(2)
  const arg = rest.join(' ')
  if (!cmd || cmd === 'help' || cmd === '--help') {
    print(
      [
        'node selfext.cjs status',
        'node selfext.cjs plugins list',
        'node selfext.cjs plugins search <关键词>',
        'node selfext.cjs plugins install <市场 id | GitHub 仓库地址>',
        'node selfext.cjs plugins reload <插件名>',
        'node selfext.cjs plugins update <插件名>',
        'node selfext.cjs upgrade [--check]',
        'node selfext.cjs restart [--delay 15]',
        'node selfext.cjs logs [80]',
        'node selfext.cjs allowlist list',
        'node selfext.cjs allowlist add <qq>',
        'node selfext.cjs allowlist remove <qq>',
      ].join('\n'),
    )
    return
  }

  if (cmd === 'status') return cmdStatus()
  if (cmd === 'logs') return cmdLogs(sub)
  if (cmd === 'allowlist') return cmdAllowlist(sub, arg)
  if (cmd === 'restart') {
    const i = process.argv.indexOf('--delay')
    const delay = i >= 0 ? Number(process.argv[i + 1]) : 15
    return cmdRestart(Number.isFinite(delay) ? Math.max(1, delay) : 15)
  }
  if (cmd === 'upgrade') return cmdUpgrade(process.argv.includes('--check'))
  if (cmd === 'plugins') {
    if (sub === 'list') return cmdPluginsList()
    if (sub === 'search') return cmdPluginsSearch(arg)
    if (sub === 'install') return cmdPluginsInstall(arg)
    if (sub === 'reload') return cmdPluginsReload(arg)
    if (sub === 'update') return cmdPluginsUpdate(arg)
    throw new Error('plugins 子命令：list | search | install | reload | update')
  }
  throw new Error(`未知命令：${cmd}`)
}

log({ ok: null, argv: process.argv.slice(2), phase: 'start' })
main()
  .then(() => log({ ok: true, argv: process.argv.slice(2), phase: 'done' }))
  .catch((err) => {
    const message = err && err.message ? err.message : String(err)
    log({ ok: false, argv: process.argv.slice(2), error: message })
    console.error(`selfext: ${message}`)
    process.exitCode = 1
  })
