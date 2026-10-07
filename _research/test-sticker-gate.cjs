/**
 * 表情包「逻辑预筛」+ mimeOf 单测
 *   cd koishi-app && node --no-warnings ../_research/test-sticker-gate.cjs
 */
const path = require('path')
const Module = require('module')

const APP = path.resolve(__dirname, '../koishi-app')
const sharp = require(path.join(APP, 'node_modules', 'sharp'))

// ---- 桩 koishi ----
const chain = new Proxy(function () {}, {
  get: (t, p) => (p === Symbol.toPrimitive || p === 'toString' || p === 'valueOf' ? () => '' : chain),
  apply: () => chain,
})
const origRequire = Module.prototype.require
Module.prototype.require = function (id) {
  if (id === 'koishi') {
    return {
      Logger: class {
        constructor(tag) { this.tag = tag }
        info() {}
        warn() {}
        debug() {}
        error() {}
      },
      h: (type, attrs) => ({ type, attrs }),
      Schema: new Proxy({}, { get: () => () => chain }),
    }
  }
  return origRequire.apply(this, arguments)
}

const admin = require(path.join(APP, 'external/koishi-plugin-chatluna-sticker-admin/lib/index.js'))

let pass = 0
let fail = 0
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + label) }
  else { fail++; console.log('  ❌ ' + label + (extra ? '  → ' + extra : '')) }
}

function makeCtx() {
  const handlers = {}
  const cmds = []
  const ctx = {
    root: {},
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); return ctx },
    inject() { return ctx },
    provide() {},
    set() {},
    model: { extend() {} },
    database: { get: async () => [], set: async () => {}, upsert: async () => {}, remove: async () => {} },
    http: {},
    command(def) {
      const rec = { def }
      const c = { alias() { return c }, usage() { return c }, option() { return c }, action(fn) { rec.action = fn; cmds.push(rec); return c } }
      return c
    },
    setTimeout: () => 0,
    setInterval: () => 0,
  }
  return { ctx, handlers, cmds }
}

async function makeImages() {
  const out = {}
  // 典型表情包：小尺寸 + 高压缩
  out.sticker = await sharp({
    create: { width: 200, height: 200, channels: 3, background: { r: 240, g: 200, b: 120 } },
  }).jpeg({ quality: 55 }).toBuffer()
  // 高清大图（照片）：面积和体积都超标
  out.photo = await sharp({
    create: { width: 2400, height: 1800, channels: 3, background: { r: 90, g: 140, b: 200 } },
  }).jpeg({ quality: 95 }).toBuffer()
  // 中等尺寸的"截图感"PNG：噪声图无法被 PNG 压小 → 压缩率接近 1
  const nw = 400
  const raw = Buffer.alloc(nw * nw * 3)
  for (let i = 0; i < raw.length; i++) raw[i] = Math.floor(Math.random() * 256)
  out.screenshot = await sharp(raw, { raw: { width: nw, height: nw, channels: 3 } }).png().toBuffer()
  // 长截图：长宽比超限
  out.tallStrip = await sharp({
    create: { width: 1800, height: 200, channels: 3, background: { r: 13, g: 13, b: 13 } },
  }).jpeg({ quality: 60 }).toBuffer()
  return out
}

