#!/usr/bin/env node
/**
 * check-docs.cjs —— 文档体量体检 + 结构校验（不写盘，只报问题）。
 *
 * 规矩写在 docs/00-文档规范.md 里，这份脚本是它的执行者。**每次改完文档都应该跑一遍。**
 *
 *   node tools/check-docs.cjs           # 体检（有 ERROR 就 exit 1）
 *   node tools/check-docs.cjs --strict  # 把 WARN 也当 ERROR
 *   node tools/check-docs.cjs --json    # 机器可读输出
 *   node tools/check-docs.cjs --top 15  # 顺带打印最大的 15 份文档
 *
 * 检什么：
 *   [E] 体量硬红线：单文件 > 800 行 或 > 80 KB
 *   [E] 死链：相对链接（去掉锚点后）目标不存在
 *   [E] 结构：docs/ 下的分册必须有且只有一个 H1、结尾必须有「← 回索引页」
 *   [E] 拆分一致性：`docs/NN-x.md` 有同名子目录时，索引要链到子目录里**每一个**文件，
 *       子目录里每个文件也要能从索引走到（反之亦然）
 *   [E] 踩坑编号：docs/04-踩坑记录/*.md 里「坑 N」不重不漏不跳号
 *   [W] 体量警戒线：单文件 > 500 行 或 > 50 KB
 *   [W] 超长行：正文单行 > 400 字符（表格行、代码围栏内不计）
 *   [W] 代码围栏 ``` 必须成对
 *
 * 为什么阈值这么定：见 docs/00-文档规范.md 的「阈值」一节（800/80KB 是硬红线，
 * 500/50KB 是警戒线 —— 越线的文件必须按轮次/坑号/日期切段）。
 */
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const ARGS = process.argv.slice(2)
const STRICT = ARGS.includes('--strict')
const AS_JSON = ARGS.includes('--json')
const TOP = (() => {
  const i = ARGS.indexOf('--top')
  return i >= 0 ? Number(ARGS[i + 1] ?? 10) : 0
})()

const HARD_LINES = 800
const HARD_BYTES = 80 * 1024
const WARN_LINES = 500
const WARN_BYTES = 50 * 1024
const WARN_LINE_CHARS = 400

// 「阶段 0+1 原始留档」：不是我们的产出、也不再维护，只当资料查 —— 免掉所有 WARN
// （ERROR 级的死链仍然照查，那是真会点不动的东西）
const LEGACY = new Set([
  'astrbot-需求覆盖调研.md',
  'nonebot-vs-koishi-13条需求调研.md',
  '接线与验证.md',
])

// 扫描范围：手写文档。第三方/依赖/抓取回来的存档不体检。
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.scratch',
  '.doc-split-backup',
  '_research',       // 抓回来的上游文档存档，不是我们的产物
  'NapCat.Framework',
  'NapCat.Shell',
  'koishi-app',
  'koishi-test',
  'maibot_research',
  'models',
  '.workbuddy',
])

const problems = [] // { level:'E'|'W', code, file, line, msg }
const add = (level, code, file, line, msg) => problems.push({ level, code, file, line, msg })

/** 文件头写 `<!-- doc-size-exempt: 理由 -->` 就免掉体量 WARN（硬红线仍然照查） */
function sizeExempt(text) {
  const m = /<!--\s*doc-size-exempt:\s*([^>]*?)\s*-->/.exec(text)
  return m ? m[1] : null
}

// ---------------------------------------------------------------- 收集文件
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') && e.name !== '.') continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      walk(full, out)
    } else if (e.name.toLowerCase().endsWith('.md')) {
      out.push(full)
    }
  }
  return out
}

