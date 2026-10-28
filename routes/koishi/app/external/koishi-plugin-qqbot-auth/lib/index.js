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

// ------------------------------------------------------------------ 好感度 → 信任（只读展示）
//
// 2026-10-09（第十八轮）用户原话：
//   「这个好感度机制似乎一直是 30，很难升级到信任，甚至我不知道信任需要多少好感，
//     看看这个好感度怎么这么难升级」
//
// 查库的结论（生产 data/koishi.db，chatluna_affinity_v2）：
//   · 所有人**初始长期好感就是 30**（chatluna-affinity 的 BASE_AFFINITY_DEFAULTS.initialAffinity）；
//   · 而「信任」的门槛是 **51**（本插件 affinityPromoteAt）—— 也就是说一进来就"卡在 30"，
//     中间这 21 点全靠模型调工具一点点加；
//   · 显示值 = 长期 × 系数，系数会在 0.7~1.3 之间飘 —— 长期 30 最坏显示 21，看着更像"停住了"；
//   · 更要命的是模型的增量：查日志（tools/logs/prod-2026-10-08.log）里它**每次只给 +2~+3**，
//     而老配置要「短期攒够 15 才折成长期 +3」—— 也就是要 6 次调用才换来长期 +3，
//     30 → 51 得 7 次折算、约 40 次工具调用、而且中途任何一次负向都会拖回去。
//
// 所以这一轮做两件事：
//   ① **调机制**（koishi.yml 的 affinityDynamics：promoteThreshold 15→12、longTermPromoteStep 3→6）
//      + 给工具描述写上"按分量给 delta"的指引，让 30 → 51 变成"约 4 次折算"；
//   ② **把账摊开**（下面这段）：/qqbot.auth.me、/qqbot.auth.list、以及好感度桥的 /favor
//      都直接写清"信任要多少、你还差多少、还差几次正面互动"。用户不该靠猜。
//
// ★ 读配置为什么不复用 schemastery 的 config：那边拿到的是"已解析的当前值"（很好用），
//   但**别名工具那条路径要的 koishi.yml 原样值**在这里也要用（同一个文件里两处读会不一致），
//   所以统一走 `resolveCfg()`：优先用本插件自己收到的 config（权威、已经是解析后的），
//   拿不到字段时才回落到读文件。**绝不抛错** —— 这只是展示。
const AUTH_DEFAULTS = {
  affinityScopeId: 'affinity',
  affinityPromoteAt: 51,
  affinityDemoteAt: 40,
  shortPromote: 12,
  shortDemote: -8,
  longStep: 6,
}

/**
 * 极简 YAML 子集解析（只认 koishi.yml 用到的那种：缩进 + `键: 值` + `- 项`）。
 *
 * ★★ 2026-10-09 这一版把四个 bug 全修了，**判据脚本在 .scratch/check-yaml-config.cjs**
 *    （拿两份真实 koishi.yml 跑，标准是"能挖到 promoteThreshold=12 / longTermPromoteStep=6"）。
 *    改这个函数必须同时改那份脚本，否则会在"看起来能跑"和"数字全错"之间反复横跳：
 *   ① **键里有冒号**：Koishi 的实例键是 `http:aa0001: {}` 这种 `名字:实例id` 形状。
 *      早先 /^([^:#]+):(.*)$/ 会把它切成 key=`http` / value=`aa0001: {}`，plugins 恒为空。
 *      现在按**最后一个冒号**切键值，取段名时按第一个冒号切。
 *   ② **空值键是不是容器，要看下一行缩进**：`plugins:`（下面更深）是容器，
 *      `mode:`（下一行同缩进）是空字符串。
 *   ③ **栈顶缩进 ≥ 本行缩进 = 本行是兄弟**，必须弹掉栈顶再挂（`seek()`）。
 *   ④ **读之前要 unwrap**：子项放在 `[ASC]` 里，直接 Object.entries(节点) 只看得到内部字段。
 *
 * ★ 不支持块标量（`key: >-`）—— 这里要的参数都是普通标量。真需要长文本请换真 YAML 库。
 * ★ 解析失败一律回落默认值 —— 这是展示用，绝不能抛。
 */
