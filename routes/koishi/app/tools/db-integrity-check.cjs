// 只读探针：用原生 sqlite 打开一次 data/koishi.db（回滚热日志、删 .db-journal）并做 integrity_check。
// 由 tools/restart-koishi-20261027-2245.ps1 调用；单独跑也行。
const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')

const APP = path.resolve(__dirname, '..')
const p = path.join(APP, 'data', 'koishi.db')
const journal = p + '-journal'
const had = fs.existsSync(journal)
let integrity = 'unknown'
try {
  const d = new DatabaseSync(p)
  const ic = d.prepare('pragma integrity_check').all()
  integrity = ic[0] && ic[0].integrity_check
  d.close()
} catch (e) {
  integrity = 'error: ' + (e && e.message ? e.message : e)
}
console.log(JSON.stringify({ had, integrity, journalAfter: fs.existsSync(journal) }))
process.exit(integrity === 'ok' ? 0 : 1)
