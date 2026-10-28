// 离线单测：chatluna-replacer 的纯函数部分（替换语义 + 参数切词）
//
// 跑法（在 koishi-app 下）：
//   node tools\probe-replacer-core.cjs
//
// 为什么要有它：替换语义里那几条（单趟最长匹配 / 替换结果不回头扫 / 群规则压过全局）
// 都是**静默**出错的东西 —— 错了不报错，只是换得不对，而跑一次测试台要一分半。
// 这几条用毫秒级的断言钉住，测试台只负责验"接线通了"。
const { _internals } = require('../external/koishi-plugin-chatluna-replacer/lib/index.js')
const { transform, tokenize, parseArgs } = _internals

let pass = 0
const fails = []

function eq(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    pass++
  } else {
    fails.push(`${label}\n    实际: ${a}\n    期望: ${e}`)
  }
}

/** 造一条规则 */
const R = (id, pattern, replacement, scope = '*') => ({
  id: String(id),
  pattern,
  replacement,
  scope,
  enabled: true,
  hits: 0,
})

const t = (text, rules) => transform(text, rules).text
const hitIds = (text, rules) => transform(text, rules).hits.map((r) => r.id)

// ---------------------------------------------------------------- 1) 基本替换
eq('基本替换：😏 → 嘿嘿', t('今天真开心😏', [R(1, '😏', '嘿嘿')]), '今天真开心嘿嘿')
eq('多处命中', t('😏a😏b😏', [R(1, '😏', 'X')]), 'XaXbX')
eq('替换为空串 = 删掉', t('今天真开心😏', [R(1, '😏', '')]), '今天真开心')
eq('没命中就原样', t('平平无奇', [R(1, '😏', 'X')]), '平平无奇')
eq('没有规则就原样', t('😏', []), '😏')
eq('空文本不炸', t('', [R(1, '😏', 'X')]), '')
eq('空 pattern 被忽略（否则死循环）', t('abc', [R(1, '', 'X')]), 'abc')

// ---------------------------------------------------------------- 2) 单趟最长匹配
eq(
  '最长匹配：😏😏 优先命中 😏😏 那条',
  t('😏😏', [R(1, '😏', 'A'), R(2, '😏😏', 'B')]),
  'B'
)
eq(
  '最长匹配与规则书写顺序无关',
  t('😏😏', [R(2, '😏😏', 'B'), R(1, '😏', 'A')]),
  'B'
)
eq('单字符仍按短的换', t('😏x', [R(1, '😏', 'A'), R(2, '😏😏', 'B')]), 'Ax')
// 左到右的最先命中优先，不是"全局找最长"
eq('左起最先命中优先', t('abc', [R(1, 'ab', 'X'), R(2, 'bc', 'Y')]), 'Xc')

// ---------------------------------------------------------------- 3) 替换结果不再回头扫
eq(
  '不回头扫：A→B 且 B→A 不会死循环',
  t('A', [R(1, 'A', 'B'), R(2, 'B', 'A')]),
  'B'
)
eq(
  '不回头扫：😏 → 😏呀 只换一层',
  t('😏', [R(1, '😏', '😏呀')]),
  '😏呀'
)
eq(
  '不回头扫：替换出来的文字不会触发第二条规则',
  t('x', [R(1, 'x', 'y'), R(2, 'y', 'z')]),
  'y'
)

// ---------------------------------------------------------------- 4) 作用域优先级
eq(
  '群规则压过全局规则（同长同原文）',
  t(
    '😏',
    [R(1, '😏', '全局', '*'), R(2, '😏', '本群', '454444539')]
  ),
  '本群'
)
eq(
  '长的仍然优先于"更具体的作用域"',
  t('😏😏', [R(1, '😏😏', '全局长', '*'), R(2, '😏', '本群短', '454444539')]),
  '全局长'
)

// ---------------------------------------------------------------- 5) 命中记录
eq('命中的规则 id 按先后顺序', hitIds('😏a😏😏', [R(1, '😏', 'A'), R(2, '😏😏', 'B')]), ['1', '2'])
eq('重复命中同一条规则算两次', hitIds('😏😏', [R(1, '😏', 'A')]), ['1', '1'])

// ---------------------------------------------------------------- 6) 切词与 -g
eq('切词：空白分隔', tokenize('a b  c'), [
  { value: 'a', quoted: false },
  { value: 'b', quoted: false },
  { value: 'c', quoted: false },
])
eq('切词：引号内空格不算分隔', tokenize('"你 好" 嗨').map((x) => x.value), ['你 好', '嗨'])
eq('切词：单引号也行', tokenize("'a b' c").map((x) => x.value), ['a b', 'c'])
eq('切词：空引号 = 一个空参数', tokenize('😏 ""').map((x) => x.value), ['😏', ''])
eq('切词：引号没闭合也容忍', tokenize('"没闭合').map((x) => x.value), ['没闭合'])
eq('切词：emoji 原样', tokenize('😏 嘿嘿').map((x) => x.value), ['😏', '嘿嘿'])
eq('parseArgs：普通两参', parseArgs('😏 嘿嘿'), { args: ['😏', '嘿嘿'], wantGlobal: false })
eq('parseArgs：-g 被摘出来', parseArgs('-g 😏 嘿嘿'), { args: ['😏', '嘿嘿'], wantGlobal: true })
eq('parseArgs：--global 也行', parseArgs('--global 😏'), { args: ['😏'], wantGlobal: true })
eq('parseArgs：-g 放中间也认', parseArgs('😏 -g 嘿嘿'), { args: ['😏', '嘿嘿'], wantGlobal: true })
eq('parseArgs：引号里的 -g 不当旗标', parseArgs('"-g" 嘿嘿'), {
  args: ['-g', '嘿嘿'],
  wantGlobal: false,
})
eq('parseArgs：只给原文', parseArgs('😏'), { args: ['😏'], wantGlobal: false })
eq('parseArgs：什么都没有', parseArgs(''), { args: [], wantGlobal: false })
// ★ Satori 会把 '>' 转义成 '&gt;'，而我们读原始正文，所以 '>' 必须是原样的 '>'
eq('切词：> 不被转义', tokenize('> →').map((x) => x.value), ['>', '→'])

// ---------------------------------------------------------------- 汇总
console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项`)
if (fails.length) {
  console.log('\n失败明细：')
  for (const f of fails) console.log('  ✗ ' + f)
  process.exitCode = 1
} else {
  console.log('全部通过 ✓')
}
