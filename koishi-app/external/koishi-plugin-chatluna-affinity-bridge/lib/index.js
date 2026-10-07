/**
 * koishi-plugin-chatluna-affinity-bridge —— 好感度垫片
 *
 * ------------------------------------------------------------------ 症状
 *
 * 生产现象（2026-10-03 深夜查库）：
 *   chatluna_affinity_v2 只有 **2 行**，两行的 chatCount / lastInteractionAt 都是 NULL；
 *   `chatluna_affinity_dashboard_snapshot` 里 10-03 的 chatCount 还是 0，
 *   和 10-02 那条一模一样；/rank 里就这么两个人，数值从 10-02 起没动过。
 *
 * ------------------------------------------------------------------ 根因（有证据，不是猜）
 *
 * chatluna-affinity 的「每轮回复后记账」= `createModelResponseProcessor`
 * → `initializeAffinityOnFirstReply`（新用户建档）+ `recordInteractionFromReply`
 * （chatCount+1、lastInteractionAt、连续互动 streak）。它不在消息事件上，
 * 而是挂在 `chatluna_character.getTemp` 上：
 *
 *     ctx.inject(['chatluna_character'], (innerCtx) => {
 *       ...
 *       modelResponseRuntime.start()      // ← 这里才开始监听模型回复
 *     })
 *     （node_modules/koishi-plugin-chatluna-affinity/lib/index.js:6668）
 *
 * 而 **这个 ChatLuna 版本里没有 `chatluna_character` 这个服务**：
 *   · `koishi-plugin-chatluna@1.4.0` 整包（lib 下全部 .cjs/.mjs/.js）grep
 *     `chatluna_character` → **0 命中**；
 *   · 因此 affinity 的 `inject` 回调**从来没执行过**，日志里也就从来没有
 *     「检测到 chatluna_character 依赖可用，开始挂载模型响应 runtime」这一行；
 *   · 旁证：一整天日志里对 `chatluna_affinity_v2` **只有 SELECT，没有任何 INSERT/UPDATE**
 *     （那些 SELECT 来自预设里的 `{affinity("…")}` 变量渲染，不是记账）。
 *
 * ------------------------------------------------------------------ 修法：给它缺的那个服务，而不是重写它的逻辑
 *
 * 那条 runtime 要的东西很少（`shared-chatluna-xmltools` 内联在 affinity 里，
 * `registerGetTempListener` 在 lib/index.js:136-182、`handleTemp` 在 307-336）：
 *
 *   1. 一个叫 `chatluna_character` 的服务，**只需要有一个 `getTemp(session)` 方法**；
 *   2. `getTemp` 返回的对象上要有 `completionMessages`，且必须是**数组**
 *      （runtime 会给它打一个 push 补丁来嗅探助手回复）；
 *   3. 往那个数组里 push 一条"助手消息"（`type/role === 'ai' | 'assistant'` 且正文非空），
 *      runtime 就会回调 `onResponse({ response, session })` →
 *      affinity 用**它自己**的代码建档 + 记账。
 *
 * 好处：**一行都不碰 affinity 的表结构**（列、初始值、系数、短期/长期换算全归它自己算）。
 *
 * ------------------------------------------------------------------ ★★ 坑 62：出站 session 上拿不到"刚才是谁在说话"
 *
 * 第一版直接拿 `session.userId` 当说话人 —— **永远是 undefined**，于是一条都不记
 * （rig 59 探针实测：`before-send 进来了：guard=- user=undefined self=2178517838`）。
 * 原因是 Satori 建出站 session 的方式（`@satorijs/core` index.cjs:733-742）：
 *
 *     this.session = this.bot.session({ type: 'send', channel: {...}, guild: {...} })
 *     for (const key in this.options.session) this.session[key] = this.options.session[key]
 *
 * 它只把入站 session 的**自有可枚举属性**搬过来，而 `userId` / `selfId` / `channelId`
 * 都是 **Session 原型上的 getter**（分别读 `event.user.id` / `event.self.id` /
 * `event.channel.id`）。新 session 的 event 是**现造的**、里面只有 channel 和 guild，
 * 所以搬过来的 chat 里 `selfId` 有值、`userId` 是空的。
 *
 * 所以说话人只能从**消息内容**里认回来，本插件按可靠性排三级（都在日志里标出来）：
 *   ① `quote` 元素的 id = 被回复的那条入站消息 id → 查入站索引（最准，一一对应）；
 *   ② `at` 元素的 id（reply-style 的 `@ first` 会带上），排除 bot 自己；
 *   ③ 该频道最近一个说话的人（兜底，`fallbackSeconds` 内）。
 * 三级都没有 → **不记账**（宁可漏记，也不能把 A 说的话记到 B 头上）。
 *
 * 另外：affinity 的 `recordInteractionFromReply` 读的是 `session.userId`，
 * 所以喂给它的不能是出站 session 本身，而是一个 `Object.create(出站session)` 出来的
 * **伪 session**：只覆盖 `userId`（+私聊标记），`bot` / `guildId` / `platform` / `selfId`
 * 全部沿原型链继承 —— 这样 `fetchMember()` 仍然能正常去 NapCat 查群名片。
 */

