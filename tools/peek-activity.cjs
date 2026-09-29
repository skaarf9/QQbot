/**
 * 只读诊断：看 koishi.db 里最近的活动（最后一条消息 / 最后一次互动 / 会话更新时间）
 * 用法：node --experimental-sqlite --no-warnings tools/peek-activity.cjs
 */
const { DatabaseSync } = require('node:sqlite')
const path = require('node:path')

const dbPath = path.join(__dirname, '..', 'koishi-app', 'data', 'koishi.db')
const db = new DatabaseSync(dbPath, { readOnly: true })

const q = (sql, ...args) => {
  try {
    return db.prepare(sql).all(...args)
  } catch (e) {
    return [{ __error: e.message }]
  }
}

const ts = (v) => {
  if (v == null || v === '') return '-'
  const n = Number(v)
  const d = Number.isFinite(n) && n > 1e11 ? new Date(n) : new Date(String(v))
  return Number.isNaN(d.getTime()) ? String(v) : `${d.toLocaleString('zh-CN')} (${v})`
}

const show = (title, rows) => {
  console.log(`\n=== ${title} ===`)
  if (!rows.length) return console.log('(空)')
  for (const r of rows) console.log(JSON.stringify(r, (k, v) => (typeof v === 'bigint' ? String(v) : v)))
}

const tables = q(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).map((r) => r.name)
console.log('表：' + tables.join(', '))

const cols = (t) => {
  try {
    return db.prepare(`PRAGMA table_info(\`${t}\`)`).all().map((r) => r.name)
  } catch {
    return []
  }
}

// 最近的消息（chathub_message 是 chatluna 的正式消息表）
if (tables.includes('chathub_message')) {
  const c = cols('chathub_message')
  const order = c.includes('id') ? 'rowid DESC' : 'rowid DESC'
  show(
    'chathub_message 最近 10 条',
    q(`SELECT rowid, ${c.filter((x) => ['id', 'role', 'name', 'text', 'conversation'].includes(x)).join(', ')}
       FROM chathub_message ORDER BY ${order} LIMIT 10`).map((r) => ({
      ...r,
      text: typeof r.text === 'string' ? r.text.slice(0, 120) : r.text,
    })),
  )
}

if (tables.includes('chatluna_message')) {
  const c = cols('chatluna_message')
  show(
    'chatluna_message 最近 10 条',
    q(`SELECT rowid, ${c.filter((x) => ['id', 'role', 'name', 'text', 'conversation'].includes(x)).join(', ')}
       FROM chatluna_message ORDER BY rowid DESC LIMIT 10`).map((r) => ({
      ...r,
      text: typeof r.text === 'string' ? r.text.slice(0, 120) : r.text,
    })),
  )
}

if (tables.includes('chatluna_conversation')) {
  const c = cols('chatluna_conversation')
  const timeCol = c.find((x) => /updated|created/i.test(x))
  show(
    'chatluna_conversation 最近 8 条',
    q(`SELECT rowid, ${c.filter((x) => ['id', 'title', 'latestId', 'updatedAt', 'createdAt'].includes(x)).join(', ')}
       FROM chatluna_conversation ORDER BY ${timeCol || 'rowid'} DESC LIMIT 8`).map((r) => ({
      ...r,
      ...(timeCol ? { [timeCol]: ts(r[timeCol]) } : {}),
    })),
  )
}

if (tables.includes('chatluna_affinity_v2')) {
  show(
    'chatluna_affinity_v2（最后互动时间）',
    q(`SELECT userId, nickname, chatCount, lastInteractionAt FROM chatluna_affinity_v2
       ORDER BY lastInteractionAt DESC LIMIT 10`).map((r) => ({
      ...r,
      lastInteractionAt: ts(r.lastInteractionAt),
    })),
  )
}

for (const t of ['chatluna_scene', 'chatluna_emotion', 'chatluna_image_cache']) {
  if (!tables.includes(t)) continue
  const c = cols(t)
  const timeCol = c.find((x) => /lastActive|updatedAt|createdAt/i.test(x))
  show(
    `${t} 最近 5 条`,
    q(`SELECT * FROM ${t} ORDER BY ${timeCol || 'rowid'} DESC LIMIT 5`),
  )
}

db.close()
