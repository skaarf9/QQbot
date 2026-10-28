// 好感度 scopeId 迁移：xingyuan → affinity（2026-10-04 第八轮）
//
// 为什么需要它：chatluna-affinity 拿配置里的 `scopeId` 同时当**数据库命名空间**和
// **指令命名空间**。用户要求把带旧角色名「星源」的 scopeId 换成功能性名字，
// 而只改 koishi.yml 不改数据 = 换了一个命名空间：/rank 会突然空掉、所有人的好感度
// 回到初始值（旧行还躺在库里，只是再也读不到）。
//
// 这个脚本把**所有带 scopeId 列的 affinity 表**里的旧值原地改成新值。
// 主键含 scopeId（[scopeId, userId] / [scopeId, userId, date] …），因为新值在库里
// 一行都不存在，改主键不会撞车。
//
// 用法（**必须先停掉 Koishi**，否则运行中的实例会拿旧 scopeId 继续写）：
//   node tools/migrate-affinity-scope.cjs                      # 只看会改什么（dry-run，默认）
//   node tools/migrate-affinity-scope.cjs --apply               # 真的改（生产库）
//   node tools/migrate-affinity-scope.cjs --db koishi-test/data/test.db --apply
//   node tools/migrate-affinity-scope.cjs --from xingyuan --to affinity
//
// ★ 幂等：跑第二遍会报「没有需要迁移的行」，不会重复改。

const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')

const ROOT = 'D:/deepseek/QQbot'

function parseArgs(argv) {
  const out = {
    db: path.join(ROOT, 'koishi-app/data/koishi.db'),
    from: 'xingyuan',
    to: 'affinity',
    apply: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') out.apply = true
    else if (a === '--db') out.db = path.resolve(ROOT, argv[++i])
    else if (a === '--from') out.from = argv[++i]
    else if (a === '--to') out.to = argv[++i]
    else if (a === '--help' || a === '-h') {
      console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(0, 24).join('\n'))
      process.exit(0)
    }
  }
  return out
}

/** 所有「带 scopeId 列」的表（按 sqlite_master 扫，不写死名字 —— 插件升级加表也跟得上） */
function tablesWithScopeId(db) {
  const tables = db
    .prepare("select name from sqlite_master where type='table' order by name")
    .all()
  const hits = []
  for (const { name } of tables) {
    const cols = db.prepare(`pragma table_info("${name}")`).all()
    if (cols.some((c) => c.name === 'scopeId')) hits.push(name)
  }
  return hits
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!fs.existsSync(args.db)) {
    console.error(`找不到数据库：${args.db}`)
    process.exit(1)
  }
  console.log(`数据库：${args.db}`)
  console.log(`迁移：  scopeId "${args.from}" → "${args.to}"`)
  console.log(args.apply ? '模式：  ★ APPLY（真的写）' : '模式：  dry-run（只看，不写）')
  console.log('')

  const db = new DatabaseSync(args.db)
  let total = 0
  try {
    const tables = tablesWithScopeId(db)

    // 迁移记录表里如果有别的 scopeId 的"已迁移"标记，也要一起搬，
    // 否则插件会以为新命名空间还没迁移过，可能把旧表数据再灌一遍。
    for (const table of tables) {
      const rows = db.prepare(`select count(*) c from "${table}" where scopeId = ?`).get(args.from).c
      const already = db.prepare(`select count(*) c from "${table}" where scopeId = ?`).get(args.to).c
      const flag = rows ? '★' : ' '
      console.log(
        `${flag} ${table.padEnd(38)} 待迁移 ${String(rows).padStart(4)} 行` +
          (already ? `（已存在 ${already} 行新值，注意核对）` : '')
      )
      if (rows && args.apply) {
        const info = db.prepare(`update "${table}" set scopeId = ? where scopeId = ?`).run(args.to, args.from)
        console.log(`    → 已更新 ${info.changes} 行`)
      }
      total += rows
    }

    console.log('')
    if (!total) {
      console.log('没有需要迁移的行（可能已经迁过了）。')
    } else if (args.apply) {
      console.log(`迁移完成：共 ${total} 行。`)
      console.log('别忘了同步改 koishi.yml 的 chatluna-affinity.scopeId / qqbot-auth.affinityScopeId 与预设里的 {affinity("…")}。')
    } else {
      console.log(`共 ${total} 行待迁移。加 --apply 真的执行（执行前请先停掉 Koishi）。`)
    }
  } finally {
    db.close()
  }
}

main()