const { Schema, Logger } = require('koishi')

const name = 'chatluna-affinity-bridge'
const inject = { required: [], optional: ['chatluna'] }

const logger = new Logger('chatluna-affinity-bridge')

/** 垫片服务的名字。★ 必须和 affinity `inject` 里的名字一字不差 */
const SERVICE_NAME = 'chatluna_character'

/** 命令前缀（koishi.yml: prefix [/ .]，strict）。用来识别"这条入站其实是敲指令" */
const COMMAND_PREFIX = /^[/.]\S/

const Config = Schema.intersect([
  Schema.object({
    enabled: Schema.boolean().default(true).description(
      '总开关。关掉后不再提供垫片服务，affinity 的自动记账会回到"静默不动"的状态'
    ),
    provideShim: Schema.boolean().default(true).description(
      '提供 chatluna_character 垫片服务。若将来装了自带该服务的 ChatLuna 分支，会自动跳过（不抢占）'
    ),
    minIntervalMs: Schema.natural().default(2000).description(
      '同一个人两次记账之间的最小间隔（毫秒）。用于兜住"一条回复被拆成多条发送"的重复计数'
    ),
    fallbackSeconds: Schema.natural().default(180).description(
      '连引用和 @ 都没有时，允许回退到"本频道最近一个说话的人"的时间窗（秒）。填 0 = 关掉这级兜底'
    ),
    skipCommandTriggers: Schema.boolean().default(true).description(
      '被回复的那条入站消息本身就是指令（以 / 或 . 开头）时不记账。' +
        '挡的是"敲了条不存在的指令、bot 回你一句没这指令"这种 —— 那不算聊了一句'
    ),
    // ---- /short：只读查看「短期好感度」（2026-10-04 晚新增）----
    //
    // 为什么要它：affinity 的显示值 = 长期 × 系数，模型每次 ±2/±3 只进 shortTermAffinity，
    // 攒到 promoteThreshold(默认 15) 才折成长期 +3 —— 于是"模型明明调了工具，/rank 却纹丝不动"。
    // 原插件的 /favor(affinity.inspect) 一次只能看**一个人**，且混在一堆字段里；
    // 这个命令是**一次看所有人还各攒着多少**、距折算/降级还差几点。**只读，不写库。**
    shortCommand: Schema.boolean().default(true).description(
      '注册只读命令 /short（原始名 affinity.short）：列短期好感度存量、距折算/降级还差多少。关掉就不注册'
    ),
    affinityScopeId: Schema.string().default('affinity').description(
      'chatluna-affinity 的 scopeId（= 数据命名空间）。/short 按它查 chatluna_affinity_v2，' +
        '★ 必须和 koishi.yml 里 chatluna-affinity.scopeId 一致，否则一个人都查不到'
    ),
    shortLimit: Schema.natural().default(20).description('/short 列表最多显示几行（也可以用 -l 临时改）'),
    promoteThreshold: Schema.natural().default(15).description(
      '短期好感 ≥ 该值 → 折算进长期。★ 只用于显示，真正生效的是 chatluna-affinity 里的 shortTerm.promoteThreshold，两个要一致'
    ),
    demoteThreshold: Schema.number().default(-10).description(
      '短期好感 ≤ 该值 → 从长期里扣。★ 同上，真正生效的是 affinity 的 shortTerm.demoteThreshold'
    ),
    promoteStep: Schema.natural().default(3).description('折算时长期 +N（= affinity 的 longTermPromoteStep，仅显示用）'),
    demoteStep: Schema.natural().default(5).description('降级时长期 -N（= affinity 的 longTermDemoteStep，仅显示用）'),
    debug: Schema.boolean().default(false).description('打印每次记账/跳过的判定与理由'),
  }),
])

