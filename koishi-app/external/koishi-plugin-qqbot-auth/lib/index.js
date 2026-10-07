/**
 * qqbot-auth —— R13 权限分级
 *
 * 设计目标（用户原始硬性要求）：
 *   「对 bot 发出的命令需要有权限校验，比如某一些命令必须管理员权限才能使用，
 *     而其他的普通群友也能随便使用」
 *
 * 五级模型（与 Koishi 的权限声明 `authority:N` 一一对应）：
 *
 *   4  主人   插件装卸 / 指令开关 / 授权他人 —— 框架已卡死在 4
 *   3  管理员 破坏性、影响他人的指令（删会话 / 停对话 / 切模型 / 换预设 / 清空 …）
 *   2  信任   预留给 R4 好感度达标者
 *   1  普通   默认等级（Koishi 的 autoAuthorize 默认就是 1）
 *   0  拉黑   连 /qqbot.help 都用不了
 *
 * ---
 * ★ 三条实测出来的硬事实（2026-09-29 用运行期探针验的，别凭印象改）
 *
 * 1. Koishi 的权限判定是 `!user || user.authority >= +value`
 *    （@koishijs/core lib/index.cjs:2127）。**没有 user 时直接放行** ——
 *    所以别指望靠"库里没这行"来拦人。
 *
 * 2. `autoAuthorize` 默认值就是 **1**（koishi/lib/index.cjs:2433，
 *    Schema.natural().default(1)）。任何发过消息的人都会被自动建行并拿到 1 级。
 *    而且这个值**只在建行时写一次**（core:1916，getUser 里查不到才用），
 *    改配置不影响已有行 —— 想降级必须显式写库或用 qqbot.auth.set。
 *
 * 3. 一个指令的**有效门槛 = 它自己与所有祖先指令上 `authority:N` 的最大值**。
 *    判定时整条链都要过，只读自己的 config.permissions 会漏。
 *
 * ---
 * ★ 为什么要运行期改 `Command.config.permissions`
 *
 * ChatLuna 把一批**破坏性指令只挂在 1 级**，任何普通群友都能触发：
 *   chatluna.delete / stop / restart / wipe / switch / rollback / archive /
 *   use.model / use.preset / voice
 * 其中 `/chatluna.stop` 能让 bot 停止回话、`/chatluna.delete` 能删掉别人的会话、
 * `/chatluna.use.model` 能把全群的模型换掉 —— 这正是 R13 要解决的核心问题。
 *
 * 实测：运行期写 `cmd.config.permissions = ['authority:3']` **生效**，
 * 因为权限判定每次读的都是该属性的当前值（不是建指令时的快照）。
 */
const { Schema } = require('koishi')

/** 五级模型的展示名 */
const LEVEL_NAMES = {
  4: '主人',
  3: '管理员',
  2: '信任',
  1: '普通',
  0: '拉黑',
}

/** 危险指令提权表：[指令权威全名, 目标等级, 说明]。前缀匹配会一并覆盖子指令。
 *
 *  ★ 名字形式很坑：Koishi 里 `ctx.command('a/b')` 的**权威全名是 `a.b`**（斜杠即点号），
 *    而 `_commandList[].name` 用的正是点号形式。所以两种写法都登记，省得漏。
 */
