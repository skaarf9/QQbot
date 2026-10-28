#!/usr/bin/env node
/**
 * subagent-gate.cjs — 子 agent 名额与文件地盘的登记处（供 DSH QQ agent 调用）
 *
 *   node subagent-gate.cjs status
 *   node subagent-gate.cjs acquire --task "调研插件市场" --files "docs/a.md,docs/b/" [--note "只写 docs"] [--owner "qq:2791932480"]
 *   node subagent-gate.cjs check  --files "routes/astrbot/x.py"
 *   node subagent-gate.cjs release <lease-id>
 *   node subagent-gate.cjs release --all
 *   node subagent-gate.cjs sweep [--ttl-hours 3]
 *
 * 规则：
 *   - 同时最多 3 个 lease（= 最多 3 个子进程并行）。
 *   - 两个 lease 的文件地盘不能重叠：同一文件、或一个目录包含另一个，都算撞车。
 *   - `*` 表示整个仓库，和谁都撞。
 *   - 路径相对仓库根目录（D:\deepseek\QQbot）解释；也接受绝对路径；`workspace` 是
 *     `routes/astrbot/workspace` 的别名。
 *
 * 退出码：0 成功 / 2 用法错 / 3 名额满 / 4 地盘冲突 / 5 lease 不存在。
 * 输出：一行 JSON，`ok` 字段说结果，`hint` 是给人看的一句话。
 *
 * 为什么要这个：DSH 本身没有子 agent 并发上限，也没有「谁在改哪个文件」的账本。
 * 光靠提示词容易忘，所以把账本落到盘上，开之前先问一句、收工再销账。
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..', '..', '..', '..')
const STATE_DIR = path.join(REPO, 'routes', 'astrbot', 'workspace', '.state')
const STATE_FILE = path.join(STATE_DIR, 'subagent-leases.json')
const LOCK_FILE = path.join(STATE_DIR, 'subagent-leases.lock')
const MAX_ACTIVE = 3
const DEFAULT_TTL_HOURS = 3

function nowIso() {
  return new Date().toISOString()
}

function fail(code, payload) {
  process.stdout.write(JSON.stringify(payload) + '\n')
  process.exit(code)
}

function readState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8')
    const data = JSON.parse(raw)
    if (data && Array.isArray(data.leases)) return data
  } catch {
    /* 没有或坏了都当空账本 */
  }
  return { leases: [] }
}

function writeState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true })
  const tmp = `${STATE_FILE}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, STATE_FILE)
}

/** 简单的跨进程互斥：acquire 时两个进程同时来也不会都拿到最后一个名额。 */
function withLock(fn) {
  fs.mkdirSync(STATE_DIR, { recursive: true })
  const deadline = Date.now() + 3000
  let fd = null
  while (Date.now() < deadline) {
    try {
      fd = fs.openSync(LOCK_FILE, 'wx')
      break
    } catch (err) {
      if (err && err.code !== 'EEXIST') throw err
      const wait = 40 + Math.floor(Math.random() * 60)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait)
    }
  }
  if (fd === null) throw new Error('拿不到状态锁（另一个 acquire 卡住了？稍后再试）')
  try {
    return fn()
  } finally {
    try { fs.closeSync(fd) } catch {}
    try { fs.unlinkSync(LOCK_FILE) } catch {}
  }
}

const ALIASES = {
  workspace: 'routes/astrbot/workspace',
  repo: '.',
  root: '.',
}

function normalize(p) {
  let s = String(p || '').trim()
  if (!s) return ''
  s = s.replace(/\\/g, '/')
  s = s.replace(/\/+/g, '/')
  if (s === '.' || s === './') return '*'
  if (ALIASES[s.toLowerCase()]) s = ALIASES[s.toLowerCase()]
  if (s === '*') return '*'
  const abs = path.isAbsolute(s) ? path.resolve(s) : path.resolve(REPO, s)
  let rel = path.relative(REPO, abs).replace(/\\/g, '/')
  if (rel.startsWith('..')) rel = abs.replace(/\\/g, '/') // 仓库外：用绝对路径比
  if (!rel || rel === '.') return '*'
  return process.platform === 'win32' ? rel.toLowerCase() : rel
}

/** 两个地盘是否重叠：相等、或一个目录包含另一个。 */
function overlaps(a, b) {
  if (a === '*' || b === '*') return true
  if (a === b) return true
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

function scopeConflict(filesA, filesB) {
  for (const a of filesA) {
    for (const b of filesB) {
      if (overlaps(a, b)) return [a, b]
    }
  }
  return null
}

function parseList(raw) {
  return String(raw || '')
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function argValue(argv, name) {
  const i = argv.indexOf(name)
  if (i < 0) return ''
  return argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : ''
}

function newId() {
  return `s-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')}`
}

function sweepStale(state, ttlHours) {
  const cutoff = Date.now() - ttlHours * 3600 * 1000
  const before = state.leases.length
  state.leases = state.leases.filter((l) => {
    const t = Date.parse(l.startedAt || '')
    return Number.isFinite(t) ? t >= cutoff : true
  })
  return before - state.leases.length
}

function summarize(leases) {
  return leases.map((l) => ({
    lease: l.id,
    task: l.task,
    files: l.files,
    note: l.note || '',
    age_min: Math.max(0, Math.round((Date.now() - Date.parse(l.startedAt)) / 60000)),
  }))
}

