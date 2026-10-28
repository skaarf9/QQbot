/**
 * koishi-plugin-chatluna-guard —— R15 群聊屏蔽开关（"立刻闭嘴"）
 *
 * 用户原始需求（2026-09-29）：
 *   「在拉入真实群之前，检查是否有屏蔽某个群聊的开关，因为进入新的群聊之后
 *     可能产生意料之外的结果，所以需要一个迅速响应的开关……
 *     需要做到我(2791932480)在需要屏蔽的群聊中发送指令后立刻停止该群的回复，
 *     同时，你自己也可以调用脚本停止」
 *
 * 用户澄清（2026-09-30，★ 这一条改了语义，别改回去）：
 *   「"/指令"应该由 bot 的逻辑代码处理，如果是模型被屏蔽了理应仍能收到命令，
 *     只是按照逻辑判断是否要回复」
 *   ⇒ 屏蔽的是**模型开口**，不是 **bot 的逻辑**。被静默的群里：
 *     · 真指令（带前缀 / @bot 跟指令名）照常解析执行，回不回由指令自己的逻辑决定
 *     · 普通聊天、@bot 闲聊、引用闲聊 → 一个字都不回
 *     · 模型产物（聊天回复、主动发言、跟进）→ 闸门 2/4 拦掉
 *     · 想连指令一起掐掉：把 allowCommandsWhenMuted 关掉（那就是整群死寂）
 *
 * ---
 * ★ 为什么要"立刻"就必须是同步判定
 *
 * 屏蔽态放在内存 Map 里（启动与每 refreshSeconds 从库里重载），中间件里**不查库**。
 * 指令 / HTTP / 脚本三条写入口都会**同时**改内存 + 库，所以生效是当次消息级别的，
 * 不存在"等一个轮询周期"。脚本直写库的兜底路径最慢 refreshSeconds 秒。
 *
 * ---
 * ★ 四道闸门（缺一道都有漏网路径，这是实测出来的）
 *
 * 1. **全局中间件（prepend）** —— 拦"用户发进来的消息"。
 *    Koishi 的中间件只有**一个全局数组**（Processor._hooks，core:730/737），
 *    `ctx.middleware(fn, true)` 是 unshift，所以只要在插件加载期注册就一定排第一，
 *    比 `attach`、指令派发、ChatLuna 都早。这里返回（不调 next）就是整条管线短路：
 *    不建库行、不解析指令、不触发回复。
 *
 * 2. **ChatLuna 链中间件 `.before('allow_reply')`** —— 拦"绕过 Koishi 管线的调用"。
 *    我们的 chatluna-proactive（还有任何自己调 `chatChain.receiveCommand` 的插件）
 *    **不走** Koishi 中间件，闸门 1 对它无效。链上返回 `STOP`(1) 会让整轮
 *    `_runMiddleware` 直接 return false（chains/index.cjs:178-190），一个字都不会发。
 *    `ChainMiddlewareRunStatus = { SKIPPED:0, STOP:1, CONTINUE:2 }`（chains:883-887）。
 *    ★ 链闸门只拦得住"还没开始的回合"。
 *
 * 3. **`before-send`（发送口）** —— 拦"已经在生成中"的那一轮。
 *    用户喊闭嘴时上一个回合可能正跑着（模型要 10~20 秒），那条回复会在闭嘴**之后**
 *    才冒出来（剧本 27 实测发生过）。`before-send` 是 `app.serial` 调的勾子
 *    （@satorijs/core:752），返回非空即取消发送；开关操作与指令自己的回复靠中间件
 *    打在 session 上的 `__guardControl` 标记放行。
 *
 * 4. **指令自己的 authority** —— 拦"授权"。闸门 1 对控制词**和真指令**都是放行的，
 *    权限判定交给 Koishi 的 `authority:N`（qqbot-auth 在 attach-user 里把主人抬到 4）。
 *
 * ---
 * ★ 为什么"裸词兜底"要放在 next() 之后
 *
 * 闸门 1 跑在 attach **之前**，那时候 session.user 还不存在 —— 任何"你是不是主人"
 * 的判断都会得到 1。所以没带前缀、也没 @ 的裸词（用户最可能顺手打的那种：
 * 直接打「开口」）走的是：**先 next() 让管线跑完**（attach 会把权限算好），
 * 再回头处理。这样非授权者得到的是**彻底静默**，而不是一句"权限不足"。
 * 副作用只有一个：裸词会让这条消息多跑一遍管线，但 bare 词既不是指令
 * （群里没前缀不解析）也不会触发 ChatLuna（allow_reply 要 @/引用/昵称），
 * 所以 next() 很快就返回了。
 *
 * ---
 * ★ 库里的既有开关（用户问"是否有屏蔽某个群聊的开关"，2026-09-29 查过）
 *
 *   · chatluna 本体：只有 per-channel 的 `chatluna_constraint`（锁模型/预设/开关新会话），
 *     **没有"这个群不回复"**。
 *   · chatluna-affinity：`chatluna_blacklist_v2` 是**拉黑某个人**，不是拉黑群。
 *   · chatluna-proactive：只有"监控哪些群"的白名单（反向），且只管主动发言。
 *   · chathub_room_member.mute 是 room 层的老表 —— 1.4.0 正式版把 room 层删了（见坑 21）。
 *   结论：**没有现成的**，所以这个插件是新写的。
 */
const { Schema, Logger } = require('koishi')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const name = 'chatluna-guard'
const inject = { required: ['database', 'server'], optional: ['chatluna'] }

/** 服务名：别的插件用 `ctx.qqbotGuard.isBlocked(session)` 问"这个群现在能不能说话" */
const SERVICE = 'qqbotGuard'
const TABLE = 'qqbot_guard'

const logger = new Logger('chatluna-guard')

// ------------------------------------------------------------------ 控制词
//
// ★ 命名约定（2026-10-02 起）：**指令名一律英文**，中文只作为「裸词触发」存在。
//
// 控制词有两条生效路径，两条都不占用指令命名空间：
//   1. 裸词：群里直接说「闭嘴」「开口」（不带前缀）→ 走 next() 之后的兜底
//   2. 带前缀：/闭嘴、/开口 —— 由 classify() 自己剥掉前缀后匹配，
//      **不注册成指令别名**（别名会出现在指令列表 / 补全菜单里，污染命令面）
//
// 这三组词会被中间件**原样放行**：被屏蔽的群里必须还能听见这几句，否则没法解封。

const ALLOW_WORDS = ['开口', '解除屏蔽', '解除静默', '允许本群']
const MUTE_WORDS = ['闭嘴', '屏蔽本群', '静默本群']
const STATUS_WORDS = ['屏蔽状态']
const LIST_WORDS = ['屏蔽列表']
const RESET_WORDS = ['清除屏蔽']
const CONTROL_WORDS = new Set(
  [...ALLOW_WORDS, ...MUTE_WORDS, ...STATUS_WORDS, ...LIST_WORDS, ...RESET_WORDS].map((w) =>
    w.toLowerCase()
  )
)