const OVERRIDES = [
  // ---- ChatLuna：破坏性 / 影响他人 / 改全局状态 ----
  ['chatluna.delete', 3, '删除会话'],
  ['chatluna.stop', 3, '停止当前对话'],
  ['chatluna.restart', 3, '重载服务'],
  ['chatluna.wipe', 3, '清空所有对话'],
  ['chatluna.switch', 3, '切到别人的会话'],
  ['chatluna.rollback', 3, '回滚消息'],
  ['chatluna.archive', 3, '归档会话'],
  ['chatluna.use.model', 3, '切换模型'],
  ['chatluna.use.preset', 3, '切换预设'],
  ['chatluna.voice', 3, '语音合成（花钱）'],

  // ---- 长期记忆（R3 装上 chatluna-long-memory 后才存在）----
  // 父指令提权到 2，子指令自动继承（有效等级 = 父链上的最大值）；
  // 写入/删除类再单独提到 3，因为它们会污染或抹掉 bot 的长期记忆。
  // ★ 这里写「点号全名」而不是 `父>子`：`ctx.command('a.b.c')` 注册出来的
  //   子指令 `name` 就是完整路径 `a.b.c`（core:1491 点号走 `parent.name + 段`），
  //   get() 按名字/别名都能查到。`父>子` 只对**斜杠写法**（`emotion/set`）需要，
  //   那种子指令的 name 只有最后一段。
  ['chatluna.memory', 2, '长期记忆查看'],
  ['chatluna.memory.add', 3, '手动写入长期记忆'],
  ['chatluna.memory.delete', 3, '删除长期记忆'],
  ['chatluna.memory.clear', 3, '清空长期记忆'],
  ['chatluna.memory.edit', 3, '编辑长期记忆'],

  // ---- 表情包库（R5/R7 装上 chatluna-sticker 后才存在）----
  // 注意这个包的 `module.exports.name` 是 `auto-sticker`、包名却是
  // `koishi-plugin-chatluna-sticker`，指令前缀仍然是 `sticker`。
  // `sticker.retry`(3) / `sticker.retry.all`(4) / `sticker.prune`(3) 是它自带的，
  // 这里只把「看库内容」的两条从 1 提到 2（`sticker.send` 保持 1：发张表情包不是危险操作）。
  ['sticker.list', 2, '看表情包库'],
  ['sticker.stat', 2, '表情包库统计'],

  // ---- 自研插件里的管理向指令 ----
  ['followup', 3, '群聊跟进状态'],
  // ★ 这 4 条的「真名」不是 `emotion.set` —— `ctx.command('emotion/set')` 里的
  //   `/set` 被当成了**下一层的名字**，实际注册成 `emotion` 的子指令 `set`
  //   （名字和别名都是 `set`）。所以这里写成「父名>子名」表达父子关系。
  ['emotion>set', 3, '手动设置情绪'],
  ['emotion>reset', 3, '重置情绪'],
  ['vision>stat', 3, '图片缓存统计'],
  ['vision>forget', 3, '删除图片缓存'],
]

module.exports.name = 'qqbot-auth'

module.exports.Config = Schema.object({
  ownerIds: Schema.array(String)
    .role('table')
    .description('主人（等级 4）。可装卸插件、开关指令、授权他人。<b>只填你自己的号</b>。')
    .default([]),
  adminIds: Schema.array(String)
    .role('table')
    .description('管理员（等级 3）。可用删会话 / 停对话 / 切模型 / 换预设等管理指令。')
    .default([]),
  trustedIds: Schema.array(String)
    .role('table')
    .description('信任（等级 2）。可查长期记忆 / 看表情包库。留空也行——开了好感度桥会自动给。')
    .default([]),
  blockedIds: Schema.array(String)
    .role('table')
    .description('拉黑（等级 0）。连 /qqbot.help 都拒绝。')
    .default([]),
  raiseDangerousCommands: Schema.boolean()
    .description(
      '把 ChatLuna 里只挂 1 级的破坏性指令（delete / stop / restart / wipe / switch / use.model …）提到 3 级。<b>关掉的话普通群友能停掉对话、改全群模型。</b>'
    )
    .default(true),
  scanSeconds: Schema.natural()
    .description('启动后持续重扫的时长（秒）。ChatLuna 的指令注册在嵌套 ready 里，需要反复扫才抓得全。')
    .default(120),
  debug: Schema.boolean().description('打印扫描与提权明细。').default(true),

  // ---- R4 好感度 → 信任（等级 2）----
  affinityScopeId: Schema.string()
    .description(
      '接 chatluna-affinity 的好感度桥：填它的 scopeId 即启用（留空=关）。启用后「不在任何名单里」的人按好感度自动给 2 级。'
    )
    .default(''),
  affinityPromoteAt: Schema.natural()
    .description('好感度 ≥ 这个值 → 提到等级 2（信任）。chatluna-affinity 的区间默认是 51 起「熟悉」。')
    .default(51),
  affinityDemoteAt: Schema.natural()
    .description('好感度 ≤ 这个值 → 降回等级 1。故意留出滞后带（51↔40），免得在阈值上反复横跳。')
    .default(40),
})