// ---------------------------------------------------------------- 取正文

/**
 * 从出站 session 的 elements 里还原一句话的正文，并顺手把 quote / at 捞出来。
 *
 * ★ 不能直接读 `session.content`：出站 session 上的它是**同一段内容的标记形式**
 *   （`<quote id="…"/><at id="…"/>正文`），照它入库就是把标记当话（坑 58 的同类）。
 *   episode 插件为这件事写过一版递归 walker，这里的规则和它保持一致。
 */
function readOutbound(session) {
  const els = Array.isArray(session?.elements) ? session.elements : []
  const parts = []
  let images = 0
  let quoteId = null
  const atIds = []

  const walk = (el, depth = 0) => {
    if (!el || depth > 4) return
    const type = String(el.type || '')
    if (type === 'text') return void parts.push(String(el.attrs?.content ?? ''))
    if (type === 'img' || type === 'image') return void images++
    if (type === 'at') {
      const id = String(el.attrs?.id ?? '')
      if (id) atIds.push(id)
      parts.push(`@${id}`)
      return
    }
    if (type === 'face') return void parts.push('[表情]')
    if (type === 'quote') {
      // 引用前缀是别的插件加的，不是"我说的话"；但它的 id 是"在回谁"的钥匙
      if (el.attrs?.id != null && quoteId == null) quoteId = String(el.attrs.id)
      return
    }
    if (type === 'br') return void parts.push('\n')
    const kids = Array.isArray(el.children) ? el.children : []
    if (!kids.length) return
    for (const kid of kids) walk(kid, depth + 1)
    if (type === 'p' || type === 'div') parts.push('\n')
  }

  for (const el of els) walk(el)
  const text = parts.join('').replace(/\n{2,}/g, '\n').trim()
  // 纯图消息：正文填个占位，好让"bot 回了他一句图"也算一次互动
  return { text: text || (images > 0 ? '［图片］' : ''), quoteId, atIds }
}

// ------------------------------------------------- 短期好感度（/short 用的纯函数）
//
// ★ 全部放在模块作用域、不碰 ctx / logger，所以能直接 require 出来喂真实数据核对
//   （见文件尾的 `__test` 与 .scratch/check-short-cmd.cjs）。

function parseJson(value) {
  if (value && typeof value === 'object') return value
  try {
    return JSON.parse(String(value))
  } catch {
    return null
  }
}

/**
 * 库里的行 → 展示用结构。
 * ★ `nickname` 列里常常就是 QQ 号本身（affinity 存的是兜底值），这种当"没有名字"处理，
 *   免得页面上出现 `2791932480（2791932480）` 这种重复。
 */
function toShortRows(rows) {
  const out = []
  for (const r of Array.isArray(rows) ? rows : []) {
    const userId = String(r?.userId ?? '').trim()
    if (!userId) continue
    const short = Number(r?.shortTermAffinity) || 0
    const long = Number(r?.longTermAffinity ?? r?.affinity) || 0
    const shown = Number(r?.affinity)
    const coefState = parseJson(r?.coefficientState) || {}
    const nickname = String(r?.nickname ?? '').trim()
    out.push({
      userId,
      nickname: nickname && nickname !== userId ? nickname : '',
      short,
      long,
      shown: Number.isFinite(shown) ? shown : null,
      coefficient: Number(coefState.coefficient) || 1,
      streak: Number(coefState.streak) || 0,
      chatCount: Number(r?.chatCount) || 0,
      lastInteractionAt: r?.lastInteractionAt ?? null,
    })
  }
  // 有存量的排前面（正的多在前、负的多在后），同值时长期高的在前
  out.sort((a, b) => b.short - a.short || b.long - a.long || a.userId.localeCompare(b.userId))
  return out
}

/** 「再 +N 折算」/「再 -N 降级」这类一句话进度 */
function shortProgress(short, o) {
  if (short >= o.promoteThreshold) return `★ 已到折算线（下次调用就折成长期 +${o.promoteStep}）`
  if (short <= o.demoteThreshold) return `★ 已到降级线（下次调用就从长期 -${o.demoteStep}）`
  if (short > 0) return `再 +${o.promoteThreshold - short} 折算成长期 +${o.promoteStep}`
  if (short < 0) return `再 -${short - o.demoteThreshold} 降级（长期 -${o.demoteStep}）`
  return '无存量'
}

const sign = (n) => `${n >= 0 ? '+' : ''}${n}`