const ASC = 'Ascending'
const LIST = 'List'
const indentOf = (s) => String(s).length - String(s).trimStart().length

function parseSimpleYaml(text) {
  const lines = String(text ?? '').split(/\r?\n/)

  const childIndent = (from) => {
    for (let j = from + 1; j < lines.length; j++) {
      if (!lines[j].trim() || lines[j].trim().startsWith('#')) continue
      return indentOf(lines[j])
    }
    return -1
  }

  const decodeScalar = (raw) => {
    let s = String(raw ?? '').trim()
    const c = s.indexOf(' #')
    if (c >= 0) s = s.slice(0, c).trim()
    if (!s) return ''
    const q = s[0]
    if ((q === '"' || q === "'") && s.length > 1 && s[s.length - 1] === q) return s.slice(1, -1)
    if (s === '{}' || s === '~' || s === 'null') return s === '{}' ? {} : null
    if (s === '[]') return []
    if (/^-?\d+$/.test(s)) return Number(s)
    if (s === 'true') return true
    if (s === 'false') return false
    return s
  }

  const root = { [ASC]: {}, [LIST]: false, indent: -1 }
  const stack = [root]
  const seek = (indent) => {
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop()
    return stack[stack.length - 1]
  }

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue
    const indent = indentOf(rawLine)
    const line = rawLine.trim()
    let top = seek(indent)

    if (line === '-' || line.startsWith('- ')) {
      const valueText = line === '-' ? '' : line.slice(2)
      const item = { [ASC]: {}, [LIST]: true, indent }
      top[ASC][String(top[ASC].length)] = item
      if (/^[^:\s][^:]*:(\s|$)/.test(valueText)) {
        stack.push(item)
        top = item
      } else {
        item[ASC] = decodeScalar(valueText)
        continue
      }
    }

    const ci = line.lastIndexOf(':')
    if (ci < 0) continue
    const key = line.slice(0, ci).trim()
    const rest = line.slice(ci + 1).trim()
    if (!key) continue

    // `>-` / `|` 块标量：后面更深缩进的行**全是这段文本的内容**，不是子节点。
    // ★ 别按普通缩进行继续解析，否则整段描述会变成一棵嵌套树（读出来是 [object Object]）。
    if (/^[|>][-+]?$/.test(rest)) {
      const baseIndent = indent
      const parts = []
      let j = i + 1
      for (; j < lines.length; j++) {
        const l = lines[j]
        if (!l.trim()) {
          parts.push('')
          continue
        }
        if (indentOf(l) <= baseIndent) break
        parts.push(l.trim())
      }
      i = j - 1 // 吃掉已消费的行
      top[ASC][key] = parts.join(' ').replace(/\s+/g, ' ').trim()
      continue
    }
    if (rest) {
      top[ASC][key] = decodeScalar(rest)
      continue
    }
    if (childIndent(i) > indent) {
      const node = { [ASC]: {}, [LIST]: false, indent }
      top[ASC][key] = node
      stack.push(node)
      continue
    }
    top[ASC][key] = ''
  }
  return unwrapYaml(root)
}

/** 把 `{ [ASC]: {...} }` 递归还原成普通对象（读之前必须过这一步，见上面 ④） */
function unwrapYaml(node) {
  if (!node || typeof node !== 'object') return node
  const kids = node[ASC]
  if (kids && typeof kids === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(kids)) out[k] = unwrapYaml(v)
    return out
  }
  return node
}

/** 从解析结果里挖出 `plugins.chatluna-affinity` 那一段（实例 id 不认识就取第一个匹配） */
function pickAffinitySection(parsed) {
  const plugins = parsed?.plugins
  if (!plugins || typeof plugins !== 'object') return null
  for (const [k, v] of Object.entries(plugins)) {
    if (k.split(':')[0] === 'chatluna-affinity' && v && typeof v === 'object') return v
  }
  return null
}

module.exports.name = 'qqbot-auth'

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

