#!/usr/bin/env node
/**
 * split-big-docs.cjs —— 一次性把"随轮次只增不减"的几份文档切开。
 *
 * 背景：文档纪律（见 docs/00-文档规范.md）规定单文件不得超过 800 行 / 80 KB。
 * 2026-10-07 的体检里，下面这几份越权了：
 *
 *   docs/04-踩坑记录.md              2381 行 / 139 KB   83 个坑挤在一份里
 *   进度与交接.md                    1304 行 / 151 KB   顶部逐轮交接记录 + 当前状态旧条目只增不减
 *   docs/24-指令页面化与图片库.md      899 行 /  55 KB   四个轮次写在一份里
 *   docs/22-模型兜底队列与群聊上下文.md 674 行 /  48 KB   两个不相干的主题写在一份里
 *
 * 切分策略（**原文件名一律保留为索引页**，所以历史交叉引用零破坏）：
 *
 *   docs/04-踩坑记录.md          → docs/04-踩坑记录/*.md        + 索引（含坑号总表）
 *   进度与交接.md                → docs/32-开发轮次日志/*.md    + 索引（瘦身）
 *   docs/24-指令页面化与图片库.md → docs/24-指令页面化与图片库/*.md + 索引
 *   docs/22-模型兜底队列与群聊上下文.md → docs/22-.../*.md      + 索引
 *
 * 用法：
 *   node tools/split-big-docs.cjs --dry-run   # 只打印计划 + 链接改写统计，不写盘
 *   node tools/split-big-docs.cjs             # 真写（先备份到 .doc-split-backup/<时间戳>/）
 *
 * 设计要点（改之前先读）：
 *  1. 区间按**原始 1-based 行号**切，不解析语义 —— 边界表就在 PARTS 里。
 *  2. **坑号 / 轮次号一律不变**：旧笔记里的「见坑 57」照旧搜 `坑 57`（全库唯一）。
 *  3. 相对链接统一改写：子目录比原来深一层（或两层），所以每一条相对链接都补前缀；
 *     文件内锚点 `](#...)` 一律退化成纯文字（本机渲染器不给标题生成 id，锚点本来就是坏的）。
 *  4. 跑之前会先备份到 `.doc-split-backup/<时间戳>/`（含被覆盖的原件），可整目录还原。
 */
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const BACKUP_DIRNAME = '.doc-split-backup'
const DRY = process.argv.includes('--dry-run')
// --only <子串> 只重切匹配的那一份（例：`--only 04-踩坑记录`）—— 改动单份时不必整盘重跑
const ONLY = (() => {
  const i = process.argv.indexOf('--only')
  return i >= 0 ? (process.argv[i + 1] ?? '') : null
})()
// 重建索引页 `进度与交接.md` 需要显式开关（它切完就是手写的了，见下面 HANDOVER 段注释）
const REBUILD_HANDOVER = process.argv.includes('--rebuild-handover')

// ---------------------------------------------------------------- 工具
/**
 * 找"切分前的原件"。被切过一次之后，磁盘上的 `docs/04-踩坑记录.md` / `进度与交接.md`
 * 已经是**索引页**了，不能再当切分来源 —— 要去 `.doc-split-backup/<最新时间戳>/` 里取原件。
 * （备份文件名规则：路径里的分隔符换成 `__`，如 `docs/04-踩坑记录.md` → `docs__04-踩坑记录.md`）
 */
function findBackupSource(rel) {
  const dir = path.join(ROOT, BACKUP_DIRNAME)
  if (!fs.existsSync(dir)) return null
  const cands = [rel.replace(/[/\\]/g, '__'), path.basename(rel)]
  const stamps = fs
    .readdirSync(dir)
    .filter((x) => fs.statSync(path.join(dir, x)).isDirectory())
  // ★ 取**体积最大**的那份：备份里既有"切分前的原件"也有"切分后的索引页"，
  //   原件永远更大（04：139 KB vs 12 KB；进度与交接：151 KB vs 21 KB）。
  //   靠内容特征区分不行 —— 原版 `进度与交接.md` 里也有「章节对照表」这种索引页特征。
  let best = null
  let bestSize = -1
  for (const s of stamps) {
    for (const c of cands) {
      const f = path.join(dir, s, c)
      if (!fs.existsSync(f)) continue
      const size = fs.statSync(f).size
      if (size > bestSize) {
        bestSize = size
        best = f
      }
    }
  }
  return best
}

function readDoc(rel) {
  return readAbs(path.join(ROOT, rel))
}

function readAbs(abs) {
  const t = fs.readFileSync(abs, 'utf8')
  return { text: t, eol: t.includes('\r\n') ? '\r\n' : '\n', lines: t.split(/\r?\n/) }
}

