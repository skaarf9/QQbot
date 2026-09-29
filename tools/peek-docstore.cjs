/**
 * 看长期记忆到底存进向量库了没有。
 *
 * 长期记忆（chatluna-long-memory）配好向量库之后会落到两个地方：
 *   1. 数据库表 `chatluna_docstore`（key = 记忆层 id，pageContent = 记忆正文）
 *   2. `<baseDir>/data/chathub/vector_store/luna_vdb/<key>/docstore.json`（luna-vdb 的索引快照）
 * 这个脚本把两边都列出来，用来确认"记忆不再是重启就没的内存向量库"。
 *
 * 用法：
 *   node --experimental-sqlite --no-warnings tools/peek-docstore.cjs
 *   node --experimental-sqlite --no-warnings tools/peek-docstore.cjs --grep 烤鱼
 *   node --experimental-sqlite --no-warnings tools/peek-docstore.cjs --db koishi-test/data/test.db
 *   node --experimental-sqlite --no-warnings tools/peek-docstore.cjs --full     # 不截断正文
 */
const { DatabaseSync } = require('node:sqlite')
const path = require('node:path')
const fs = require('node:fs')

const args = process.argv.slice(2)
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : def
}
const has = (name) => args.includes(`--${name}`)

const DB = opt('db', path.join(__dirname, '..', 'koishi-app', 'data', 'koishi.db'))
const GREP = opt('grep', '')
const FULL = has('full')
const LIMIT = Number(opt('limit', 50)) || 50

const db = new DatabaseSync(DB, { readOnly: true })

function tableExists(name) {
  return (
    db
      .prepare("select count(*) c from sqlite_master where type='table' and name=?")
      .get(name).c > 0
  )
}

console.log(`DB: ${DB}`)

// ---- 1) docstore 表
if (!tableExists('chatluna_docstore')) {
  console.log('chatluna_docstore 表还不存在（说明向量库从没写过东西）')
} else {
  let rows = []
  try {
    rows = db
      .prepare(
        'select key, id, pageContent, metadata, createdAt from chatluna_docstore order by createdAt desc'
      )
      .all()
  } catch (e) {
    console.log('读表失败：' + e.message)
  }
  if (GREP) {
    rows = rows.filter((r) => (r.pageContent || '').includes(GREP))
  }
  console.log(`\n== chatluna_docstore：${rows.length} 条${GREP ? `（含「${GREP}」）` : ''} ==`)
  const byKey = new Map()
  for (const r of rows) byKey.set(r.key, (byKey.get(r.key) || 0) + 1)
  for (const [k, n] of byKey) console.log(`  ${k}  ${n} 条`)
  for (const r of rows.slice(0, LIMIT)) {
    const t = r.createdAt ? new Date(Number(r.createdAt)).toLocaleString('zh-CN') : '?'
    const body = FULL ? r.pageContent : (r.pageContent || '').slice(0, 160)
    console.log(`\n--- [${r.key}] ${t}`)
    console.log(`    id: ${r.id}`)
    console.log(`    ${body}`)
    if (r.metadata && r.metadata !== '{}') console.log(`    meta: ${r.metadata.slice(0, 300)}`)
  }
}

// ---- 2) luna-vdb 目录
for (const label of ['koishi-app', 'koishi-test']) {
  const dir = path.join(__dirname, '..', label, 'data', 'chathub', 'vector_store', 'luna_vdb')
  if (!fs.existsSync(dir)) {
    console.log(`\n== luna_vdb 目录（${label}）：不存在 ==`)
    continue
  }
  console.log(`\n== luna_vdb 目录（${label}）：${dir} ==`)
  for (const sub of fs.readdirSync(dir)) {
    const p = path.join(dir, sub)
    let size = 0
    try {
      size = fs.statSync(p).size
    } catch {}
    const files = fs.statSync(p).isDirectory() ? fs.readdirSync(p).join(', ') : '(file)'
    console.log(`  ${sub}  ${size} B  [${files}]`)
  }
}