const Config = Schema.intersect([
  Schema.object({
    enabled: Schema.boolean().default(true).description('总开关'),
    defaultPolicy: Schema.union([
      Schema.const('silent').description(
        '静默：不在白名单里的群一律不回复（新群拉进来绝对安全，要先说「开口」或发 /guard.allow 才会说话）'
      ),
      Schema.const('open').description('放行：默认正常回复，只静默被显式屏蔽的群'),
    ])
      .default('silent')
      .description('没被显式设置过的群怎么处理'),
    allowGroups: Schema.array(String)
      .role('table')
      .default([])
      .description('预置白名单（群号）。只有 defaultPolicy=silent 时才需要它'),
    muteGroups: Schema.array(String)
      .role('table')
      .default([])
      .description('预置黑名单（群号）。比 guard.mute 更早生效，进群前就能先写好'),
    applyToPrivate: Schema.boolean()
      .default(false)
      .description('私聊是否也受这套开关管（默认不管 —— 私聊本来就只跟你说话）'),
    controlAuthority: Schema.natural()
      .default(3)
      .description('开关本群需要的最低等级（默认 3 管理员；主人是 4，永远够）'),
    bareKeywords: Schema.boolean()
      .default(true)
      .description('允许不带前缀、不 @ 直接打「开口 / 闭嘴」（推荐开，被屏蔽时最省事）'),
    allowCommandsWhenMuted: Schema.boolean()
      .default(true)
      .description(
        '被静默的群里，**指令**是否照常执行。开着 = 屏蔽的只是"模型开口"，' +
          'bot 的逻辑代码（开关、查询、管理指令）照常工作，是否回复由指令自己的逻辑决定；' +
          '关掉 = 连指令都不解析，整群彻底死寂'
      ),
    confirmSeconds: Schema.natural()
      .default(5)
      .description('同一个群开关提示的冷却（秒），防止连点刷屏'),
    refreshSeconds: Schema.natural()
      .default(10)
      .description('从数据库重载屏蔽态的周期（秒）。0 = 只在启动时读一次'),
    debug: Schema.boolean().default(true).description('打印每次判定与开关'),
  }),
  Schema.object({
    outboundEnabled: Schema.boolean()
      .default(true)
      .description(
        '★ 出站令牌桶（防限流总闸）。所有出站消息都经过 before-send，' +
          '所以这里是**唯一**能拦住"普通回复 / 主动插话 / 跟进"全部路径的地方。' +
          '2026-10-02 真群刷屏被腾讯限流（retcode 1200）后补的总兜底'
      ),
    outboundBurst: Schema.natural()
      .default(3)
      .description('桶容量：一个群短时间内最多连发几条（突发额度）。默认 3'),
    outboundPerMinute: Schema.natural()
      .default(12)
      .description('每分钟补充分额度。默认 12（≈ 每 5 秒 1 条）'),
    outboundMinGapSeconds: Schema.natural()
      .default(3)
      .description(
        '★ 同一个群里两条出站消息之间的**最小间隔**（秒），0 = 不限。' +
          '令牌桶管"总量"（桶空就丢），这一条管"节奏"（排队等，不丢）—— 两者互补：' +
          '桶容量 3 只保证"最多 3 条能挤出去"，不保证它们不挤在一起；' +
          '加上这个间隔，同一波回复会按 3 秒一条铺开，' +
          '既不会连发被腾讯限流（retcode 1200），也不会让 NapCat 同时压着几条 send 排队到超时。' +
          '2026-10-03 用户要求补的：「既确保不会短时间回复多条，也确保不会调用 api 超时」'
      ),
    outboundGapMaxWaitSeconds: Schema.natural()
      .default(30)
      .description(
        '排队等间隔的上限（秒）：等这么久还轮不到就**丢掉**这条（安全阀）。' +
          '正常永远碰不到 —— 桶容量最大 6、间隔最长几秒，队伍最多排十几秒'
      ),
    outboundApplyToPrivate: Schema.boolean()
      .default(false)
      .description('私聊是否也限速（默认不管 —— 私聊只有你，没必要限）'),
    outboundExemptCommands: Schema.boolean()
      .default(true)
      .description(
        '★ 指令驱动的回复**不占配额、也不排队**。令牌桶与最小间隔都是防「模型刷屏」的，' +
          '而 /help、/guard.status 这类回复是**用户主动要的**，条数和时机都由人控制，' +
          '把它算进配额会让帮助页在真群里发不出去。' +
          '判定依据是 `session.argv.command`（Koishi 解析出指令时才会有的字段），' +
          '所以只放行真指令，模型回复、主动插话、跟进一律照旧受限。'
      ),
    outboundGroups: Schema.array(
      Schema.object({
        guildId: Schema.string().description('群号'),
        burst: Schema.natural().description('该群桶容量（留空用全局）'),
        perMinute: Schema.natural().description('该群每分钟补充（留空用全局）'),
        minGap: Schema.natural().description('该群两条消息的最小间隔秒数（留空用全局）'),
      })
    )
      .role('table')
      .default([])
      .description('按群覆盖令牌桶参数（真群配紧一点，测试群可以松）'),
  }),
  Schema.object({
    token: Schema.string()
      .default('')
      .description(
        '控制口令牌。留空 = 每次启动随机生成，并写到 data/guard-control.json（脚本自己读，不用你抄）'
      ),
    controlPath: Schema.string().default('/qqbot/guard').description('控制口路径'),
    controlFile: Schema.string()
      .default('')
      .description('控制信息落地文件。留空 = <baseDir>/data/guard-control.json'),
  }),
])

// ------------------------------------------------------------------ 小工具

const setOf = (v) =>
  new Set(
    (Array.isArray(v) ? v : v == null || v === '' ? [] : [v])
      .map((x) => String(x).trim())
      .filter(Boolean)
  )

const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '-')

