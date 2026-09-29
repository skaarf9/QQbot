/**
 * 只读看"bot 到底记得什么、上下文里有什么"
 *
 * ★ chatluna 的消息正文是 **gzip 压缩后存成 BLOB** 的（`chatluna_message.content`，
 *   列类型 blob、前两字节 1f 8b），所以直接 `LIKE '%饿%'` 永远搜不到 —— 必须先解压。
 *   `text` 列是 NULL，别看它。
 *
 * 用法：
 *   node --experimental-sqlite --no-warnings tools/peek-memory.cjs                    # 会话历史 + 记忆表
 *   node --experimental-sqlite --no-warnings tools/peek-memory.cjs --grep 饿           # 解压后在历史里搜关键词
 *   node --experimental-sqlite --no-warnings tools/peek-memory.cjs --hours 6           # 只看最近 6 小时的历史
 *   node --experimental-sqlite --no-warnings tools/peek-memory.cjs --db koishi-test/data/test.db
 */
const { DatabaseSync } = require('node:sqlite')
const zlib = require('node:zlib')
const path = require('node:path')

const args = process.argv.slice(2)
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : def
}
const DB = opt('db', path.join(__dirname, '..', 'koishi-app', 'data', 'koishi.db'))
const GREP = opt('grep', '')
const HOURS = Number(opt('hours', 0)) || 0
const LIMIT = Number(opt('limit', 14)) || 14

const db = new DatabaseSync(DB, { readOnly: true })
const q = (sql, ...a) => {
  try {
    return db.prepare(sql).all(...a)
  } catch (e) {
    return [{ __error: e.message }]
  }
}
const cols = (t) => {
  try {
    return db.prepare(`PRAGMA table_info(\`${t}\`)`).all().map((r) => r.name)
  } catch {
    return []
  }
}
const ts = (v) => {
  if (v == null || v === '') return '-'
  const n = Number(v)
  const d = Number.isFinite(n) && n > 1e11 ? new Date(n) : new Date(String(v))
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString('zh-CN', { hour12: false })
}
const ms = (v) => {
  if (v == null || v === '') return 0
  const n = Number(v)
  const d = Number.isFinite(n) && n > 1e11 ? new Date(n) : new Date(String(v))
  return Number.isNaN(d.getTime()) ? 0 : d.getTime()
}
const cut = (s, n = 260) => {
  const t = typeof s === 'string' ? s : s == null ? '' : JSON.stringify(s)
  const flat = t.replace(/\s+/g, ' ').trim()
  return flat.length > n ? flat.slice(0, n) + '…' : flat
}

/** BLOB(gzip) → 文本 */
function decode(v) {
  if (v == null) return ''
  try {
    let buf = Buffer.isBuffer(v) ? v : v instanceof Uint8Array ? Buffer.from(v) : null
    if (buf && buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf)
    const raw = buf ? buf.toString('utf8') : String(v)
    // 多数行是 JSON.stringify 出来的字符串或对象
    try {
      const j = JSON.parse(raw)
      if (typeof j === 'string') return j
      if (j && typeof j === 'object') {
        return j.text ?? j.content ?? j.pageContent ?? JSON.stringify(j)
      }
    } catch {
      /* 不是 JSON 就直接当文本 */
    }
    return raw
  } catch (e) {
    return `(解压失败: ${e.message})`
  }
}

const tables = q(`SELECT name FROM sqlite_master WHERE type='table'`).map((r) => r.name)
const has = (t) => tables.includes(t)
const since = HOURS ? Date.now() - HOURS * 3600_000 : 0

// ---------------------------------------------------------------- 会话消息
if (has('chatluna_message') && has('chatluna_conversation')) {
  console.log(`=== 每个会话最后 ${LIMIT} 条消息${HOURS ? `（只显示最近 ${HOURS} 小时）` : ''} ===`)
  for (const c of q(
    `SELECT id, title, updatedAt FROM chatluna_conversation ORDER BY updatedAt DESC`
  )) {
    console.log(`\n— ${c.title || '(无标题)'}｜${c.id.slice(0, 8)}｜更新 ${ts(c.updatedAt)}`)
    const rows = q(
      `SELECT rowid, role, name, content, createdAt FROM chatluna_message
       WHERE conversationId = ? ORDER BY rowid DESC LIMIT ?`,
      c.id,
      LIMIT
    ).reverse()
    for (const r of rows) {
      if (since && ms(r.createdAt) < since) continue
      const body = decode(r.content)
      console.log(`   [${ts(r.createdAt)}] ${r.role}${r.name ? `(${r.name})` : ''}: ${cut(body)}`)
    }
  }
}

// ---------------------------------------------------------------- 记忆表
console.log('\n=== 记忆/文档类表（行数）===')
for (const t of tables.filter((x) => /docstore|memory|vector|archive/i.test(x))) {
  const n = q(`SELECT COUNT(*) AS n FROM "${t}"`)[0]?.n ?? 0
  console.log(`   ${String(n).padStart(4)}  ${t}`)
  if (!n) continue
  const c = cols(t)
  for (const r of q(`SELECT * FROM "${t}" LIMIT 20`)) {
    const parts = []
    for (const k of c) {
      if (/^(key|id|createdAt|updatedAt|metadata|scopeId|userId)$/.test(k)) continue
      const v = decode(r[k])
      if (v && v.length > 1) parts.push(`${k}=${cut(v, 120)}`)
    }
    console.log(`      ${cut(parts.join('｜'), 300)}`)
  }
}

// ---------------------------------------------------------------- 关键词搜索
if (GREP) {
  console.log(`\n=== 解压后在历史里搜「${GREP}」 ===`)
  let hit = 0
  for (const r of q(
    `SELECT rowid, conversationId, role, name, content, createdAt FROM chatluna_message ORDER BY rowid DESC`
  )) {
    const body = decode(r.content)
    if (!body.includes(GREP)) continue
    hit++
    console.log(
      `   [${ts(r.createdAt)}] ${r.role}${r.name ? `(${r.name})` : ''}｜${r.conversationId.slice(0, 8)}: ${cut(body, 300)}`
    )
  }
  if (!hit) console.log('   （没有命中）')
}

db.close()
