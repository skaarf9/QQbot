/**
 * koishi-plugin-chatluna-cmdname —— 指令名净化
 *
 * 为什么需要它
 * ------------
 * 命令面（指令列表 / 补全菜单 / 平台下发的指令菜单 / 「你是不是想找 xxx」提示）
 * 显示的是 **Command._aliases 的全部键**，不只是主名。所以只要某个插件
 * `.alias('限速')`、`.alias('屏蔽状态')`，中文就会出现在用户的指令界面里。
 *
 * 自写插件可以直接删掉那几行 `.alias()`，但**市场插件改不动**：
 *   - `koishi-plugin-chatluna-affinity` 有 10 条中文别名（好感度排行 / 黑名单 / 调整好感 …）
 *   - 其它插件将来也可能有
 * 直接改 node_modules 会在 `npm i` 之后被覆盖，所以这里用**运行时净化**：
 * 在 `ready` 之后遍历 Commander 的指令表，把非 ASCII 的别名键删掉。
 *
 * 依据（@koishijs/core 源码实证）
 * ------------------------------
 *   - `Command._aliases` 是一个普通对象 `Object.create(null)`，形如
 *       { 'affinity.rank': {filter,args,options}, '好感度排行': {...} }
 *     —— 见 `@koishijs/core/lib/index.cjs` 的 `_registerAlias()`。
 *   - `Command.displayName` = `Object.keys(this._aliases)[0]`（**第一个键是主名**），
 *     所以删别名时**必须保留第一个键**，否则会改掉指令的显示名。
 *   - `Commander.get(name)` / `available(session)` 都直接读 `_aliases`，
 *     所以 `delete cmd._aliases['限速']` 之后：`/限速` 不再能解析，列表里也不再出现。
 *   - 事件 `command-updated` 在 `.alias()` 里 emit，会沿 scope 链冒泡到根，
 *     所以在自己的 ctx 上监听就能捕获所有子插件的后续注册。
 *
 * 注意：本插件**只删别名，不改指令的行为**。中文控制词（guard 的「闭嘴/开口」）
 * 走的是 guard 自己的 middleware，不依赖指令别名，所以不受影响。
 */

const { Schema, Logger } = require('koishi')

const name = 'chatluna-cmdname'
const logger = new Logger('cmdname')

/** 非 ASCII（中文 / 日文 / emoji）判定 */
const NON_ASCII = /[^\x00-\x7F]/

const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('总开关'),
  stripNonAscii: Schema.boolean()
    .default(true)
    .description('把非 ASCII（中文/日文等）的**指令别名**摘掉，只留英文指令名。描述文字不受影响'),
  keepNames: Schema.array(Schema.string())
    .role('table')
    .default([])
    .description('豁免名单：这些别名即使含中文也保留（一般留空）'),
  logRemoved: Schema.boolean().default(true).description('启动时打印摘掉了哪些别名'),
  debug: Schema.boolean().default(false).description('打印每次扫描的细节'),
})

function commanderOf(ctx) {
  const c = ctx.$commander || ctx.root?.$commander
  if (!c || !Array.isArray(c._commandList)) return null
  return c
}

function apply(ctx, config) {
  const keep = new Set((config.keepNames || []).map(String))
  /** 已经摘过的（避免 command-updated 反复刷日志） */
  const removedOnce = new Set()

  /**
   * 扫描一遍指令表，摘掉非 ASCII 别名。
   * @returns {{scanned:number, removed:string[]}}
   */
  function sweep() {
    const removed = []
    let scanned = 0
    const cmdr = commanderOf(ctx)
    if (!cmdr) return { scanned, removed }

    for (const cmd of cmdr._commandList) {
      const aliases = cmd?._aliases
      if (!aliases || typeof aliases !== 'object') continue
      scanned++
      const keys = Object.keys(aliases)
      // ★ 第一个键是主名（displayName），永不动它
      for (let i = 1; i < keys.length; i++) {
        const key = keys[i]
        if (!NON_ASCII.test(key)) continue
        if (keep.has(key)) continue
        try {
          delete aliases[key]
        } catch {
          /* 只读对象：忽略 */
        }
        removed.push(key)
      }
    }
    return { scanned, removed }
  }

  function run(reason) {
    if (!config.enabled || !config.stripNonAscii) return
    let out
    try {
      out = sweep()
    } catch (e) {
      logger.warn('指令名净化失败（不影响运行）：%s', e.message)
      return
    }
    const fresh = out.removed.filter((k) => !removedOnce.has(k))
    for (const k of out.removed) removedOnce.add(k)
    if (config.debug) {
      logger.debug('扫描 %d 条指令，本次摘掉 %d 条别名（%s）', out.scanned, out.removed.length, reason)
    }
    if (fresh.length && config.logRemoved) {
      logger.info(
        '已摘掉 %d 条中文指令别名（%s）：%s',
        fresh.length,
        reason,
        fresh.slice(0, 20).join(' / ') + (fresh.length > 20 ? ` …共 ${fresh.length} 条` : '')
      )
    }
  }

  // 插件加载是异步的：ready 之后再扫两遍，覆盖"加载晚"的插件
  ctx.on('ready', () => {
    run('ready')
    ctx.setTimeout(() => run('ready+3s'), 3000)
    ctx.setTimeout(() => run('ready+8s'), 8000)
  })

  // 第三方插件在别处 async 注册别名时也能兜住（debounce 200ms）
  let timer = null
  ctx.on('command-updated', () => {
    if (timer) return
    timer = ctx.setTimeout(() => {
      timer = null
      run('command-updated')
    }, 200)
  })

  // ------------------------------------------------------------- 人工核对
  ctx
    .command('cmdname.scan', '列出当前所有仍含非 ASCII 的指令名/别名', { authority: 3 })
    .action(() => {
      const cmdr = commanderOf(ctx)
      if (!cmdr) return '拿不到指令表'
      const rows = []
      for (const cmd of cmdr._commandList) {
        const keys = Object.keys(cmd?._aliases || {})
        keys.forEach((k, i) => {
          if (NON_ASCII.test(k)) rows.push(`${k}${i === 0 ? '（主名！）' : ''}  ← ${cmd.name}`)
        })
      }
      if (!rows.length) return '干净：没有任何非 ASCII 指令名或别名。'
      return `仍有 ${rows.length} 条：\n` + rows.join('\n')
    })

  logger.info(
    '指令名净化已挂载（开关 %s；豁免 %d 条）',
    config.enabled && config.stripNonAscii ? '开' : '关',
    keep.size
  )
}

module.exports = { name, Config, apply }
