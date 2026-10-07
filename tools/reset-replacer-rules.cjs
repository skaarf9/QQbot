/**
 * 清空测试实例里的「出站替换规则」表，让 rig 63 能从零开跑。
 *
 *   node tools\reset-replacer-rules.cjs          # 清空（打印清掉了什么）
 *   node tools\reset-replacer-rules.cjs --dump   # 只打印，不动
 *
 * 为什么需要它：rig 63（出站替换层）的判据里有「清单里只剩 #1」这种**绝对**断言，
 * 而规则是**落库**的 —— 上一轮跑完留着 #1，这一轮 `/replacer.add 😏 嘿嘿` 就会
 * 撞上「这条原文已经有了」而失败，看起来像插件坏了。所以每轮开跑前清一次。
 *
 * 与 `seed-test-group.cjs` 一样：**Koishi 必须没在跑**（sqlite 单写）。
 * 注意与 chatluna-guard 的屏蔽态无关，那个不用清。
 */
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')

const argv = process.argv.slice(2)
const DUMP_ONLY = argv.includes('--dump')
const DB = path.resolve(__dirname, '../koishi-test/data/test.db')

const db = new DatabaseSync(DB)

function dump(label) {
  console.log('\n--- ' + label + ' ---')
  const rows = db
    .prepare('select id, scope, pattern, replacement, enabled, hits from chatluna_replacer_rule order by cast(id as integer)')
    .all()
  if (rows.length === 0) {
    console.log('  （空）')
    return
  }
  for (const r of rows) {
    console.log(
      `  #${r.id} ${r.enabled ? '开' : '关'} [${r.scope}] 「${r.pattern}」→「${r.replacement}」 命中 ${r.hits}`
    )
  }
}

dump('清空前')
if (DUMP_ONLY) {
  db.close()
  process.exit(0)
}

const n = db.prepare('delete from chatluna_replacer_rule').run()
console.log(`\n已删除 ${n.changes} 条规则`)
dump('清空后')
db.close()