/** 磁盘上这份已经是"切完的索引页"了吗（是的话必须回到备份取原件） */
const looksSplit = (rel) => {
  const p = path.join(ROOT, rel)
  if (!fs.existsSync(p)) return false
  const t = fs.readFileSync(p, 'utf8')
  if (/^##\s*章节对照表（原单文件/m.test(t)) return true // 进度与交接.md 的索引页特征
  return /^##\s*★\s*2026-10-07：/m.test(t) // 分册索引页特征
}

/** 取切分来源：已经是索引页就自动回溯到备份 */
function readSource(rel) {
  if (looksSplit(rel)) {
    const b = findBackupSource(rel)
    if (!b) {
      throw new Error(
        `${rel} 已经是索引页了，但 ${BACKUP_DIRNAME}/ 里找不到它的原件备份 —— 无法重切`,
      )
    }
    return readAbs(b)
  }
  return readDoc(rel)
}

/** 把 [label](#anchor) 退化成 label —— 锚点在本机渲染器里本来就是坏的 */
function stripAnchors(text) {
  return text.replace(/\[([^\]]+)\]\(#[^)]*\)/g, '$1')
}

/**
 * 给所有相对链接补前缀。
 *  - 来源在仓库根（进度与交接.md）：新位置 docs/<dir>/ → 补 ../../（../../docs/x 与 ../x 等效）
 *  - 来源在 docs/（04 / 22 / 24）：新位置 docs/<dir>/ → 补 ../
 */
function fixLinks(text, up) {
  text = stripAnchors(text)
  return text.replace(/\]\((?!https?:|#|mailto:)([^)]*)\)/g, (_, t) => `](${up}${t})`)
}

function joinLines(lines, eol) {
  // 去掉首尾空行
  let a = 0
  let b = lines.length
  while (a < b && lines[a].trim() === '') a++
  while (b > a && lines[b - 1].trim() === '') b--
  return lines.slice(a, b).join(eol)
}

/**
 * 剥掉原文自带的"结尾装饰"：分隔线，以及分册页脚 `[← 回索引页](…)`。
 * ★ 不剥的话，切出来的段会变成两段 `---` 加两个"回索引页"，很乱。
 */
function trimTail(text) {
  let out = text
  // 页脚（可能带 1~2 层 ../）
  out = out.replace(/(?:\s*\n-{3,})+\s*\n\[←\s*回索引页\]\([^)]*\)\s*$/, '')
  // 只剩分隔线的情形
  out = out.replace(/(?:\s*\n-{3,})+\s*$/, '')
  return out.trimEnd()
}

/**
 * 从区间里抽出 `### 坑 N：标题` 列表。
 * 标题有四种写法，都要吃得下：
 *   坑 1：官方 OneBot 适配器已废弃
 *   坑 4（最坑）：`help` / `echo` 是独立插件        ← 圆括号前缀 + 冒号
 *   坑 52（★ 主动插话的提示词被当成群友发言…）      ← 只有圆括号、没有冒号
 */
function scanPitfalls(lines, from, to) {
  const out = []
  for (let i = from; i <= to; i++) {
    const m = /^###\s*坑\s*(\d+)\s*(.*)$/.exec(lines[i - 1] ?? '')
    if (!m) continue
    const raw = m[2].trim()
    const paren = /^[（(]([^）)]*)[）)]/.exec(raw)
    const afterParen = raw.replace(/^[（(][^）)]*[）)]\s*/, '')
    const title = /^[：:]/.test(afterParen)
      ? afterParen.replace(/^[：:]\s*/, '').trim()
      : paren
        ? paren[1].trim()
        : afterParen
    if (title) out.push({ no: Number(m[1]), title, line: i })
  }
  return out
}

// ---------------------------------------------------------------- 切分表
const PARTS = {
  // ---------------------------------------------------------- 04 踩坑记录
  // ★ 按**类型**切（不是按坑号区间）：同一个领域/阶段的坑放一份，查"这一阶段的坑"时一次看全。
  //   类型内仍按坑号升序；**坑号一律不变**。某一类超过 80 KB 时，按 `子类型` 再分（见 docs/00）。
  'docs/04-踩坑记录.md': {
    dir: 'docs/04-踩坑记录',
    title: '踩坑记录（重来一次会浪费几小时的东西）',
    shortTitle: '踩坑记录',
    up: '../',
    headFrom: 6, headTo: 9, // 文件头里要留进索引页的那几行（H1 与"属于…"由索引自己生成）
    byType: true,
    categories: [
      {
        out: '01-环境与安装.md',
        label: '环境与安装',
        desc: '装 Koishi / NapCat、启动与端口、进程与日志、QQ 版本',
        nos: [1, 2, 3, 4, 5, 6, 7, 8, 9, 26, 72, 78],
      },
      {
        out: '02-市场生态与上游服务.md',
        label: '市场生态与上游服务',
        desc: '去哪找插件（注册表/镜像）、市场报错、上游插件的质量与能力、模型供应商的坑',
        nos: [10, 11, 14, 61, 65, 82],
      },
      {
        out: '03-ChatLuna机制与模型.md',
        label: 'ChatLuna 机制与模型',
        desc: '预设名 / 模型名三段式 / 会话级模型 / 中间件与触发条件 / 上下文 / 模型兜底队列',
        nos: [15, 16, 18, 19, 20, 21, 22, 28, 47, 79, 80],
      },
      {
        out: '04-自研插件开发.md',
        label: '自研插件开发',
        desc: '指令注册与别名、require 双实例、参数解析、钩子与执行顺序、生命周期',
        nos: [23, 25, 27, 32, 35, 36, 39, 42, 43, 44, 45, 50, 64, 74],
      },
      {
        out: '05-配置与落盘.md',
        label: '配置与落盘',
        desc: 'koishi.yml 的改写与注释、必填字段、scopeId 这类"一次改就是换命名空间"的字段',
        nos: [13, 17, 60, 83],
      },
      {
        out: '06-消息出站与渲染.md',
        label: '消息出站与渲染',
        desc: '元素与标记、Markdown 折行与排版、出图、图片压缩、熔断提示、URL 解析',
        nos: [33, 34, 37, 38, 41, 53, 58, 66, 75, 76],
      },
      {
        out: '07-插话与记忆.md',
        label: '插话与记忆',
        desc: 'R9 主动插话（频率/池/黑名单）+ 短期情景记忆与长期记忆的落库',
        nos: [29, 52, 54, 55, 59, 62, 69, 71],
      },
      {
        out: '08-断线与运行时故障.md',
        label: '断线与运行时故障',
        desc: 'OneBot 断线不重连、看门狗自伤、孤儿实例、QQ 侧网络栈故障',
        nos: [31, 51, 57, 70, 73],
      },
      {
        out: '09-测试台与验收.md',
        label: '测试台与验收',
        desc: '伪 OneBot / rig 剧本 / 判据设计 / koishi-test 测试实例',
        nos: [24, 30, 46, 48, 56, 63, 67, 77],
      },
      {
        out: '10-脚本与命令行.md',
        label: '脚本与命令行',
        desc: 'PowerShell / Node 一次性脚本与命令行本身的坑（编码、管道、句柄）',
        nos: [12, 40, 49, 68, 81],
      },
    ],
    index: (ctx) => buildPitfallIndex(ctx),
  },

  // ---------------------------------------------------------- 24 指令页面化
  'docs/24-指令页面化与图片库.md': {
    dir: 'docs/24-指令页面化与图片库',
    title: '24 —— 指令页面化：帮助体系 / 图片库 / 思考过程',
    shortTitle: '24 指令页面化',
    up: '../',
    headFrom: 3, headTo: 12,
    parts: [
      { out: '01-第一轮-指令页面化与图片库.md', short: '第一轮', from: 16, to: 497, label: '第一轮：帮助体系 / 图片库 / 状态出图 / 思考过程（§1–§10）' },
      { out: '02-第二轮-真群实测报回五条.md', short: '第二轮', from: 498, to: 597, label: '第二轮：真群实测报回五条（§12）' },
      { out: '03-第三轮-别名层与熔断归并.md', short: '第三轮', from: 598, to: 720, label: '第三轮：指令别名层 + 熔断并入令牌桶（§13）' },
      { out: '04-第四轮-长文本图片化与AI出图.md', short: '第四轮', from: 721, to: 899, label: '第四轮：长文本图片化 + 出站最小间隔 + AI 自己出图（§14–§15）' },
    ],
  },

  // ---------------------------------------------------------- 22 模型队列 / 群聊上下文
  'docs/22-模型兜底队列与群聊上下文.md': {
    dir: 'docs/22-模型兜底队列与群聊上下文',
    title: '22 —— 模型兜底队列 与 群聊上下文',
    shortTitle: '22 模型队列与群聊上下文',
    up: '../',
    headFrom: 4, headTo: 8,
    parts: [
      { out: '01-模型兜底队列.md', short: '模型兜底队列', from: 10, to: 373, label: '模型兜底队列（§0 结论速览 / §1 人格预设命名 / §2 队列机制 / §5 待办 / §6 回滚）' },
      { out: '02-群聊上下文.md', short: '群聊上下文', from: 374, to: 674, label: '群聊上下文（§3 bot 能拿到什么 / §4 注入验证结果）' },
    ],
  },
}

// ---------------------------------------------------------------- 进度与交接（特例）
const HANDOVER = {
  src: '进度与交接.md',
  dir: 'docs/32-开发轮次日志',
  index: 'docs/32-开发轮次日志.md',
  // 顶部"逐轮交接记录"：5..837（838 起是"本文件已拆分"说明 + ---）
  roll: { from: 5, to: 837 },
  // 「当前状态」里保留最近两条实查；934..1210 是 2026-10-03 21:27 及更早的历史实查
  statusKeep: { from: 898, to: 932 },
  statusOld: { from: 934, to: 1210 },
  // 索引页要原样保留的段落
  keepHowTo: { from: 845, to: 892 }, // 怎么用 + 分册导航
  keepTail: { from: 1212, to: 1304 }, // 未决 + 章节对照表 + 回滚说明
}

/**
 * `### 坑 N：标题` 后面那段的归一化。四种写法都要吃得下：
 *   坑 1：官方 OneBot 适配器已废弃
 *   坑 4（最坑）：`help` / `echo` 是独立插件        ← 圆括号前缀 + 冒号
 *   坑 52（★ 主动插话的提示词被当成群友发言…）      ← 只有圆括号、没有冒号
 */
function pitfallTitle(raw) {
  const s = (raw ?? '').trim()
  const paren = /^[（(]([^）)]*)[）)]/.exec(s)
  const afterParen = s.replace(/^[（(][^）)]*[）)]\s*/, '')
  return /^[：:]/.test(afterParen)
    ? afterParen.replace(/^[：:]\s*/, '').trim()
    : paren
      ? paren[1].trim()
      : afterParen
}

