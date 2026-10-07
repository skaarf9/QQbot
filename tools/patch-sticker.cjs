#!/usr/bin/env node
/**
 * 给市场插件 koishi-plugin-chatluna-sticker 打两个小补丁。
 *
 * 为什么必须打补丁（而不是另写插件）
 * ---------------------------------
 * 这个插件的两条关键逻辑都**没有对外钩子**，只能从内部接：
 *   ① 图片落盘/送模型判断之前没有"逻辑预筛"的位置
 *      —— 压缩率 / 分辨率 / 体积这些是**纯逻辑**信号，不该花一次视觉调用去问模型；
 *   ② `sticker_send` 检索时只取 `listCollected(20)`，即"按使用次数排序的前 20 张"。
 *      新库 useCount 全是 0 → 永远只有那 20 张候选，AI 根本检索不到库里其它图。
 * 它也没有 `ctx.provide(...)` 任何服务，外部插件拿不到它的 library 实例，
 * 所以"再写一个薄插件"这条路在这里走不通。
 *
 * 补丁做了四件事（都极小、都幂等、都可回滚）：
 *   [1] middleware.js：落盘前插一段 `ctx.stickerGuard.check(buf)` 钩子。
 *       逻辑与配置**不在补丁里**，在自写插件 `koishi-plugin-chatluna-sticker-admin` 里
 *       （它能进控制台 UI、能随时改）。补丁只是一根 4 行的线。
 *       我们的插件没装时 `ctx.stickerGuard` 为 undefined → 补丁整段跳过，行为与原生一致。
 *   [2] tools.js：候选池 20 → 2000，并给"常用（pinned）"加一点权重。
 *   [3] library.js：加一个 `mimeOf(buf)`，按魔数认真实格式。
 *   [4] tools.js / commands.js：发图时不再写死 `data:image/png`，改用 mimeOf。
 *       —— 原代码把 GIF / JPEG 的表情也声明成 image/png（文件是按原字节存的），
 *          这是真的会发出去显示不出来（QQ 侧按 MIME 解就废了）。
 *
 * 用法
 *   node tools/patch-sticker.cjs            # 打补丁（幂等）
 *   node tools/patch-sticker.cjs --revert   # 从 .orig 还原
 *   node tools/patch-sticker.cjs --check    # 只看状态，不改文件
 *
 * 装完/升级依赖后要重跑（koishi-app/package.json 里挂了 postinstall 自动跑）。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const LIB = path.join(ROOT, 'koishi-app', 'node_modules', 'koishi-plugin-chatluna-sticker', 'lib')

const GUARD_START = '            // >>>SC-GUARD-START<<<'
const GUARD_END = '            // >>>SC-GUARD-END<<<'

const args = process.argv.slice(2)
const REVERT = args.includes('--revert')
const CHECK = args.includes('--check')

let changed = 0
let problems = 0

function read(f) {
  try {
    return fs.readFileSync(f, 'utf8')
  } catch (e) {
    console.error(`✗ 读不到 ${f}（插件没装？）：${e.message}`)
    problems++
    return null
  }
}

function writeWithBackup(f, next) {
  const bak = f + '.orig'
  if (!fs.existsSync(bak)) {
    fs.copyFileSync(f, bak)
    console.log(`  · 已备份原始文件 → ${path.basename(bak)}`)
  }
  fs.writeFileSync(f, next)
  changed++
}

function hasMarkers(s) {
  return (
    s.includes('>>>SC-GUARD-START<<<') ||
    s.includes('>>>SC-POOL<<<') ||
    s.includes('>>>SC-MIME<<<')
  )
}

// ------------------------------------------------------------------ [1] middleware.js
function patchMiddleware() {
  const f = path.join(LIB, 'middleware.js')
  let s = read(f)
  if (s == null) return

  if (REVERT) {
    const bak = f + '.orig'
    if (!fs.existsSync(bak)) return console.log('  · middleware.js 没有备份，跳过还原')
    fs.copyFileSync(bak, f)
    changed++
    return console.log('  · middleware.js 已还原')
  }

  if (CHECK) {
    console.log(`  · middleware.js : ${hasMarkers(s) ? '已打补丁' : '未打补丁'}`)
    return
  }
  if (s.includes('>>>SC-GUARD-START<<<')) return console.log('  · middleware.js 已打过补丁，跳过')

  const anchor = `            const { canonicalHash, status, isNew } = await library.recordOccurrence(pHash);`
  if (!s.includes(anchor)) {
    console.error('✗ middleware.js 找不到锚点（插件版本变了？），请人工核对')
    problems++
    return
  }

  const guard = [
    GUARD_START,
    "            // 逻辑预筛：压缩率 / 分辨率 / 体积不达标就直接标 rejected，不落盘、不烧视觉调用。",
    "            // 真正的判定逻辑在自写插件 koishi-plugin-chatluna-sticker-admin 里（服务名 stickerGuard）。",
    "            // 不装那个插件时 ctx.stickerGuard 为 undefined，这段等价于不存在。",
    "            const scGuard = ctx.stickerGuard || (ctx.root && ctx.root.stickerGuard);",
    "            if ((status === 'new' || status === 'pending_review') && scGuard) {",
    '                try {',
    '                    const gate = await scGuard.check(buf);',
    '                    if (gate && gate.ok === false) {',
    "                        await ctx.database.set('sticker_occurrence', { pHash: canonicalHash }, {",
    "                            status: 'rejected',",
    "                            judgeError: ('预筛淘汰：' + gate.reason).slice(0, 500),",
    '                        });',
    "                        ctx.logger.debug('[sticker] 预筛淘汰 ' + canonicalHash + '（' + gate.reason + '）');",
    '                        continue;',
    '                    }',
    '                } catch (e) {',
    "                    ctx.logger.warn('[sticker] 预筛出错（放行）：' + (e?.message ?? e));",
    '                }',
    '            }',
    GUARD_END,
  ].join('\n')

  s = s.replace(anchor, anchor + '\n' + guard)
  writeWithBackup(f, s)
  console.log('  ✓ middleware.js 已注入预筛钩子')
}

// ------------------------------------------------------------------ [2] tools.js
function patchTools() {
  const f = path.join(LIB, 'tools.js')
  let s = read(f)
  if (s == null) return

  if (REVERT) {
    const bak = f + '.orig'
    if (!fs.existsSync(bak)) return console.log('  · tools.js 没有备份，跳过还原')
    fs.copyFileSync(bak, f)
    changed++
    return console.log('  · tools.js 已还原')
  }

  if (CHECK) {
    console.log(`  · tools.js      : ${s.includes('>>>SC-POOL<<<') ? '已打补丁' : '未打补丁'}`)
    return
  }
  if (s.includes('>>>SC-POOL<<<')) return console.log('  · tools.js 已打过补丁，跳过')

  const anchorPool = 'const candidates = await library.listCollected(20);'
  const anchorScore = 'return { c, score: score * 100 + (c.useCount || 0) };'
  if (!s.includes(anchorPool) || !s.includes(anchorScore)) {
    console.error('✗ tools.js 找不到锚点（插件版本变了？），请人工核对')
    problems++
    return
  }

  s = s.replace(
    anchorPool,
    [
      '// >>>SC-POOL<<< 候选池：原来写死 20（=按使用次数取前 20），新库 useCount 全是 0，',
      '        // 结果 AI 永远只能在那 20 张里挑。改成整库参与打分（上限 2000，和 maxSendableImages 同量级）。',
      '        const candidates = await library.listCollected(2000);',
    ].join('\n')
  )
  s = s.replace(
    anchorScore,
    'return { c, score: score * 100 + (c.useCount || 0) + (c.pinned ? 50 : 0) }; // +50 = 「常用」微加权'
  )
  writeWithBackup(f, s)
  console.log('  ✓ tools.js 已放宽候选池 + 常用加权')
}

// ------------------------------------------------------------------ [3] library.js：mimeOf
function patchLibrary() {
  const f = path.join(LIB, 'library.js')
  let s = read(f)
  if (s == null) return

  if (REVERT) {
    const bak = f + '.orig'
    if (!fs.existsSync(bak)) return console.log('  · library.js 没有备份，跳过还原')
    fs.copyFileSync(bak, f)
    changed++
    return console.log('  · library.js 已还原')
  }
  if (CHECK) {
    console.log(`  · library.js    : ${s.includes('mimeOf') ? '已打补丁' : '未打补丁'}`)
    return
  }
  if (s.includes('mimeOf(')) return console.log('  · library.js 已打过补丁，跳过')

  const anchor = '    // ── 图片文件存取 ──────────────────────────────────────'
  if (!s.includes(anchor)) {
    console.error('✗ library.js 找不到锚点（插件版本变了？），请人工核对')
    problems++
    return
  }
  const method = [
    '    // >>>SC-MIME<<< 按魔数判断真实图片格式。原代码发图时一律写 data:image/png，',
    '    // 但文件是按**原字节**存的（GIF/JPEG 也是原样），声明错了 QQ 侧可能解不出来。',
    '    mimeOf(buf) {',
    '        if (!buf || buf.length < 12) return "image/png";',
    '        if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";',
    '        if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";',
    '        if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";',
    '        if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57 && buf[9] === 0x45) return "image/webp";',
    '        if (buf[0] === 0x42 && buf[1] === 0x4d) return "image/bmp";',
    '        return "image/png";',
    '    }',
    '',
  ].join('\n')
  s = s.replace(anchor, method + anchor)
  writeWithBackup(f, s)
  console.log('  ✓ library.js 已加 mimeOf()')
}

// ------------------------------------------------------------------ [4] 发图 MIME
function patchMimeUsage(file) {
  const f = path.join(LIB, file)
  let s = read(f)
  if (s == null) return

  if (REVERT) {
    const bak = f + '.orig'
    if (!fs.existsSync(bak)) return console.log(`  · ${file} 没有备份，跳过还原`)
    fs.copyFileSync(bak, f)
    changed++
    return console.log(`  · ${file} 已还原`)
  }
  if (CHECK) {
    console.log(`  · ${file.padEnd(13)}: ${s.includes('mimeOf(buf)') ? '已打补丁' : '未打补丁'}`)
    return
  }
  if (s.includes('mimeOf(buf)')) return console.log(`  · ${file} 已打过补丁，跳过`)

  const from = 'h.image(`data:image/png;base64,${buf.toString("base64")}`)'
  const alt = "h.image(`data:image/png;base64,${buf.toString('base64')}`)"
  let hit = 0
  if (s.includes(from)) {
    s = s.split(from).join('h.image(`data:${library.mimeOf(buf)};base64,${buf.toString("base64")}`)')
    hit++
  }
  if (s.includes(alt)) {
    s = s.split(alt).join("h.image(`data:${library.mimeOf(buf)};base64,${buf.toString('base64')}`)")
    hit++
  }
  if (!hit) {
    console.error(`✗ ${file} 找不到 data:image/png 发图锚点，请人工核对`)
    problems++
    return
  }
  writeWithBackup(f, s)
  console.log(`  ✓ ${file} 发图改用 mimeOf()`)
}

console.log(`chatluna-sticker 补丁${REVERT ? '（还原模式）' : CHECK ? '（检查模式）' : ''}`)
if (!fs.existsSync(LIB)) {
  console.error(`✗ 目录不存在：${LIB}\n  先 npm i 装好 koishi-plugin-chatluna-sticker 再跑这个脚本。`)
  process.exit(1)
}
patchMiddleware()
patchTools()
patchLibrary()
patchMimeUsage('tools.js')
patchMimeUsage('commands.js')
console.log(
  CHECK ? '检查完成' : REVERT ? `还原完成（改动 ${changed} 个文件）` : `完成：改了 ${changed} 个文件${problems ? `，${problems} 处需要人工核对` : ''}`
)
process.exit(problems ? 1 : 0)