function cmdStatus() {
  const state = readState()
  const leases = state.leases.filter((l) => !l.releasedAt)
  process.stdout.write(JSON.stringify({
    ok: true,
    active: leases.length,
    max: MAX_ACTIVE,
    free: Math.max(0, MAX_ACTIVE - leases.length),
    leases: summarize(leases),
    hint: leases.length
      ? `在跑 ${leases.length}/${MAX_ACTIVE}：${leases.map((l) => `${l.id}(${l.task})`).join('、')}`
      : '没有在跑的子 agent，名额全空。',
  }) + '\n')
}

function cmdAcquire(argv) {
  const task = argValue(argv, '--task') || '未命名任务'
  const rawFiles = argValue(argv, '--files') || argValue(argv, '--scopes')
  const note = argValue(argv, '--note')
  const owner = argValue(argv, '--owner')
  const files = parseList(rawFiles).map(normalize).filter(Boolean)
  if (!files.length) {
    fail(2, { ok: false, error: 'missing-files', hint: '必须用 --files 写清要改哪些文件/目录（逗号分隔），否则没法判断会不会撞车。' })
  }
  const result = withLock(() => {
    const state = readState()
    sweepStale(state, DEFAULT_TTL_HOURS)
    if (state.leases.length >= MAX_ACTIVE) {
      return { code: 3, payload: { ok: false, error: 'limit', active: state.leases.length, max: MAX_ACTIVE, leases: summarize(state.leases), hint: `名额满了（${MAX_ACTIVE} 个都在跑）。先 status 看谁快完了，或等它 release 再来。` } }
    }
    for (const lease of state.leases) {
      const hit = scopeConflict(files, lease.files)
      if (hit) {
        return { code: 4, payload: { ok: false, error: 'conflict', with: lease.id, with_task: lease.task, with_files: lease.files, overlap: hit, leases: summarize(state.leases), hint: `和 ${lease.id}（${lease.task}）撞地盘：${hit[0]} ↔ ${hit[1]}。改成串行，或把范围缩到不重叠。` } }
      }
    }
    const lease = { id: newId(), task, files, note, owner: owner || '', startedAt: nowIso() }
    state.leases.push(lease)
    writeState(state)
    return { code: 0, payload: { ok: true, lease: lease.id, task, files, active: state.leases.length, max: MAX_ACTIVE, hint: `拿到 ${lease.id}（${state.leases.length}/${MAX_ACTIVE}）。子 agent 只许碰 ${files.join('、')}；做完 release ${lease.id}。` } }
  })
  if (result.code !== 0) fail(result.code, result.payload)
  process.stdout.write(JSON.stringify(result.payload) + '\n')
}

function cmdCheck(argv) {
  const files = parseList(argValue(argv, '--files') || argValue(argv, '--scopes')).map(normalize).filter(Boolean)
  if (!files.length) fail(2, { ok: false, error: 'missing-files', hint: '用 --files 写要检查的路径。' })
  const state = readState()
  const hits = []
  for (const lease of state.leases) {
    const hit = scopeConflict(files, lease.files)
    if (hit) hits.push({ lease: lease.id, task: lease.task, overlap: hit })
  }
  process.stdout.write(JSON.stringify({ ok: hits.length === 0, conflicts: hits, free: Math.max(0, MAX_ACTIVE - state.leases.length), hint: hits.length ? '会撞车，别并行。' : '干净，可以开。' }) + '\n')
  if (hits.length) process.exitCode = 4
}

function cmdRelease(argv) {
  const all = argv.includes('--all')
  const id = all ? '' : (argv.find((a) => a && !a.startsWith('--')) || '')
  if (!all && !id) fail(2, { ok: false, error: 'missing-id', hint: '用法：release <lease-id>，或 release --all。' })
  const result = withLock(() => {
    const state = readState()
    const before = state.leases.length
    if (all) state.leases = []
    else state.leases = state.leases.filter((l) => l.id !== id)
    writeState(state)
    return { before, after: state.leases.length, id: all ? '*' : id }
  })
  if (!all && result.before === result.after) {
    fail(5, { ok: false, error: 'not-found', lease: id, hint: '没有这个 lease，可能已经 release 过或 id 记错了（status 看一下）。' })
  }
  process.stdout.write(JSON.stringify({ ok: true, released: result.id, active: result.after, max: MAX_ACTIVE, hint: `已销账，剩 ${result.after}/${MAX_ACTIVE}。` }) + '\n')
}

function cmdSweep(argv) {
  const ttl = Number(argValue(argv, '--ttl-hours')) || DEFAULT_TTL_HOURS
  const dropped = withLock(() => {
    const state = readState()
    const n = sweepStale(state, ttl)
    writeState(state)
    return { n, active: state.leases.length }
  })
  process.stdout.write(JSON.stringify({ ok: true, dropped: dropped.n, active: dropped.active, max: MAX_ACTIVE, hint: dropped.n ? `清掉 ${dropped.n} 个超过 ${ttl} 小时的僵尸 lease。` : '没有僵尸 lease。' }) + '\n')
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  switch (cmd) {
    case 'status': return cmdStatus()
    case 'acquire': return cmdAcquire(rest)
    case 'check': return cmdCheck(rest)
    case 'release': return cmdRelease(rest)
    case 'sweep': return cmdSweep(rest)
    default:
      fail(2, {
        ok: false,
        error: 'unknown-command',
        hint: '可用命令：status | acquire --task --files [--note] | check --files | release <id> | release --all | sweep',
      })
  }
}

try {
  main()
} catch (err) {
  fail(1, { ok: false, error: 'internal', message: err && err.message ? err.message : String(err) })
}