/**
 * 把原文按 `### 坑 N：…` 切成块。**只认 `### 坑 N`**，所以 `### 还有一条：…`
 * 这种跟在某个坑后面的小标题会留在同一块里（它本来就是这个坑的一部分）。
 */
function cutPitfallBlocks(lines, from, to) {
  const blocks = []
  let cur = null
  for (let i = from; i <= to; i++) {
    const l = lines[i - 1]
    const m = /^###\s*坑\s*(\d+)\s*(.*)$/.exec(l)
    if (m) {
      cur = { no: Number(m[1]), title: pitfallTitle(m[2]), lines: [] }
      blocks.push(cur)
    }
    if (cur) cur.lines.push(l)
  }
  return blocks
}

// ---------------------------------------------------------------- 索引生成
/** 通用索引页：H1 + 属于… + 保留的文件头 + 切段表 + 回索引页 */
function buildGenericIndex({ title, shortTitle, dirRel, up, parts, headLines, eol }) {
  const idx = []
  idx.push(`# ${title}`, '')
  idx.push(`> 属于 [QQ 机器人项目 —— 进度与交接](${up}进度与交接.md) 的分册。`)
  idx.push('> 旧编号（如「第八·十三节」）的去向见索引页的章节对照表。', '')
  idx.push(...headLines, '')
  idx.push('---', '')
  idx.push('## ★ 2026-10-07：已按轮次切段', '')
  idx.push('这份原来是一份只增不减的长文（每做完一轮就往里追加）。现在按**轮次**切成几段，')
  idx.push('本页留作索引与结论入口。**轮次编号与原来一致**，旧引用（「24 §13」之类）搜小节号即可。', '')
  idx.push('| 分册 | 覆盖 |')
  idx.push('|---|---|')
  for (const p of parts) idx.push(`| [${p.out}](${dirRel}/${p.out}) | ${p.label} |`)
  idx.push('')
  idx.push(`> 新增一轮请**另起一个文件**（\`${dirRel}/\` 里接着编号），不要再往老文件里追加。`, '')
  idx.push('[← 回索引页](' + up + '进度与交接.md)', '')
  return idx.join(eol)
}