module.exports.apply = (ctx, config) => {
  const logger = ctx.logger('qqbot-auth')

  const cfg = {
    ownerIds: [],
    adminIds: [],
    trustedIds: [],
    blockedIds: [],
    raiseDangerousCommands: true,
    scanSeconds: 120,
    debug: true,
    affinityScopeId: '',
    affinityPromoteAt: 51,
    affinityDemoteAt: 40,
    ...(config ?? {}),
  }

  const set = (v) => {
    const arr = Array.isArray(v) ? v : v == null || v === '' ? [] : [v]
    return new Set(arr.map((x) => String(x).trim()).filter(Boolean))
  }

  /** 名单 → 等级；不在任何名单里返回 null（保持数据库里的既有值） */
  function authorityOf(userId) {
    const id = String(userId)
    if (set(cfg.blockedIds).has(id)) return 0
    if (set(cfg.ownerIds).has(id)) return 4
    if (set(cfg.adminIds).has(id)) return 3
    if (set(cfg.trustedIds).has(id)) return 2
    return null
  }

  // ------------------------------------------------------------ R4 好感度 → 信任
  //
  // 读的是 chatluna-affinity 的表 `chatluna_affinity_v2`（主键是 scopeId + userId，
  // 见插件 `lib/index.js:990-1007`）。只在「不在任何名单里，且当前等级 ≤2」时接管 ——
  // 3/4 级是人工用 qqbot.auth.set 给的，不能被好感度掀掉。
  //
  // 加 10 秒缓存：attach-user 每条消息都跑，不能每条都查库；但也不能太久
  // （好感度是一轮对话里就可能变的东西，缓存 60 秒会让升级慢半拍，实测踩过）。
  // 带内（40 < aff < 51）返回 'keep'，表示"维持现状"，避免在阈值上反复横跳。
  const AFFINITY_TABLE = 'chatluna_affinity_v2'
  const AFFINITY_TTL = 10_000
  const affCache = new Map() // userId -> { level, at }

  async function affinityLevel(userId) {
    if (!cfg.affinityScopeId) return null
    const key = String(userId)
    const now = Date.now()
    const hit = affCache.get(key)
    if (hit && now - hit.at < AFFINITY_TTL) return hit.level

    let level = null
    const db = ctx.get('database')
    if (db) {
      try {
        const rows = await db.get(AFFINITY_TABLE, {
          scopeId: cfg.affinityScopeId,
          userId: key,
        })
        if (rows && rows.length) {
          const aff = Number(rows[0].affinity)
          if (Number.isFinite(aff)) {
            if (aff >= cfg.affinityPromoteAt) level = 2
            else if (aff <= cfg.affinityDemoteAt) level = 1
            else level = 'keep'
          }
        }
      } catch (e) {
        // 表还没建（affinity 插件没装/没起来）时不要刷屏
        if (cfg.debug) logger.warn('读好感度失败：%s', e.message)
      }
    }
    affCache.set(key, { level, at: now })
    return level
  }

  // ------------------------------------------------------------ 名单 → authority
  //
  // 挂在 `attach-user` 上：该钩子在 session.observeUser() **之后**触发
  // （core:803-804），此时 session.user 已存在且被 observe 包裹 ——
  // 改 authority 会被自动写回数据库；同时又早于指令解析，当次消息即生效。
  // 这个钩子是用 `await ctx.serial(...)` 调的（core:804），所以可以是 async。
  ctx.on('attach-user', async (session) => {
    if (!session.user) return
    let want = authorityOf(session.userId)
    let why = '名单'

    if (want === null && cfg.affinityScopeId) {
      const cur = session.user.authority ?? 1
      if (cur <= 2) {
        const aff = await affinityLevel(session.userId)
        if (aff === 2 && cur < 2) want = 2
        else if (aff === 1 && cur === 2) want = 1
        if (want !== null) why = '好感度'
      }
    }

    if (want === null) return
    if (session.user.authority === want) return
    logger.info(
      '%s：用户 %s 的权限 %s → %s（%s）',
      why,
      session.userId,
      session.user.authority,
      want,
      LEVEL_NAMES[want]
    )
    session.user.authority = want
  })

  // ------------------------------------------------------------ 有效等级
  /**
   * 把提权表里的写法解析成真正的 Command 对象。
   *
   * ★ 为什么不能简单 `get(name)`：Koishi 的命令名/别名跟"用户敲什么"并不总一致，
   *   两种都踩过：
   *   · `ctx.command('emotion/set')` 里的 `/set` 是**下一层的名字**，
   *     实际注册成 `emotion` 的子指令 `set`（名字和别名都是 `set`）——
   *     `get('emotion.set')` 永远查不到。这种用 `'父名>子名'` 表达。
   *   · 反过来有的指令 `c.name` 是 `chatluna.admin.purge-legacy`，
   *     但用户实际敲的是别名 `chatluna.admin` —— `get()` 能把名字和别名都查到。
   */
  function resolveCmd(spec) {
    const gt = spec.indexOf('>')
    if (gt < 0) return ctx.$commander?.get?.(spec)

    const parent = ctx.$commander?.get?.(spec.slice(0, gt))
    if (!parent) return undefined
    const child = spec.slice(gt + 1)
    const kids = parent.children ?? []
    return (
      kids.find((c) => c.name === child) ??
      // `ctx.command('a.b.c')` 的子指令 name 是完整路径，`ctx.command('a/c')` 的只有一段
      kids.find((c) => c.name === parent.name + '.' + child) ??
      kids.find((c) => Object.hasOwn(c._aliases ?? {}, child))
    )
  }

  function effectiveLevel(cmd) {
    let max = null
    let node = cmd
    const guard = new Set()
    while (node && !guard.has(node)) {
      guard.add(node)
      for (const p of node.config?.permissions ?? []) {
        const m = /^authority:(\d+)$/.exec(p)
        if (m) max = Math.max(max ?? 0, +m[1])
      }
      node = node.parent
    }
    return max
  }

  // ------------------------------------------------------------ 提权扫描
  //
  // 指令表是**扁平**的（Commander._commandList，core:907），别套递归。
  // ChatLuna 的指令注册在**嵌套的第二个 ready** 里（chatluna lib:8109），
  // 所以一次扫描抓不全 —— 启动后按 scanSeconds 持续重扫，收敛后自行停止。
  let scanTimer = null
  let lastMissing = null
  let dumpedNames = false

  function scanOnce(why) {
    const list = ctx.$commander?._commandList
    if (!Array.isArray(list) || !list.length) return { missing: ['(指令表为空)'], upToDate: [], raised: 0 }

    if (!cfg.raiseDangerousCommands) return { missing: [], upToDate: [], raised: 0 }

    // 首次扫描把自研插件的指令打出来，方便核对提权表有没有写错
    if (cfg.debug && !dumpedNames) {
      dumpedNames = true
      const mine = []
      for (const c of list) {
        const names = [...new Set([c.name, ...Object.keys(c._aliases ?? {})])]
        if (names.some((n) => /^(emotion|vision|followup|qqbot)/.test(n))) {
          mine.push(`${names.join('|')}(a=${effectiveLevel(c)})`)
        }
      }
      logger.info('自研插件指令：%s', mine.join('  ') || '（一条都没有）')
    }

    let raised = 0
    const missing = [] // 指令还没注册出来（等下一轮）
    const upToDate = [] // 指令存在但**本来就达标**，不需要我们动手
    for (const [spec, level, desc] of OVERRIDES) {
      const cmd = resolveCmd(spec)
      if (!cmd) {
        missing.push(spec)
        continue
      }
      const before = effectiveLevel(cmd)
      if (before !== null && before >= level) {
        upToDate.push(spec)
        continue
      }
      cmd.config.permissions = [`authority:${level}`]
      raised++
      if (cfg.debug) logger.info('提权 %s（%s）：%s → %s', spec, desc, before, level)
    }
    return { missing, upToDate, raised, total: list.length }
  }

  function tick(round) {
    const { missing, upToDate, raised, total } = scanOnce()
    const key = missing.join(',')
    if (!missing.length) {
      logger.info(
        '提权规则已全部命中（指令表 %d 条；其中 %d 条本来就达标、未改动），停止重扫',
        total,
        upToDate.length
      )
      clearInterval(scanTimer)
      scanTimer = null
      lastMissing = null
      return
    }
    // 只在"缺哪些"变了或"有实际提权"时说话，避免每 2 秒刷屏
    if (key !== lastMissing) {
      logger.info('还没注册出来的指令：%s（继续扫）', key)
      lastMissing = key
    } else if (cfg.debug && raised) {
      logger.info('第 %d 轮：新增提权 %d 处', round, raised)
    }
  }

  ctx.on('ready', () => {
    let round = 0
    const step = () => {
      round++
      tick(round)
      if (round * 2000 >= cfg.scanSeconds * 1000 && scanTimer) {
        logger.warn(
          '重扫到时（%d 秒），这些指令一直没注册出来：%s（多半是插件没装/名字写错）',
          cfg.scanSeconds,
          lastMissing ?? '（无）'
        )
        clearInterval(scanTimer)
        scanTimer = null
      }
    }
    setTimeout(step, 2000)
    scanTimer = setInterval(step, 2000)
    ctx.on('dispose', () => {
      if (scanTimer) clearInterval(scanTimer)
    })
  })

  // ------------------------------------------------------------ 指令
  //
  // ★ 触发写法（这些结论都是实测出来的，改之前先看第八·十三节）
  //
  //   1. Koishi **没有** `命令/子命令` 这种写法：`Argv.parse` 只按空格切词，
  //      `_resolve` 按**点号**拆段，所以只有 `/chatluna.stop` 这种点号写法有效。
  //   2. 自动别名是**整条命令名**（`ctx.command('qqbot.auth')` → 别名就是
  //      `qqbot.auth`），不是最后一段，所以短名 `auth` 不存在。
  //   3. （历史坑位）别名的参数声明不能写进别名名里，必须单独传
  //      `alias(name, { args: [...] })`。
  //
  //   结论：**指令名一律英文**（2026-10-02 起，全局约定）。中文只出现在
  //   描述/帮助文案里；不再注册中文别名（会污染指令列表，也会被
  //   chatluna-cmdname 净化插件摘掉）。
  const GROUP = { authority: 1 }

  // ★ 2026-10-03：原来这里有一份手写的 CMD_HELP 指令清单（只有 8 行，只覆盖 qqbot.*），
  //   而运行期指令表实际有 135 条 —— 手写清单必然越写越旧。
  //   现在整块帮助**搬到了 `koishi-plugin-chatluna-help`**：它从 `_commandList` 现场枚举，
  //   按类目/等级出图。这里只留一句指路，避免两处各写一份又对不上。
  //
  //   同时**摘掉了 `qqbot.help` 与它的 `help` 别名**：框架的 `@koishijs/plugin-help` 也注册
  //   一个 `help`（authority:0，见 plugin-help/lib/index.js:129），三处同名会打架。
  //   帮助的唯一定义权归 chatluna-help。
  const HELP_POINTER = '权限分五级：4 主人 / 3 管理员 / 2 信任 / 1 普通 / 0 拉黑。\n完整指令清单发 /help（图文版）。'

  /** 统一的注册入口：一个命令挂多个名字（英文 + 中文扁平别名）
   *
   *  ★ 别名**不要**传 args 声明！`alias(name, options)` 里的 `options` 是直接存进
   *    `_aliases[name]` 的，而 `inferCommand` 会把它**整体**赋给 `argv.args`
   *    （core:1456），随后 `Command.parse` 又把解析结果 push 到这个数组后面
   *    （core:372 起）。所以传声明对象进去，handler 收到的第一个参数就是
   *    `{ name:'target', type:'string', required:true }` 这种对象 —— 实测踩到的。
   *    参数声明来自主命令名的 def（`ctx.command(def)` 自己会 parseDecl），
   *    别名只要留空数组即可。
   */
  function define(def, aliases, desc, config, handler) {
    const cmd = ctx.command(def, desc, config)
    for (const a of aliases) {
      cmd.alias(a, { args: [] })
    }
    if (handler) cmd.action(handler)
    return cmd
  }

  // 总入口：/qqbot.auth
  define('qqbot.auth', [], '权限分级：查看与设置权限等级', GROUP, async ({ session }) => {
    const lv = session.user?.authority ?? 1
    return `你的权限等级是 ${lv}（${LEVEL_NAMES[lv] ?? '未知'}）。\n\n${HELP_POINTER}`
  })

  // 查自己：/qqbot.auth.me
  define('qqbot.auth.me', [], '查看自己的权限等级', GROUP, async ({ session }) => {
    const lv = session.user?.authority ?? 1
    return `你的权限等级是 ${lv}（${LEVEL_NAMES[lv] ?? '未知'}）`
  })

  // 看名单：/qqbot.auth.list
  define('qqbot.auth.list', [], '查看四级名单', GROUP, async () => {
    const lines = ['权限名单：']
    for (const [key, lv] of [
      ['ownerIds', 4],
      ['adminIds', 3],
      ['trustedIds', 2],
      ['blockedIds', 0],
    ]) {
      const ids = [...set(cfg[key])]
      lines.push(`  ${lv} ${LEVEL_NAMES[lv]}：${ids.length ? ids.join(', ') : '（空）'}`)
    }
    lines.push('', '名单外的人保持库里的既有等级，默认 1。')
    return lines.join('\n')
  })

  // 改等级：/qqbot.auth.set <QQ号> <0-4>
  define(
    'qqbot.auth.set <target:string> <level:natural>',
    [],
    '设置某人的权限等级（0-4）',
    { authority: 4 },
    async ({ session }, target, level) => {
      if (!Number.isFinite(level) || level < 0 || level > 4) return '等级只能是 0-4 的整数。'
      const id = String(target ?? '').replace(/[^0-9]/g, '')
      if (!id) return '请给一个纯数字的 QQ 号。'
      const platform = session.platform ?? 'onebot'
      const db = ctx.get('database')
      if (!db) return '数据库服务还没就绪，稍后再试。'
      try {
        await db.setUser(platform, id, { authority: level })
      } catch (e) {
        // setUser 在库里没有绑定时会抛 "user not found"（core:577-581）
        if (!/not found/i.test(e.message)) throw e
        await db.createUser(platform, id, { authority: level })
        logger.info('%s 库里还没有记录，已新建', id)
      }
      logger.info('%s 把 %s 的等级设为 %s', session.userId, id, level)
      return `已把 ${id} 的权限等级设为 ${level}（${LEVEL_NAMES[level] ?? '未知'}）。`
    }
  )

  // 重扫：/qqbot.auth.rescan
  define('qqbot.auth.rescan', [], '手动重扫并应用提权规则', { authority: 4 }, async () => {
    scanOnce('手动')
    return '已重扫，明细见日志。'
  })

  // 帮助：★ 2026-10-03 起**不再由本插件提供** —— 整块搬去了 koishi-plugin-chatluna-help
  // （现场枚举全部指令、按类目分级出图）。这里原来那条 `qqbot.help` + `help` 别名已删除，
  // 否则会和框架的 `@koishijs/plugin-help`（也注册 `help`）抢同一个名字。

  // 回声（调试用）：/qqbot.echo <内容>
  define(
    'qqbot.echo <message:text>',
    [],
    '把话原样说回来',
    GROUP,
    async ({ session }, message) => {
      // text 类型在 Koishi 里会被解析成 h 元素数组，直接返回会变成 [object Object]，
      // 所以优先取原始内容，退回时再从元素里抠文本。
      if (typeof message === 'string' && message) return message
      const raw = session?.stripped?.content ?? ''
      const cut = raw.indexOf(' ')
      return cut >= 0 ? raw.slice(cut + 1) : '(没给内容)'
    }
  )

  logger.info(
    '权限分级已挂载：主人 %d / 管理员 %d / 信任 %d / 拉黑 %d；危险指令提权 %s；启动后持续重扫 %d 秒',
    set(cfg.ownerIds).size,
    set(cfg.adminIds).size,
    set(cfg.trustedIds).size,
    set(cfg.blockedIds).size,
    cfg.raiseDangerousCommands ? '开' : '关',
    cfg.scanSeconds
  )

  // 自检：命令解析是这一块最容易出错的地方（斜杠写法、整条别名、参数声明都踩过），
  // 所以启动后主动验一遍所有触发名，出问题在日志里一眼能看到。
  ctx.on('ready', () => {
    setTimeout(() => {
      const names = [
        'qqbot.auth',
        'qqbot.auth.me',
        'qqbot.auth.list',
        'qqbot.auth.set',
        'qqbot.auth.rescan',
        'qqbot.echo',
      ]
      const bad = names.filter((n) => !ctx.$commander?.get?.(n))
      if (bad.length) {
        logger.warn('触发名自检：这些名字解析不到 → %s', bad.join(' / '))
      } else {
        logger.info('触发名自检通过：%d 个触发名全部可用', names.length)
      }
    }, 8000)
  })
}