// ------------------------------------------------------------------ 等级文本 ↔ 数字
//
// ★ 2026-10-09 用户原话：「权限的文本也需要使用 /help 中显示的这几个文本，数字太不直观了」。
//   所以等级的**文本形式**是一等公民：`/qqbot.auth.set 2791932480 信任` 与 `... 2` 等价。
//   一份别名表 + 一份中文名表，认得出就收 —— 中文名直接取 LEVEL_NAMES，不再抄一份。

/** 英文同义词（用户可能顺手敲英文） */
const LEVEL_SYNONYMS = {
  trust: 2,
  trusted: 2,
  admin: 3,
  administrator: 3,
  owner: 4,
  master: 4,
  normal: 1,
  user: 1,
  block: 0,
  blocked: 0,
  ban: 0,
}

/** `信任`/`trust`/`2` → 2；认不出来返回 null */
function parseLevelArg(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return null
  if (/^\d+$/.test(s)) {
    const n = Number(s)
    return n >= 0 && n <= 4 ? n : null
  }
  const low = s.toLowerCase()
  if (LEVEL_SYNONYMS[low] != null) return LEVEL_SYNONYMS[low]
  for (const [k, v] of Object.entries(LEVEL_NAMES)) if (String(v) === s) return Number(k)
  return null
}

/** 等级菜单一行：`` `0`=拉黑　·　`1`=普通 … `` */
const LEVEL_MENU_TEXT = Object.keys(LEVEL_NAMES)
  .map(Number)
  .sort((a, b) => a - b)
  .map((n) => `\`${n}\`=${LEVEL_NAMES[n]}`)
  .join('　·　')

module.exports.name = 'qqbot-auth'
// ★ 只提供、不消费：`qqbotAuth` 是给好感度桥读"信任门槛"的只读接口（见文件尾 ctx.provide）。
//   声明出来是为了让依赖关系在指令表/控制台里看得见，不是为了 inject 别人。
module.exports.inject = { required: [], optional: [] }

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

