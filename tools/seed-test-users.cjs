/**
 * 给测试库预置几个不同权限等级的账号，让权限脚本可重复跑。
 *
 *   node tools\seed-test-users.cjs            # 只播种
 *   node tools\seed-test-users.cjs --reset    # 先清空 user/binding 再播种
 *
 * 为什么要播种：Koishi 的 `setUser` 要求库里**已经有绑定行**（core:577-581
 * 查不到 binding 会抛 "user not found"），而绑定行是用户发第一条消息时才建的。
 * 所以直接写库最省事，也保证每次跑的初始状态一致。
 */
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')

const RESET = process.argv.includes('--reset')
const DUMP_ONLY = process.argv.includes('--dump')
const DB = path.resolve(__dirname, '../koishi-test/data/test.db')
const db = new DatabaseSync(DB)

const PLATFORM = 'onebot'

/** 打印库里的 uid → 等级 */
function dump(label) {
  console.log('\n--- ' + label + ' ---')
  for (const r of db
    .prepare(
      'select b.pid, u.id as aid, u.authority from binding b join "user" u on u.id = b.aid where b.platform = ? order by b.pid'
    )
    .all(PLATFORM)) {
    console.log(`  ${String(r.pid).padEnd(12)}  aid=${String(r.aid).padEnd(4)} authority=${r.authority}`)
  }
}

if (DUMP_ONLY) {
  dump(DB)
  db.close()
  process.exit(0)
}

/** [QQ 号, 等级, 备注] —— 等级故意和 qqbot-auth 的名单错开，好验证"名单会覆盖库里的值" */
const USERS = [
  ['10001', 1, '普通群友（名单外，保持库里的 1）'],
  ['10002', 1, '管理员名单里，库里先给 1，验证会被提到 3'],
  ['10003', 1, '完全未登记（其实这条就是"默认等级"的样子）'],
  ['10004', 1, '拉黑名单里，库里先给 1，验证会被压到 0'],
  ['2791932480', 1, '主人名单里，库里先给 1，验证会被提到 4'],
]

if (RESET) {
  db.exec('delete from binding')
  db.exec('delete from "user"')
  console.log('已清空 user / binding')
}

for (const [pid, authority, note] of USERS) {
  const existing = db.prepare('select aid from binding where pid = ? and platform = ?').get(pid, PLATFORM)
  let aid
  if (existing) {
    aid = existing.aid
    db.prepare('update "user" set authority = ? where id = ?').run(authority, aid)
  } else {
    const r = db.prepare('insert into "user" (name, flag, authority, locales, permissions) values (null, 0, ?, \'\', \'\')').run(authority)
    aid = r.lastInsertRowid
    db.prepare('insert into binding (aid, bid, pid, platform) values (?, ?, ?, ?)').run(aid, aid, pid, PLATFORM)
  }
  console.log(`  ${pid}  aid=${aid}  初始等级=${authority}  ${note}`)
}

console.log('\n当前库内状态：')
dump(DB)
db.close()
