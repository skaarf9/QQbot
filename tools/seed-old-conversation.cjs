/**
 * 把测试库里"当前活跃会话"做旧，用来验证 chatluna 的知识过期（autoArchive）。
 *
 * 做的事（只动测试库，生产库要显式 --db 才动）：
 *   1. 找到某个绑定（默认群 454444539）当前指向的会话
 *   2. 把它的 updatedAt / lastChatAt 改成 N 小时前（默认 3 小时）
 *   3. 往它里面塞一条**很好认**的旧消息（默认："我昨天说我饿了想吃烤鱼"）
 *
 * ★ chatluna 的消息正文是 **gzip 压缩后的 JSON 字符串**存进 `chatluna_message.content`
 *   （列类型 Blob），所以这里也按同样格式写，否则 chatluna 读不出来。
 *
 * 用法：
 *   node --experimental-sqlite --no-warnings tools/seed-old-conversation.cjs
 *   node --experimental-sqlite --no-warnings tools/seed-old-conversation.cjs --hours 5
 *   node --experimental-sqlite --no-warnings tools/seed-old-conversation.cjs --db koishi-app/data/koishi.db
 *   node --experimental-sqlite --no-warnings tools/seed-old-conversation.cjs --text "我养了只猫叫团子"
 */
const { DatabaseSync } = require('node:sqlite')
const zlib = require('node:zlib')
const path = require('node:path')
const crypto = require('node:crypto')

const args = process.argv.slice(2)
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 ? args[i + 1] : d
}
const DB = opt('db', path.join(__dirname, '..', 'koishi-test', 'data', 'test.db'))
const HOURS = Number(opt('hours', 3))
const TEXT = opt('text', '我昨天说我饿了想吃烤鱼')
const BINDING = opt('binding', 'shared:onebot:2178517838:454444539')

const db = new DatabaseSync(DB)
const q = (s, ...a) => db.prepare(s).all(...a)
const run = (s, ...a) => db.prepare(s).run(...a)

const bindings = q(`SELECT * FROM chatluna_binding WHERE bindingKey = ?`, BINDING)
if (!bindings.length) {
  console.error(`找不到绑定 ${BINDING}；现有绑定：`)
  for (const b of q(`SELECT bindingKey, activeConversationId FROM chatluna_binding`)) {
    console.error('   ', b.bindingKey, '→', b.activeConversationId)
  }
  process.exit(2)
}
const convId = bindings[0].activeConversationId
if (!convId) {
  console.error(`绑定 ${BINDING} 没有活跃会话`)
  process.exit(2)
}

const old = new Date(Date.now() - HOURS * 3600_000)
run(
  `UPDATE chatluna_conversation SET updatedAt = ?, lastChatAt = ?, status = 'active' WHERE id = ?`,
  old.getTime(),
  old.getTime(),
  convId
)

// 塞一条旧消息（gzip + JSON 字符串，跟 chatluna 的存法一致）
const mk = (role, name, text, at) => {
  const id = crypto.randomUUID()
  const buf = zlib.gzipSync(Buffer.from(JSON.stringify(text), 'utf8'))
  run(
    `INSERT INTO chatluna_message (id, conversationId, parentId, role, content, name, rawId, createdAt)
     VALUES (?, ?, NULL, ?, ?, ?, NULL, ?)`,
    id,
    convId,
    role,
    buf,
    name,
    at.getTime()
  )
}
mk('human', '绮罗星([ゝω・)☆', `群友[绮罗星([ゝω・)☆]（QQ 2791932480）说：${TEXT}`, old)
mk('ai', null, '哦，烤鱼啊。那你去吃啊，跟我说有什么用。', new Date(old.getTime() + 2000))

const cols = q(`PRAGMA table_info(chatluna_conversation)`).map((r) => r.name)
const row = q(`SELECT * FROM chatluna_conversation WHERE id = ?`, convId)[0]
console.log(`库：${DB}`)
console.log(`绑定：${BINDING}`)
console.log(`会话：${convId}｜标题=${row.title}｜状态=${row.status}`)
console.log(`已把 updatedAt/lastChatAt 改成 ${HOURS} 小时前 → ${old.toLocaleString('zh-CN')}`)
console.log(`已塞入旧消息：「${TEXT}」`)
console.log(`该会话现有消息 ${q(`SELECT COUNT(*) AS n FROM chatluna_message WHERE conversationId = ?`, convId)[0].n} 条`)
console.log(`表列示例：${cols.slice(0, 8).join(', ')}…`)
db.close()
