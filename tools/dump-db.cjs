/**
 * 只读导出 chatluna 相关表，用来在 Koishi 之外独立验证状态。
 *
 *   cd D:\deepseek\QQbot
 *   node --experimental-sqlite tools\dump-db.cjs                 # 生产库 koishi-app/data/koishi.db
 *   node --experimental-sqlite tools\dump-db.cjs --db koishi-test/data/test.db
 *
 * 注意：Node 22 需要 --experimental-sqlite；即使脚本成功，
 *       PowerShell 也会因 stderr 的 experimental 警告报 exit 1，属正常。
 */
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')

const argv = process.argv.slice(2)
const dbArgIdx = argv.indexOf('--db')
const DB =
  dbArgIdx >= 0 && argv[dbArgIdx + 1]
    ? path.resolve(process.cwd(), argv[dbArgIdx + 1])
    : path.resolve(__dirname, '../koishi-app/data/koishi.db')
console.log('库：' + DB)
const db = new DatabaseSync(DB, { readOnly: true })

function q(label, sql) {
  try {
    const rows = db.prepare(sql).all()
    console.log('\n--- ' + label + ' (' + rows.length + ') ---')
    console.log(JSON.stringify(rows, null, 1))
  } catch (e) {
    console.log('\n--- ' + label + ' --- 跳过：' + e.message)
  }
}

q('会话', 'select id, bindingKey, title, model, preset, chatMode, status from chatluna_conversation')
q('情绪', 'select * from chatluna_emotion')
q(
  '图片解析缓存',
  'select hash, substr(description,1,50) as descr, model, bytes, createdAt from chatluna_image_cache'
)
q(
  '★长期记忆（chatluna_docstore）',
  "select key, id, substr(pageContent,1,120) as content, substr(metadata,1,200) as meta, createdAt from chatluna_docstore order by createdAt"
)
q(
  '图片临时存储',
  'select id, name, size, expireTime from chatluna_storage_temp order by expireTime desc limit 20'
)
q('用户权限', 'select id, name, authority, permissions from user')
q('用户组', 'select id, name, permissions from group')
q('全部表', "select name from sqlite_master where type='table' order by name")

