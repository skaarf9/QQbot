/**
 * 指令命名回归：断言
 *   1. 所有注册出来的指令主名都是纯 ASCII、点号/小写英文
 *   2. 旧的中文名仍作为「别名」存在（老习惯不废）
 * 用的是桩 ctx：把 ctx.command / ctx.on / ctx.provide 都接住。
 */
const Module = require('module')
const path = require('path')

// 万能的"链式空对象"：任何属性访问/调用都返回它自己，用来顶掉 Schema.xxx().yyy() 这类调用
function chain() {
  const f = function () {
    return p
  }
  const p = new Proxy(f, {
    get: (t, k) => {
      if (k === 'then') return undefined
      if (k === Symbol.toPrimitive || k === 'toString' || k === 'valueOf') return () => ''
      return chain()
    },
    apply: () => chain(),
  })
  return p
}

function makeCtx() {
  const commands = []
  const handlers = {}
  const base = {
    baseDir: process.cwd(),
    app: {},
    root: {},
    logger: () => ({ info() {}, warn() {}, debug() {}, error() {} }),
    on: (ev, fn) => {
      ;(handlers[ev] = handlers[ev] || []).push(fn)
      return ctx
    },
    once: () => ctx,
    setTimeout: () => 0,
    setInterval: () => 0,
    clearInterval: () => {},
    clearTimeout: () => {},
    inject: () => ctx,
    provide: () => {},
    set: () => {},
    component: () => {},
    middleware: () => {},
    model: { extend: () => {} },
    database: { get: async () => [], upsert: async () => {}, set: async () => {}, remove: async () => {} },
    http: {},
    $commander: { get: () => null },
    command: (def, desc, cfg) => {
      const rec = { def, desc, cfg, aliases: [], usages: [] }
      commands.push(rec)
      const cmd = {
        alias(name) {
          rec.aliases.push(name)
          return cmd
        },
        usage(u) {
          rec.usages.push(u)
          return cmd
        },
        option() {
          return cmd
        },
        action(fn) {
          rec.action = fn
          return cmd
        },
      }
      return cmd
    },
  }
  const ctx = new Proxy(base, {
    get: (t, k) => (k in t ? t[k] : chain()),
  })
  return { ctx, commands, handlers }
}

function patchRequire() {
  const orig = Module.prototype.require
  Module.prototype.require = function (id) {
    if (id === 'koishi') {
      return {
        Schema: chain(),
        Logger: class {
          info() {}
          warn() {}
          debug() {}
          error() {}
        },
        h: (type, attrs) => ({ type, attrs }),
      }
    }
    if (id === 'zod' || id === '@langchain/core/tools') return chain()
    return orig.apply(this, arguments)
  }
  return () => (Module.prototype.require = orig)
}

const targets = [
  ['koishi-plugin-chatluna-guard', ['限速', '限速重置']],
  ['koishi-plugin-chatluna-selfext', ['插件搜索', '插件申请', '插件安装', '插件申请列表']],
]

const restore = patchRequire()
let bad = 0

for (const [pkg, legacyNames] of targets) {
  const dir = path.join(__dirname, '..', 'koishi-app', 'external', pkg)
  const { ctx, commands } = makeCtx()
  const mod = require(path.join(dir, 'lib', 'index.js'))
  mod.apply(ctx, mod.Config ? {} : {})
  console.log(`\n=== ${pkg} ===`)
  for (const c of commands) {
    const primary = c.def.split(' ')[0]
    const ascii = /^[a-z][a-z0-9.]*$/i.test(primary)
    console.log(
      `${ascii ? '✔' : '✘'} 主名 ${primary.padEnd(22)} 别名 [${c.aliases.join(', ')}]`
    )
    if (!ascii) bad++
  }
  const allAliases = commands.flatMap((c) => c.aliases)
  for (const legacy of legacyNames) {
    const ok = allAliases.includes(legacy)
    console.log(`${ok ? '✔' : '✘'} 旧名「${legacy}」保留为别名`)
    if (!ok) bad++
  }
}

restore()
console.log(bad === 0 ? '\n全部通过 ✔' : `\n有 ${bad} 项不通过 ✘`)
process.exit(bad === 0 ? 0 : 1)