function buildPitfallIndex({ dirRel, up, categories, headLines, eol, blocks }) {
  const idx = []
  const titleOf = (no) => blocks.find((b) => b.no === no)?.title ?? ''
  idx.push(`# 踩坑记录（重来一次会浪费几小时的东西）`, '')
  idx.push(`> 属于 [QQ 机器人项目 —— 进度与交接](${up}进度与交接.md) 的分册。`)
  idx.push(`> 旧编号（如「第八·十三节」）的去向见索引页的章节对照表。`, '')
  idx.push(...headLines, '')
  idx.push('---', '')
  idx.push('## ★ 2026-10-07：已按「坑的类型」切分', '')
  idx.push('原文 **2381 行 / 139 KB** 一份、每轮只增不减。现在按**领域/阶段**切成 ' + categories.length + ' 份 ——')
  idx.push('**要查"某个阶段踩过什么坑"，打开那一份就能一次看全**，不用在 2000 行里翻。')
  idx.push('')
  idx.push('> **坑号一律不变。** 旧笔记、旧对话里的「见坑 57」照旧直接搜 `坑 57`（全库唯一），')
  idx.push('> 或在下面的总表里查它在哪一类。类型内部仍按坑号升序。', '')
  idx.push('| 类型 | 分册 | 覆盖的坑 | 说明 |')
  idx.push('|---|---|---|---|')
  for (const c of categories) {
    idx.push(
      `| **${c.label}** | [${c.out}](${dirRel}/${c.out}) | ${c.nos.join('、')} | ${c.desc} |`,
    )
  }
  idx.push('')
  idx.push('> 新增的坑：先判断**属于哪一类**，追加到那一份的末尾（同类内按坑号升序）。')
  idx.push('> 某一类超过 **80 KB / 800 行** 时，在该类内部按**子类型**再分')
  idx.push('> （例：`06-消息出站与渲染/` → `01-图片与压缩.md` / `02-元素与排版.md`），并在上表补一行。')
  idx.push('> 规矩见 [文档规范](00-文档规范.md)。', '')
  idx.push('---', '')
  idx.push('## 坑号总表', '')
  idx.push('| 坑 | 标题 | 类型 |')
  idx.push('|---|---|---|')
  const owner = new Map()
  for (const c of categories) for (const n of c.nos) owner.set(n, c)
  const all = [...owner.keys()].sort((a, b) => a - b)
  for (const no of all) {
    const c = owner.get(no)
    idx.push(`| ${no} | ${titleOf(no).replace(/\|/g, '\\|')} | [${c.label}](${dirRel}/${c.out}) |`)
  }
  idx.push('')
  idx.push('[← 回索引页](' + up + '进度与交接.md)', '')
  return idx.join(eol)
}