function ago(ts) {
  if (!ts) return '-'
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return `${s} 秒前`
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`
  return `${Math.round(s / 86400)} 天前`
}

// ------------------------------------------------------------------ 应用

function apply(ctx, config) {
  const cfg = {
    enabled: true,
    defaultPolicy: 'silent',
    allowGroups: [],
    muteGroups: [],
    applyToPrivate: false,
    controlAuthority: 3,
    bareKeywords: true,
    confirmSeconds: 5,
    refreshSeconds: 10,
    debug: true,
    outboundEnabled: true,
    outboundBurst: 3,
    outboundPerMinute: 12,
    outboundMinGapSeconds: 3,
    outboundGapMaxWaitSeconds: 30,
    outboundApplyToPrivate: false,
    outboundExemptCommands: true,
    outboundGroups: [],
    token: '',
    controlPath: '/qqbot/guard',
    controlFile: '',
    ...(config ?? {}),
  }

  const log = (...a) => cfg.debug && logger.info(...a)

  // ★ 必须先注册表模型，否则 `ctx.database.get('qqbot_guard')` 直接抛
  //   `cannot resolve table "qqbot_guard"`（踩过：忘了这段，所有写入全静默失败）
  ctx.model.extend(
    TABLE,
    {
      scopeKey: { type: 'string', length: 160 },
      platform: { type: 'string', length: 32, nullable: true },
      channelId: { type: 'string', length: 128, nullable: true },
      guildId: { type: 'string', length: 128, nullable: true },
      state: { type: 'string', length: 8, initial: 'mute' },
      reason: { type: 'text', nullable: true },
      operatorId: { type: 'string', length: 128, nullable: true },
      via: { type: 'string', length: 16, nullable: true },
      updatedAt: { type: 'timestamp', nullable: true },
    },
    { primary: ['scopeKey'] }
  )

  /** key -> { state, reason, operatorId, via, updatedAt(ms), channelId, guildId } */
  const states = new Map()
  /** key -> 上次提示时间（冷却） */
  const lastConfirm = new Map()

  // ---------------------------------------------------------- 出站令牌桶（防限流总闸）
  //
  // 为什么放在这里：`before-send` 是所有出站消息的**唯一必经之路**
  // （普通 @ 回复、R9 主动插话、chatluna-followup 的跟进、指令回执……全部经过它）。
  // 2026-10-02 真群 1040488785 放行后 2 分半发了 20 条被腾讯限流（retcode 1200）；
  // 当时只给 followup 补了"整群熔断"，但 proactive / 普通回复仍然没有总闸。
  // 这里补上按群的口径：**凡是按人的上限，群里都要再配一个按群的总闸**（坑 29 的教训）。
  //
  // 经典令牌桶：容量 burst（允许的突发条数），按 perMinute 匀速补充。
  // 桶空了就丢这条（返回 true 取消发送），并打一行 warn —— 丢消息比被腾讯封号强。
  //
  // ★ 2026-10-03：这里成了**整群唯一的限流规则**。
  //   用户问「整群熔断还有必要吗」——没必要，它和这个桶在干同一件事。followup 那套
  //   固定窗口计数（`groupMaxPerWindow`）已经删掉，改成入站时来问这里的 `peek()`。
  //   规则因此只剩一句：**按时间补令牌，补满为止；桶空了就不说话**。
  //   附带的好处：直接 @ bot 的对话和主动插话、跟进共用同一个桶 —— 人主动要的回复
  //   天然优先，bot 自己找话说的那部分先被饿死，这个优先级正是想要的。
  //
  // ★ 同日晚些时候（第四轮）用户又追问「没有限制短时间能回复的上限 / 回复之间的间隔」，
  //   于是同一个文件里补了第二半：**最小间隔（排队式）**。两者合起来才是完整的出站规则：
  //       令牌桶  = 一小时内能说多少（总量，多了就丢）
  //       最小间隔 = 每条之间至少隔多久（节奏，排队等）
  //   实现见下面 claimGap / waitForGap。
  const outboundBuckets = new Map() // key -> { tokens, last }
  const outboundDrops = new Map() // key -> { count, lastAt } 仅用于观测
  const outboundOverride = new Map() // guildId -> { burst, perMinute, minGap }

  for (const g of Array.isArray(cfg.outboundGroups) ? cfg.outboundGroups : []) {
    const gid = String(g?.guildId ?? '').trim()
    if (!gid) continue
    outboundOverride.set(gid, {
      burst: Number(g.burst) > 0 ? Number(g.burst) : cfg.outboundBurst,
      perMinute: Number(g.perMinute) > 0 ? Number(g.perMinute) : cfg.outboundPerMinute,
      minGap: Number(g.minGap) >= 0 && g.minGap !== '' && g.minGap != null ? Number(g.minGap) : cfg.outboundMinGapSeconds,
    })
  }

  function bucketParams(groupId) {
    const o = outboundOverride.get(String(groupId))
    return {
      burst: o?.burst ?? cfg.outboundBurst,
      perMinute: o?.perMinute ?? cfg.outboundPerMinute,
      minGap: o?.minGap ?? cfg.outboundMinGapSeconds,
    }
  }

  /** 取一个令牌。true = 放行，false = 超速，应丢弃 */
  function takeOutboundToken(groupId) {
    const key = String(groupId)
    const { burst, perMinute } = bucketParams(key)
    if (!(burst > 0) || !(perMinute > 0)) return true

    const now = Date.now()
    let b = outboundBuckets.get(key)
    if (!b) {
      // 首次见到这个群：直接给满桶（否则第一条消息就会被误杀）
      b = { tokens: burst, last: now }
      outboundBuckets.set(key, b)
    }
    const ratePerMs = perMinute / 60000
    b.tokens = Math.min(burst, b.tokens + (now - b.last) * ratePerMs)
    b.last = now

    if (b.tokens >= 1) {
      b.tokens -= 1
      return true
    }
    const d = outboundDrops.get(key) || { count: 0, lastAt: 0 }
    d.count += 1
    d.lastAt = now
    outboundDrops.set(key, d)
    return false
  }

  /** 观测用：把桶状态整理成一行字 */
  function bucketText(groupId) {
    const key = String(groupId)
    const { burst, perMinute, minGap } = bucketParams(key)
    const b = outboundBuckets.get(key)
    const d = outboundDrops.get(key)
    const g = outboundGapStats.get(key)
    const tokens = b ? b.tokens : burst
    return `群 ${key}：剩余 ${tokens.toFixed(2)} / ${burst} 个令牌（每分钟补 ${perMinute}）` +
      `｜最小间隔 ${minGap > 0 ? `${minGap}s` : '不限'}` +
      (g && g.count ? `（已排队 ${g.count} 次，上次等了 ${(g.lastWaitMs / 1000).toFixed(1)}s）` : '') +
      (d ? `｜累计丢弃 ${d.count} 条` : '')
  }

  // ---------------------------------------------------------- 出站最小间隔（排队式限流）
  //
  // ★ 为什么令牌桶之外还要这一条（用户 2026-10-03 第四轮的追问）：
  //   「令牌桶虽然给群聊添加了限制，但似乎没有限制短时间能够回复的上限？就是每个回复之间的
  //     间隔，既确保不会短时间回复多条，也确保不会调用 api 超时」
  //   —— 说得对。令牌桶是**容量**语义：容量 3 的意思正是"头 3 条可以立刻一起冲出去"。
  //   它拦得住"第 4、5、6 条"，拦不住"前 3 条挤在同一秒"。而 QQ 侧真正会炸的是**瞬时并发**：
  //   retcode 1200（发送过于频繁）与 NapCat 的 send 请求排队到超时，都是这个形态。
  //
  // ★ 分工（两条规则互不替代，也别合成一条）：
  //     令牌桶   → 总量：桶空就**丢**消息，宁可少说也不刷屏
  //     最小间隔 → 节奏：**排队等**，不丢消息（模型已经花过钱的回复不该被静默扔掉）
  //
  // ★ 排队怎么做到"不并发"：before-send 这一层**可能同时进来好几条**（一轮回复拆成多条、
  //   主动插话与跟进撞在一起）。所以不能只记一个"上次发送时刻"就完事 —— 那样两条并发的
  //   消息会读到同一个时刻、又同时发出去。这里的做法是**先占坑再等待**：
  //   用一条 per-群 的 promise 链把"读 nextAt → 写 nextAt"串行化，谁先占到谁先走，
  //   后面那条拿到的是"前一条的时刻 + 间隔"，于是自然排成一队。
  //
  // ★ 上限：等超过 outboundGapMaxWaitSeconds 就丢掉这条（安全阀）。正常碰不到：
  //   桶容量最大 6、间隔最长几秒，队伍最多排十几秒。
  const outboundGapNextAt = new Map() // key -> 下一次允许发送的时刻
  const outboundGapChain = new Map() // key -> promise，用来串行化"占坑"
  const outboundGapStats = new Map() // key -> { count, lastWaitMs } 仅用于观测

  /**
   * 占一个发送坑位。返回 { wait, at }：
   *   wait >= 0 → 等这么多毫秒再发（0 = 立刻发）
   *   wait <  0 → 队伍太长，调用方应该**丢掉**这条
   */
  function claimGap(key) {
    const prev = outboundGapChain.get(key) ?? Promise.resolve()
    const job = prev.then(() => {
      const { minGap } = bucketParams(key)
      const gapMs = Math.max(0, Number(minGap) || 0) * 1000
      const now = Date.now()
      const at = Math.max(now, outboundGapNextAt.get(key) ?? 0)
      const wait = at - now
      if (!gapMs) return { wait: 0, at: now }
      if (wait > cfg.outboundGapMaxWaitSeconds * 1000) return { wait: -1, at }
      outboundGapNextAt.set(key, at + gapMs)
      return { wait, at }
    })
    // 链子本身不能因为某次异常断掉（断了后面所有消息都会卡在旧 promise 上）
    outboundGapChain.set(
      key,
      job.then(
        () => {},
        () => {}
      )
    )
    return job
  }

  /** 按最小间隔排队；返回 false = 该丢（队伍太长） */
  async function waitForGap(key) {
    const { minGap } = bucketParams(key)
    if (!(Number(minGap) > 0)) return true
    const { wait } = await claimGap(key)
    if (wait < 0) {
      logger.warn(
        '出站排队过长（超过 %ds），丢弃一条：%s',
        cfg.outboundGapMaxWaitSeconds,
        bucketText(key)
      )
      return false
    }
    if (wait > 0) {
      const st = outboundGapStats.get(key) || { count: 0, lastWaitMs: 0 }
      st.count += 1
      st.lastWaitMs = wait
      outboundGapStats.set(key, st)
      // ★ 别用 `%.1f` —— Koishi 的 logger 走的是 Node 的 util.format，**不支持精度**，
      //   那样会打出「等 %.1fs 再发 1.764」这种半截话（rig 51 实测踩到）。先 toFixed 再用 %s。
      if (wait >= 1000) logger.info('出站排队：群 %s 等 %ss 再发', key, (wait / 1000).toFixed(1))
      await new Promise((r) => setTimeout(r, wait))
    }
    return true
  }

  /**
   * 只看不扣：现在这个群还发得出话吗？
   *
   * ★ 为什么需要它（2026-10-03，用户问「熔断机制还有必要吗」之后合并出来的）
   *   followup 原本自己有一套"整群熔断"（固定时间窗计数），和这个令牌桶**做的是同一件事**，
   *   但算法更差（固定窗口能跨边界连发 2×limit 条），还得单独配一遍参数。
   *   现在整群里只剩下这一道闸：**按时间补令牌，除此之外没有别的限流规则**（用户原话）。
   *
   *   那 followup 为什么还要"看"一眼？因为令牌桶挂在 `before-send` 上，是**出站**才拦的 ——
   *   等它拦下来时，模型已经跑完、钱已经花了。提前 peek 一下，桶空了就干脆不接这句话，
   *   省掉一次白跑的模型调用。**只 peek 不扣**：真正扣令牌的还是 `before-send` 那一处，
   *   两处都扣会让额度凭空减半。
   */
  function peekOutboundToken(groupId) {
    const key = String(groupId)
    const { burst, perMinute } = bucketParams(key)
    if (!(burst > 0) || !(perMinute > 0)) return true
    const b = outboundBuckets.get(key)
    if (!b) return true // 还没发过话 = 满桶
    const tokens = Math.min(burst, b.tokens + (Date.now() - b.last) * (perMinute / 60000))
    return tokens >= 1
  }

  // ---------------------------------------------------------- 作用域与判定

  const platformOf = (session) => session?.platform || 'onebot'
  const groupIdOf = (session) =>
    session == null ? '' : String(session.channelId ?? session.guildId ?? '')

  function keyOf(session) {
    if (!session) return null
    if (session.isDirect) return `${platformOf(session)}:direct:${session.userId}`
    const gid = groupIdOf(session)
    return gid ? `${platformOf(session)}:channel:${gid}` : null
  }

  /** 显式设置过的状态行（没有就返回 null = 走默认策略） */
  function rowOf(session) {
    const key = keyOf(session)
    if (key && states.has(key)) return states.get(key)
    // 兜底：有的适配器 channelId/guildId 不一致，两个都试
    const gid = groupIdOf(session)
    if (gid) {
      const alt = `${platformOf(session)}:channel:${gid}`
      if (states.has(alt)) return states.get(alt)
    }
    return null
  }

  const allowSet = setOf(cfg.allowGroups)
  const muteSet = setOf(cfg.muteGroups)

  /** 库里的状态是否已经读出来过（`isAllowed` 靠它区分"没屏蔽"与"还不知道"） */
  let ready = false

  /**
   * ★ 同步判定：这个会话现在被屏蔽了吗。
   *   热路径上**不查库**，所以是当次消息级别生效。
   */
  function isBlocked(session) {
    if (!cfg.enabled) return false
    if (!session) return false
    if (session.userId != null && String(session.userId) === String(session.selfId)) return false
    if (session.isDirect && !cfg.applyToPrivate) return false

    const row = rowOf(session)
    if (row) return row.state === 'mute'
    if (session.isDirect) return false

    const gid = groupIdOf(session)
    if (gid && muteSet.has(gid)) return true
    if (gid && allowSet.has(gid)) return false
    return cfg.defaultPolicy === 'silent'
  }

  function describe(session) {
    if (!session) return '（未知会话）'
    return session.isDirect
      ? `私聊 ${session.userId}`
      : `群 ${groupIdOf(session) || '?'}`
  }

  // ---------------------------------------------------------- 库读写

  let lastWarnAt = 0

  async function reload(quiet) {
    try {
      const rows = await ctx.database.get(TABLE, {})
      const before = states.size
      states.clear()
      for (const r of rows) {
        if (!r?.scopeKey) continue
        states.set(r.scopeKey, {
          ...r,
          updatedAt: r.updatedAt ? new Date(r.updatedAt).getTime() : 0,
        })
      }
      if (!quiet || before !== states.size) log('屏蔽态已重载：%d 条', states.size)
      // ★ 只有真的读到库了才算 ready。放在 catch 里是不行的：读失败时"没有屏蔽记录"
      //   是个假象，这时候放行会让别人按错的答案做决定（所以失败就继续 ready=false）。
      ready = true
    } catch (e) {
      // 表还没建好 / 数据库刚重启时会走到这里，别刷屏（每分钟最多一条）
      const now = Date.now()
      if (now - lastWarnAt > 60_000) {
        lastWarnAt = now
        logger.warn('读 %s 失败：%s', TABLE, e.message)
      }
    }
  }

  /** 写入一条状态（内存 + 库，同步生效） */
  async function writeState(scopeKey, patch) {
    const old = states.get(scopeKey) ?? {}
    const row = {
      ...old,
      ...patch,
      scopeKey,
      updatedAt: new Date(),
    }
    delete row.id
    await ctx.database.upsert(TABLE, [row])
    states.set(scopeKey, { ...row, updatedAt: Date.now() })
    return states.get(scopeKey)
  }

  async function removeState(scopeKey) {
    await ctx.database.remove(TABLE, { scopeKey })
    states.delete(scopeKey)
  }

  /** 按群号找 key（脚本/指令只给群号时用） */
  function keyOfGroup(platform, groupId) {
    const gid = String(groupId).trim()
    for (const [k, v] of states) {
      if (String(v.channelId ?? '') === gid || String(v.guildId ?? '') === gid) return k
    }
    return `${platform || 'onebot'}:channel:${gid}`
  }

  async function setGroup(groupId, state, meta = {}) {
    const gid = String(groupId ?? '').trim()
    if (!gid) throw new Error('没给群号')
    const platform = meta.platform || 'onebot'
    const key = keyOfGroup(platform, gid)
    return writeState(key, {
      platform,
      channelId: gid,
      guildId: gid,
      state,
      reason: meta.reason ?? null,
      operatorId: meta.operatorId != null ? String(meta.operatorId) : null,
      via: meta.via ?? 'command',
    })
  }

  async function resetGroup(groupId, meta = {}) {
    const gid = String(groupId ?? '').trim()
    if (!gid) throw new Error('没给群号')
    const key = keyOfGroup(meta.platform || 'onebot', gid)
    const had = states.get(key)
    await removeState(key)
    return had ?? null
  }

  /** 写库包一层：失败不能悄悄过去（否则用户以为已经闭嘴了，其实还在说） */
  async function tryWrite(fn) {
    try {
      return { ok: true, value: await fn() }
    } catch (e) {
      logger.warn('写屏蔽态失败：%s', e.message)
      return { ok: false, error: e.message }
    }
  }

  // ---------------------------------------------------------- HTTP 控制口

  const token = cfg.token || crypto.randomBytes(12).toString('hex')
  const controlFile =
    cfg.controlFile || path.join(ctx.baseDir ?? process.cwd(), 'data', 'guard-control.json')

  function statusPayload() {
    const rows = [...states.values()]
      .map((r) => ({
        groupId: r.channelId ?? r.guildId ?? '',
        platform: r.platform ?? 'onebot',
        state: r.state,
        reason: r.reason ?? '',
        operatorId: r.operatorId ?? '',
        via: r.via ?? '',
        updatedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : null,
      }))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    return {
      ok: true,
      enabled: cfg.enabled,
      defaultPolicy: cfg.defaultPolicy,
      applyToPrivate: cfg.applyToPrivate,
      controlAuthority: cfg.controlAuthority,
      allowGroups: [...allowSet],
      muteGroups: [...muteSet],
      groups: rows,
      blockedCount: rows.filter((r) => r.state === 'mute').length,
    }
  }

  async function handleControl(req) {
    const action = String(req.action ?? 'status').toLowerCase()
    const groupId = req.groupId ?? req.group ?? req.channelId ?? ''
    const platform = req.platform ?? 'onebot'
    const reason = req.reason ?? `脚本（${req.by ?? 'mcp'}）`

    if (action === 'status' || action === 'list') return statusPayload()
    if (action === 'mute' || action === 'allow') {
      if (!groupId) return { ok: false, error: '缺 groupId' }
      const row = await setGroup(groupId, action === 'mute' ? 'mute' : 'allow', {
        platform,
        reason,
        operatorId: req.by ?? 'script',
        via: 'http',
      })
      logger.info(
        '[HTTP] 群 %s → %s（%s）',
        String(groupId),
        row.state === 'mute' ? '静默' : '放行',
        reason
      )
      return { ok: true, groupId: String(groupId), state: row.state, ...statusPayload() }
    }
    if (action === 'reset') {
      if (!groupId) return { ok: false, error: '缺 groupId' }
      await resetGroup(groupId, { platform })
      logger.info('[HTTP] 群 %s → 回到默认策略（%s）', String(groupId), cfg.defaultPolicy)
      return { ok: true, groupId: String(groupId), state: `default:${cfg.defaultPolicy}` }
    }
    return { ok: false, error: `不认识的 action：${action}` }
  }

  function readReq(koa) {
    const body = koa.request?.body
    const q = koa.query ?? {}
    return {
      token: koa.request?.headers?.['x-guard-token'] ?? body?.token ?? q.token ?? '',
      action: body?.action ?? q.action,
      groupId: body?.groupId ?? body?.group ?? q.groupId ?? q.group,
      platform: body?.platform ?? q.platform,
      reason: body?.reason ?? q.reason,
      by: body?.by ?? q.by,
    }
  }

  const route = async (koa) => {
    const req = readReq(koa)
    if (String(req.token ?? '') !== token) {
      koa.status = 403
      koa.body = { ok: false, error: 'token 不对' }
      return
    }
    try {
      koa.body = await handleControl(req)
    } catch (e) {
      koa.status = 500
      koa.body = { ok: false, error: e.message }
    }
  }

  ctx.server.get(cfg.controlPath, route)
  ctx.server.post(cfg.controlPath, route)

  ctx.on('ready', () => {
    try {
      fs.mkdirSync(path.dirname(controlFile), { recursive: true })
      fs.writeFileSync(
        controlFile,
        JSON.stringify(
          {
            port: ctx.server?.port ?? null,
            host: ctx.server?.host ?? '127.0.0.1',
            path: cfg.controlPath,
            token,
            updatedAt: new Date().toISOString(),
          },
          null,
          2
        )
      )
      log('控制信息已写到 %s', controlFile)
    } catch (e) {
      logger.warn('写控制信息失败：%s', e.message)
    }
  })

  // ---------------------------------------------------------- 闸门 1：全局中间件

  /** 指令前缀（顶层 prefix 配置，可能是数组也可能被写成字符串） */
  function commandPrefixes() {
    const p = ctx.root?.config?.prefix
    if (Array.isArray(p)) return p.filter(Boolean)
    if (typeof p === 'string' && p) return [...p]
    return []
  }

  /** 这条消息 @ 了 bot 吗 */
  function hasAtSelf(session) {
    return !!session.elements?.some(
      (el) => el?.type === 'at' && String(el?.attrs?.id) === String(session.selfId)
    )
  }

  /** 去掉前缀 / 去掉 @ 之后的"用户实际敲的东西" */
  function textOf(session) {
    const raw = String(session.content ?? '').trim()
    if (!raw) return { text: '', bare: false, prefixed: false }
    const hit = commandPrefixes().find((x) => raw.startsWith(x))
    if (hit) return { text: raw.slice(hit.length).trim(), bare: false, prefixed: true }
    if (hasAtSelf(session)) {
      const s = String(session.stripped?.content ?? '').trim()
      // stripped 有时会把 @ 保留成 <at .../>，兜底再洗一遍
      return { text: s.replace(/<at[^>]*>/g, '').trim(), bare: false, prefixed: false }
    }
    return { text: raw, bare: true, prefixed: false }
  }

  /**
   * 这条消息是不是**真实存在的指令**？是就返回指令名（给日志用），不是返回 null。
   *
   * ★ 为什么必须查一次指令表而不是"看到前缀就算"：
   *   被静默的群里，用户随手打的 `/随便什么` 不该让 Koishi 冒出"指令不存在"之类的回执
   *   —— 静默就是静默，只有真指令才放行。
   */
  function commandName(session) {
    const { text, prefixed } = textOf(session)
    if (!text) return null
    if (!prefixed && !hasAtSelf(session)) return null // 裸词不当指令（群里本来也要前缀才解析）
    const word = text.split(/\s+/)[0]?.toLowerCase()
    if (!word) return null
    const cmd = ctx.$commander?.get?.(word)
    return cmd ? cmd.name || word : null
  }

  /** 控制词识别。返回 { kind, bare } —— bare 表示"没前缀也没 @"（走 next() 之后的兜底） */
  function classify(session) {
    const { text, bare } = textOf(session)
    if (!text) return null
    if (bare && !cfg.bareKeywords) return null

    // 剥掉可能的前缀（/ ／ ! ！ . 。）后再匹配：
    // 控制词**故意不注册成指令别名**（别名会污染指令列表），所以 /闭嘴 这种写法
    // 走不到 Commander，只能在这里自己认。
    const word = text
      .split(/\s+/)[0]
      .toLowerCase()
      .replace(/^[/／!！.。]+/, '')
    if (!CONTROL_WORDS.has(word)) return null
    if (ALLOW_WORDS.includes(word)) return { kind: 'allow', bare }
    if (MUTE_WORDS.includes(word)) return { kind: 'mute', bare }
    if (STATUS_WORDS.includes(word)) return { kind: 'status', bare }
    if (LIST_WORDS.includes(word)) return { kind: 'list', bare }
    if (RESET_WORDS.includes(word)) return { kind: 'reset', bare }
    return null
  }

  async function confirm(session, text) {
    const key = keyOf(session) ?? '?'
    const now = Date.now()
    if (now - (lastConfirm.get(key) ?? 0) < cfg.confirmSeconds * 1000) return
    lastConfirm.set(key, now)
    try {
      await session.send(text)
    } catch (e) {
      logger.warn('提示发送失败：%s', e.message)
    }
  }

  /** 裸词兜底：管线已经跑完（权限已算好），这里才做真正的授权判定 */
  async function handleBare(session, kind) {
    try {
      await handleBareInner(session, kind)
    } catch (e) {
      // 写库失败必须让人看见 —— 否则用户以为"已经闭嘴了"，其实还在说
      logger.warn('裸词处理失败（%s）：%s', kind, e.message)
      await confirm(session, `开关没改成：${e.message}`)
    }
  }

  async function handleBareInner(session, kind) {
    const auth = Number(session.user?.authority ?? 1)
    if (session.isDirect) {
      // 私聊里没有"本群"可言，必须显式给群号（/guard.mute 123456），裸词一律不处理
      if (auth >= cfg.controlAuthority) {
        await confirm(session, '私聊里要带上群号，比如：/guard.mute 123456')
      }
      return
    }
    if (kind === 'status') {
      await confirm(session, statusText(session))
      return
    }
    if (auth < cfg.controlAuthority) {
      log('裸词 %s 被忽略：%s 的权限 %d < %d', kind, session.userId, auth, cfg.controlAuthority)
      return
    }
    if (kind === 'allow') {
      await setGroup(groupIdOf(session), 'allow', {
        platform: platformOf(session),
        reason: '群内开口',
        operatorId: session.userId,
        via: 'keyword',
      })
      logger.info('群 %s 由 %s 解除静默（裸词）', groupIdOf(session), session.userId)
      await confirm(session, '好，我回来了。要我再闭嘴就发：/guard.mute（或直接说「闭嘴」）')
    } else if (kind === 'mute') {
      await setGroup(groupIdOf(session), 'mute', {
        platform: platformOf(session),
        reason: '群内闭嘴',
        operatorId: session.userId,
        via: 'keyword',
      })
      logger.info('群 %s 由 %s 静默（裸词）', groupIdOf(session), session.userId)
      await confirm(session, '好，这个群我先不说话了。要恢复就发：/guard.allow（或直接说「开口」）')
    }
  }

  ctx.middleware(async (session, next) => {
    try {
      if (!cfg.enabled) return next()
      if (session.isDirect && !cfg.applyToPrivate) return next()
      if (String(session.userId) === String(session.selfId)) return next()

      const blocked = isBlocked(session)
      const cls = classify(session)

      // ---- 没被屏蔽 ----
      // 带前缀 / 带 @ 的控制词交给指令系统（权限由 authority 声明卡）；
      // 只有"裸词"（用户顺手直接打「闭嘴」）需要我兜底 —— 走 next() 之后再判定权限，
      // 这样没权限的人得到的是完全静默，而不是一句"权限不足"。
      if (!blocked) {
        if (cls?.bare) {
          log('裸词兜底（未屏蔽）：%s｜%s', describe(session), cls.kind)
          session.__guardControl = cls.kind
          const out = await next()
          await handleBare(session, cls.kind)
          return out
        }
        return next()
      }

      // ---- 被屏蔽：模型不许开口，但 bot 的逻辑（指令）照常工作 ----
      //
      // ★ 用户 2026-09-30 明确要求："指令应该由 bot 的逻辑代码处理，
      //   如果是模型被屏蔽了理应仍能收到命令，只是按照逻辑判断是否要回复"。
      //   所以这里的顺序是：控制词 → 真指令 → 其余一律丢弃。
      //   指令走到指令系统里，回复与否由**每条指令自己的逻辑**决定；
      //   而被屏蔽的只是"模型开口"（闸门 2 链 + 闸门 4 发送口会拦住模型产物）。

      // 1) 控制词
      if (cls) {
        // 打标：这条会话是"开关操作"，它的回复（含指令的返回值）必须放出去，见闸门 4。
        // 标记加在 session 对象上，因为 MessageEncoder 用的就是同一个对象。
        session.__guardControl = cls.kind
        if (cls.bare) {
          log('静默中收到裸词：%s｜%s', describe(session), cls.kind)
          const out = await next()
          await handleBare(session, cls.kind)
          return out
        }
        // 带前缀的控制词放行给指令系统 —— 权限判定在 attach 之后，非授权者会看到
        // 一句"权限不足"。这是有意的取舍：控制词本身是显式操作，不是"意料之外的输出"。
        log('静默中放行控制词（交给指令系统判定权限）：%s｜%s', describe(session), cls.kind)
        return next()
      }

      // 2) 真指令（带前缀 / @bot 跟上指令名）—— 逻辑照跑
      if (cfg.allowCommandsWhenMuted) {
        const cmdName = commandName(session)
        if (cmdName) {
          session.__guardControl = `command:${cmdName}`
          logger.info(
            '静默中放行指令 %s（%s）：屏蔽只拦模型开口，逻辑照常执行',
            cmdName,
            describe(session)
          )
          return next()
        }
      }

      // 3) 其余：彻底静默
      log('静默丢弃：%s｜%s', describe(session), String(session.content ?? '').slice(0, 40))
      return
    } catch (e) {
      logger.warn('屏蔽判定出错（放行）：%s', e.message)
      return next()
    }
  }, true)

  // ---------------------------------------------------------- 指令标记（给闸门 4 用）
  //
  // 在指令真要执行时往 session 上打一个**普通赋值**的标记。必须是普通赋值：出站编码器
  // 只复制可枚举键（@satorijs/core:739-742），`session.argv` 那种 defineProperty 挂的
  // 属性到不了 before-send。属性名带 `__guard` 前缀，和 `__guardControl` 保持一致。
  ctx.before('command/execute', (argv) => {
    const s = argv?.session
    if (s && argv?.command) s.__guardIsCommand = argv.command.name || 'command'
  })

  // ---------------------------------------------------------- 闸门 4：发送口
  //
  // 拦住"已经在生成中"的那一轮回复。为什么非要有这道：
  // 用户说「闭嘴」时，上一个回合可能正在跑（模型要 10~20 秒），那条回复会在他闭嘴
  // **之后**才冒出来 —— 剧本 27 实测真的发生过（第 8 步闭嘴之后 3 秒，bot 又说了
  // 一句"在，但不太想理你。"）。前两道闸门都拦不住它：回合已经开始了。
  //
  // 挂在 `before-send`（@satorijs/core:752 用 `app.serial` 调用，返回非空即取消发送）。
  // 开关操作自己产生的回复必须放行（否则"好，我先不说话了"和 `/屏蔽状态` 都会被吞掉），
  // 靠中间件打在 session 对象上的 `__guardControl` 标记区分 —— MessageEncoder 拿到的
  // 就是同一个 session 对象。
  //
  // ★ 2026-10-03 第四轮：这个监听器改成 **async** —— 最小间隔要在里面 await 排队。
  //   安全性来自 cordis 的 `serial` 实现（`for await (const result of dispatch(...))`，
  //   逐个 await 每个监听器的返回值），所以返回 Promise<true> 一样能取消发送，
  //   而且这一等会**真的**把这条消息的发送推后（后面几个监听器也要等它）。
  ctx.on('before-send', async (session) => {
    try {
      if (!session || session.__guardControl) return
      if (!cfg.enabled) return

      const isDirect = !!session.isDirect

      // ---- 屏蔽总闸：静默的群一个字都不发 ----
      // 私聊默认不受这套开关管（applyToPrivate=false）
      if (!(isDirect && !cfg.applyToPrivate) && isBlocked(session)) {
        log('发送前拦下（%s）', describe(session))
        return true
      }

      // ---- 出站令牌桶：按群防刷屏（所有出站路径的总兜底）----
      if (cfg.outboundEnabled) {
        if (isDirect && !cfg.outboundApplyToPrivate) return

        // ★ 指令驱动的回复不占配额（2026-10-03，用户要求：「这种命令应全都不占配额才对，
        //   因为是命令驱动的」）。
        //
        //   为什么必须放行：令牌桶防的是**模型刷屏**，那才是不可控的；而 /help、/guard.status
        //   这类输出的条数与时机完全由人控制 —— 一个群 burst=2，用户敲两次帮助页就把自己的
        //   模型回复额度吃光了，这显然不对。模型回复 / proactive 主动发言 / followup 跟进
        //   都不会有下面这个标记，照旧受限。
        //
        //   ★ 判据不能用 `session.argv.command` —— **那个字段在 before-send 里永远是空的**。
        //     实测（rig 42）：@satorijs/core 的编码器出站时会 new 一个 session，只把原
        //     session 上**可枚举**的键拷过去（lib/index.cjs:739-742 `for (const key in ...)`），
        //     而 `argv` 是 Koishi 用 `defineProperty` 挂的（@koishijs/core:1285），不可枚举，
        //     于是被漏掉。本插件自己的 `__guardControl` 能生效，正是因为它是一次普通赋值。
        //     所以这里也在 `command/execute` 打一个普通赋值的标记，见下面的 ctx.before。
        if (cfg.outboundExemptCommands && session.__guardIsCommand) {
          log('指令输出不占配额：%s', session.__guardIsCommand)
          return
        }

        const gid = groupIdOf(session)
        if (gid && !takeOutboundToken(gid)) {
          logger.warn('出站超速，丢弃一条（%s）', bucketText(gid))
          return true
        }

        // ---- 最小间隔：排队等（桶管总量、这里管节奏）----
        // ★ 顺序有意如此：**先**过桶（可能直接丢），**再**排队 —— 否则被桶丢掉的消息
        //   会白占一个坑位，把后面真正要发的挤走。
        // ★ 判据用 bucketParams(gid).minGap 而不是全局 cfg：按群覆盖里也能单独调间隔。
        // ★ 这是在 before-send 里 await：@satorijs/core 用 `app.serial` 顺序调监听器并等结果
        //   （cordis 的 serial 是 for-await，逐个 await），所以这一等会**真的**把发送推后，
        //   而不是只延迟一个回调 —— 这正是"两条消息之间至少隔 N 秒"要的语义。
        if (gid && bucketParams(gid).minGap > 0) {
          if (!(await waitForGap(gid))) return true
        }
      }
    } catch (e) {
      logger.warn('发送前判定出错（放行）：%s', e.message)
    }
  })

  // ---------------------------------------------------------- 闸门 2：ChatLuna 链
  //
  // 这道闸门是给"不走 Koishi 中间件"的调用准备的 —— 我们的 proactive 是直接
  // `chatChain.receiveCommand()`，闸门 1 拦不到它。

  ctx.inject(['chatluna'], (ctx2) => {
    const chain = ctx2.chatluna?.chatChain
    if (!chain || typeof chain.middleware !== 'function') {
      logger.warn('拿不到 chatluna.chatChain，链闸门未生效（主动发言的屏蔽要另想办法）')
      return
    }
    const STOP = 1

    let checked = false
    function checkOrder() {
      checked = true
      try {
        const levels = chain._graph?.build?.()
        if (!Array.isArray(levels)) return
        const levelOf = (n) => levels.findIndex((lv) => lv?.some?.((m) => m.name === n))
        const a = levelOf('guard')
        const b = levelOf('allow_reply')
        if (a < 0 || b < 0) logger.warn('排序自检：找不到 guard=%d / allow_reply=%d', a, b)
        else if (a < b) log('排序自检通过：guard 在第 %d 层，allow_reply 在第 %d 层', a, b)
        else logger.warn('排序自检失败：guard 在第 %d 层，allow_reply 在第 %d 层', a, b)
      } catch (e) {
        logger.warn('排序自检抛错（不影响主流程）：%s', e.message)
      }
    }

    chain
      .middleware(
        'guard',
        async (session) => {
          if (!checked) checkOrder()
          if (isBlocked(session)) {
            log('链闸门拦下：%s', describe(session))
            return STOP
          }
          return 0
        },
        ctx2
      )
      .before('allow_reply')

    logger.info('ChatLuna 链闸门已挂载（排在 allow_reply 之前）')
  })

  // ---------------------------------------------------------- 指令（闸门 3：授权）

  function resolveGroupArg(session, arg) {
    const gid = String(arg ?? '').trim()
    if (gid) return { groupId: gid, platform: platformOf(session) }
    if (session.isDirect) return null
    const mine = groupIdOf(session)
    return mine ? { groupId: mine, platform: platformOf(session) } : null
  }

  function statusText(session, groupId) {
    const gid = groupId ?? groupIdOf(session)
    const key = gid ? keyOfGroup(platformOf(session), gid) : null
    const row = key ? states.get(key) : null
    const blocked = isBlocked(session)
    const src = row
      ? `显式设置：${row.state === 'mute' ? '静默' : '放行'}（${row.via || '?'}｜${row.operatorId || '?'}｜${ago(row.updatedAt)}${row.reason ? `｜${row.reason}` : ''}）`
      : `没被显式设置过 → 默认策略：${cfg.defaultPolicy === 'silent' ? '白名单外一律静默' : '默认放行'}`
    return [
      `群 ${gid || '?'} 现在：${blocked ? '🔇 静默（不会回复任何话）' : '🔊 正常（该回就回）'}`,
      src,
      `开关门槛：等级 ${cfg.controlAuthority} 以上（主人 4 / 管理员 3）`,
    ].join('\n')
  }

  ctx
    .command('guard', '群聊屏蔽开关（静默这个群 / 放行这个群）', { authority: 1 })
    .action(() => [
      '/guard.mute [群号]     让 bot 立刻不在这个群说话（后面每句话都会被丢掉）',
      '/guard.allow [群号]    解除静默，正常回复',
      '/guard.status [群号]   看这个群现在是不是静默的',
      '/guard.list            看所有被显式设置过的群',
      '/guard.reset [群号]    删掉设置，回到默认策略',
      '',
      '不带群号 = 对当前群生效；在私聊里必须带群号',
      '（中文只是便利：「闭嘴/开口」这类裸词仍能被识别，但它不是指令，列表里查不到）',
    ].join('\n'))

  ctx
    .command('guard.mute [groupId:string]', '让 bot 立刻不在这个群说话', {
      authority: cfg.controlAuthority,
    })
    // ★ 不再注册中文指令别名（会出现在指令列表里）。中文仍可**裸词**触发，见 classify()。
    .action(async ({ session }, groupId) => {
      const t = resolveGroupArg(session, groupId)
      if (!t) return '在群里直接发 /guard.mute；在私聊里要带上群号：/guard.mute 123456'
      const r = await tryWrite(() =>
        setGroup(t.groupId, 'mute', {
          platform: t.platform,
          reason: `群内指令（${session.isDirect ? '私聊' : '群聊'}）`,
          operatorId: session.userId,
          via: 'command',
        })
      )
      if (!r.ok) return `没能改成：${r.error}`
      logger.info('群 %s → 静默（%s 下发）', t.groupId, session.userId)
      return `好，群 ${t.groupId} 我闭嘴了，从现在起一个字都不回。要恢复：/guard.allow`
    })

  ctx
    .command('guard.allow [groupId:string]', '解除静默，恢复正常回复', {
      authority: cfg.controlAuthority,
    })
    // ★ 同上：中文走裸词，不占指令名
    .action(async ({ session }, groupId) => {
      const t = resolveGroupArg(session, groupId)
      if (!t) return '在群里直接发 /guard.allow；在私聊里要带上群号：/guard.allow 123456'
      const r = await tryWrite(() =>
        setGroup(t.groupId, 'allow', {
          platform: t.platform,
          reason: `群内指令（${session.isDirect ? '私聊' : '群聊'}）`,
          operatorId: session.userId,
          via: 'command',
        })
      )
      if (!r.ok) return `没能改成：${r.error}`
      logger.info('群 %s → 放行（%s 下发）', t.groupId, session.userId)
      return `好，群 ${t.groupId} 我恢复了，@我 或者叫我名字就行。`
    })

  ctx
    .command('guard.status [groupId:string]', '看某个群现在是不是被静默了', { authority: 1 })
    // ★ 同上：中文走裸词，不占指令名
    .action(({ session }, groupId) => {
      const t = resolveGroupArg(session, groupId)
      if (!t) return '在群里直接发 /guard.status；在私聊里要带上群号：/guard.status 123456'
      return statusText(session, t.groupId)
    })

  ctx
    .command('guard.list', '看所有被显式设置过屏蔽状态的群', { authority: 2 })
    // ★ 同上：中文走裸词，不占指令名
    .action(() => {
      const rows = [...states.values()]
      if (!rows.length) {
        return `没有任何群被显式设置过。默认策略：${cfg.defaultPolicy === 'silent' ? '白名单外一律静默' : '默认放行'}｜预置白名单 ${[...allowSet].join(',') || '（空）'}`
      }
      return rows
        .map(
          (r) =>
            `群 ${r.channelId ?? r.guildId ?? '?'}：${r.state === 'mute' ? '🔇 静默' : '🔊 放行'}｜${r.via || '?'}｜${r.operatorId || '?'}｜${ago(r.updatedAt)}`
        )
        .join('\n')
    })

  ctx
    .command('guard.reset [groupId:string]', '删掉显式设置，让这个群回到默认策略', {
      authority: cfg.controlAuthority,
    })
    // ★ 同上：中文走裸词，不占指令名
    .action(async ({ session }, groupId) => {
      const t = resolveGroupArg(session, groupId)
      if (!t) return '在群里直接发 /guard.reset；在私聊里要带上群号：/guard.reset 123456'
      const r = await tryWrite(() => resetGroup(t.groupId, { platform: t.platform }))
      if (!r.ok) return `没能改成：${r.error}`
      const had = r.value
      logger.info('群 %s 的屏蔽设置已删除（%s 下发）', t.groupId, session.userId)
      const now = isBlocked({ ...session, channelId: t.groupId, guildId: t.groupId, isDirect: false })
      return had
        ? `群 ${t.groupId} 的设置已删除 → 按默认策略现在是「${now ? '静默' : '正常'}」`
        : `群 ${t.groupId} 本来就没有显式设置`
    })

  // ---------------------------------------------------------- 出站令牌桶：查看 / 重置

  // ★ 指令名一律英文点号（与 guard.* 其余指令一致），**不留中文别名**。
  ctx
    .command('guard.limit [groupId:string]', '查看某群的出站令牌桶状态', { authority: 1 })
    .action((argv, gid) => {
      const explicit = String(gid ?? '').trim()
      const mine = explicit || groupIdOf(argv?.session)
      if (mine) return bucketText(mine)
      return [
        '用法：/guard.limit <群号>（或在某个群里直接 /guard.limit）',
        `全局：桶容量 ${cfg.outboundBurst}，每分钟补 ${cfg.outboundPerMinute}，两条之间最小间隔 ${cfg.outboundMinGapSeconds}s；开关 ${cfg.outboundEnabled ? '开' : '关'}`,
        `按群覆盖：${outboundOverride.size} 个`,
      ].join('\n')
    })

  ctx
    .command('guard.refill [groupId:string]', '把某群的令牌桶补满（应急用）', { authority: 4 })
    .action((_a, gid) => {
      const g = String(gid ?? '').trim()
      if (!g) return '要给群号：/guard.refill 454444539'
      outboundBuckets.delete(g)
      outboundDrops.delete(g)
      return `已重置群 ${g} 的令牌桶（下次发送时补满）。`
    })

  // ---------------------------------------------------------- 对外服务（给别的插件问）

  ctx.provide(SERVICE, {
    isBlocked,
    /**
     * ★ 语义反转的对外口子（给 chatluna-episode 用）。
     *
     * 为什么不能让别人自己写 `!isBlocked(...)`：**启动窗口里会答错**。
     * `isBlocked` 在库里那条 mute 记录还没读出来之前是拿内置名单 + 默认策略判的
     * （`reload()` 在 `ready` 事件里才跑），所以启动那几百毫秒内一个"库里被静音"的群
     * 会被判成放行。做记录用的插件按这个答案写库，就会把不该记的群记进来。
     * 这里显式暴露 `ready`，让调用方能区分"确定没屏蔽"和"还不知道"。
     */
    isAllowed: (session) => (ready ? !isBlocked(session) : null),
    ready: () => ready,
    stateOf: (session) => rowOf(session)?.state ?? null,
    status: () => statusPayload(),
    setGroup,
    resetGroup,
    reload: () => reload(true),
    bucketText,
    /**
     * 出站令牌桶的对外口子。
     *
     * ★ 专给 chatluna-followup 用：它在**入站**阶段就要知道"这个群现在还发得出话吗"，
     *   桶空了就别接话（省一次模型调用）。见 peekOutboundToken 的注释。
     * ★ 不要在这里 take —— 扣令牌只有 `before-send` 一处，两处都扣等于额度减半。
     */
    bucket: {
      params: (groupId) => bucketParams(String(groupId)),
      peek: (groupId) => peekOutboundToken(groupId),
      text: (groupId) => bucketText(groupId),
      /** 下一次允许发送的时刻（ms 时间戳，0 = 没排过队）。诊断用 */
      gapAt: (groupId) => outboundGapNextAt.get(String(groupId)) ?? 0,
    },
  })

  // ---------------------------------------------------------- 启动

  ctx.on('ready', async () => {
    await reload()
    logger.info(
      '群聊屏蔽开关已挂载（默认策略=%s；预置白名单 %d / 黑名单 %d；控制口 %s；门槛 %d）',
      cfg.defaultPolicy === 'silent' ? '白名单外一律静默' : '默认放行',
      allowSet.size,
      muteSet.size,
      cfg.controlPath,
      cfg.controlAuthority
    )
    if (cfg.outboundEnabled) {
      logger.info(
        '出站令牌桶已挂载（全局：容量 %d / 每分钟 %d / 最小间隔 %ds；按群覆盖 %d 个）—— 所有出站消息的总兜底',
        cfg.outboundBurst,
        cfg.outboundPerMinute,
        cfg.outboundMinGapSeconds,
        outboundOverride.size
      )
    }
  })

  if (cfg.refreshSeconds > 0) {
    ctx.setInterval(() => reload(true), cfg.refreshSeconds * 1000)
  }
}

module.exports = { name, inject, Config, apply }