// ---- 名字解析（要跟 affinity 的 /rank、/favor 显示一致）----
//
// ★ 为什么不能只看库里的 `nickname` 列：那一列在生产里**存的就是 QQ 号**（affinity 建档时
//   没解析到群名片就回落成 userId），所以照它显示会得到 `2791932480（2791932480）`。
//   真正的名字只能现场跟平台要 —— 优先群成员列表，取不到再逐个查。

/** 群成员对象/单查结果 → 名字。字段优先级**照抄 affinity 的 collectNicknameCandidates**，
 *  这样 /short 与 /rank 对同一个人显示同一个名字（card = 群名片，nick = 群昵称）。 */
function pickMemberName(member) {
  if (!member || typeof member !== 'object') return ''
  const candidates = [
    member.card,
    member.remark,
    member.displayName,
    member.nick,
    member.nickname,
    member.name,
    member.user?.card,
    member.user?.remark,
    member.user?.nickname,
    member.user?.name,
  ]
  for (const c of candidates) {
    const s = String(c ?? '').trim()
    if (s) return s
  }
  return ''
}

/** 群成员对象/单查结果 → QQ 号。Satori 用 userId/id，OneBot 原样回 user_id/uin。 */
function pickMemberId(member) {
  if (!member || typeof member !== 'object') return ''
  return String(member.userId ?? member.user_id ?? member.id ?? member.uin ?? member.user?.id ?? '').trim()
}

/**
 * 群成员列表响应 → `Map<QQ, 名字>`（纯函数，便于单测）。
 * ★ `bot.getGuildMemberList()` 在 Satori 下回的是 **`{ data: [...] }`**、不是裸数组；
 *   早期照裸数组 `for…of` 会直接 TypeError（被 try/catch 吃掉 → 一个名字都没有，
 *   表现就是"全都是 QQ 号"）。两种形状都得吃。
 */
function namesFromMemberList(res) {
  const map = new Map()
  const list = Array.isArray(res) ? res : Array.isArray(res?.data) ? res.data : []
  for (const m of list) {
    const id = pickMemberId(m)
    const name = pickMemberName(m)
    if (id && name) map.set(id, name)
  }
  return map
}

/**
 * `名字（QQ）`；**没有名字时只给 QQ**（绝不出现 `QQ（QQ）`）。
 * ★ 这里的兜底判断是**刻意重复**的：即便某条档案是别处造出来的（nickname 列塞了 QQ 号），
 *   显示层也不允许把 QQ 号当名字打两遍。
 */
function nameLabel(e, o) {
  const resolved = o.names?.get?.(e.userId) || ''
  const fallback = e.nickname && e.nickname !== e.userId ? e.nickname : ''
  const name = String(resolved || fallback).trim()
  return name && name !== e.userId ? `${name}（${e.userId}）` : e.userId
}

function formatShortList(entries, o) {
  const head =
    `【短期好感度】scopeId=${o.scopeId} ｜ 折算线 +${o.promoteThreshold}（→ 长期 +${o.promoteStep}）` +
    ` / ≤${o.demoteThreshold}（→ 长期 -${o.demoteStep}）`
  if (!entries.length) {
    return `${head}\n还没有任何好感度档案（scopeId 填错也会是这样：先让 bot 在群里回几句话建档）。`
  }
  const shown = entries.slice(0, o.limit)
  const lines = shown.map(
    (e, i) =>
      `${i + 1}. ${nameLabel(e, o)}　短期 ${sign(e.short)} ｜ ${shortProgress(e.short, o)}` +
      ` ｜ 长期 ${e.long} ｜ 显示 ${e.shown == null ? '—' : e.shown} ｜ 聊过 ${e.chatCount} 次`
  )
  const more =
    entries.length > shown.length
      ? [`（另有 ${entries.length - shown.length} 人未显示：/short -l ${entries.length} 全看，或 /short <QQ> 看单人）`]
      : []
  return [
    head,
    `${entries.length} 人有档案（有短期存量的排前面）：`,
    ...lines,
    ...more,
    `★ 短期不参与显示值：显示值 = 长期 × 系数（系数在 ±0.3 内随互动/冷淡浮动，所以长期 30 可能显示 29~32）。`,
    `★ 攒够折算线才并进长期并清零 —— 这就是「模型加了分、/rank 却不动」的原因，不是工具坏了。`,
  ].join('\n')
}

/**
 * 把用户敲的目标（`@123` / `onebot:123` / `123`）对到某条档案上。
 * 页面上贴过来的 QQ 常常带平台前缀，所以三种写法都收。
 */