// ---------------------------------------------------------------- 索引页收尾修补
/** 索引页里几处"照抄原文但已经过时"的句子，重写掉 */
function handoverFix(text, eol) {
  const FIX = [
    [
      '| [踩坑记录（重来一次会浪费几小时的东西）](docs/04-踩坑记录.md) | ★ 最值钱的一份：30 条真实踩过的坑 |',
      '| [踩坑记录（重来一次会浪费几小时的东西）](docs/04-踩坑记录.md) | ★ 最值钱的一份：**83 条**真实踩过的坑；2026-10-07 **按类型切成 10 份** + 坑号总表 |',
    ],
    [
      '# 分册是生成物，可以整目录删掉：',
      '# ★ 2026-10-07 更正：docs/ 自 2026-10-02 起就是"直接维护"的，别再当生成物整目录删（见 docs/18 那条更正）',
    ],
    [
      '5. **每份分册的结尾都有「← 回索引页」**，不会迷路。',
      [
        '5. **每份分册的结尾都有「← 回索引页」**，不会迷路。',
        '6. **要写文档 / 改文档**：先读 [文档规范](docs/00-文档规范.md) —— 单文件 ≤ **800 行 / 80 KB**，',
        '   超了按**轮次 / 日期 / 编号区间**切段；改完必跑 `node tools/check-docs.cjs`（体检）。',
      ].join(eol),
    ],
  ]
  let out = text
  for (const [a, b] of FIX) out = out.split(a).join(b)
  return out
}