const files = [path.join(ROOT, '进度与交接.md'), ...walk(path.join(ROOT, 'docs'))].filter((f) =>
  fs.existsSync(f),
)
// 仓库根的其它手写 md（调研留档等）
for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
  if (e.isFile() && e.name.toLowerCase().endsWith('.md')) files.push(path.join(ROOT, e.name))
}
const uniq = [...new Set(files)]

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/')
const readLines = (p) => fs.readFileSync(p, 'utf8').split(/\r?\n/)
const isFence = (l) => /^\s*(```|~~~)/.test(l)

function fenceMask(lines) {
  const mask = []
  let inFence = false
  for (const l of lines) {
    if (isFence(l)) { mask.push(true); inFence = !inFence; continue }
    mask.push(inFence)
  }
  return mask
}

// ---------------------------------------------------------------- 1) 体量
const stats = []
for (const f of uniq) {
  const text = fs.readFileSync(f, 'utf8')
  const lines = text.split(/\r?\n/).length
  const bytes = Buffer.byteLength(text)
  const name = rel(f)
  stats.push({ file: name, lines, bytes })
  const over = []
  if (lines > HARD_LINES) over.push(`${lines} 行 > ${HARD_LINES}`)
  if (bytes > HARD_BYTES) over.push(`${(bytes / 1024).toFixed(1)} KB > ${HARD_BYTES / 1024} KB`)
  if (over.length) {
    add('E', 'size-hard', name, 0, `体量超硬红线：${over.join('，')}`)
  } else if (LEGACY.has(name)) {
    // 原始留档：不提醒
  } else if (lines > WARN_LINES || bytes > WARN_BYTES) {
    const why = sizeExempt(text)
    if (!why) {
      add(
        'W',
        'size-warn',
        name,
        0,
        `体量过警戒线：${lines} 行 / ${(bytes / 1024).toFixed(1)} KB（建议按轮次/坑号/日期切段；` +
          '确有理由就写在文件头的 `<!-- doc-size-exempt: 理由 -->`）',
      )
    }
  }
}
stats.sort((a, b) => b.lines - a.lines)

// ---------------------------------------------------------------- 2) 逐文件结构 / 死链 / 长行
const docsDir = path.join(ROOT, 'docs')
for (const f of uniq) {
  const name = rel(f)
  const isDocsPiece = name.startsWith('docs/')
  const lines = readLines(f)
  const mask = fenceMask(lines)

  // 围栏配对
  const fences = lines.filter(isFence).length
  if (fences % 2 !== 0) add('E', 'fence', name, 0, `代码围栏不配对（${fences} 个 \`\`\`/\`~~~\`）`)

  // H1 数量
  const h1 = lines.filter((l, i) => !mask[i] && /^# /.test(l)).length
  if (isDocsPiece && h1 !== 1) add('E', 'h1', name, 0, `docs/ 下的分册应恰好 1 个 H1，实际 ${h1} 个`)

  // 回索引页（分册自称"回索引页"，子段自称"回 XX 索引"，统一认「← 回」）
  if (isDocsPiece && !lines.some((l) => /←\s*回/.test(l))) {
    add('E', 'backlink', name, 0, '缺少「← 回索引页 / ← 回 XX 索引」链接')
  }

  // 长行
  const legacy = LEGACY.has(name)
  lines.forEach((l, i) => {
    if (legacy) return
    if (mask[i]) return
    if (/^\s*\|/.test(l)) return // 表格行不算
    if (l.length > WARN_LINE_CHARS) {
      add('W', 'long-line', name, i + 1, `单行 ${l.length} 字符 > ${WARN_LINE_CHARS}`)
    }
  })

  // 死链
  lines.forEach((l, i) => {
    if (mask[i]) return
    // ★ 先摘掉行内代码 `` `…` `` —— 文档里大量存在「格式示例」而不是真链接，例如
    //   `[昵称](../QQ号):内容`（坑：这条会把自己报成死链）
    const prose = l.replace(/`[^`]*`/g, '``')
    const re = /\]\(([^)]+)\)/g
    let m
    while ((m = re.exec(prose))) {
      let target = m[1].trim()
      if (/^(https?:|mailto:|#)/.test(target)) continue
      target = target.split('#')[0]
      // Markdown 允许用尖括号把带空格的路径括起来：`](<a/b c.md>)`
      target = target.replace(/^<(.*)>$/, '$1').trim()
      if (!target) continue
      const resolved = path.resolve(path.dirname(f), decodeURIComponent(target))
      if (!fs.existsSync(resolved)) add('E', 'dead-link', name, i + 1, `死链 → ${target}`)
    }
  })
}

// ---------------------------------------------------------------- 3) 拆分一致性
// docs/<name>.md 有同名目录 docs/<name>/ 时，两边必须互相可达
if (fs.existsSync(docsDir)) {
  for (const e of fs.readdirSync(docsDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const groupDir = path.join(docsDir, e.name)
    const indexFile = path.join(docsDir, `${e.name}.md`)
    if (!fs.existsSync(indexFile)) {
      add('E', 'split-index', `docs/${e.name}/`, 0, '有子目录但没有同名索引页 docs/' + e.name + '.md')
      continue
    }
    const idxText = fs.readFileSync(indexFile, 'utf8')
    const children = fs.readdirSync(groupDir).filter((x) => x.toLowerCase().endsWith('.md'))
    for (const c of children) {
      if (!idxText.includes(`${e.name}/${c}`) && !idxText.includes(encodeURI(`${e.name}/${c}`))) {
        add('E', 'split-orphan', `docs/${e.name}/`, 0, `子文件没被索引页链到：${c}`)
      }
    }
    // 子目录里的文件应当回链索引
    for (const c of children) {
      const t = fs.readFileSync(path.join(groupDir, c), 'utf8')
      if (!t.includes(`../${e.name}.md`)) {
        add('E', 'split-backlink', `docs/${e.name}/${c}`, 0, `没有回链索引页 ../${e.name}.md`)
      }
    }
  }
}

// ---------------------------------------------------------------- 4) 踩坑编号
const pitDir = path.join(docsDir, '04-踩坑记录')
if (fs.existsSync(pitDir)) {
  const found = []
  for (const c of fs.readdirSync(pitDir).filter((x) => x.endsWith('.md'))) {
    readLines(path.join(pitDir, c)).forEach((l, i) => {
      const m = /^###\s*坑\s*(\d+)/.exec(l)
      if (m) found.push({ no: Number(m[1]), file: `docs/04-踩坑记录/${c}`, line: i + 1 })
    })
  }
  found.sort((a, b) => a.no - b.no)
  const seen = new Map()
  for (const it of found) {
    if (seen.has(it.no)) {
      add('E', 'pit-dup', it.file, it.line, `坑 ${it.no} 重复（另见 ${seen.get(it.no).file}）`)
    } else seen.set(it.no, it)
  }
  const max = found.length ? found[found.length - 1].no : 0
  for (let n = 1; n <= max; n++) {
    if (!seen.has(n)) add('E', 'pit-gap', 'docs/04-踩坑记录/', 0, `坑 ${n} 缺失（编号必须连续）`)
  }
  // 索引页的总表要覆盖全部坑号
  const idxText = fs.readFileSync(path.join(docsDir, '04-踩坑记录.md'), 'utf8')
  const inTable = new Set(
    [...idxText.matchAll(/^\|\s*(\d+)\s*\|/gm)].map((m) => Number(m[1])),
  )
  for (const it of found) {
    if (!inTable.has(it.no)) add('E', 'pit-table', 'docs/04-踩坑记录.md', 0, `坑 ${it.no} 不在索引页的坑号总表里`)
  }
  if (!AS_JSON) console.log(`  踩坑编号：共 ${found.length} 条，1..${max}${found.length === max ? ' 连续' : ''}\n`)
}

// ---------------------------------------------------------------- 输出
const errs = problems.filter((p) => p.level === 'E')
const warns = problems.filter((p) => p.level === 'W')

if (AS_JSON) {
  console.log(JSON.stringify({ errors: errs, warnings: warns, stats }, null, 2))
} else {
  if (TOP) {
    console.log(`最大的 ${Math.min(TOP, stats.length)} 份文档：`)
    for (const s of stats.slice(0, TOP)) {
      const badge = s.lines > HARD_LINES || s.bytes > HARD_BYTES ? '✗' : s.lines > WARN_LINES || s.bytes > WARN_BYTES ? '⚠' : ' '
      console.log(`  ${badge} ${s.file.padEnd(48)} ${String(s.lines).padStart(5)} 行  ${(s.bytes / 1024).toFixed(1).padStart(7)} KB`)
    }
    console.log('')
  }

  const show = (list, tag) => {
    for (const p of list) {
      const where = p.line ? `${p.file}:${p.line}` : p.file
      console.log(`  ${tag} [${p.code}] ${where}  ${p.msg}`)
    }
  }
  if (errs.length) { console.log('ERROR：'); show(errs, '✗') ; console.log('') }
  if (warns.length) { console.log('WARN：'); show(warns, '⚠'); console.log('') }

  const total = uniq.length
  if (!errs.length && !warns.length) {
    console.log(`✅ 文档体检通过：${total} 份文件，无 ERROR、无 WARN`)
  } else {
    console.log(`共 ${total} 份文件：${errs.length} 个 ERROR，${warns.length} 个 WARN`)
  }
}

const failed = errs.length > 0 || (STRICT && warns.length > 0)
process.exitCode = failed ? 1 : 0
