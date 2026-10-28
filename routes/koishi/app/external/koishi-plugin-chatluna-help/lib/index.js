/**
 * koishi-plugin-chatluna-help —— 指令帮助体系（三级图片）
 *
 * 需求（用户原话，2026-10-03）：
 *   「我私聊过 bot，可以看到命令主要以文字形式返回，而且不好看……目前的命令似乎不是
 *     完整的命令，补全一下并按类型逐级展示」
 *
 * ★ 为什么必须重写而不是改文案
 *   原来 `/help` 打印的是 `qqbot-auth` 里**手写的 8 行字**，只覆盖 `qqbot.*`。
 *   而运行期指令表实际有 **135 条**（含 ChatLuna / 表情包 / 好感度 / 记忆 …）。
 *   手写清单必然越写越旧，所以这里**不在代码里列指令** —— 一律从
 *   `ctx.$commander._commandList` 现场枚举。装一个新插件，帮助页自动多出它的指令。
 *
 * ★ 四级结构（用户要的「按类型逐级展示」+ 2026-10-03 要的「别名抽象层」）
 *   ① `/help`              → 常用页：**只列别名**（英文单词），来自 chatluna-alias
 *   ② `/help -all`         → 总览：全部原始指令有哪些类目、各多少条、我能不能用
 *   ③ `/help <类目>`       → 类目页：这一类里每条指令一行，分页
 *   ④ `/help <指令|别名>`  → 详情页：用法、参数、选项、等级、原名与别名的对应
 *   每一页底部都写着「下一步发什么」，这样用户不用记语法。
 *
 *   ★ 为什么首页要换成别名层（用户原话）
 *     「现在的命令列表的命令有前缀，有的甚至使用的发 "xingyuan" 这个过时的名称前缀……
 *      只有那些可能经常用到的命令才列出来；只显示别名（英文，一个单词，不重复）」。
 *     147 条里绝大多数是诊断/运维指令，一次性用完就再也不敲；首页全列出来等于没重点。
 *     别名表在 chatluna-alias 里维护（一处配置），这边只负责**读它、画它**；
 *     读不到服务就退回原来的全量总览 —— 少装一个插件也不会开天窗。
 *
 * ★★ 2026-10-09 第十八轮：四件事（用户原话）
 *   「① /help 命令根据使用者显示可用的命令，而不是显示全部；
 *     ② /help 动态显示所有的有别名的命令（我在 koishi 中为命令添加别名后这里也能动态更新）；
 *     ③ koishi 命令管理那里需要能够管理别名和用途文本；
 *     ④ 权限的文本也需要使用 /help 中显示的这几个文本，数字太不直观了」
 *
 *   ① 按使用者过滤：命令级的 `showUnavailable` 是**总闸**，但每条命令还有 `-u` 覆盖
 *      （`/help -u` 临时把"用不了的也列出来"打开）。过滤是**所有页面都做**：
 *      首页别名层、类目页、详情页的"同类别"提示、以及数字口径（"你能用 N 个"）。
 *      ★ 判据用 `authorityOf(session)`，`session.user` 没挂上时按 Koishi 自己的语义
 *        （`!user || user.authority >= +value`，core:2127）——**没有 user 就等于放行**，
 *        所以退回 4（主人），绝不把"拿不到 session"显示成"你什么都没有"。
 *
 *   ② 别名动态化：别名有两个来源，**都以运行期指令表为准**：
 *        · `chatluna-alias` 的配置表（只读它注册成功的那部分）；
 *        · `Command._aliases` 的**实时键集**（谁在哪儿 `cmd.alias('x')` 都能看见，
 *          装个新插件、改一行配置、管理命令里加一个，刷新一次这一页就变了）。
 *      这里**不缓存别名表**：`aliasIndex()` 每次渲染现场算，和 `catalogue()` 同源。
 *
 *   ③ 命令管理：`/cmdadmin`（别名 `cman`）—— list / alias / aliases / desc / level / preview。
 *      ★ 为什么不去改 `koishi.yml`：改文件要重启，而用户在群里敲一条命令就该看到结果。
 *        所以覆盖层落在**数据库**里（`chatluna_cmd_overlay` / `chatluna_cmd_alias_extra`），
 *        启动 2.5 秒后装载，运行期改了立刻生效（`command-updated` 会冒泡给所有插件）。
 *      ★ 仍然**兼容**：`koishi.yml` 里的配置永远是最底层，数据库覆盖层只在有行时压上去，
 *        删掉行 = 回到配置。这样"活动一过就恢复原样"是一条 DELETE，不用去翻 yml。
 *
 *   ④ 权限文本：`LEVEL_NAMES` 是**唯一一份**等级文本（与 qqbot-auth 的 LEVEL_NAMES 同源），
 *      等级徽章、详情页、/cmdadmin 的列表与提示、`/cmdadmin level` 的入参**全用它**。
 *      `levelLabel(n)` = `信任`，`levelText(n)` = `信任（2）` —— 后者只用在需要点明数字的地方
 *      （管理命令的确认回执、`/cmdadmin level` 的用法），面向普通用户的页面只给文本。
 *
 * ★ 等级怎么算（别只读自己的）
 *   一个指令的**有效门槛 = 它自己与所有祖先指令上 `authority:N` 的最大值**
 *   （`@koishijs/core` 判定时整条链都要过）。所以这里沿 `cmd.parent` 往上取最大，
 *   和 `qqbot-auth` 的 `effectiveLevel()` 是同一套算法 —— 那边管**提权**，这边管**展示**，
 *   两边必须同源，否则帮助页会显示错的等级。
 *
 * ★ 注册名用 `help`，并**要求关掉 `@koishijs/plugin-help`**
 *   实测框架那个 help 插件会注册 `ctx.command("help [command:string]", {authority:0})`
 *   （`@koishijs/plugin-help/lib/index.js:129`）。两个 help 撞在一起时，命令的多个 action
 *   是**按顺序取第一个非空返回**，所以谁先谁生效 —— 留着它我们这个 action 可能永远不执行。
 *   已在 `koishi.yml` 里摘掉 `help:`，并在启动时自检 `help` 到底解析到谁。
 *
 * ★ 管理命令为什么叫 `cmdadmin` 而不是 `help.admin`
 *   `ctx.command('help [target:string]')` 里的 `[target:string]` 是**贪婪**的
 *   （core:1332 给 string 域加了 `greedy:true`）。父指令 `help` 已经能把 `/help admin`
 *   整条吃掉，`help.admin` 与它同名前缀，解析优先级由 Commander 内部顺序决定 ——
 *   赌这个顺序不值得。另起一个不会撞车的根名最稳（`cmdadmin` / `cman`）。
 */

const { Schema, Logger } = require('koishi')

const name = 'chatluna-help'
const inject = { required: [], optional: ['chatlunaPage', 'qqbotGuard', 'chatlunaAlias', 'database'] }
const logger = new Logger('help')

/** 五级权限的展示名（★ 与 qqbot-auth 的 LEVEL_NAMES 保持一致，那边是权威定义） */
const LEVEL_NAMES = { 0: '拉黑', 1: '普通', 2: '信任', 3: '管理员', 4: '主人' }
/** 没声明 authority 的指令走 Koishi 的默认值（Schema.natural().default(1)） */
const DEFAULT_LEVEL = 1
/** 覆盖层最大等级（与 qqbot-auth 的五级模型一致） */
const LEVEL_MIN = 0
const LEVEL_MAX = 4
/** 覆盖层的固定映射名：给"整套文本替换"留的口子，将来要改文案不用改代码 */
const OVERLAY_MAP = 'help.texts'

const OVERLAY_TABLE = 'chatluna_cmd_overlay'
const EXTRA_ALIAS_TABLE = 'chatluna_cmd_alias_extra'

const DEFAULT_CATEGORIES = [
  { id: 'auth', name: '权限与身份', prefixes: ['qqbot'] },
  { id: 'memory', name: '长期记忆', prefixes: ['chatluna.memory', 'chatluna_long_memory'] },
  // ★ affinity 的指令根是**它配置里的 scopeId**，不是插件名 —— 它拿 scopeId 当命名空间
  //   （koishi.yml: `chatluna-affinity.scopeId: affinity`）。
  //   2026-10-04 之前那个 scopeId 叫 `xingyuan`（小号的旧名"星源"），按用户要求换成了
  //   功能性名字 `affinity`；这里连同下面 alias 的 target 一起改，别只改一半。
  { id: 'affinity', name: '好感度', prefixes: ['affinity'] },
  { id: 'chat', name: '对话与模型', prefixes: ['chatluna'] },
  { id: 'media', name: '表情包与图片', prefixes: ['sticker', 'vision', 'emojiluna'] },
  { id: 'emotion', name: '情绪与人格', prefixes: ['emotion'] },
  { id: 'guard', name: '群管理与限流', prefixes: ['guard'] },
  { id: 'interact', name: '互动与剧情', prefixes: ['scene', 'proactive', 'followup', 'focus', 'episode'] },
  // ★ 第九轮（2026-10-04）：人设卡片（chatluna-persona）与作息表（chatluna-routine）。
  //   这两类原来会掉进「其他」，而它们恰好是主人最常要看的两块状态（"我是谁"、"现在几点在干嘛"）。
  { id: 'persona', name: '人设与作息', prefixes: ['persona', 'routine'] },
  {
    id: 'ext',
    name: '扩展与运维',
    // ★ `assign` / `authorize` / `user` / `channel` 来自 @koishijs/plugin-admin；
    //   `replyshaper` 是自研的回复整形。生产 143 条指令里有 7 条原本落进「其他」，
    //   就是这几个（rig 只有 124 条所以没暴露出来）。
    //   `cmdadmin` 是本轮新增的管理命令（2026-10-09）。
    prefixes: [
      'selfext',
      'render',
      'page',
      'localemb',
      'cmdname',
      'cmdadmin',
      'admin',
      'command',
      'status',
      'plugin',
      'assign',
      'authorize',
      'user',
      'channel',
      'replyshaper',
      'replystyle',
    ],
  },
  { id: 'basic', name: '基础指令', prefixes: ['help', 'echo', 'think'] },
]