// ---------------------------------------------------------------- 主流程
function main() {
  const plan = []       // { file, content } 要么是子文件，要么是索引页
  const backups = new Set()

  // ---- 普通切分（04 / 24 / 22）
  for (const [src, spec] of Object.entries(PARTS)) {
    if (ONLY && !src.includes(ONLY)) continue
    const doc = readSource(src)
    const dirRel = spec.dir.replace('docs/', '')
    const headLines = doc.lines.slice(spec.headFrom - 1, spec.headTo)
    const base = path.basename(src)
    const E = doc.eol
    let blocks = []
    let categories = []
    let parts = []

    if (spec.byType) {
      // ★ 按"坑的类型"切：一个类型一份，类型内按坑号升序
      blocks = cutPitfallBlocks(doc.lines, spec.headFrom + 4, spec.headTo + 1_000_000)
      const seen = new Map()
      for (const b of blocks) {
        if (seen.has(b.no)) throw new Error(`坑 ${b.no} 在原文里出现了两次`)
        seen.set(b.no, b)
      }
      categories = spec.categories
      const claimed = categories.flatMap((c) => c.nos)
      for (const no of claimed) if (!seen.has(no)) throw new Error(`分类表里的坑 ${no} 在原文里找不到`)
      for (const no of seen.keys()) if (!claimed.includes(no)) throw new Error(`坑 ${no} 没被任何类型认领`)
      if (new Set(claimed).size !== claimed.length) throw new Error('分类表里有重复的坑号')
      for (const c of categories) {
        const body = trimTail(
          fixLinks(
            c.nos.map((no) => seen.get(no).lines.join(E).trim()).join(E + E),
            spec.up,
          ),
        )
        const head =
          `# ${spec.shortTitle} · ${c.label}${E}${E}` +
          `> 属于 [${spec.title}](${spec.up}${base}) 的一份。${E}` +
          `> **按类型切分**（2026-10-07）：${c.desc}。坑号未变；本文件覆盖坑 ${c.nos.join('、')}。${E}${E}`
        const tail = `${E}${E}---${E}${E}[← 回 ${spec.shortTitle} 索引](${spec.up}${base})${E}`
        plan.push({ file: `${spec.dir}/${c.out}`, content: head + body + tail })
      }
    } else {
      parts = spec.parts.map((p) => ({
        ...p,
        pitfalls: src.includes('04-踩坑记录') ? scanPitfalls(doc.lines, p.from, p.to) : [],
      }))
      for (const p of parts) {
        let body = fixLinks(joinLines(doc.lines.slice(p.from - 1, p.to), doc.eol), spec.up)
        body = trimTail(body)
        const head =
          `# ${spec.shortTitle} · ${p.short}${E}${E}` +
          `> 属于 [${spec.title}](${spec.up}${base}) 的一段` +
          `（2026-10-07 按轮次切开，编号未变）。${E}${E}`
        const tail = `${E}${E}---${E}${E}[← 回 ${spec.shortTitle} 索引](${spec.up}${base})${E}`
        plan.push({ file: `${spec.dir}/${p.out}`, content: head + body + tail })
      }
    }

    const idxFn = spec.index ?? buildGenericIndex
    const idx = idxFn({
      dirRel,
      up: spec.up,
      parts,
      categories,
      blocks,
      headLines,
      eol: doc.eol,
      title: spec.title,
      shortTitle: spec.shortTitle,
    })
    plan.push({ file: src, content: fixLinks(idx, '') })   // 索引页在 docs/ 层，链接不用补前缀
    backups.add(src)
  }

  // ---- 进度与交接（特例）
  // ★ 索引页 `进度与交接.md` 切完之后就是**手写直维护**的了（比如「未决」会被人工增删）。
  //   所以重建它必须是**显式**的：加 `--rebuild-handover`（或 `--only 进度与交接`）才动它，
  //   否则只重切 `--only` 指定的那几份分册，绝不碰索引页。
  if (REBUILD_HANDOVER && (!ONLY || HANDOVER.src.includes(ONLY))) {
    const doc = readSource(HANDOVER.src)
    const L = doc.lines
    const eol = doc.eol
    const up = '../../' // 新位置 docs/32-开发轮次日志/

    // ① 顶部逐轮交接 → 按日期分组
    const rollLines = L.slice(HANDOVER.roll.from - 1, HANDOVER.roll.to)
    const groups = []
    let cur = null
    rollLines.forEach((l) => {
      const m = /^> \*\*(20\d\d)-(\d\d)-(\d\d)/.exec(l)
      if (m) {
        const day = `${m[1]}-${m[2]}-${m[3]}`
        if (!cur || cur.day !== day) {
          cur = { day, lines: [] }
          groups.push(cur)
        }
      }
      if (!cur) { cur = { day: 'unknown', lines: [] }; groups.push(cur) }
      cur.lines.push(l)
    })
    // 顺序：老 → 新，再合并不足 60 行的相邻日期（10-05 只有 31 行）
    groups.sort((a, b) => (a.day < b.day ? -1 : 1))
    const merged = []
    for (const g of groups) {
      const prev = merged[merged.length - 1]
      if (prev && prev.lines.length < 60 && g.day !== 'unknown') {
        prev.dayList.push(g.day)
        prev.lines.push('>', ...g.lines)
      } else {
        merged.push({ day: g.day, dayList: [g.day], lines: [...g.lines] })
      }
    }

    const rollFiles = []
    merged.forEach((g, i) => {
      const span = g.dayList.length > 1 ? `${g.dayList[0]} ~ ${g.dayList[g.dayList.length - 1]}` : g.dayList[0]
      const fname = `${String(i + 1).padStart(2, '0')}-${span}.md`
      rollFiles.push({ fname, span, lines: g.lines })
    })

    // ② 历史实查
    const oldLines = L.slice(HANDOVER.statusOld.from - 1, HANDOVER.statusOld.to)
    const oldFname = `${String(rollFiles.length + 1).padStart(2, '0')}-历史运行实查（2026-10-03 及以前）.md`
    const oldSpan = '2026-09-28 ~ 2026-10-03'

    // ---- 写子文件（每个子段都回链 32 索引 + 总索引）
    const backTpl =
      `${eol}${eol}---${eol}${eol}` +
      `[← 回 开发轮次日志 索引](../32-开发轮次日志.md) ｜ [回总索引](../../进度与交接.md)${eol}`
    for (const f of rollFiles) {
      const body = trimTail(fixLinks(joinLines(f.lines, eol), up))
      const head =
        `# 开发轮次日志 · ${f.span}${eol}${eol}` +
        `> 属于 [QQ 机器人项目 —— 进度与交接](../../进度与交接.md) 的分册。${eol}` +
        `> 从索引页顶部搬出来的逐轮交接记录（原文是"最新在最上"），这里按日期**从早到晚**排。${eol}${eol}`
      plan.push({ file: `${HANDOVER.dir}/${f.fname}`, content: head + body + backTpl })
    }
    {
      const body = trimTail(fixLinks(joinLines(oldLines, eol), up))
      const head =
        `# 开发轮次日志 · 历史运行实查（2026-10-03 及以前）${eol}${eol}` +
        `> 属于 [QQ 机器人项目 —— 进度与交接](../../进度与交接.md) 的分册。${eol}` +
        `> 从索引页「当前状态」搬出来的旧条目（最新在最上）。**当前状态只看索引页顶部那两条。**${eol}${eol}`
      plan.push({ file: `${HANDOVER.dir}/${oldFname}`, content: head + body + backTpl })
    }

    // ---- 写 32 索引
    const idx = []
    idx.push('# 32 —— 开发轮次日志（按日期切段）', '')
    idx.push('> 属于 [QQ 机器人项目 —— 进度与交接](../进度与交接.md) 的分册。', '')
    idx.push('索引页 `进度与交接.md` 原来有两块**只增不减**的记录，2026-10-07 搬到这里：', '')
    idx.push('- **顶部「本轮交接」**：每轮一段（用户原话 / 做了什么 / 怎么验的 / 上线没有），按日期切段；')
    idx.push('- **「当前状态」里的旧实查**：2026-10-03 21:27 及更早的那些生产实查记录。', '')
    idx.push('> 索引页现在只留**最近一轮**的摘要。往下新增轮次时：在索引页写新的一段，')
    idx.push('> 上一轮那段**追加到对应日期的文件末尾**（同一天就并进同一个文件）。', '')
    idx.push('---', '')
    idx.push('## 逐轮交接记录', '')
    idx.push('| 日期 | 文件 | 备注 |')
    idx.push('|---|---|---|')
    for (const f of rollFiles) {
      idx.push(`| ${f.span} | [${f.fname}](32-开发轮次日志/${f.fname}) | |`)
    }
    idx.push(`| ${oldSpan} | [${oldFname}](32-开发轮次日志/${oldFname}) | 「当前状态」搬出来的历史实查 |`)
    idx.push('')
    idx.push('---', '')
    idx.push('## 索引页瘦身说明', '')
    idx.push('| 原位置 | 行数 | 现在在哪 |')
    idx.push('|---|---|---|')
    idx.push(`| 索引页 顶部逐轮交接 | ${HANDOVER.roll.to - HANDOVER.roll.from + 1} | 本目录 \`01\`~\`0${rollFiles.length}\` |`)
    idx.push(`| 索引页 「当前状态」旧实查 | ${HANDOVER.statusOld.to - HANDOVER.statusOld.from + 1} | 本目录 \`${oldFname}\` |`)
    idx.push('')
    idx.push('[← 回索引页](../进度与交接.md)', '')
    plan.push({ file: HANDOVER.index, content: idx.join(eol) })

    // ---- 重建索引页 进度与交接.md
    const head = L.slice(0, 3) // H1 + 空行 + "> 用于对话压缩后的续接。只信这份文件"
    const howTo = L.slice(HANDOVER.keepHowTo.from - 1, HANDOVER.keepHowTo.to)
    const statusKeep = L.slice(HANDOVER.statusKeep.from - 1, HANDOVER.statusKeep.to)
    const tailSec = L.slice(HANDOVER.keepTail.from - 1, HANDOVER.keepTail.to)

    const newIdx = []
    newIdx.push(...head, '')
    newIdx.push('> **本文件是索引页，只放"现在是什么状态"和"东西在哪"。**')
    newIdx.push('> 2026-10-07 把两块随轮次**只增不减**的记录搬了出去（原来 1304 行 / 151 KB，每轮还在涨）：')
    newIdx.push('> ① 顶部逐轮交接记录 → [开发轮次日志](docs/32-开发轮次日志.md)（按日期切段）；')
    newIdx.push(`> ② 「当前状态」里 2026-10-03 及更早的实查 → 同目录 \`${oldFname}\`。`)
    newIdx.push('> 规矩见 [文档规范](docs/00-文档规范.md)：**索引页只留最近一轮，旧轮次必须搬走。**')
    newIdx.push('')
    newIdx.push('---', '')

    // 怎么用 + 分册导航（补齐导航表里漏掉的 25–29，并在末尾插一行 32）
    const NAV_PATCH_AFTER = /^\| \[指令页面化与图片库\]/
    const NAV_EXTRA = [
      '| [短期情景记忆与专注模式](docs/25-短期情景记忆与专注模式.md) | 第五轮（2026-10-03）：自写 `chatluna-episode` —— 短期情景记忆 + 专注模式，出站也记账 |',
      '| [主动插话频率诊断](docs/26-主动插话频率诊断.md) | 第六轮（2026-10-03）：`/proactive` 现场 + 「理解之后再开口」三段式判断 |',
      '| [模型总览与联网搜索](docs/27-模型总览与联网搜索.md) | 第八轮（2026-10-04）：`/models` 翻页 + `/model -a` + 联网搜索 MCP |',
      '| [人设卡片与作息表](docs/28-人设卡片与作息表.md) | 第九轮（2026-10-04）：`/persona` 人设卡片 / 视觉自我识别 / `/routine` 作息表 |',
      '| [出站文本替换层](docs/29-出站文本替换层.md) | 第十三轮（2026-10-05）：`chatluna-replacer` —— 在发送口把 😏 之类换掉，规则落库可 CRUD |',
    ]
    howTo.forEach((l) => {
      newIdx.push(l)
      if (NAV_PATCH_AFTER.test(l)) newIdx.push(...NAV_EXTRA)
      if (/^\| \[模型运维命令与队列自愈\]/.test(l)) {
        newIdx.push('| [开发轮次日志（按日期切段）](docs/32-开发轮次日志.md) | ★ 2026-10-07 从本页搬出：每轮的用户原话 / 做了什么 / 怎么验的 / 上线没有，按日期分文件 |')
      }
    })
    newIdx.push('', '---', '')

    // 当前状态
    newIdx.push('## 当前状态', '')
    statusKeep.forEach((l) => newIdx.push(l))
    newIdx.push('>')
    newIdx.push(`> 📚 **更早的实查记录**（${oldSpan}，共 ${HANDOVER.statusOld.to - HANDOVER.statusOld.from + 1} 行）`)
    newIdx.push(`> 已搬进 [开发轮次日志 · ${oldFname}](docs/32-开发轮次日志/${oldFname})。`)
    newIdx.push('> 本节**只保留最近一轮** —— 再往下写就该把上一轮搬走。')
    newIdx.push('', '---', '')

    // 未决 + 对照表 + 回滚
    let tailFixed = tailSec
    tailFixed = tailFixed.map((l) => (l.includes('拆分的脚本是') ? '' : l))
    newIdx.push(...tailFixed)
    newIdx.push('')
    newIdx.push('### 2026-10-07：第二次文档重组', '')
    newIdx.push('这次不是重切分册，而是把"只增不减"的部分**搬出去**：')
    newIdx.push('')
    newIdx.push('| 原位置 | 现在在哪 |')
    newIdx.push('|---|---|')
    newIdx.push(`| 本页顶部逐轮交接（${HANDOVER.roll.to - HANDOVER.roll.from + 1} 行） | [\`docs/32-开发轮次日志/\`](docs/32-开发轮次日志.md) |`)
    newIdx.push(`| 本页「当前状态」旧实查（${HANDOVER.statusOld.to - HANDOVER.statusOld.from + 1} 行） | [\`docs/32-开发轮次日志/05\`](docs/32-开发轮次日志/${oldFname}) |`)
    newIdx.push('| `docs/04-踩坑记录.md`（2381 行） | [\`docs/04-踩坑记录/\`](docs/04-踩坑记录.md)（**按类型 10 份** + 坑号总表） |')
    newIdx.push('| `docs/24-指令页面化与图片库.md`（899 行） | [\`docs/24-指令页面化与图片库/\`](docs/24-指令页面化与图片库.md)（4 段） |')
    newIdx.push('| `docs/22-模型兜底队列与群聊上下文.md`（674 行） | [\`docs/22-模型兜底队列与群聊上下文/\`](docs/22-模型兜底队列与群聊上下文.md)（2 段） |')
    newIdx.push('')
    newIdx.push('驱动脚本 [`tools/split-big-docs.cjs`](tools/split-big-docs.cjs)（一次性），')
    newIdx.push('纪律与阈值见 [文档规范](docs/00-文档规范.md)，体检用 `node tools/check-docs.cjs`。')
    newIdx.push('')

    plan.push({ file: HANDOVER.src, content: handoverFix(joinLines(newIdx.map((l) => l ?? ''), eol) + eol, eol) })
    backups.add(HANDOVER.src)
  }

  // ---------------------------------------------------------------- 输出
  let totalOld = 0
  let totalNew = 0
  for (const b of backups) totalOld += fs.statSync(path.join(ROOT, b)).size

  console.log(DRY ? '=== DRY RUN（不写盘） ===' : '=== 切分 ===')
  for (const p of plan) {
    const size = Buffer.byteLength(p.content)
    const lines = p.content.split('\n').length
    totalNew += size
    const exists = fs.existsSync(path.join(ROOT, p.file))
    console.log(
      `  ${exists ? '↻' : '+'} ${p.file.padEnd(56)} ${(size / 1024).toFixed(1).padStart(7)} KB  ${String(lines).padStart(5)} 行`,
    )
  }
  console.log(`\n  原文件合计 ${(totalOld / 1024).toFixed(1)} KB → 产出合计 ${(totalNew / 1024).toFixed(1)} KB（${plan.length} 个文件）`)

  if (DRY) {
    console.log('\n（--dry-run：什么都没写）')
    return
  }

  // 备份被覆盖/被移动的原件
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const bakDir = path.join(ROOT, BACKUP_DIRNAME, stamp)
  fs.mkdirSync(bakDir, { recursive: true })
  for (const b of backups) {
    const dst = path.join(bakDir, b.replace(/[/\\]/g, '__'))
    fs.copyFileSync(path.join(ROOT, b), dst)
  }
  console.log(`\n  已备份原件 → ${BACKUP_DIRNAME}/${stamp}/`)

  // ★ 清掉**切分目录**里"本次不再是产物"的旧 .md（换切法时必需 —— 否则旧的
  //   `01-坑01-20-….md` 会和新类型文件并存，体检脚本会报"子文件没被索引页链到"）。
  //   ⚠️ 只许在 `spec.dir` / `HANDOVER.dir` 这两个**子目录**里清，绝不能算到 `docs/` 头上 ——
  //   索引页 `docs/04-踩坑记录.md` 的 dirname 也是 `docs`，按 dirname 收会把整个 docs/ 清空。
  const planned = new Set(plan.map((p) => p.file))
  const managedDirs = new Set([
    ...Object.entries(PARTS).filter(([k]) => !ONLY || k.includes(ONLY)).map(([, s]) => s.dir),
    ...(ONLY && !HANDOVER.src.includes(ONLY) ? [] : [HANDOVER.dir]),
  ])
  for (const d of managedDirs) {
    const abs = path.join(ROOT, d)
    if (!fs.existsSync(abs)) continue
    for (const f of fs.readdirSync(abs)) {
      if (!f.toLowerCase().endsWith('.md')) continue
      const relFile = `${d.replace(/\\/g, '/')}/${f}`
      if (planned.has(relFile)) continue
      const doomed = path.join(abs, f)
      // 也备份一份，免得手滑后找不回来
      fs.copyFileSync(doomed, path.join(bakDir, relFile.replace(/[/\\]/g, '__')))
      fs.unlinkSync(doomed)
      console.log(`  🗑  移除旧产物 ${relFile}`)
    }
  }

  for (const p of plan) {
    const full = path.join(ROOT, p.file)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, p.content, 'utf8')
  }
  console.log(`  已写 ${plan.length} 个文件。\n\n下一步：node tools/check-docs.cjs`)
}

main()
