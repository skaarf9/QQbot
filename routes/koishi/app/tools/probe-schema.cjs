// 诊断工具：把 authority 机制相关的 schema / 数据 / 指令实测出来。
// 跑法（在 D:\deepseek\QQbot）：node --experimental-sqlite --no-warnings koishi-app\tools\probe-schema.cjs
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')

const DB = path.resolve(__dirname, '../data/koishi.db')
const db = new DatabaseSync(DB, { readOnly: true })

function q(label, sql) {
  try {
    const rows = db.prepare(sql).all()
    console.log('\n=== ' + label + ' (' + rows.length + ') ===')
    console.log(JSON.stringify(rows, null, 1))
  } catch (e) {
    console.log('\n=== ' + label + ' === ERROR: ' + e.message)
  }
}

q('所有表', "select name from sqlite_master where type='table' order by name")
q('user schema', "select sql from sqlite_master where name='user'")
q('group schema', "select sql from sqlite_master where name='group'")
q('perm_track schema', "select sql from sqlite_master where name='perm_track'")
q('binding schema', "select sql from sqlite_master where name='binding'")
q('channel schema', "select sql from sqlite_master where name='channel'")
q('user 数据', 'select id, name, authority, permissions, locales from user')
q('group 数据', 'select * from "group"')
q('perm_track 数据', 'select * from perm_track')
q('binding 数据', 'select * from binding')