/** 别的插件（好感度桥的 /favor）要的只读接口名 */
const SERVICE_NAME = 'qqbotAuth'

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

  // ------------------------------------------------------------ 好感度实况（只读展示）
  //
  // 用户问的是「信任需要多少好感 / 为什么一直是 30」，所以这里要把**机制数字**摊开：
  // 折算线、折算步长、信任门槛、以及"你还差几次正面互动"。三个地方共用这段：
  //   · /qqbot.auth.me            —— 自己看
  //   · /qqbot.auth.list          —— 名单 + 当前生效的机制数字
  //   · /qqbot.auth.set <QQ>      —— 看某个人的进度（不给等级时不改任何东西）
  //   · 好感度桥的 /favor 也会调（`ctx.qqbotAuth.trustReport`）

  const affDynCache = { at: 0, value: null }

  /**
   * 解析"当前生效的好感度机制数字"。
   *
   * ★ 优先级：**本插件 config 里的 → 读 koishi.yml 的 chatluna-affinity 段 → 出厂默认**。
   *   真实生效的是 affinity 插件自己那份配置，本插件只能读文件看 —— 读不到就按出厂值，
   *   并在行尾标 `（默认值）`，免得把猜的当成实的。
   */
  function resolveAffinityDynamics() {
    const now = Date.now()
    if (affDynCache.value && now - affDynCache.at < 60_000) return affDynCache.value

    const out = { ...AUTH_DEFAULTS, source: '默认值' }
    try {
      const fs = require('node:fs')
      const path = require('node:path')
      // ★ 工作目录：loader 用 `app.provide('baseDir', …, true)` 暴露它（@koishijs/loader
      //   shared.js:354），所以走 ctx.get('baseDir')/ctx.baseDir —— **`ctx.loader` 在 4.18 上
      //   不存在**（实测：rig 67 第二轮的 /qqbot.auth.list 显示"参数来源：默认值"就是它）。
      const base =
        ctx.get?.('baseDir') ?? ctx.baseDir ?? ctx.root?.baseDir ?? ctx.loader?.baseDir ?? process.cwd?.() ?? '.'
      const text = fs.readFileSync(path.join(base, 'koishi.yml'), 'utf8')
      const sec = pickAffinitySection(parseSimpleYaml(text))
      const st = sec?.affinityDynamics?.shortTerm
      if (st && typeof st === 'object' && !Array.isArray(st)) {
        const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)
        out.promoteThreshold = num(st.promoteThreshold, AUTH_DEFAULTS.shortPromote)
        out.demoteThreshold = num(st.demoteThreshold, AUTH_DEFAULTS.shortDemote)
        out.longTermPromoteStep = num(st.longTermPromoteStep, AUTH_DEFAULTS.longStep)
        out.source = 'koishi.yml'
      }
    } catch (e) {
      if (cfg.debug) logger.debug('读 koishi.yml 的好感度参数失败（按默认值显示）：%s', e.message)
    }
    out.scopeId = cfg.affinityScopeId || AUTH_DEFAULTS.affinityScopeId
    out.promoteAt = Number(cfg.affinityPromoteAt) || AUTH_DEFAULTS.affinityPromoteAt
    out.demoteAt = Number(cfg.affinityDemoteAt) || AUTH_DEFAULTS.affinityDemoteAt
    affDynCache.at = now
    affDynCache.value = out
    return out
  }

  /** 一个人当前的好感度实况（读不到就返回 null —— 展示层据此说"没有档案"） */
  async function affinitySnapshot(userId) {
    const db = ctx.get('database')
    if (!db || !cfg.affinityScopeId) return null
    try {
      const rows = await db.get(AFFINITY_TABLE, { scopeId: cfg.affinityScopeId, userId: String(userId) })
      const r = rows?.[0]
      if (!r) return null
      let coef = 1
      try {
        const s = typeof r.coefficientState === 'string' ? JSON.parse(r.coefficientState) : r.coefficientState
        if (Number.isFinite(Number(s?.coefficient))) coef = Number(s.coefficient)
      } catch {}
      return {
        userId: String(userId),
        shown: Number(r.affinity),
        long: Number(r.longTermAffinity ?? r.affinity) || 0,
        short: Number(r.shortTermAffinity) || 0,
        chatCount: Number(r.chatCount) || 0,
        coefficient: coef,
        lastInteractionAt: r.lastInteractionAt ?? null,
      }
    } catch (e) {
      if (cfg.debug) logger.warn('读好感度实况失败：%s', e.message)
      return null
    }
  }

  /**
   * 离"信任"还差多少 —— 全部用**当前生效值**算，不给用户看死数字。
   *
   * 换算链（就是 chatluna-affinity 的机制，逐条写清楚免得又靠猜）：
   *   模型调工具给 delta → 进**短期**；短期 ≥ promoteThreshold → 长期 += longTermPromoteStep、短期清零；
   *   显示值 = 长期 × 系数（0.7~1.3 之间飘）。
   *   所以"长期涨 1 点"的代价是 `promoteThreshold / longTermPromoteStep` 点短期存量。
   */
  function trustGap(snap, d = resolveAffinityDynamics()) {
    const long = snap?.long ?? 0
    const gap = Math.max(d.promoteAt - long, 0)
    const perStep = Math.max(d.longTermPromoteStep, 1)
    const promotions = Math.ceil(gap / perStep)
    const shortNeed = promotions * d.promoteThreshold
    const shortLeft = Math.max(d.promoteThreshold - (snap?.short ?? 0), 0)
    // 一次"不错的互动"按 +3 估（= 改造前模型的实际水平）；这是**估算**，写在括号里
    const typical = 3
    const rounds = Math.ceil((gap * d.promoteThreshold) / perStep / typical)
    return { gap, perStep, promotions, shortNeed, shortLeft, rounds, d }
  }

  const signOf = (n) => `${n >= 0 ? '+' : ''}${n}`

  /** 人话版：把"还差多少"讲清 */
  function trustGapText(snap, indent = '') {
    const d = resolveAffinityDynamics()
    if (!snap) {
      return `${indent}还没有好感度档案（先在群里跟 bot 聊几句就有了）。信任门槛是 **${d.promoteAt}**。`
    }
    const g = trustGap(snap, d)
    if (g.gap <= 0) {
      return (
        `${indent}**已经够信任了**（长期 ${snap.long} ≥ 门槛 ${d.promoteAt}）；` +
        `掉到 ${d.demoteAt} 以下才会退回「普通」。`
      )
    }
    return [
      `${indent}信任门槛 **${d.promoteAt}**，你的长期好感 **${snap.long}** → 还差 **${g.gap}** 点。`,
      `${indent}每攒 **${d.promoteThreshold}** 点短期好感折成长期 **+${g.perStep}**，` +
        `所以要 **${g.promotions} 次折算**、合计 **${g.shortNeed}** 点正面互动（按每次 +3 估 ≈ **${g.rounds} 次**）。`,
      `${indent}你现在的短期存量 **${signOf(snap.short)}**，距下一次折算还差 **${g.shortLeft}** 点` +
        `${d.source === 'koishi.yml' ? '' : '（参数按出厂默认值算）'}。`,
      `${indent}提示：显示值 = 长期 × 系数（你现在 ×${snap.coefficient.toFixed(2)}）= **${snap.shown}**，` +
        `所以长期涨了显示值也可能先不动 —— 那不是没涨。`,
    ].join('\n')
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

  // 查自己：/qqbot.auth.me —— ★ 2026-10-09 起连"离信任还差多少"一起给
  //   用户原话：「很难升级到信任，甚至我不知道信任需要多少好感」。
  //   所以这条命令不再只回一句等级，直接把账摊开（机制数字 + 差距 + 估算次数）。
  define('qqbot.auth.me', [], '查看自己的权限等级，以及离"信任"还差多少好感度', GROUP, async ({ session }) => {
    const id = String(session?.userId ?? '')
    const lv = session.user?.authority ?? 1
    const d = resolveAffinityDynamics()
    const snap = await affinitySnapshot(id)
    return [
      `你的权限等级是 ${lv}（${LEVEL_NAMES[lv] ?? '未知'}）`,
      ``,
      `【好感度 → 信任】`,
      trustGapText(snap),
      ``,
      `（好感度区间：${d.demoteAt} 以下回「普通」/ ${d.promoteAt} 以上给「信任」；` +
        `这份账在 /favor 与 /short 里也能看到）`,
    ].join('\n')
  })

  // 看名单：/qqbot.auth.list —— ★ 顺带把当前生效的机制数字写出来
  define('qqbot.auth.list', [], '查看四级名单，以及好感度给信任的门槛', GROUP, async () => {
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

    const d = resolveAffinityDynamics()
    lines.push(
      '',
      '【好感度 → 信任（当前生效值）】',
      `  长期 ≥ ${d.promoteAt} → 信任（2）；≤ ${d.demoteAt} → 退回普通（1）`,
      `  短期攒到 ${d.promoteThreshold} → 长期 +${d.longTermPromoteStep}（降级线 ${d.demoteThreshold} → 长期 -${d.longTermDemoteStep}）`,
      `  也就是"长期每 +1"要 ${(d.promoteThreshold / Math.max(d.longTermPromoteStep, 1)).toFixed(1)} 点正面互动`,
      `  参数来源：${d.source}　·　scopeId：${d.scopeId}`,
      `  看某个人的进度：/qqbot.auth.set <QQ号>（只给 QQ 号不改任何东西）`
    )
    return lines.join('\n')
  })

  // 改等级：/qqbot.auth.set <QQ号> [等级]
  //
  // ★ 2026-10-09 两处改动，都是用户那句「数字太不直观了」：
  //   ① 等级位**认文本**（`信任` / `管理员` / `trust` …），数字仍然照收；
  //   ② **不给等级 = 只看不改**：回一份这个人的权限 + 好感度进度。
  //      以前想"看某人离信任还差多少"只能去查库，现在一条命令就够。
  // ★ 等级位从 `<level:natural>` 改成可选 `[level:string]`：natural 域会把非数字直接
  //   判成解析失败（走不到 handler），"认文本"就必须自己解析。
  define(
    'qqbot.auth.set <target:string> [level:string]',
    [],
    '设置某人的权限等级（认文本：拉黑/普通/信任/管理员/主人）；只给 QQ 号则只看不改',
    { authority: 4 },
    async ({ session }, target, levelRaw) => {
      const id = String(target ?? '').replace(/[^0-9]/g, '')
      if (!id) return '请给一个纯数字的 QQ 号。'

      // ---- 只看不改 ----
      if (levelRaw == null || String(levelRaw).trim() === '') {
        const snap = await affinitySnapshot(id)
        const row = await (async () => {
          try {
            return await ctx.get('database')?.getUser?.(session.platform ?? 'onebot', id)
          } catch {
            return null
          }
        })()
        const lv = Number(row?.authority)
        return [
          `【${id}】`,
          `权限等级：${Number.isFinite(lv) ? `${lv}（${LEVEL_NAMES[lv] ?? '未知'}）` : '（库里还没有记录，默认普通）'}`,
          `名单里吗：${['blockedIds', 'ownerIds', 'adminIds', 'trustedIds'].find((k) => set(cfg[k]).has(id)) ?? '不在任何名单'}`,
          ``,
          `【好感度 → 信任】`,
          trustGapText(snap),
          ``,
          `要改：/qqbot.auth.set ${id} <等级>（等级可写 0-4，也可写 拉黑/普通/信任/管理员/主人）`,
        ].join('\n')
      }

      // ---- 改 ----
      const level = parseLevelArg(levelRaw)
      if (level == null) {
        return `等级 "${String(levelRaw).trim()}" 不认识。可写 0-4，也可写文本：${LEVEL_MENU_TEXT}`
      }
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

  // ------------------------------------------------------------ 只读对外服务
  //
  // ★ 为什么要暴露：好感度桥的 `/favor`（affinity.inspect）是用户最常敲的那条，
  //   而"离信任还差多少"的计算要读 **qqbot-auth 自己的配置**（门槛 51/40 在这里，
  //   不在 affinity 里）。让桥去读 koishi.yml 就是两份实现、两个真相；
  //   这里给一个只读接口，桥那边只负责排版。
  // ★ 只读：`snapshot` 不改任何东西，`report` 只返回文本。桥拿不到服务时会自己降级。
  ctx.provide(SERVICE_NAME, {
    levels: { ...LEVEL_NAMES },
    levelLabel: (n) => LEVEL_NAMES[Number(n)] ?? '未知',
    dynamics: () => ({ ...resolveAffinityDynamics() }),
    snapshot: (userId) => affinitySnapshot(userId),
    report: async (userId) => trustGapText(await affinitySnapshot(userId)),
  })

  logger.info(
    '权限分级已挂载：主人 %d / 管理员 %d / 信任 %d / 拉黑 %d；危险指令提权 %s；启动后持续重扫 %d 秒',
    set(cfg.ownerIds).size,
    set(cfg.adminIds).size,
    set(cfg.trustedIds).size,
    set(cfg.blockedIds).size,
    cfg.raiseDangerousCommands ? '开' : '关',
    cfg.scanSeconds
  )

  // ★ 这一行必须走 logger.info（不受 debug 门控）：它是"我到底读到哪份好感度参数"的唯一证据。
  //   读不到 koishi.yml 时会显示"默认值"—— 那就是 /qqbot.auth.me 里数字不对的信号。
  ctx.on('ready', () => {
    ctx.setTimeout(() => {
      const d = resolveAffinityDynamics()
      logger.info(
        '好感度 → 信任参数：长期 ≥ %d 给信任 / ≤ %d 退回普通；短期 %d → 长期 +%d（来源：%s）',
        d.promoteAt,
        d.demoteAt,
        d.promoteThreshold,
        d.longTermPromoteStep,
        d.source
      )
      if (d.source === '默认值') {
        logger.warn('没读到 koishi.yml 的 affinityDynamics（%s）—— 展示的折算参数会是出厂默认值', d.source)
      }
    }, 3000)
  })

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
