/**
 * 给测试库预置一个"守卫放行"的测试群，让不依赖 proactive/followup 的剧本能跑起来。
 *
 *   node tools\seed-test-group.cjs                  # 播种默认测试群 777000111
 *   node tools\seed-test-group.cjs --group 888000222
 *   node tools\seed-test-group.cjs --dump           # 只打印当前守卫状态
 *
 * 为什么要播种：chatluna-guard 在测试实例里是 `defaultPolicy: silent` + 空白名单，
 * 也就是**默认一个群都不让说话**，而它的闸门排在 ChatLuna 链的最前面 —— 群没放行的话
 * 根本走不到模型那一步（不是"回复被吞"，是"压根没请求模型"）。
 * 现有剧本都用 454444539（库里手工放行过），但那个群同时开着 proactive（每 3 秒轮询），
 * 会给"数上游请求次数"这类断言引入噪音。所以要一个干净的群。
 *
 * 前置：Koishi 必须没在跑（sqlite 单写）。跑完重启测试实例生效。
 */
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')

const argv = process.argv.slice(2)
const getArg = (name, dflt) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] != null ? argv[i + 1] : dflt
}
const GROUP = String(getArg('group', '777000111'))
const DUMP_ONLY = argv.includes('--dump')
const PLATFORM = 'onebot'
const DB = path.resolve(__dirname, '../koishi-test/data/test.db')

const db = new DatabaseSync(DB)

function dump(label) {
  console.log('\n--- ' + label + ' ---')
  const rows = db.prepare('select scopeKey, state, reason, via from qqbot_guard order by scopeKey').all()
  if (rows.length === 0) console.log('  （空）')
  for (const r of rows) console.log(`  ${r.scopeKey.padEnd(28)} ${r.state.padEnd(6)} ${r.reason ?? ''}  via=${r.via ?? ''}`)
}

if (DUMP_ONLY) {
  dump(DB)
  db.close()
  process.exit(0)
}

const scopeKey = `${PLATFORM}:channel:${GROUP}`
const existing = db.prepare('select scopeKey, state from qqbot_guard where scopeKey = ?').get(scopeKey)
if (existing) {
  console.log(`已存在 ${scopeKey}（state=${existing.state}），改成 allow`)
  db.prepare('update qqbot_guard set state = ?, reason = ?, operatorId = ?, via = ?, updatedAt = ? where scopeKey = ?').run(
    'allow',
    '测试群（seed-test-group 播种）',
    '2791932480',
    'seed',
    Date.now(),
    scopeKey
  )
} else {
  db.prepare(
    'insert into qqbot_guard (scopeKey, platform, channelId, guildId, state, reason, operatorId, via, updatedAt) values (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(scopeKey, PLATFORM, GROUP, GROUP, 'allow', '测试群（seed-test-group 播种）', '2791932480', 'seed', Date.now())
  console.log(`已插入 ${scopeKey} → allow`)
}

dump(DB)
db.close()