const Config = Schema.intersect([
  Schema.object({
    enabled: Schema.boolean().default(true).description('总开关。关掉后回退到一行纯文字提示'),
    pageSize: Schema.natural().default(18).description('类目页每页几条指令。★ 直接决定图片高度与体积：18 条约 330 KB'),
    showUnavailable: Schema.boolean()
      .default(false)
      .description(
        '显示自己等级不够用的指令（灰掉并标注等级）。' +
          '★ 2026-10-09 起**默认关**：用户要的是「/help 根据使用者显示可用的命令，而不是显示全部」。' +
          '临时想看全的：`/help -u`'
      ),
    showHidden: Schema.boolean().default(false).description('连标记为 hidden 的指令也列出来'),
    textFallback: Schema.boolean().default(true).description('出图不可用时回退成文字清单'),
  }),
  Schema.object({
    categories: Schema.array(
      Schema.object({
        id: Schema.string().description('ASCII 代号，`/help <代号>` 用它'),
        name: Schema.string().description('显示名'),
        prefixes: Schema.array(String).description('指令名前缀，匹配时**最长前缀优先**'),
      })
    )
      .role('table')
      .default(DEFAULT_CATEGORIES)
      .description('类目规则。没匹配上的进「其他」。改完不用重启缓存会自己失效（按内容哈希）'),
  }),
  Schema.object({
    managedAliases: Schema.boolean()
      .default(true)
      .description(
        '把覆盖层里新增的别名真的挂到指令上（`/cmdadmin alias` 加完立刻能敲）。' +
          '关掉后 `/cmdadmin alias` 只改帮助页的显示，不改变指令解析'
      ),
    adminKeepText: Schema.boolean()
      .default(true)
      .description('`/cmdadmin` 的输出**永远走文字**，不出图（列表要能复制指令名，图片没法抄）'),
    debug: Schema.boolean().default(false).description('打印指令表扫描明细'),
  }),
  Schema.object({
    unknownHint: Schema.boolean().default(true).description(
      '★ 敲了不存在的指令时，回一句"没有这个指令 + 你是不是想看哪个类目"，而不是让模型接话。' +
        '2026-10-03 实测：用户看到总览表里写着 `ext` 就发了 `/ext`，' +
        '结果那条既不是指令、也没人管，直接漏给 ChatLuna，模型回了句' +
        '「这命令不是给我的吧，群里就我们俩」——用户以为"命令没效果"。'
    ),
    unknownHintInGroup: Schema.boolean().default(true).description(
      '群聊里是否也回这句。关掉则只在私聊提示（群里少刷屏）'
    ),
  }),
])

