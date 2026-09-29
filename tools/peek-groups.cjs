// 看一下生产库里出现过哪些群（用来决定 R9 监控范围）
const { DatabaseSync } = require('node:sqlite')
const db = new DatabaseSync('D:/deepseek/QQbot/koishi-app/data/koishi.db', { readOnly: true })
const q = (sql) => {
  try {
    return db.prepare(sql).all()
  } catch (e) {
    return [{ error: e.message }]
  }
}
for (const [label, sql] of [
  ['channel', 'SELECT platform, id, guildId FROM channel LIMIT 20'],
  ['binding', 'SELECT platform, pid, aid FROM binding LIMIT 20'],
  ['chatluna_conversation', 'SELECT id, title, platform, guildId FROM chatluna_conversation LIMIT 20'],
  ['chatluna_binding', 'SELECT * FROM chatluna_binding LIMIT 20'],
  ['chatluna_scene', 'SELECT scopeKey, status, title FROM chatluna_scene LIMIT 10'],
]) {
  console.log('--- ' + label + ' ---')
  for (const r of q(sql)) console.log(JSON.stringify(r))
}
db.close()