function resolveTargetUser(entries, target) {
  const raw = String(target ?? '').trim().replace(/^@/, '')
  if (!raw) return null
  const bare = raw.includes(':') ? raw.slice(raw.lastIndexOf(':') + 1) : raw
  return entries.find((e) => e.userId === raw || e.userId === bare || e.userId.endsWith(`:${bare}`)) || null
}

function formatShortOne(e, o) {
  const t = e.lastInteractionAt
  const when = t ? new Date(t instanceof Date ? t.getTime() : Number(t)).toLocaleString('zh-CN') : '—'
  return [
    `【短期好感度】${nameLabel(e, o)}`,
    `短期 ${sign(e.short)} ｜ ${shortProgress(e.short, o)}`,
    `长期 ${e.long} ｜ 显示 ${e.shown == null ? '—' : e.shown} ｜ 系数 ${e.coefficient.toFixed(2)} ｜ 连续互动 ${e.streak} 天`,
    `聊过 ${e.chatCount} 次 ｜ 最后互动 ${when}`,
    `（折算线 +${o.promoteThreshold} → 长期 +${o.promoteStep}／降级线 ${o.demoteThreshold} → 长期 -${o.demoteStep}）`,
  ].join('\n')
}

// ---------------------------------------------------------------- 垫片服务

/**
 * 最小可用的 `chatluna_character`。
 *
 * ★ 全局**只给一个** temp（一个 completionMessages 数组）。这不是偷懒，是刻意的：
 *   runtime 的 `handleTemp` 用 WeakMap 把"数组 → 订阅"记下来，每个新数组都会
 *   新装一个 push 补丁并塞进 `trackedMessages`（那个 Set **只增不减**）；
 *   一条回复一个新数组 = 一份永不释放的订阅。共用一个数组就只有一份订阅。
 *   安全性来自 `handleTemp` 的第一行：`sessionByMessages.set(messages, session)`
 *   **每次调用都会刷新**，而我们正是"取 temp（刷新 session）→ 立刻 push"，
 *   所以监听器拿到的永远是这一次的 session。
 *
 * ★ 返回同步值没问题：runtime 外层是 `async (...args) => { const temp =
 *   await originalGetTemp(...) }`（lib/index.js:155-166），会 await 我们。
 *   但**调用方必须 await** —— 补丁后的 `getTemp` 是 async 的，直接同步取
 *   `.completionMessages` 会拿到 undefined（第一版就踩了这个，push 静默没发生）。
 */
function createCharacterShim() {
  const shared = { session: null, completionMessages: [], createdAt: Date.now() }
  return {
    getTemp(session) {
      if (session && typeof session === 'object') shared.session = session
      return shared
    },
  }
}

// ---------------------------------------------------------------- 应用

