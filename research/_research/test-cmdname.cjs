/**
 * 指令名净化插件单测（不启动 Koishi，纯桩）
 *   node _research/test-cmdname.cjs
 */
const path = require('path')
const Module = require('module')

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
        info() {}
        warn() {}
        debug() {}
        error() {}
      },
      Schema: new Proxy({}, { get: () => () => chain }),
    }
  }
  return origRequire.apply(this, arguments)
}

const plugin = require(path.resolve(
  __dirname,
  '../koishi-app/external/koishi-plugin-chatluna-cmdname/lib/index.js'
))

function makeCtx(commandList) {
  const handlers = {}
  const timeouts = []
  const cmdr = {
    _commandList: commandList,
    get(n) {
      return commandList.find((c) => Object.hasOwn(c._aliases, n))
    },
  }
  const ctx = {
    $commander: cmdr,
    root: {},
    on(ev, fn) {
      ;(handlers[ev] = handlers[ev] || []).push(fn)
      return ctx
    },
    setTimeout(fn) {
      timeouts.push(fn)
      return timeouts.length
    },
    command(def, desc, cfg) {
      const rec = { def, desc, cfg, aliases: [] }
      const c = {
        alias() {
          return c
        },
        usage() {
          return c
        },
        option() {
          return c
        },
        action(fn) {
          rec.action = fn
          return c
        },
      }
      return c
    },
    logger: { info() {}, warn() {}, debug() {}, error() {} },
  }
  return { ctx, handlers, timeouts, cmdr }
}

function cmd(name, ...aliases) {
  const _aliases = Object.create(null)
  _aliases[name] = {}
  for (const a of aliases) _aliases[a] = { args: [] }
  return { name, _aliases }
}

let pass = 0
let fail = 0
function check(label, cond, extra) {
  if (cond) {
    pass++
    console.log('  ✅ ' + label)
  } else {
    fail++
    console.log('  ❌ ' + label + (extra ? '  →  ' + extra : ''))
  }
}

console.log('=== 指令名净化单测 ===')

// 场景 1：混合中英文别名
{
  console.log('\n[1] 摘掉中文别名、保留英文别名与主名')
  const list = [
    cmd('guard.limit', '限速'),
    cmd('selfext.search', 'plugin-search', '插件搜索'),
    cmd('affinity.rank', '好感度排行'),
    cmd('affinity.clearAll', '清空好感度'),
    cmd('sticker.list', 'sticker.list'),
  ]
  const { ctx, handlers } = makeCtx(list)
  plugin.apply(ctx, { enabled: true, stripNonAscii: true, keepNames: [], logRemoved: false, debug: false })
  handlers.ready.forEach((fn) => fn())

  check('guard.limit 主名保留', Object.keys(list[0]._aliases)[0] === 'guard.limit', JSON.stringify(Object.keys(list[0]._aliases)))
  check('guard.limit 的「限速」被摘掉', !Object.hasOwn(list[0]._aliases, '限速'))
  check('selfext.search 的英文别名 plugin-search 保留', Object.hasOwn(list[1]._aliases, 'plugin-search'))
  check('selfext.search 的中文别名被摘掉', !Object.hasOwn(list[1]._aliases, '插件搜索'))
  check('affinity 的 2 条中文别名都被摘掉', !Object.hasOwn(list[2]._aliases, '好感度排行') && !Object.hasOwn(list[3]._aliases, '清空好感度'))
  check('displayName（第一个键）没被改动', list[3] && Object.keys(list[3]._aliases)[0] === 'affinity.clearAll')
  check('无法再通过中文名解析', ctx.$commander.get('好感度排行') === undefined)
  check('英文名仍可解析', ctx.$commander.get('affinity.rank') === list[2])
}

// 场景 2：豁免名单
{
  console.log('\n[2] keepNames 豁免')
  const list = [cmd('x.y', '中文名')]
  const { ctx, handlers } = makeCtx(list)
  plugin.apply(ctx, { enabled: true, stripNonAscii: true, keepNames: ['中文名'], logRemoved: false, debug: false })
  handlers.ready.forEach((fn) => fn())
  check('豁免的中文别名被保留', Object.hasOwn(list[0]._aliases, '中文名'))
}

// 场景 3：总开关关闭
{
  console.log('\n[3] 开关关闭时不动作')
  const list = [cmd('x.y', '中文名')]
  const { ctx, handlers } = makeCtx(list)
  plugin.apply(ctx, { enabled: false, stripNonAscii: true, keepNames: [], logRemoved: false, debug: false })
  handlers.ready.forEach((fn) => fn())
  check('别名原样保留', Object.hasOwn(list[0]._aliases, '中文名'))
}

// 场景 4：主名本身是中文 → 绝不能动（否则指令直接失效）
{
  console.log('\n[4] 主名是中文时不动第一个键')
  const list = [cmd('中文主名', '中文别名')]
  const { ctx, handlers } = makeCtx(list)
  plugin.apply(ctx, { enabled: true, stripNonAscii: true, keepNames: [], logRemoved: false, debug: false })
  handlers.ready.forEach((fn) => fn())
  check('主名保留', Object.keys(list[0]._aliases)[0] === '中文主名')
  check('别名被摘掉', !Object.hasOwn(list[0]._aliases, '中文别名'))
}

// 场景 5：command-updated 后新别名也会被清
{
  console.log('\n[5] 运行期新注册的中文别名会被清掉')
  const list = [cmd('late.cmd')]
  const { ctx, handlers, timeouts } = makeCtx(list)
  plugin.apply(ctx, { enabled: true, stripNonAscii: true, keepNames: [], logRemoved: false, debug: false })
  handlers.ready.forEach((fn) => fn())
  // 模拟第三方插件后注册
  list[0]._aliases['迟到中文'] = {}
  handlers['command-updated'].forEach((fn) => fn())
  // 触发 debounce 里的 setTimeout
  timeouts.filter((f) => f).forEach((f) => {})
  const after = Object.keys(list[0]._aliases)
  // debounce 通过 ctx.setTimeout 排队，桩里只是收集——手动执行最后一个
  const last = timeouts[timeouts.length - 1]
  if (typeof last === 'function') last()
  check('迟到中文别名被摘掉', !Object.hasOwn(list[0]._aliases, '迟到中文'), '实际=' + JSON.stringify(Object.keys(list[0]._aliases)))
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