function apply(ctx, config) {
  const cfg = {
    enabled: true,
    pageSize: 18,
    showUnavailable: false,
    showHidden: false,
    textFallback: true,
    categories: DEFAULT_CATEGORIES,
    managedAliases: true,
    adminKeepText: true,
    unknownHint: true,
    unknownHintInGroup: true,
    debug: false,
    ...(config ?? {}),
  }

  const log = (...a) => cfg.debug && logger.info(...a)

  /** 类目规则：按前缀长度从长到短，保证 `chatluna.memory` 先于 `chatluna` 命中 */
  function rules() {
    const list = Array.isArray(cfg.categories) && cfg.categories.length ? cfg.categories : DEFAULT_CATEGORIES
    return list.map((c) => ({
      id: String(c.id || '').trim() || 'other',
      name: String(c.name || c.id || '其他'),
      prefixes: (Array.isArray(c.prefixes) ? c.prefixes : []).map(String).filter(Boolean),
    }))
  }

  function categoryOf(cmdName) {
    const n = String(cmdName)
    let best = null
    for (const r of rules()) {
      for (const p of r.prefixes) {
        // 前缀要么就是它本身，要么后面跟一个点（避免 `chatlunaX` 命中 `chatluna`）
        if (n === p || n.startsWith(p + '.')) {
          if (!best || p.length > best.len) best = { r, len: p.length }
        }
      }
    }
    return best ? best.r : { id: 'other', name: '其他', prefixes: [] }
  }

  // ------------------------------------------------------------------ 等级文本
  //
  // ★ 2026-10-09 用户原话：「权限的文本也需要使用 /help 中显示的这几个文本，数字太不直观了」。
  //   所以这里出两个函数，语义分清：
  //     levelLabel(n) → `信任`        （面向用户的页面只给这个）
  //     levelText(n)  → `信任（2）`   （需要同时点明数字的地方：管理命令的回执/用法）
  //   等级名唯一来源是 LEVEL_NAMES，改文案只改那一处。

  function levelLabel(n) {
    const v = Number(n)
    return LEVEL_NAMES[v] ?? '未知'
  }

  function levelText(n) {
    const v = Number(n)
    return `${levelLabel(v)}（${Number.isFinite(v) ? v : '?'}）`
  }

  /** 把用户敲的等级参数解析成 0-4：认数字，也认中文/英文名（`信任`、`trust`） */
  const LEVEL_ALIASES = {
    trust: 2,
    trusted: 2,
    admin: 3,
    owner: 4,
    master: 4,
    normal: 1,
    block: 0,
    blocked: 0,
    ban: 0,
  }

  function parseLevel(raw) {
    const s = String(raw ?? '').trim()
    if (!s) return null
    if (/^\d+$/.test(s)) {
      const n = Number(s)
      return n >= LEVEL_MIN && n <= LEVEL_MAX ? n : null
    }
    const low = s.toLowerCase()
    if (LEVEL_ALIASES[low] != null) return LEVEL_ALIASES[low]
    for (const [k, v] of Object.entries(LEVEL_NAMES)) if (String(v) === s) return Number(k)
    return null
  }

  /** 等级说明（管理命令用）：`0 拉黑 / 1 普通 / 2 信任 …` */
  const LEVEL_MENU = Object.keys(LEVEL_NAMES)
    .map(Number)
    .sort((a, b) => a - b)
    .map((n) => `\`${n}\`=${LEVEL_NAMES[n]}`)
    .join('　·　')

  // ------------------------------------------------------------------ 目录

  function commander() {
    const c = ctx.$commander || ctx.root?.$commander
    return c && Array.isArray(c._commandList) ? c : null
  }

  /** 有效等级：自己 + 所有祖先上的 authority 取最大 */
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

  /**
   * 取一条本地化文案。
   *
   * ★ 为什么不能用 `cmd.toJSON().description`
   *   实测（rig 40-help-pages，2026-10-03）：**124 条指令的 description 全是
   *   `[object Object]`**。根因在 Koishi 的 i18n：
   *     `I18n.get(key, locales)` 返回的是 **locale → 文案 的映射对象**，不是字符串
   *     （@koishijs/core/lib/index.cjs:1648-1655，`const result = {}; … result[locale] = …`）
   *   而 `Command.toJSON()` 正是用 `ctx.i18n.get(...)` 填 description 的（同文件 1125 行）。
   *   框架自己的 help 插件也绕开了 toJSON，改用 `session.text(['commands.X.description',''])`
   *   渲染（plugin-help/lib/index.js:170）。
   *
   *   这里照做，但**不用 session** —— 用 `ctx.i18n.render([], [path, ''], params)`，好处是
   *   结果与「谁在问」无关（启动自检时没有 session 也能拿到文案）。
   *   第二段路径 `''` 是兜底：文案缺失时返回空串而**不会**打一条 `missing` 警告，
   *   否则 124 条里只要有一条没写说明，日志就会被刷屏。
   */
  function t(path, params) {
    try {
      return ctx.i18n.render([], [path, ''], params ?? {}).join('')
    } catch {
      return ''
    }
  }

  function argDesc(name, arg) {
    return {
      name: arg.name,
      type: typeof arg.type === 'string' ? arg.type : 'string',
      required: !!arg.required,
      description: t(`commands.${name}.arguments.${arg.name}`),
    }
  }

  function optDesc(name, oname, opt) {
    return {
      name: oname,
      type: typeof opt.type === 'string' ? opt.type : 'string',
      description: t(`commands.${name}.options.${oname}`),
      hidden: !!opt.hidden,
    }
  }

  function usageOf(cmd, args, options) {
    const parts = [`/${cmd.displayName || cmd.name}`]
    for (const a of args) {
      parts.push(a.required ? `<${a.name}:${a.type}>` : `[${a.name}:${a.type}]`)
    }
    if (options.length) parts.push('[选项]')
    return parts.join(' ')
  }

  // ------------------------------------------------------------------ 覆盖层
  //
  // 数据库里两张表：
  //   chatluna_cmd_overlay(userId, command, note, level)      —— 用途文本 / 等级门槛
  //   chatluna_cmd_alias_extra(userId, target, alias, enabled) —— 额外别名（可停用）
  //
  // ★ userId = '\*' 的固定映射（OVERLAY_MAP）专门放"整套文本"，
  //   不参与指令查询，免得和真指令重名。

  const overlay = {
    /** command(lowercase) → { note, level }；null level = 没覆盖门槛 */
    byCmd: new Map(),
    /** target(lowercase) → [{ alias, enabled }] */
    aliases: new Map(),
    /** 所有运行时挂上去的别名：alias(lowercase) → Command */
    applied: new Map(),
    loaded: false,
    error: null,
  }

  /**
   * ★ 这里要的是**数据库服务本体**（`ctx.database`），不是 `ctx.get('database')`：
   *   `db.get(table, query)` / `db.create(...)` / `db.set(...)` 是数据库服务上的方法，
   *   而 `ctx.get()` 在没声明 inject 时会打一条 "property database is not registered" 警告
   *   （rig 67 第三轮实测就刷了这条）。inject.optional 里已经声明，这里直接用属性。
   *   两台实例（生产 db=koishi.db / 测试台 db=test.db）都从这里走。
   */
  function db() {
    return ctx.database ?? null
  }

  const low = (s) => String(s ?? '').trim().toLowerCase()

  async function loadOverlay() {
    const m = db()
    if (!m) {
      overlay.loaded = true
      return
    }
    try {
      const rows = await m.get(OVERLAY_TABLE, { userId: { $ne: null } })
      overlay.byCmd.clear()
      for (const r of rows ?? []) {
        const cmd = low(r.command)
        if (!cmd) continue
        overlay.byCmd.set(cmd, {
          note: r.note == null || r.note === '' ? null : String(r.note),
          level: r.level == null ? null : Number(r.level),
          userId: r.userId,
        })
      }
      const extras = await m.get(EXTRA_ALIAS_TABLE, { userId: { $ne: null } })
      overlay.aliases.clear()
      for (const r of extras ?? []) {
        const tgt = low(r.target)
        const al = low(r.alias)
        if (!tgt || !al) continue
        if (!overlay.aliases.has(tgt)) overlay.aliases.set(tgt, [])
        overlay.aliases.get(tgt).push({ alias: al, enabled: r.enabled !== false && r.enabled !== 0 })
      }
      overlay.loaded = true
      overlay.error = null
      log('覆盖层已装载：用途/等级 %d 条，额外别名 %d 条', overlay.byCmd.size, [...overlay.aliases.values()].reduce((n, l) => n + l.length, 0))
    } catch (e) {
      overlay.error = e.message
      logger.warn('读取命令覆盖层失败（这次先用 koishi.yml 的原样）：%s', e.message)
    }
  }

  /** 用途文本：覆盖层优先，其次 i18n */
  function noteOf(cmd) {
    return overlay.byCmd.get(low(cmd))?.note ?? null
  }

  function descriptionOf(cmd) {
    return noteOf(cmd.name) ?? t(`commands.${cmd.name}.description`)
  }

  /** 覆盖层里的等级覆盖（null = 没覆盖） */
  function levelOverride(cmdName) {
    const v = overlay.byCmd.get(low(cmdName))?.level
    return v == null ? null : v
  }

  /** 展示用等级 = 覆盖层 > 现场 authority */
  function displayLevel(cmd) {
    const ov = levelOverride(cmd.name)
    return ov == null ? effectiveLevel(cmd) ?? DEFAULT_LEVEL : ov
  }

  /**
   * 覆盖层写入的唯一入口。
   *
   * ★ 为什么要合成一个：用途和等级**共用一行**（`(userId, command)` 复合主键），
   *   各写各的很容易把对方抹掉。这里统一成"把这一行改成什么样"，
   *   两个都为空就**删行** —— 保持"库里有行 = 有覆盖"，不留空壳让人误以为改过。
   */
  async function writeOverlay(cmdName, patch) {
    const m = db()
    if (!m) throw new Error('数据库服务没就绪')
    const userId = OVERLAY_MAP
    const command = low(cmdName)
    const cur = overlay.byCmd.get(command)
    const note = patch.note === undefined ? cur?.note ?? null : patch.note
    const level = patch.level === undefined ? cur?.level ?? null : patch.level
    const key = { userId, command }
    const rows = await m.get(OVERLAY_TABLE, key)

    if (note == null && level == null) {
      overlay.byCmd.delete(command)
      if (rows?.length) await m.remove(OVERLAY_TABLE, key)
      return
    }
    const payload = { command, note, level }
    if (rows?.length) {
      // ★ minato 的 `set()` 会检查 "update 里有没有主键列"，有就抛 `cannot modify primary key`
      //   （minato/lib/index.cjs:1289-1292）。所以更新对象里**只能放非主键列**。
      await m.set(OVERLAY_TABLE, key, { note, level })
    } else {
      await m.create(OVERLAY_TABLE, { userId, ...payload })
    }
    overlay.byCmd.set(command, { note, level, userId })
  }

  const setOverlayNote = (cmdName, note) => writeOverlay(cmdName, { note })

  const setOverlayLevel = (cmdName, level) => writeOverlay(cmdName, { level })

  async function setExtraAlias(target, alias, enabled) {
    const m = db()
    if (!m) throw new Error('数据库服务没就绪')
    const userId = OVERLAY_MAP
    const rows = await m.get(EXTRA_ALIAS_TABLE, { userId, target: low(target), alias: low(alias) })
    // ★ 同上：`set()` 的更新对象里不能带主键列（userId/target/alias 全是主键），只更新 enabled
    if (rows?.length) await m.set(EXTRA_ALIAS_TABLE, { userId, target: low(target), alias: low(alias) }, { enabled: !!enabled })
    else await m.create(EXTRA_ALIAS_TABLE, { userId, target: low(target), alias: low(alias), enabled: !!enabled })

    const list = overlay.aliases.get(low(target)) ?? []
    const hit = list.find((x) => x.alias === low(alias))
    if (hit) hit.enabled = !!enabled
    else list.push({ alias: low(alias), enabled: !!enabled })
    overlay.aliases.set(low(target), list)
  }

  /**
   * 把覆盖层里"启用着的"额外别名挂到指令上。
   *
   * ★ 冲突就不挂（`_registerAlias` 会直接抛 `duplicate command names`，core:934-940），
   *   只 warn —— 一条配错的别名绝不该把帮助页带崩。
   * ★ 已经挂过的**不重复挂**：`_registerAlias` 对"同一条指令的同一个别名"是空操作，
   *   但每次重刷都调一遍也是白花时间，而且日志会刷屏。
   */
  function applyManagedAliases() {
    if (!cfg.managedAliases) return []
    const cmdr = commander()
    if (!cmdr) return []
    const problems = []
    for (const [target, list] of overlay.aliases) {
      const cmd = cmdr.get(target)
      if (!cmd) {
        const on = list.filter((x) => x.enabled).map((x) => x.alias)
        if (on.length) problems.push(`${on.join('/')} → ${target}（没有这条指令）`)
        continue
      }
      for (const { alias, enabled } of list) {
        if (!enabled) continue
        if (alias === low(cmd.name) || cmd._aliases?.[alias]) {
          overlay.applied.set(alias, cmd)
          continue
        }
        const owner = cmdr.get(alias)
        if (owner && owner !== cmd) {
          problems.push(`${alias}（已被 ${owner.name} 占用）`)
          continue
        }
        try {
          cmd.alias(alias)
          overlay.applied.set(alias, cmd)
        } catch (e) {
          problems.push(`${alias}（${e.message}）`)
        }
      }
    }
    return problems
  }

  function applyOverlayToCommands() {
    const cmdr = commander()
    if (!cmdr) return []
    const problems = []
    for (const [cmdName, ov] of overlay.byCmd) {
      if (ov.level == null) continue
      const cmd = cmdr.get(cmdName)
      if (!cmd) {
        problems.push(`等级覆盖 ${cmdName} → 没有这条指令`)
        continue
      }
      if (cmd.config.permissions?.length === 1 && cmd.config.permissions[0] === `authority:${ov.level}`) continue
      cmd.config.permissions = [`authority:${ov.level}`]
      ctx.emit('command-updated', cmd)
    }
    return problems
  }

  // ------------------------------------------------------------------ 别名索引
  //
  // ★★ 2026-10-09：别名一律**现场从运行期指令表读**，不再依赖任何静态表。
  //   来源三个，合并成同一条"这条指令有哪些别名"：
  //     ① `Command._aliases` 的实时键集 —— 谁在哪儿 `.alias('x')` 都能看见；
  //     ② chatluna-alias 的配置表（它注册成功的那些，带 note）；
  //     ③ 覆盖层里额外挂的（带 enabled 开关）。
  //   `aliasIndex()` 每次渲染现算，所以"在 koishi 里给命令加个别名 → /help 立刻多一条"。

  function aliasIndex() {
    const cmdr = commander()
    const out = new Map() // cmdName → { primary, extras:[], live:[], notes:Map }
    if (!cmdr) return out

    const ensure = (name) => {
      const key = String(name)
      if (!out.has(key)) out.set(key, { primary: null, extras: [], live: [], notes: new Map() })
      return out.get(key)
    }

    // ① 运行期别名（第一个键是主名 = displayName，别把它当别名）
    for (const cmd of cmdr._commandList) {
      if (!cmd || typeof cmd.name !== 'string' || !cmd.name) continue
      const keys = Object.keys(cmd._aliases ?? {})
      const e = ensure(cmd.name)
      e.primary = String(cmd.displayName || cmd.name)
      for (let i = 1; i < keys.length; i++) e.live.push(keys[i])
    }

    // ② chatluna-alias 的配置表（只收注册成功的）
    for (const it of aliasEntries()) {
      const cmd = cmdr.get(it.target)
      if (!cmd) continue
      const e = ensure(cmd.name)
      if (!e.live.includes(it.alias) && it.alias !== low(cmd.name)) e.live.push(it.alias)
      if (it.note) e.notes.set(it.alias, it.note)
    }

    // ③ 覆盖层
    for (const [target, list] of overlay.aliases) {
      const cmd = cmdr.get(target)
      if (!cmd) continue
      const e = ensure(cmd.name)
      for (const { alias, enabled } of list) {
        if (!enabled) continue
        if (!e.live.includes(alias)) e.live.push(alias)
        e.extras.push(alias)
      }
    }
    return out
  }

  /**
   * 读 chatluna-alias 的别名表。
   *
   * ★ 拿不到服务就返回空表 —— 调用方（首页）据此退回全量总览。
   *   两个插件是各自独立的：alias 没装/没启用时，/help 不该开天窗。
   * ★ 只收注册成功的条目：帮助页里出现一条敲不出来的别名，比不出现更糟。
   */
  function aliasEntries() {
    try {
      const list = ctx.get('chatlunaAlias')?.entries?.()
      return Array.isArray(list) ? list.filter((e) => e && e.alias && e.ok !== false) : []
    } catch {
      return []
    }
  }

  const esc = (s) =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
  /** 表格里的说明文字：竖线会破坏表格，换行会破坏行 */
  const cell = (s) => esc(String(s ?? '').replace(/\|/g, '｜').replace(/\s*\n\s*/g, ' ')).trim()

  /**
   * 现场枚举整张指令表 → 规范化条目。**不缓存成静态清单**，因为插件是异步挂载的。
   * ★ `mine` 传进来就地算"我能不能用"（`usable`），过滤交给各页面 —— 因为
   *   "显示不可用"这件事既可能来自配置，也可能来自一次 `/help -u`。
   */
  function catalogue(mine) {
    const cmdr = commander()
    if (!cmdr) return []
    const idx = aliasIndex()
    const out = []
    const seen = new Set()
    for (const cmd of cmdr._commandList) {
      if (!cmd || typeof cmd.name !== 'string' || !cmd.name) continue
      if (seen.has(cmd.name)) continue
      seen.add(cmd.name)
      if (!cfg.showHidden && cmd.config?.hidden) continue

      const args = (cmd._arguments ?? []).map((a) => argDesc(cmd.name, a))
      const options = Object.entries(cmd._options ?? {})
        .map(([oname, o]) => optDesc(cmd.name, oname, o))
        .filter((o) => !o.hidden)

      const e = idx.get(cmd.name)
      const display = e?.primary || cmd.displayName || cmd.name
      const aliases = (e?.live ?? []).filter((a) => a !== display && a !== String(cmd.name))
      const level = displayLevel(cmd)
      const description = descriptionOf(cmd)
      out.push({
        name: cmd.name,
        display,
        aliases,
        description,
        args,
        options,
        level,
        usable: mine == null ? true : level <= mine,
        overridden: overlay.byCmd.has(low(cmd.name)),
        usage: usageOf(cmd, args, options),
        category: categoryOf(cmd.name),
      })
    }
    out.sort((a, b) => a.name.localeCompare(b.name))
    return out
  }

  /** 按使用者过滤：能用的留下；不能用的在 `-u` 或配置打开时才留（灰掉） */
  function visible(list, mine, showAll) {
    if (showAll || cfg.showUnavailable) return list
    return list.filter((c) => c.usable)
  }

  const ALL_LEVELS = 4

  // ------------------------------------------------------------------ 四张页面

  /**
   * 首页：**只列别名**（用户要的那层抽象）。
   *
   * 返回 null = 拿不到别名表，调用方改画全量总览。
   *
   * ★ 用途那一列优先用**覆盖层**（用户自己写的用途文本），再退 alias 表的 note，
   *   最后才是指令自己的 i18n 说明 —— 有几条原始指令压根没写说明（`chatluna.stop` 就是），
   *   在别名表里补一句比在别人的插件里补 i18n 现实得多。
   * ★ 不显示原始指令名：用户明确要求「只显示别名」。
   *   要看原名映射：单条详情 /help <别名>，或者 /help -all 翻全量目录。
   */
  function shortcutPage(page, mine, showAll) {
    const all = catalogue(mine)
    const idx = aliasIndex()

    // 首页的每一行 = 一条**真实可敲的别名**（而不是 alias 表里的一行）：
    // 这样"在 koishi 里给命令加别名"→ 首页立刻多一行，一处配置都不用改。
    const items = []
    const seen = new Set()
    for (const c of all) {
      const e = idx.get(c.name)
      if (!e) continue
      const names = [...e.live]
      const hasAlias = names.some((n) => n !== String(c.name))
      if (!hasAlias) continue
      for (const al of names) {
        if (al === String(c.name) || seen.has(al)) continue
        seen.add(al)
        items.push({
          alias: al,
          target: c.name,
          note: overlay.byCmd.get(low(c.name))?.note || e.notes.get(al) || c.description || '（这条还没有写说明）',
          level: c.level,
          usable: c.usable,
        })
      }
    }
    if (!items.length) return null

    const shown = visible(items, mine, showAll)
    const pageSize = Math.max(Number(cfg.pageSize) || 18, 4)
    const pages = Math.max(Math.ceil(shown.length / pageSize), 1)
    const p = Math.min(Math.max(Number(page) || 1, 1), pages)
    const slice = shown.slice((p - 1) * pageSize, p * pageSize)
    const hiddenCount = items.length - shown.length

    const rows = slice.map((i) => {
      const off = i.usable ? '' : ' lv-off'
      return `| <span class="${off.trim() || 'x'}">\`/${esc(i.alias)}\`</span> | ${cell(i.note)} | ${levelBadge(i.level, mine)} |`
    })

    // ★ `-u` 也要作用在首页上：类目页留了"想看用不了的那些"的入口，首页不给就没路可走
    //   （用户可能压根不知道 `-all` 是什么）。这里只把**别名本身**再列出一次，
    //   不带用途，避免整页翻倍变长。
    const offRows = showAll
      ? []
      : items
          .filter((i) => !i.usable)
          .slice(0, 12)
          .map((i) => `\`/${esc(i.alias)}\`（${esc(levelLabel(i.level))}）`)

    const foot = [
      p < pages ? `下一页：<code>/help ${p + 1}</code>` : null,
      p > 1 ? `上一页：<code>/help ${p - 1}</code>` : null,
      `单条详情：<code>/help &lt;别名&gt;</code>`,
      hiddenCount > 0 ? `别名共 **${items.length}** 个，还有 **${hiddenCount}** 个你用不了：<code>/help -u</code>` : null,
      `全部 **${all.length}** 条原始指令：<code>/help -all</code>`,
    ]
      .filter(Boolean)
      .join('　·　')

    // ★ 口径要跟**显示的行数**一致：标题写"你能用的别名"就必须只数能用的。
    //   第一版这里写的是 `shown.length`，而 `shown` 在"配置了默认显示不可用"（showUnavailable=true）
    //   时是**全部**条目 —— 普通群友看到"共 61 个你能用的"、表格里却一堆用不了的。
    //   现在无论哪种开关，标题都只报真正能用的那几个。
    const usableCount = items.filter((i) => i.usable).length

    return [
      `# 大肥鱼 · 常用指令`,
      ``,
      `共 **${usableCount}** 个你能用的别名 · 第 **${p}/${pages}** 页 · 你的等级：${levelBadge(mine, mine)}`,
      ``,
      // ★ 2026-10-03 用户要求：「把那个『别名就是简写…』的这一段删掉，不需要在这个界面说明这些」
      //   —— 首页只为"有哪些能敲"服务，不讲机制。机制说明留在 docs/24 与 /help <别名> 的详情页。
      `| 别名 | 用途 | 等级 |`,
      `| --- | --- | --- |`,
      ...rows,
      ...(offRows.length
        ? [``, `**你用不了的别名**（等级不够，共 ${hiddenCount} 条，这里列前 ${offRows.length} 条）：`, ...offRows]
        : []),
      ``,
      `<div class="pg-foot">${foot}</div>`,
    ].join('\n')
  }

  function overviewPage(mine, showAll) {
    const all = catalogue(mine)
    if (!all.length) return '# 指令总览\n\n拿不到指令表（Commander 还没就绪）。稍后再试。'

    // 按规则顺序排类目，保证「其他」永远在最后
    const order = [...rules(), { id: 'other', name: '其他' }]
    const groups = new Map()
    for (const c of all) {
      const k = c.category.id
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k).push(c)
    }

    const rows = []
    let total = 0
    let usableTotal = 0
    for (const cat of order) {
      const list = groups.get(cat.id)
      if (!list || !list.length) continue
      const shown = visible(list, mine, showAll)
      const usable = list.filter((c) => c.usable).length
      total += shown.length
      usableTotal += usable
      if (!shown.length) continue
      const minLevel = list.reduce((m, c) => Math.min(m, c.level), ALL_LEVELS)
      rows.push(
        `| **${esc(cat.name)}** | \`/help ${esc(cat.id)}\` | ${shown.length} | ${usable} | ${levelBadge(minLevel, mine)} |`
      )
    }

    return [
      `# 大肥鱼 · 全部指令`,
      ``,
      `共 **${total}** 条指令在你能看的范围里（能真正用 **${usableTotal}** 条），分 **${rows.length}** 类。你的等级：${levelBadge(mine, mine)}`,
      ``,
      // ★ 「怎么看」这一列必须写出**完整的命令**，不能只写代号。
      //   2026-10-03 实测：用户看到表里写着 `ext`，就顺手发了 `/ext` ——
      //   那不是指令，于是被 ChatLuna 当成聊天接了（回了句"这命令不是给我的吧"）。
      //   写全 `/help ext` 就没有这个歧义了。
      `| 类目 | 怎么看 | 条数 | 你能用 | 最低等级 |`,
      `| --- | --- | --- | --- | --- |`,
      ...rows,
      ``,
      `<div class="pg-foot">发 <b>/help &lt;代号&gt;</b> 看某一类的全部指令（例：<code>/help chat</code>）<br>` +
        `发 <b>/help &lt;指令名或别名&gt;</b> 看单条详情（例：<code>/help model</code>）<br>` +
        `${showAll || cfg.showUnavailable ? '' : `想看自己等级不够的那些：<code>/help -u</code>　·　`}` +
        `只看常用的那几个：<code>/help</code>　·　不想看图：<code>/page.text on</code></div>`,
    ].join('\n')
  }

  function categoryPage(catId, page, mine, showAll) {
    const all = catalogue(mine)
    const cat = [...rules(), { id: 'other', name: '其他' }].find((c) => c.id === catId)
    const list = all.filter((c) => c.category.id === catId)
    if (!cat || !list.length) return null
    const idx = aliasIndex()

    const shown = visible(list, mine, showAll)
    const pageSize = Math.max(Number(cfg.pageSize) || 18, 4)
    const pages = Math.max(Math.ceil(shown.length / pageSize), 1)
    const p = Math.min(Math.max(Number(page) || 1, 1), pages)
    const slice = shown.slice((p - 1) * pageSize, p * pageSize)
    const usable = list.filter((c) => c.usable).length
    const hiddenCount = list.length - shown.length

    // 只留"真的能敲的"别名；一个指令可能挂了好几个，全列出来
    const aliasListOf = (c) => (idx.get(c.name)?.live ?? []).filter((a) => a !== String(c.name))

    const rows = slice.map((c) => {
      const off = c.usable ? '' : ' lv-off'
      // ★ 有别名就把别名摆在前面：这是用户日常真正会敲的那个名字。
      //   原始名不删，缩小一档跟在后面 —— 老习惯发全名照样能用，两边的对应关系也一眼可见。
      const als = aliasListOf(c)
      const label = als.length
        ? `${als.map((a) => `\`/${esc(a)}\``).join(' ')} <span class="pg-sub">${esc(c.display)}</span>`
        : `\`${esc(c.display)}\``
      return `| <span class="${off.trim() || 'x'}">${label}</span> | ${cell(c.description) || '（无说明）'} | ${levelBadge(c.level, mine)} |`
    })

    const foot = [
      p < pages ? `下一页：<code>/help ${esc(catId)} ${p + 1}</code>` : null,
      p > 1 ? `上一页：<code>/help ${esc(catId)} ${p - 1}</code>` : null,
      hiddenCount > 0 ? `另有 ${hiddenCount} 条你用不了：<code>/help ${esc(catId)} -u</code>` : null,
      `回总览：<code>/help -all</code>；单条详情：<code>/help &lt;指令名&gt;</code>`,
    ]
      .filter(Boolean)
      .join('　·　')

    return [
      `# ${esc(cat.name)}`,
      ``,
      `你能用 **${shown.length}** 条（这一类共 ${list.length} 条，你能用 ${usable} 条） · 第 **${p}/${pages}** 页 · 你的等级：${levelBadge(mine, mine)}`,
      ``,
      `| 指令 | 说明 | 等级 |`,
      `| --- | --- | --- |`,
      ...rows,
      ``,
      `<div class="pg-foot">${foot}</div>`,
    ].join('\n')
  }

  function detailPage(entry, mine, askedAs) {
    const c = entry
    const idx = aliasIndex()
    const liveAliases = (idx.get(c.name)?.live ?? []).filter((a) => a !== String(c.name))
    const lines = [
      `# ${esc(c.display)}`,
      ``,
      c.description ? esc(c.description) : '（这条指令没有写说明）',
      ``,
      `| 项 | 值 |`,
      `| --- | --- |`,
      `| 等级 | ${levelText(c.level)}${c.usable ? '' : ' —— 你暂时用不了'} |`,
      `| 用法 | \`${esc(c.usage)}\` |`,
      `| 类目 | ${esc(c.category.name)} |`,
      `| 别名 | ${liveAliases.length ? liveAliases.map((a) => `\`/${esc(a)}\``).join(' ') : '（无）'} |`,
      `| 原名 | \`${esc(c.name)}\`${c.overridden ? '（用途/等级已被 `/cmdadmin` 覆盖）' : ''} |`,
    ]

    // ★ 用户是用别名（或不带前缀的写法）查过来的 → 明确写出"你敲的那个名字 = 这个名字"。
    //   用户要的就是"抽象层与原指令的映射"，映射关系必须在这里看得见，
    //   否则他没法确认 /model 到底改的是哪条指令。
    if (askedAs && askedAs !== c.name) {
      lines.splice(8, 0, `| 你敲的 | \`/${esc(askedAs)}\` 与它完全等价 |`)
    }

    if (c.args.length) {
      lines.push(``, `**参数**`, ``, `| 参数 | 类型 | 必填 | 说明 |`, `| --- | --- | --- | --- |`)
      for (const a of c.args) {
        lines.push(
          `| \`${esc(a.name)}\` | ${esc(a.type)} | ${a.required ? '是' : '否'} | ${cell(a.description) || '—'} |`
        )
      }
    }

    if (c.options.length) {
      lines.push(``, `**选项**`, ``, `| 选项 | 类型 | 说明 |`, `| --- | --- | --- |`)
      for (const o of c.options) {
        lines.push(`| \`-${esc(o.name)}\` | ${esc(o.type)} | ${cell(o.description) || '—'} |`)
      }
    }

    lines.push(
      ``,
      `<div class="pg-foot">直接发 <code>${esc(c.usage)}</code> 就能用。<br>` +
        `同一类别的其它指令：<code>/help ${esc(c.category.id)}</code>　·　回总览：<code>/help</code></div>`
    )
    return lines.join('\n')
  }

  // ------------------------------------------------------------------ 查找

  /** 目标可能是：类目代号 / 类目中文名 / 指令名 / 指令别名（大小写不敏感） */
  function resolveTarget(raw, mine) {
    const t = String(raw ?? '').trim()
    if (!t) return { kind: 'overview' }
    const lowT = t.toLowerCase()

    const cat = [...rules(), { id: 'other', name: '其他' }].find(
      (c) => c.id.toLowerCase() === lowT || String(c.name).toLowerCase() === lowT
    )
    if (cat) return { kind: 'category', catId: cat.id }

    const all = catalogue(mine)
    const byName = all.find((c) => c.name.toLowerCase() === lowT)
    if (byName) return { kind: 'command', entry: byName, via: null }

    const byDisplay = all.find((c) => String(c.display).toLowerCase() === lowT)
    if (byDisplay) return { kind: 'command', entry: byDisplay, via: lowT }

    // ★ 别名（`/help model`）也要查得到 —— 这是首页列出来的名字，
    //   用户照着首页敲进来却"找不到"是最不能接受的失败。
    const byAlias = all.find((c) => c.aliases.some((a) => a.toLowerCase() === lowT))
    if (byAlias) return { kind: 'command', entry: byAlias, via: lowT }

    // 没命中：给几个像的，别让用户对着「找不到」发呆
    const near = all
      .filter((c) => c.name.toLowerCase().includes(lowT) || lowT.includes(c.name.toLowerCase()))
      .slice(0, 6)
      .map((c) => c.display)
    return { kind: 'miss', target: t, near }
  }

  /** 等级徽章：★ 只给文本（用户要的"数字太不直观"），数字只在详情页的 `levelText` 里出现 */
  function levelBadge(level, mine) {
    const off = mine != null && level > mine ? ' lv-off' : ''
    return `<span class="lv lv${level}${off}">${esc(levelLabel(level))}</span>`
  }

  // ------------------------------------------------------------------ /help

  ctx
    .command('help [target:string]', '常用指令 / 分类 / 单条详情（出图）', { authority: 1 })
    // ★ 三种写法都要能用：`-a`（短）、`--all`（长）、`-all`（用户原话里的写法）。
    //   `-all` 在 Koishi 里走的是**组合短选项**分支（core:400-409，`-all` 被拆成 a/l/l），
    //   只定义 `-a` 其实也能出 all=true，但会顺手给 `options.l` 塞一个空值 ——
    //   那要看 `parseValue(undefined)` 的脸色。用 symbols 精确匹配整个 `-all` 就没这条尾巴。
    .option('all', '-a 列出全部原始指令（默认只看常用的别名）', { symbols: ['-all'] })
    .option('unavailable', '-u 把"你等级不够"的指令也列出来（灰掉）')
    .action(async (argv, target) => {
      const session = argv?.session
      const showAllCmds = !!argv?.options?.all
      const showUnavailable = !!argv?.options?.unavailable
      const mine = authorityOf(session)

      // ★★ `[target:string]` 是**贪婪**位置参数，第二个位置参数根本拿不到值
      //   （`@koishijs/core:1332` 把 `string` 域定义成 `{greedy:true}`，解析时
      //   `Argv.stringify(argv)` 会把**剩下所有 token** 一次性塞给第一个参数，
      //   见 core:385-388）。也就是说 `/help chat 2` 里 target 拿到的是整串 `"chat 2"`、
      //   `page` 永远是 undefined —— 而页脚一直写着「下一页：`/help chat 2`」，
      //   实际会回一句「找不到「chat 2」」。2026-10-03 复核分页时才发现（第一轮就带着）。
      //   修法：自己把结尾的数字切出来当页码。指令名/类目代号里不可能有空格，切了不会误伤。
      let rawTarget = String(target ?? '').trim()
      let pageNo
      const tail = /^(.+?)\s+(\d+)$/.exec(rawTarget)
      if (tail) {
        rawTarget = tail[1].trim()
        pageNo = Number(tail[2])
      }

      // ★ `/help 2` = 常用页第 2 页。目标位只认纯数字时当页码，
      //   否则翻页就得写成 `/help 1 2` 这种没人猜得到的写法。
      const asPage = /^\d+$/.test(rawTarget) ? Number(rawTarget) : null

      let md
      const r = asPage === null ? resolveTarget(rawTarget, mine) : { kind: 'overview' }
      if (r.kind === 'overview') {
        // 首页 = 别名层；`-all` = 全部原始指令；没有别名表时首页退回全量总览
        md = showAllCmds ? overviewPage(mine, showUnavailable) : shortcutPage(asPage ?? pageNo, mine, showUnavailable)
        if (!md) md = overviewPage(mine, showUnavailable)
      } else if (r.kind === 'category') {
        md = categoryPage(r.catId, pageNo, mine, showUnavailable)
        if (!md) md = `类目 \`${esc(r.catId)}\` 里没有你能看的指令。发 \`/help\` 看常用指令。`
      } else if (r.kind === 'command') {
        md = detailPage(r.entry, mine, r.via)
      } else {
        md = [
          `# 找不到「${esc(r.target)}」`,
          ``,
          `它既不是类目代号，也不是指令名或别名。`,
          r.near.length ? `\n你是不是想找：${r.near.map((n) => `\`${esc(n)}\``).join('、')}` : '',
          ``,
          `发 \`/help\` 看常用指令，发 \`/help -all\` 看全部类目。`,
        ]
          .filter((x) => x !== '')
          .join('\n')
      }

      return output(session, md)
    })

  /** 会话等级：`session.user` 没挂上时按 Koishi 的语义放行（core:2127 `!user || authority >= n`） */
  function authorityOf(session) {
    const v = session?.user?.authority
    return Number.isFinite(v) ? Number(v) : ALL_LEVELS
  }

  /** 统一的输出口：出图 or 文字（`forceText` 由管理命令用来钉住文字） */
  function output(session, md, forceText) {
    const pg = ctx.get('chatlunaPage')
    // ★ 文字模式必须走 plainify，不能把 md 原样 return：
    //   `session.send(string)` 会经过 `h.parse`，而 OneBot 编码器不认识 `<br>`，
    //   会把 br **连同它的子节点**一起丢掉 —— `<br>` 之后的内容整段消失。
    //   rig 47 实测（2026-10-03）：首页的别名表格、页脚的第二三行全没了，
    //   但出图路径完全正常，只有文字模式会撞上。
    if (!forceText && pg?.available?.() && !pg.isTextMode?.(session)) return pg.output(session, md)
    if (!forceText && !cfg.textFallback) return md
    return pg?.plainify ? pg.plainify(md) : md.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '')
  }

  // ------------------------------------------------------------------ /cmdadmin
  //
  // 用户原话：「koishi 命令管理那里需要能够管理别名和用途文本，权限的文本也需要使用
  //           /help 中显示的这几个文本，数字太不直观了」
  //
  // 所以这一组命令干三件事，全部**落库、热生效**：
  //   · alias   —— 给一条指令加/删别名（真的挂到 Command 上，`/新别名` 当场能敲）
  //   · desc    —— 改"用途"（帮助页那一列，覆盖 i18n 说明）
  //   · level   —— 改权限门槛，**认文本**（`信任` = 2），显示也一律文本
  // 另加 list / aliases / preview 三个查看入口，方便核对与验收。

  const ADMIN_KEEP_TEXT = () => cfg.adminKeepText

  function findCmd(raw) {
    const cmdr = commander()
    if (!cmdr) return { error: '拿不到指令表（Commander 还没就绪），稍后再试。' }
    const key = String(raw ?? '').trim()
    if (!key) return { error: '要指定一条指令。先 `cmdadmin list` 看看有哪些。' }
    const cmd = cmdr.get(key) ?? cmdr.get(key.toLowerCase())
    if (!cmd) return { error: `没有 \`${esc(key)}\` 这条指令。` }
    return { cmd }
  }

  /** 列表过滤用的纯函数：把 i18n 说明也纳入匹配（`-f` 能按用途找） */
  function descOfName(cmdName) {
    return descriptionOf({ name: cmdName })
  }

  function splitAliases(raw) {
    return String(raw ?? '')
      .split(/[,，\s]+/)
      .map((s) => s.trim().replace(/^\//, '').toLowerCase())
      .filter(Boolean)
  }

  /** 别名合法性与冲突检查（冲突返回原因字符串，没问题返回 null） */
  function aliasProblem(cmd, alias) {
    if (!/^[a-z][a-z0-9._-]*$/.test(alias) && !/^[\u4e00-\u9fff][\u4e00-\u9fff0-9]*$/.test(alias)) {
      return '别名只允许英文（字母开头，可含数字 . _ -）或中文'
    }
    if (alias === low(cmd.name)) return null
    if (cmd._aliases?.[alias]) return null // 已经是它的别名
    const cmdr = commander()
    const owner = cmdr?.get(alias)
    if (owner && owner !== cmd) return `\`${alias}\` 已被 \`${owner.name}\` 占用`
    return null
  }

  if (cfg.enabled) {
    ctx
      .command('cmdadmin', '指令管理：别名 / 用途文本 / 权限等级（改动立刻生效）', { authority: 3 })
      .alias('cman')
      .action(async ({ session }) => {
        const mine = authorityOf(session)
        return output(
          session,
          [
            `# 指令管理`,
            ``,
            `你的等级：${levelBadge(mine, mine)}　·　常用别名表：**${aliasEntries().length}** 条　·　覆盖层改动：**${overlay.byCmd.size}** 条`,
            ``,
            `| 命令 | 干什么 |`,
            `| --- | --- |`,
            `| \`/cmdadmin list\` | 列出全部指令（分页 / 按类目 / 按等级过滤） |`,
            `| \`/cmdadmin aliases\` | 只看**有别名的**指令（含 Koishi 里配的） |`,
            `| \`/cmdadmin alias help model\` | 给 \`help\` 加别名 \`model\` |`,
            `| \`/cmdadmin alias help -d model\` | 去掉别名 |`,
            `| \`/cmdadmin desc help 指令总览\` | 改"用途"文本 |`,
            `| \`/cmdadmin level help 普通\` | 改权限门槛（**认文本**，也认 0-4） |`,
            `| \`/cmdadmin preview 2791932480\` | 看某个等级的人眼里的 \`/help\` |`,
            ``,
            `权限等级：${LEVEL_MENU}`,
            ``,
            `<div class="pg-foot">改动**写进数据库、当场生效**，不用重启；` +
              `向往回退就再设一次原值，或把用途/等级设成 \`-\`（清掉覆盖）。<br>` +
              `例：<code>/cmdadmin level help 普通</code>　<code>/cmdadmin alias help -d model</code></div>`,
          ].join('\n'),
          ADMIN_KEEP_TEXT()
        )
      })

    ctx
      .command('cmdadmin.list [page:number]', '列出全部指令：名字 / 别名 / 用途 / 等级', { authority: 3 })
      .option('category', '-c <cat:string> 只看某个类目代号')
      .option('level', '-l <lv:string> 只看某个等级（数字或文本）')
      .option('filter', '-f <text:string> 名字/别名/用途里含这段文字')
      .option('plain', '-p 连没有别名的也列出来（默认全列）')
      .action(async ({ session, options }, pageNo) => {
        const mine = authorityOf(session)
        const all = catalogue(mine)
        const idx = aliasIndex()
        let list = all
        if (options?.category) {
          const cat = [...rules(), { id: 'other', name: '其他' }].find(
            (c) => c.id.toLowerCase() === String(options.category).toLowerCase()
          )
          list = cat ? list.filter((c) => c.category.id === cat.id) : []
        }
        if (options?.level != null && String(options.level) !== '') {
          const lv = parseLevel(options.level)
          if (lv == null) return output(session, `等级 \`${esc(options.level)}\` 不认识。可用：${LEVEL_MENU}`, true)
          list = list.filter((c) => c.level === lv)
        }
        if (options?.filter) {
          const f = String(options.filter).toLowerCase()
          list = list.filter(
            (c) =>
              c.name.toLowerCase().includes(f) ||
              c.display.toLowerCase().includes(f) ||
              String(descOfName(c.name) ?? '').toLowerCase().includes(f) ||
              c.aliases.some((a) => a.toLowerCase().includes(f))
          )
        }
        if (!list.length) return output(session, '没有符合条件的指令。', true)

        const pageSize = Math.max(Number(cfg.pageSize) || 18, 4)
        const pages = Math.max(Math.ceil(list.length / pageSize), 1)
        const p = Math.min(Math.max(Number(pageNo) || 1, 1), pages)
        const slice = list.slice((p - 1) * pageSize, p * pageSize)

        const rows = slice.map((c) => {
          const als = (idx.get(c.name)?.live ?? []).filter((a) => a !== String(c.name))
          const mark = c.overridden ? ' ✎' : ''
          return (
            `| \`${esc(c.name)}\`${mark} | ${als.length ? als.map((a) => `\`${esc(a)}\``).join(' ') : '—'} ` +
            `| ${cell(descOfName(c.name) ?? c.description) || '—'} | ${levelBadge(c.level, mine)} |`
          )
        })

        return output(
          session,
          [
            `# 指令管理 · 全部指令`,
            ``,
            `共 **${list.length}** 条 · 第 **${p}/${pages}** 页　·　✎ = 用途或等级已被覆盖`,
            ``,
            `| 指令 | 别名 | 用途 | 等级 |`,
            `| --- | --- | --- | --- |`,
            ...rows,
            ``,
            `<div class="pg-foot">${p < pages ? `下一页：<code>/cmdadmin list ${p + 1}</code>　·　` : ''}` +
              `按类目：<code>/cmdadmin list -c chat</code>　·　按等级：<code>/cmdadmin list -l 信任</code><br>` +
              `改用途：<code>/cmdadmin desc &lt;指令&gt; &lt;文本&gt;</code>　·　改等级：<code>/cmdadmin level &lt;指令&gt; &lt;等级&gt;</code></div>`,
          ].join('\n'),
          ADMIN_KEEP_TEXT()
        )
      })

    ctx
      .command('cmdadmin.aliases [page:number]', '只看有别名的指令（Koishi 里配的也算）', { authority: 3 })
      .action(async ({ session }, pageNo) => {
        const mine = authorityOf(session)
        const all = catalogue(mine)
        const idx = aliasIndex()
        const rowsData = all
          .map((c) => ({ c, als: (idx.get(c.name)?.live ?? []).filter((a) => a !== String(c.name)) }))
          .filter((x) => x.als.length)
        if (!rowsData.length) return output(session, '当前一条别名都没有。', true)

        const pageSize = Math.max(Number(cfg.pageSize) || 18, 4)
        const pages = Math.max(Math.ceil(rowsData.length / pageSize), 1)
        const p = Math.min(Math.max(Number(pageNo) || 1, 1), pages)
        const slice = rowsData.slice((p - 1) * pageSize, p * pageSize)

        return output(
          session,
          [
            `# 指令管理 · 别名一览`,
            ``,
            `共 **${rowsData.length}** 条指令有别名 · 第 **${p}/${pages}** 页　·　来源：运行时 \`_aliases\` + chatluna-alias 配置 + 覆盖层`,
            ``,
            `| 指令 | 别名 | 等级 |`,
            `| --- | --- | --- |`,
            ...slice.map(
              ({ c, als }) =>
                `| \`${esc(c.name)}\` | ${als.map((a) => `\`${esc(a)}\``).join(' ')} | ${levelBadge(c.level, mine)} |`
            ),
            ``,
            `<div class="pg-foot">${p < pages ? `下一页：<code>/cmdadmin aliases ${p + 1}</code>　·　` : ''}` +
              `去掉一个：<code>/cmdadmin alias &lt;指令&gt; -d &lt;别名&gt;</code></div>`,
          ].join('\n'),
          ADMIN_KEEP_TEXT()
        )
      })

    ctx
      .command('cmdadmin.alias <target:string> <alias:string>', '给指令加/删别名（真的挂到指令上）', { authority: 3 })
      .option('delete', '-d 删掉这个别名（而不是添加）')
      .action(async ({ session, options }, target, aliasRaw) => {
        const found = findCmd(target)
        if (found.error) return output(session, found.error, true)
        const cmd = found.cmd
        const aliases = splitAliases(aliasRaw)
        if (!aliases.length) return output(session, '要指定别名，例：`/cmdadmin alias help model`', true)

        const done = []
        const failed = []
        for (const alias of aliases) {
          if (options?.delete) {
            let removed = false
            try {
              if (cmd._aliases?.[alias] && alias !== Object.keys(cmd._aliases)[0]) {
                delete cmd._aliases[alias]
                removed = true
              }
            } catch {
              /* 只读对象：忽略 */
            }
            overlay.applied.delete(alias)
            // 覆盖层里也停掉（配置里的那一条会被 runtime 删掉，重启后才回来 —— 如实说）
            await setExtraAlias(cmd.name, alias, false)
            if (removed) done.push(`已删 \`/${alias}\``)
            else done.push(`覆盖层里已停用 \`/${alias}\`（不在运行时别名里）`)
            continue
          }
          const problem = aliasProblem(cmd, alias)
          if (problem) {
            failed.push(problem)
            continue
          }
          try {
            cmd.alias(alias)
            overlay.applied.set(alias, cmd)
            await setExtraAlias(cmd.name, alias, true)
            done.push(`已加 \`/${alias}\``)
          } catch (e) {
            failed.push(`\`${alias}\`（${e.message}）`)
          }
        }
        ctx.emit('command-updated', cmd)
        return output(
          session,
          [
            `# ${options?.delete ? '删除别名' : '添加别名'}：\`${esc(cmd.name)}\``,
            ``,
            ...done,
            ...(failed.length ? ['', `没成功：${failed.join('　')}`] : []),
            ``,
            `现在这条指令的别名：${
              (aliasIndex().get(cmd.name)?.live ?? [])
                .filter((a) => a !== String(cmd.name))
                .map((a) => `\`/${esc(a)}\``)
                .join(' ') || '（无）'
            }`,
            `<div class="pg-foot">改完立刻能敲，\`/help\` 首页也会马上多出这一条。<br>` +
              `★ 配置里（chatluna-alias）本来就有的别名，删掉后**重启会回来** —— 要永久去掉得去 koishi.yml 改配置。</div>`,
          ].join('\n'),
          true
        )
      })

    ctx
      .command('cmdadmin.desc <target:string> <text:string>', '改"用途"文本（帮助页显示的那一列）', { authority: 3 })
      .action(async ({ session }, target, textRaw) => {
        const found = findCmd(target)
        if (found.error) return output(session, found.error, true)
        const cmd = found.cmd
        const text = String(textRaw ?? '').trim()
        const current = descriptionOf(cmd)
        try {
          if (!text || text === '-') {
            await setOverlayNote(cmd.name, null)
            ctx.emit('command-updated', cmd)
            return output(
              session,
              `已清掉 \`${esc(cmd.name)}\` 的用途覆盖，回到原本的说明：${esc(t(`commands.${cmd.name}.description`) || '（本来就没有）')}`,
              true
            )
          }
          await setOverlayNote(cmd.name, text)
          ctx.emit('command-updated', cmd)
        } catch (e) {
          return output(session, `写库失败：${esc(e.message)}`, true)
        }
        return output(
          session,
          [
            `# 用途已改：\`${esc(cmd.name)}\``,
            ``,
            `原来：${esc(current) || '（无）'}`,
            `现在：**${esc(text)}**`,
            ``,
            `<div class="pg-foot">\`/help ${esc(cmd.name)}\` 与 \`/cmdadmin list\` 立刻显示新文本。<br>` +
              `清掉覆盖：<code>/cmdadmin desc ${esc(cmd.name)} -</code></div>`,
          ].join('\n'),
          true
        )
      })

    ctx
      .command('cmdadmin.level <target:string> <level:string>', '改权限门槛（认文本：普通/信任/管理员/主人）', {
        authority: 3,
      })
      .action(async ({ session }, target, levelRaw) => {
        const found = findCmd(target)
        if (found.error) return output(session, found.error, true)
        const cmd = found.cmd
        const before = displayLevel(cmd)
        const raw = String(levelRaw ?? '').trim()

        if (!raw || raw === '-') {
          try {
            await setOverlayLevel(cmd.name, null)
            ctx.emit('command-updated', cmd)
          } catch (e) {
            return output(session, `写库失败：${esc(e.message)}`, true)
          }
          return output(
            session,
            `已清掉 \`${esc(cmd.name)}\` 的等级覆盖，现在是现场值：${levelText(displayLevel(cmd))}`,
            true
          )
        }

        const lv = parseLevel(raw)
        if (lv == null) {
          return output(
            session,
            [`等级 \`${esc(raw)}\` 不认识。可写文本或数字：`, ``, LEVEL_MENU, ``, `例：\`/cmdadmin level help 普通\``].join('\n'),
            true
          )
        }
        try {
          await setOverlayLevel(cmd.name, lv)
          ctx.emit('command-updated', cmd)
        } catch (e) {
          return output(session, `写库失败：${esc(e.message)}`, true)
        }
        return output(
          session,
          [
            `# 等级已改：\`${esc(cmd.name)}\``,
            ``,
            `${levelText(before)} → **${levelText(lv)}**`,
            ``,
            `也就是说：这条指令从现在起要 **${levelLabel(lv)}** 及以上才能用。`,
            `<div class="pg-foot">清掉覆盖：<code>/cmdadmin level ${esc(cmd.name)} -</code><br>` +
              `★ 覆盖层写在数据库里，且**重启后依然生效**（这是刻意的：不然改完一重启就白改）。</div>`,
          ].join('\n'),
          true
        )
      })

    ctx
      .command('cmdadmin.preview <level:string>', '看某个等级的人眼里的 /help（验"按使用者显示"）', { authority: 3 })
      .action(async ({ session }, levelRaw) => {
        const lv = parseLevel(levelRaw)
        if (lv == null) {
          return output(session, `等级 \`${esc(levelRaw)}\` 不认识。可写文本或数字：${LEVEL_MENU}`, true)
        }
        const all = catalogue(lv)
        const usable = all.filter((c) => c.usable)
        const idx = aliasIndex()
        const aliasRows = []
        for (const c of usable) {
          for (const a of idx.get(c.name)?.live ?? []) {
            if (a !== String(c.name)) aliasRows.push(a)
          }
        }
        const byLevel = new Map()
        for (const c of all) byLevel.set(c.level, (byLevel.get(c.level) ?? 0) + 1)

        return output(
          session,
          [
            `# 预览：${levelLabel(lv)} 眼里的 /help`,
            ``,
            `指令表共 **${all.length}** 条，这个等级**能用 ${usable.length}** 条（${((usable.length / Math.max(all.length, 1)) * 100).toFixed(0)}%）；首页别名 **${aliasRows.length}** 个。`,
            ``,
            `| 等级 | 门坎在这级的指令数 | 能用吗 |`,
            `| --- | --- | --- |`,
            ...[...byLevel.keys()]
              .sort((a, b) => a - b)
              .map((k) => `| ${levelBadge(k, lv)} | ${byLevel.get(k)} | ${k <= lv ? '✅' : '❌'} |`),
            ``,
            `<div class="pg-foot">想让某条指令换个门槛：<code>/cmdadmin level &lt;指令&gt; &lt;等级&gt;</code><br>` +
              `权限等级：${LEVEL_MENU}</div>`,
          ].join('\n'),
          true
        )
      })
  }

  // ------------------------------------------------------------------ 未知指令兜底
  //
  // ★ 为什么必须有
  //   2026-10-03 实测（生产日志 01:58:46）：用户在群里发 `/ext`。
  //   `ext` 是总览表里的**类目代号**，不是指令名，于是：
  //     ① Koishi 的指令中间件解析不到 → next()；
  //     ② Koishi 自带的"你是不是想输入 X"（core:1294-1316）也匹配不上
  //        （它只在**指令名**里找近似，类目代号当然找不到）；
  //     ③ 于是这条消息**整条漏给 ChatLuna**，模型把它当聊天接了，
  //        回了句「这命令不是给我的吧，群里就我们俩 / 你想干嘛直接说」。
  //   用户那边的体感就是"命令没有效果，或者是我没正确使用？"——两者都是。
  //
  // ★ 为什么要 prepend（`ctx.middleware(fn, true)`）
  //   ChatLuna 是在它自己加载时用普通 `ctx.middleware` 挂上去的，**排在前面**。
  //   如果我们也用普通注册，等轮到我们的时候 ChatLuna 已经把这句当聊天回完了。
  //   prepend 是 unshift（guard 的注释里记过这条），能在插件加载期插到最前面。
  //
  // ★ prepend 的代价：我们比 `chatluna-guard` 还早，屏蔽判定得自己问
  //   被屏蔽的群不该因为敲错指令就冒出一句话。guard 用 `ctx.provide('qqbotGuard')`
  //   暴露了 `isBlocked(session)`，这里直接问它；问不到就当没屏蔽（宁可多回一句，
  //   也不要因为拿不到服务就整条兜底失效）。
  //
  // ★ 什么时候**不**兜底（把决定权还回去）
  //   - 指令真的存在（含别名 / 子指令）→ next()，走正常执行；
  //   - 有指令名以这个 token 开头 → next()，交给 Koishi 自己的 suggest 去问
  //     "你是不是想输入 xxx"（那套逻辑比这里细，别抢它的活）；
  //   - 不像指令名（中文、含空格、含奇怪符号）→ next()，那是自然语言，不是敲错了。

  /** 类目代号（或显示名）→ 类目规则项 */
  function categoryFor(token) {
    const t = String(token || '').toLowerCase()
    if (!t) return null
    const list = [...rules(), { id: 'other', name: '其他' }]
    return (
      list.find((c) => String(c.id).toLowerCase() === t) ||
      list.find((c) => String(c.name) === token) ||
      null
    )
  }

  /**
   * 所有指令名 + 别名（小写）。
   *
   * ★ 这里**故意不用 `$commander.resolve(name, session)`**：prepend 中间件比 `attach` 还早，
   *   那时候 `session.user` 还没挂上，权限判定拿不到东西，`resolve` 有可能把一条**真实存在**
   *   的指令判成不存在 —— 那样我们就会把用户正常发的指令抢掉。
   *   只按名字（和别名）查表不依赖任何 session 状态，是安全的做法：
   *   名字对得上就放行，让 Koishi 自己去判权限（它会给"权限不足"，而不是"没有这个指令"）。
   */
  function commandNames() {
    const cmdr = commander()
    const set = new Set()
    if (!cmdr) return set
    for (const c of cmdr._commandList) {
      const n = String(c.name || '').toLowerCase()
      if (n) set.add(n)
      for (const a of Object.keys(c._aliases || {})) {
        const k = String(a || '').toLowerCase()
        if (k) set.add(k)
      }
    }
    return set
  }

  /** 这个名字是不是（或可能是）一条指令 */
  function looksLikeCommand(token, names) {
    if (names.has(token)) return true
    // 有指令名以它开头 → 可能是子指令写了一半，交给 Koishi 自己的 suggest
    for (const n of names) if (n.startsWith(token + '.') || n.startsWith(token)) return true
    return false
  }

  /** 类目代号里和这个 token 沾边的（给"你是不是想看"用） */
  function nearCategories(token) {
    const t = String(token || '').toLowerCase()
    if (t.length < 2) return []
    return [...rules(), { id: 'other', name: '其他' }]
      .map((c) => String(c.id))
      .filter((id) => {
        const s = id.toLowerCase()
        return s.startsWith(t) || t.startsWith(s)
      })
      .slice(0, 4)
  }

  /** 返回要发的话；返回 null 表示"别拦，让后面的人处理" */
  function unknownHintFor(token, names) {
    if (looksLikeCommand(token, names)) return null

    const cat = categoryFor(token)
    if (cat) {
      return (
        `没有 \`/${token}\` 这个指令 —— \`${cat.id}\` 是**类目代号**，不是指令名。\n` +
        `想看「${cat.name}」这一类：发 \`/help ${cat.id}\`\n` +
        `看全部类目：发 \`/help\``
      )
    }

    const near = nearCategories(token)
    return [
      `没有 \`/${token}\` 这个指令。`,
      near.length ? `你是不是想看这些类目：${near.map((id) => `/help ${id}`).join('、')}` : '',
      `常用指令：发 /help　·　全部原始指令：发 /help -all`,
    ]
      .filter(Boolean)
      .join('\n')
  }

  /** 当前生效的指令前缀（配置里可能是 ['/', '.']） */
  function prefixList(session) {
    try {
      const cmdr = commander()
      if (cmdr?._resolvePrefixes) {
        const list = [...cmdr._resolvePrefixes(session)].filter((p) => typeof p === 'string' && p)
        if (list.length) return list.sort((a, b) => b.length - a.length)
      }
      const raw = cmdr?.config?.prefix
      if (Array.isArray(raw)) return raw.filter((p) => typeof p === 'string' && p).sort((a, b) => b.length - a.length)
    } catch {}
    return ['/']
  }

  ctx.middleware(async (session, next) => {
    try {
      if (!cfg.enabled || !cfg.unknownHint) return next()
      if (!session?.stripped) return next()
      if (session.isDirect ? false : !cfg.unknownHintInGroup) return next()

      // 指令已经解析出来了 —— 正常执行，别插手
      if (session.argv?.command) return next()

      // 被屏蔽的群保持静默。拿不到 guard 服务时不因为这一条把兜底整个关掉
      const guard = ctx.get('qqbotGuard')
      if (guard?.isBlocked?.(session)) return next()

      // ★ 前缀要**自己切**：prepend 中间件比 `attach` 还早，而 `stripped.prefix` 是
      //   `ctx.before('attach')` 里才写上去的（@koishijs/core:1275-1284）。
      //   第一次跑这个剧本时就是漏了这一步：token 拿到的是 `/ext`（带着斜杠），
      //   正则 `^[a-z]...` 直接不匹配 → 一次都没兜底，日志里连一行都没有。
      let content = String(session.stripped.content || '').trim()
      if (!content) return next()
      let hadPrefix = false
      for (const p of prefixList(session)) {
        if (content.startsWith(p)) {
          content = content.slice(p.length).trim()
          hadPrefix = true
          break
        }
      }

      const appel = session.stripped.appel
      if (!session.isDirect && !hadPrefix && !appel) return next()

      const token = content.split(/\s/, 1)[0]
      if (!token) return next()
      // 只认"看起来就是个指令名"的：字母开头，只含 [a-z0-9._-]
      if (!/^[a-z][a-z0-9._-]*$/i.test(token)) return next()

      const hint = unknownHintFor(token.toLowerCase(), commandNames())
      if (hint === null) return next()

      log('未知指令兜底：%s → 回提示', token)
      await session.send(hint)
      // 短路：不调 next()，ChatLuna 不会再再把这句话当聊天接一遍
      return
    } catch (e) {
      logger.warn('未知指令兜底出错（放行给后续处理）：%s', e.message)
      return next()
    }
  }, true)

  // ------------------------------------------------------------------ 数据模型 + 启动

  /**
   * 两张覆盖层表。
   * ★ 用复合主键（不是自增 id）：`(userId, command)` / `(userId, target, alias)`
   *   —— 同一个人对同一条指令只该有一行，`db.set` 才能对着键直接改。
   */
  ctx.model.extend(
    OVERLAY_TABLE,
    {
      userId: { type: 'string', length: 64 },
      command: { type: 'string', length: 128 },
      note: { type: 'text', nullable: true },
      level: { type: 'integer', nullable: true },
    },
    { primary: ['userId', 'command'] }
  )
  ctx.model.extend(
    EXTRA_ALIAS_TABLE,
    {
      userId: { type: 'string', length: 64 },
      target: { type: 'string', length: 128 },
      alias: { type: 'string', length: 64 },
      enabled: { type: 'boolean', initial: true },
    },
    { primary: ['userId', 'target', 'alias'] }
  )

  ctx.on('ready', () => {
    // ★ 覆盖层要等数据库 + 指令表都就绪。指令表本身是异步挂载的（ChatLuna 在嵌套 ready
    //   里注册），所以这里只装载一次、不反复扫 —— 覆盖层是"数据"，不是"指令快照"。
    setTimeout(() => {
      void (async () => {
        await loadOverlay()
        const p1 = applyOverlayToCommands()
        const p2 = applyManagedAliases()
        for (const p of [...p1, ...p2]) logger.warn('覆盖层有问题：%s', p)
        report()
      })()
    }, 2500)

    setTimeout(() => {
      const all = catalogue(ALL_LEVELS)
      const cmdr = commander()
      if (!cmdr) {
        logger.warn('拿不到 Commander 指令表，/help 会是空的')
        return
      }
      // ★ 自检 1：help 这个名字到底解析到谁？框架 help 插件没关干净的话会解析到它
      const helpCmd = cmdr.get?.('help')
      if (!helpCmd) logger.warn('自检失败：`help` 解析不到，指令系统可能没起来')
      else if (helpCmd.name !== 'help') {
        logger.warn('自检失败：`help` 解析到了 %s —— 多半是 @koishijs/plugin-help 没关掉', helpCmd.name)
      } else {
        // ★ 这条必须走 logger.info，不能走 debug 门控的 log()：
        //   生产环境 debug=false，用 log() 的话「自检通过」永远不打印，
        //   于是「没打印」既可能是没通过、也可能是没开 debug —— 自检就失去意义了（踩过）。
        logger.info('自检通过：`help` 指向本插件')
      }

      // ★ 自检 2：有多少条指令落在「其他」里 —— 说明类目规则该补了
      const other = all.filter((c) => c.category.id === 'other')
      logger.info(
        '指令目录就绪：共 %d 条，分 %d 类；未归类 %d 条%s',
        all.length,
        new Set(all.map((c) => c.category.id)).size,
        other.length,
        other.length ? `（${other.slice(0, 8).map((c) => c.name).join(' / ')}${other.length > 8 ? ' …' : ''}）` : ''
      )

      // ★ 自检 3：首页到底画哪一张。别名层没接上时必须说清楚，
      //   否则用户看到"首页突然又变回 147 条"会以为是回归。
      const aliases = aliasEntries()
      const missingTargets = aliases.filter((e) => !all.some((c) => c.name === e.target))
      const liveAliasCount = [...aliasIndex().values()].reduce(
        (n, e) => n + e.live.filter((a) => a !== e.primary && a !== '').length,
        0
      )
      if (!aliases.length && !liveAliasCount) {
        logger.warn('别名表为空（chatluna-alias 没装/没启用？）→ /help 首页退回全量总览')
      } else {
        logger.info(
          '别名层就绪：配置表 %d 条 / 运行期可见 %d 个别名（/help 首页只列这些）；%d 条原始指令在 /help -all%s',
          aliases.length,
          liveAliasCount,
          all.length,
          missingTargets.length ? `；⚠ ${missingTargets.length} 个别名的目标不在指令表里` : ''
        )
        if (missingTargets.length) {
          logger.warn('别名指向了不存在的指令：%s', missingTargets.map((e) => `${e.alias}→${e.target}`).join(' / '))
        }
      }
      if (cfg.debug) {
        for (const c of all) log('  %s [%s] %s — %s', c.name, c.category.id, levelText(c.level), c.description)
      }
    }, 9000)
  })

  /** 覆盖层状态一句话（启动日志 + `/cmdadmin` 都能看到"到底生效了没有"） */
  function report() {
    const notes = [...overlay.byCmd.values()].filter((v) => v.note).length
    const levels = [...overlay.byCmd.values()].filter((v) => v.level != null).length
    const extras = [...overlay.aliases.values()].reduce((n, l) => n + l.filter((x) => x.enabled).length, 0)
    if (overlay.error) {
      logger.warn('命令管理覆盖层没启用（%s）—— /cmdadmin 的改动这次不会生效', overlay.error)
      return
    }
    logger.info(
      '命令管理覆盖层就绪：用途 %d 条 / 等级 %d 条 / 额外别名 %d 个（数据库 → 运行期指令表）',
      notes,
      levels,
      extras
    )
  }

  logger.info(
    '指令帮助体系已挂载（每页 %d 条；默认只显示本等级能用的指令：%s）',
    cfg.pageSize,
    cfg.showUnavailable ? '否（showUnavailable=true 全显）' : '是'
  )
}

module.exports = { name, inject, Config, apply }