function apply(ctx, config) {
  const cfg = {
    enabled: true,
    provideShim: true,
    minIntervalMs: 2000,
    fallbackSeconds: 180,
    skipCommandTriggers: true,
    shortCommand: true,
    affinityScopeId: 'affinity',
    shortLimit: 20,
    promoteThreshold: 15,
    demoteThreshold: -10,
    promoteStep: 3,
    demoteStep: 5,
    debug: false,
    ...(config || {}),
  }

  if (!cfg.enabled) {
    logger.info('已关闭（enabled=false），不提供 chatluna_character 垫片')
    return
  }

  // ---- A. 提供垫片服务（不抢占已有的）----
  //
  // ★ 自己造的对象**留一个直接引用**（`shim`），运行时不再走 `ctx.get(...)` 去取。
  //   `ctx.set` 存进去的就是同一个对象，affinity 的 runtime 是**就地改写**
  //   `service.getTemp`（lib/index.js:155），所以本地引用一样拿到补丁后的版本；
  //   而服务查找要多绕一层（cordis 的 ReflectService / isolate），一旦哪层不对，
  //   表现就是"静默不记账"。
  let shim = null
  if (cfg.provideShim) {
    let existing = null
    try {
      existing = typeof ctx.get === 'function' ? ctx.get(SERVICE_NAME) : null
    } catch (e) {
      existing = null
    }
    if (existing) {
      shim = existing
      logger.info('已存在 %s 服务，跳过垫片（交给真正的实现）', SERVICE_NAME)
    } else {
      shim = createCharacterShim()
      ctx.set(SERVICE_NAME, shim)
      logger.info('已提供 %s 垫片（getTemp）；affinity 的模型响应 runtime 应能挂载了', SERVICE_NAME)
    }
  }

  // ---- B. 入站索引：谁、在哪条消息里说过话 ----
  /** 入站 messageId → { userId, channelId, guildId, platform, text, at } */
  const inboundByMid = new Map()
  /** 频道键 → 最近一个说话的人 */
  const lastSpeaker = new Map()

  const channelKey = (session) =>
    `${session.platform || ''}:${session.channelId || session.guildId || ''}`

  function pruneInbound(now) {
    if (inboundByMid.size <= 800) return
    for (const [k, v] of inboundByMid) {
      if (now - v.at > 600000) inboundByMid.delete(k)
    }
  }

  ctx.on('message', (session) => {
    try {
      const userId = String(session?.userId || '')
      const selfId = String(session?.selfId || '')
      if (!userId || userId === selfId) return
      const now = Date.now()
      const rec = {
        userId,
        selfId,
        platform: session.platform,
        channelId: session.channelId,
        guildId: session.guildId,
        // ★ stripped.content 是"去掉前缀和 @ 之后"的正文，比 content（标记形式）更适合判指令
        text: String(session.stripped?.content ?? session.content ?? ''),
        at: now,
      }
      const mid = String(session.messageId || '')
      if (mid) inboundByMid.set(mid, rec)
      lastSpeaker.set(channelKey(session), rec)
      pruneInbound(now)
    } catch (e) {
      logger.debug('入站索引失败：%s', e.message)
    }
  })

  // ---- C. 出站记账 ----
  /** key = 会话+说话人 → { mid, at }，用来给"一条回复拆成多条发送"去重 */
  const recent = new Map()

  /**
   * 认"这条出站消息是在回谁"。三级回退，全失败返回 null（**不记账**）。
   * 返回 { userId, via }；via 只用于日志，方便以后排查"记到别人头上了"。
   */
  function resolveSpeaker(session, out) {
    const selfId = String(session.selfId || '')
    // ① 引用：最准，直接对上那条入站消息
    if (out.quoteId && inboundByMid.has(out.quoteId)) {
      const rec = inboundByMid.get(out.quoteId)
      if (rec.userId !== selfId) return { userId: rec.userId, via: 'quote', rec }
    }
    // ② @：reply-style 的 `@ first` 会带上
    for (const id of out.atIds) {
      if (id && id !== selfId) return { userId: id, via: 'at' }
    }
    // ③ 最近说话的人（有超时窗口；填 0 可关掉）
    if (cfg.fallbackSeconds > 0) {
      const rec = lastSpeaker.get(channelKey(session))
      if (rec && Date.now() - rec.at < cfg.fallbackSeconds * 1000) {
        return { userId: rec.userId, via: 'recent', rec }
      }
    }
    return null
  }

  function shouldSkip(session, userId) {
    const selfId = String(session.selfId || '')
    if (!userId || !selfId || userId === selfId) return 'self-or-broadcast'

    const key = `${session.platform || ''}:${session.channelId || ''}:${userId}`
    const mid = String(session.messageId || '')
    const now = Date.now()
    const last = recent.get(key)
    if (last) {
      // 有 messageId：同一条入站消息的多次发送算一次（1 分钟内）
      if (mid && last.mid === mid && now - last.at < 60000) return 'dedupe(mid)'
      // 没有 messageId：只能用时间间隔兜
      if (!mid && !last.mid && now - last.at < cfg.minIntervalMs) return 'dedupe(interval)'
    }
    recent.set(key, { mid, at: now })
    if (recent.size > 500) {
      for (const [k, v] of recent) {
        if (now - v.at > 300000) recent.delete(k)
      }
    }
    return null
  }

  async function recordReply(session) {
    const out = readOutbound(session)
    if (!out.text) {
      if (cfg.debug) logger.debug('记账跳过：empty-text')
      return
    }
    const speaker = resolveSpeaker(session, out)
    if (!speaker) {
      if (cfg.debug) logger.debug('记账跳过：认不出在回谁（没有 quote/at，也没人在窗口内说过话）')
      return
    }
    // 触发它的那条入站消息本身就是指令 → 这是"指令没找到"之类的回执，不算聊天
    if (cfg.skipCommandTriggers && speaker.rec && COMMAND_PREFIX.test(speaker.rec.text.trim())) {
      if (cfg.debug) logger.debug('记账跳过：触发消息是指令（%s）', speaker.rec.text.slice(0, 24))
      return
    }
    const skip = shouldSkip(session, speaker.userId)
    if (skip) {
      if (cfg.debug) logger.debug('记账跳过：%s', skip)
      return
    }
    if (!shim || typeof shim.getTemp !== 'function') {
      logger.warn('记账跳过：拿不到 %s 垫片（provideShim=%s）', SERVICE_NAME, cfg.provideShim)
      return
    }

    // ★ 伪 session：只覆盖 userId（出站 session 上它是 undefined，见文件头坑 62），
    //   其余（bot / guildId / platform / selfId / transform）沿原型链继承，
    //   affinity 内部要用的 fetchMember(session, userId) 才走得通。
    const pseudo = Object.create(session)
    pseudo.userId = speaker.userId
    pseudo.isDirect = !!session.isDirect

    // ★ 必须 await（补丁后的 getTemp 是 async）；顺序也不能换：
    //   先 getTemp 刷新 runtime 里的 sessionByMessages，再 push。
    const temp = await shim.getTemp(pseudo)
    if (!temp || !Array.isArray(temp.completionMessages)) {
      logger.warn('记账跳过：getTemp 没给出 completionMessages 数组（affinity 的 runtime 没挂上？）')
      return
    }
    temp.completionMessages.push({ type: 'ai', content: out.text })
    if (cfg.debug) {
      logger.info(
        '好感度记账：%s ｜说话人 %s（依据 %s）｜回复 %d 字',
        session.channelId || session.userId || '—',
        speaker.userId,
        speaker.via,
        out.text.length
      )
    }
  }

  /**
   * 出站咽喉。
   *
   * ★ 指令回执（`__guardIsCommand`）跳过：那是"我执行了一条命令"，不是"我跟谁聊了一句"。
   *   这个标记由 chatluna-guard 打在 command/execute 上，再由 Encoder.send 复制到
   *   出站 session（episode 插件的坑 59 已经把这套验证过一遍）。
   */
  ctx.on('before-send', (session) => {
    try {
      if (session?.__guardIsCommand) {
        if (cfg.debug) logger.debug('记账跳过：指令回执（%s）', session.__guardIsCommand)
        return
      }
      recordReply(session).catch((e) => logger.warn('记账失败：%s', e.message))
    } catch (e) {
      logger.warn('出站记账异常：%s', e.message)
    }
  })

  // ---- D. /short：只读查看「短期好感度」----
  //
  // 现状（2026-10-04 实测）：模型确实在调 `affinity_affinity`（sandbox 留档里能看到调用与
  // `已调整 …：+2` 的返回），但**显示值 = round(长期 × 系数)**，短期只是**中间层**：
  //   短期 ≥ +15 → 长期 +3、短期清零；短期 ≤ -10 → 长期 -5、短期清零。
  // 所以"加了 4 次好感、/rank 还是 30"是**设计如此**，不是工具坏了。
  // 这个命令把那层看不见的存量摊开：谁攒了多少、距折算/降级还差几点。**只读，不写库。**
  const AFFINITY_TABLE = 'chatluna_affinity_v2'

  /**
   * 单个群成员信息 —— 走 affinity 验证过的那两条路（OneBot 原生接口优先，
   * 再退 Satori 的 `bot.getGuildMember`）。只在群成员列表拿不到这个人时用。
   */
  async function fetchOneMember(bot, guildId, userId) {
    try {
      if (bot?.internal) {
        if (typeof bot.internal.getGroupMemberInfo === 'function') {
          const r = await bot.internal.getGroupMemberInfo(Number(guildId), Number(userId), false)
          if (r) return r
        } else if (typeof bot.internal._request === 'function') {
          const r = await bot.internal._request('get_group_member_info', {
            group_id: Number(guildId),
            user_id: Number(userId),
            no_cache: false,
          })
          if (r) return r
        }
      }
      if (typeof bot?.getGuildMember === 'function') return await bot.getGuildMember(guildId, userId)
    } catch (e) {
      if (cfg.debug) logger.debug('查群成员 %s 失败：%s', userId, e.message)
    }
    return null
  }

  /**
   * `Map<QQ, 名字>`：① 群成员列表（一次拿全）→ ② 列表没覆盖到的**只查将要显示的那几个**。
   * 库里的 `nickname` 列不可靠（生产里存的就是 QQ 号），所以名字只能现场要。
   */
  async function memberNames(session, userIds = []) {
    const map = new Map()
    const bot = session?.bot
    const guildId = session?.guildId || session?.event?.guild?.id
    if (!bot || !guildId) return map
    try {
      if (typeof bot.getGuildMemberList === 'function') {
        // ★ Satori 回的是 { data: [...] }（不是裸数组）—— namesFromMemberList 两种都吃
        const merged = namesFromMemberList(await bot.getGuildMemberList(guildId))
        for (const [id, name] of merged) map.set(id, name)
      }
    } catch (e) {
      if (cfg.debug) logger.debug('取群成员列表失败（改逐个查）：%s', e.message)
    }
    for (const id of userIds) {
      if (!id || map.has(id)) continue
      const name = pickMemberName(await fetchOneMember(bot, guildId, id))
      if (name) map.set(id, name)
    }
    if (!map.size && cfg.debug) logger.debug('一个群名片都没拿到，/short 会退回显示 QQ 号')
    return map
  }

  if (cfg.shortCommand) {
    ctx.command('affinity.short [target:string]', '查看短期好感度（攒着还没折算进长期的那部分）', {
      authority: 1,
    })
      .alias('short')
      .option('limit', '-l <n:number> 显示几行')
      .usage(
        '示例：/short（看所有人）　/short 2791932480（看某人）　/short -l 30（多显示几行）\n' +
          '只读命令，不会改任何数据；改好感度的仍然是模型工具 affinity_affinity 与 /adjust。'
      )
      .action(async ({ session, options }, target) => {
        const db = typeof ctx.get === 'function' ? ctx.get('database') : null
        if (!db) return '读不到 database 服务，暂时看不了短期好感度。'
        let rows = []
        try {
          // ★ 一次把整个 scope 捞回来再本地排序/截断。这张表每个 scope 一行一个人（本项目 9 行），
          //   不值得为分页再引入 Selection；真到几百行也只是多几毫秒。
          // ★ 表**必须已经被 chatluna-affinity 声明**（它自己 `ctx.model.extend('chatluna_affinity_v2'…)`），
          //   否则 minato 会 `throw cannot resolve table` —— 见 .scratch/check-short-minato.cjs 实测。
          rows = await db.get(AFFINITY_TABLE, { scopeId: cfg.affinityScopeId })
        } catch (e) {
          logger.warn('查询 %s 失败：%s', AFFINITY_TABLE, e.message)
          if (/cannot resolve table/i.test(e.message || '')) {
            return `好感度表 ${AFFINITY_TABLE} 还没被声明 —— chatluna-affinity 没加载或没起来？（scopeId=${cfg.affinityScopeId}）`
          }
          return `读 ${AFFINITY_TABLE} 失败（scopeId=${cfg.affinityScopeId}）：${e.message}`
        }
        const entries = toShortRows(rows)
        const asked = Number(options?.limit)
        const limit = Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), 100) : cfg.shortLimit
        const hit = target ? resolveTargetUser(entries, target) : null
        if (target && !hit) {
          return `没有 ${String(target).replace(/^@/, '')} 的好感度档案（scopeId=${cfg.affinityScopeId}）。`
        }
        // ★ 只给"将要显示的人"要名字：列表 = 前 limit 个，单人 = 那一个。
        //   群成员列表一次就能全覆盖；拿不到时逐个查，也不会把全群都查一遍。
        const wantIds = hit ? [hit.userId] : entries.slice(0, limit).map((e) => e.userId)
        const opts = {
          scopeId: cfg.affinityScopeId,
          promoteThreshold: cfg.promoteThreshold,
          demoteThreshold: cfg.demoteThreshold,
          promoteStep: cfg.promoteStep,
          demoteStep: cfg.demoteStep,
          limit,
          names: await memberNames(session, wantIds),
        }
        return hit ? formatShortOne(hit, opts) : formatShortList(entries, opts)
      })
  }

  ctx.on('ready', () => {
    logger.info(
      '好感度垫片就绪：出站回复会计入 chatluna-affinity 的 chatCount / 互动时间（说话人靠 quote→at→最近发言三级识别）'
    )
  })
}

module.exports = {
  name,
  inject,
  Config,
  apply,
  // 纯函数（不依赖 ctx / koishi 运行时），给 .scratch 里的核对脚本用：
  //   node .scratch/check-short-cmd.cjs
  __test: {
    toShortRows,
    shortProgress,
    formatShortList,
    formatShortOne,
    resolveTargetUser,
    nameLabel,
    pickMemberName,
    pickMemberId,
    namesFromMemberList,
  },
}