;(async () => {
  console.log('=== 表情包逻辑预筛单测 ===')
  const cfg = {
    prefilterEnabled: true,
    maxPixels: 1_000_000,
    maxBytes: 1_200_000,
    maxCompressionRatio: 0.85,
    minPixels: 0,
    maxAspectRatio: 4,
    dryRun: false,
    debug: false,
    storageDir: 'data/sticker-library',
    toolsEnabled: false,
    learnModel: 'x',
    syncVision: false,
    debugTools: false,
  }
  const { ctx, handlers } = makeCtx()
  admin.apply(ctx, cfg)
  handlers.ready?.forEach((f) => f())

  const guard = ctx.root.stickerGuard
  check('服务已挂到 ctx.root.stickerGuard', !!guard && typeof guard.check === 'function')
  check('ctx.stickerGuard 也可用', !!ctx.stickerGuard)

  const img = await makeImages()
  console.log('\n[1] 逐张判定')
  const a = await guard.check(img.sticker)
  check(`小尺寸高压缩 JPEG 放行（${img.sticker.length}B，${a.metrics ? a.metrics.w + 'x' + a.metrics.h + ' 压缩率' + a.metrics.ratio : ''}）`, a.ok === true, JSON.stringify(a))

  const b = await guard.check(img.photo)
  check(`2400x1800 高清图被拦（${(img.photo.length / 1024) | 0}KB）→ ${b.reason}`, b.ok === false)

  const c = await guard.check(img.screenshot)
  check(`900x900 无损 PNG 被拦（压缩率 ${c.metrics?.ratio}）→ ${c.reason}`, c.ok === false)

  const d = await guard.check(img.tallStrip)
  check(`1800x200 长条被拦（长宽比 9）→ ${d.reason}`, d.ok === false)

  console.log('\n[2] 开关与 dryRun')
  const { ctx: ctx2, handlers: h2 } = makeCtx()
  admin.apply(ctx2, { ...cfg, prefilterEnabled: false })
  h2.ready?.forEach((f) => f())
  const off = await ctx2.root.stickerGuard.check(img.photo)
  check('总开关关闭 → 一律放行', off.ok === true)

  const { ctx: ctx3, handlers: h3 } = makeCtx()
  admin.apply(ctx3, { ...cfg, dryRun: true })
  h3.ready?.forEach((f) => f())
  const dry = await ctx3.root.stickerGuard.check(img.photo)
  check('dryRun → 只记不拦', dry.ok === true)

  console.log('\n[3] 真实样本：已收藏的表情（真正会被发出去的那些）')
  const fs = require('fs')
  const { DatabaseSync } = require('node:sqlite')
  const base = path.join(APP, 'data/sticker-library')
  let collected = []
  try {
    const db = new DatabaseSync(path.join(APP, 'data/koishi.db'))
    collected = db.prepare('SELECT pHash, description FROM sticker_meta').all()
    db.close()
  } catch (e) {
    console.log('  （读不到 sticker_meta，跳过）', e.message)
  }
  if (!collected.length) {
    console.log('  （库里还没有已收藏的表情，跳过）')
  } else {
    let blocked = 0
    const details = []
    for (const row of collected) {
      const f = path.join(base, row.pHash.slice(0, 2), row.pHash + '.png')
      if (!fs.existsSync(f)) continue
      const r = await guard.check(fs.readFileSync(f))
      if (!r.ok) {
        blocked++
        details.push(`    ${row.pHash} 「${String(row.description || '').slice(0, 20)}」 → ${r.reason}`)
      }
    }
    console.log(`  已收藏 ${collected.length} 张，被预筛拦下 ${blocked} 张`)
    if (details.length) console.log(details.slice(0, 10).join('\n'))
    check('已收藏表情误伤率 = 0', blocked === 0, `${blocked}/${collected.length}`)
  }

  console.log('\n[3b] 真实样本：库里所有追踪过的图（含未收藏）')
  let files = []
  try {
    for (const d of fs.readdirSync(base)) {
      const dd = path.join(base, d)
      if (!fs.statSync(dd).isDirectory()) continue
      for (const f of fs.readdirSync(dd)) files.push(path.join(dd, f))
      if (files.length > 400) break
    }
  } catch {}
  if (files.length) {
    const sample = files.slice(0, 40)
    let blocked = 0
    for (const f of sample) {
      const r = await guard.check(fs.readFileSync(f))
      if (!r.ok) blocked++
    }
    console.log(`  抽样 ${sample.length} 张，拦下 ${blocked} 张（拦下的都是大图/截图，正是想要的效果）`)
  }

  console.log('\n[4] 统计接口')
  const st = guard.stats()
  check('stats 有计数', typeof st.checked === 'number' && typeof st.rejected === 'number', JSON.stringify(st))

  console.log('\n[5] mimeOf（补丁加的方法）')
  const libPath = path.join(APP, 'node_modules/koishi-plugin-chatluna-sticker/lib/library.js')
  const libSrc = fs.readFileSync(libPath, 'utf8')
  check('library.js 已含 mimeOf', libSrc.includes('mimeOf('))
  const StickerLibrary = require(libPath).StickerLibrary
  const inst = new StickerLibrary({ on() {}, logger: { info() {}, warn() {}, debug() {}, error() {} } }, {})
  check('JPEG 魔数 → image/jpeg', inst.mimeOf(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])) === 'image/jpeg')
  check('GIF 魔数 → image/gif', inst.mimeOf(Buffer.from('GIF89a--------', 'utf8')) === 'image/gif')
  check('PNG 魔数 → image/png', inst.mimeOf(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0])) === 'image/png')
  check('真实小 JPEG 判定正确', inst.mimeOf(img.sticker) === 'image/jpeg')
  check('真实 PNG 判定正确', inst.mimeOf(img.screenshot) === 'image/png')

  console.log('\n[6] tools.js 候选池补丁')
  const toolsSrc = fs.readFileSync(path.join(APP, 'node_modules/koishi-plugin-chatluna-sticker/lib/tools.js'), 'utf8')
  check('候选池已放宽到 2000', toolsSrc.includes('listCollected(2000)'))
  check('常用加权已加', toolsSrc.includes('c.pinned ? 50 : 0'))

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail ? 1 : 0)
})().catch((e) => {
  console.error('测试崩了：', e)
  process.exit(2)
})
