/**
 * 把测试实例的「会话（短期）历史」清干净，但**保留长期记忆**。
 *
 * 用途：验证长期记忆是不是真的落库、真的跨重启还在。
 *   1) 先跑一次 32-memory-hippo.json 把事实喂给 bot（写进 chatluna_docstore + luna_vdb）
 *   2) 跑这个脚本，把 chatluna_message / chatluna_conversation / chatluna_binding 清掉
 *      —— 相当于"人还是那些人、事还是那些事，但对话从零开始，且进程已经重启过"
 *   3) 再跑 33-memory-recall.json 问同一个问题
 *      如果 bot 还能答出来，那只可能来自长期记忆（向量库），不可能是上下文
 *
 * ★ 只动会话相关的表，不碰 chatluna_docstore / data/chathub/vector_store / long-memory 的图文件。
 *
 * 用法：node --experimental-sqlite --no-warnings tools/clear-test-conversation.cjs [--db <路径>] [--yes]
 */
const { DatabaseSync } = require('node:sqlite')
const path = require('node:path')

const args = process.argv.slice(2)
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : def
}
const DB = opt('db', path.join(__dirname, '..', 'koishi-test', 'data', 'test.db'))

// 只清这些：会话绑定 / 会话 / 消息 / 归档快照
const TABLES = [
  'chatluna_binding',
  'chatluna_conversation',
  'chatluna_message',
  'chatluna_archive',
]

const db = new DatabaseSync(DB)

function count(t) {
  try {
    return db.prepare(`select count(*) c from "${t}"`).get().c
  } catch {
    return null
  }
}

console.log(`DB: ${DB}`)
console.log('清理前：')
for (const t of [...TABLES, 'chatluna_docstore']) {
  const n = count(t)
  if (n != null) console.log(`  ${t}: ${n}`)
}

for (const t of TABLES) {
  try {
    db.prepare(`delete from "${t}"`).run()
  } catch (e) {
    console.log(`  跳过 ${t}：${e.message}`)
  }
}

console.log('清理后：')
for (const t of [...TABLES, 'chatluna_docstore']) {
  const n = count(t)
  if (n != null) console.log(`  ${t}: ${n}`)
}
console.log('\n长期记忆（chatluna_docstore）没动，向量库目录也没动。')
