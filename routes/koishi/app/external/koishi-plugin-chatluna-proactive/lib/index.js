/**
 * koishi-plugin-chatluna-proactive
 *
 * R9「定时监控群聊、择机插话」——**自写**。
 *
 * 为什么不直接用生态里那个现成的 `koishi-plugin-chatluna-proactive-trigger@0.3.12`：
 *   它是 2026-07-26 发的，对的是 chatluna 1.4.0-alpha；而 chatluna **1.4.0 正式版
 *   （2026-09-19）把整个 room 层删掉了** —— `koishi-plugin-chatluna/chains` 现在只导出
 *   ChainMiddleware / ChainMiddlewareRunStatus / ChatChain，`lib/chains/rooms.d.ts` 里
 *   声明的 queryJoinedConversationRoom / resolveConversationRoom / getConversationRoomCount /
 *   createConversationRoom **一个实现都没有**（只有 .d.ts，没有 .cjs）。
 *   实测结果就是触发判定全对、执行时炸在 `getConversationRoomCount is not a function`：
 *
 *     [I] chatluna-proactive [evaluateTriggers] group:454444539: activityScore=0.094 threshold=0.050
 *     [I] chatluna-proactive [verboseLog][message-eval] … finalDecision=activity-trigger
 *     [I] chatluna-proactive [ensureUserRoomForGroup] 使用模板 room 进行补建 …
 *     [E] chatluna-proactive 主动触发响应失败：TypeError: getConversationRoomCount is not a function
 *
 *   所以这里只借它的**思路**（活跃度打分公式、群级历史池、回复后清池、冷却/失败退避），
 *   执行路径改成 1.4.0 的会话模型：直接把「最后发言者的 session」伪装一下丢进 chatChain。
 *
 * 三个关键机制（都有源码依据，改之前先看）：
 *   1. **怎么让 chatluna 认账**：`ctx.chatluna.chatChain.receiveCommand(session, "", { message, is_proactive })`
 *      —— 第二个参数传**空字符串**是有意的：`allow_reply` 里 `if (context.command != null) return CONTINUE`
 *      （`lib/index.cjs:2961`），空串不是 null，于是绕过"必须 @bot/引用 bot/叫昵称"的判定。
 *      同时 `read_chat_message` 里 `context.command != null ? context.message : session.elements`
 *      （`lib/index.cjs:3578`）会采用我们塞进去的 message。
 *   2. **伪装会话**：把最后一次群消息的 session 浅克隆，删掉 author/userId/username 再写入
 *      `userId = "__proactive_trigger__"`。chatluna 核心不认这个魔数，但本项目自己的
 *      `chatluna-vision` 靠它放行主动插话里的图片（配置项 parseWhenUserIds）。
 *   3. **回复后清池**：挂一个链中间件排在 `request_conversation` **之后**——能跑到那儿就说明
 *      bot 这一轮真的回复了（allow_reply 提前 STOP 的话根本到不了），此时把该群历史池清空，
 *      下一轮主动发言就只会看到"上次发言之后"的新消息，不会重复作答。
 *
 * 与 R10（消息聚合）的关系：主动发言走的是 `command = ""`，`messageQueue` 判定
 * `context.command?.length > 0` 为假 → 会进 pending 队列，所以实际开口时间 = 轮询命中 + messageQueueDelay。
 */

const { Schema, Logger, h } = require('koishi')

const name = 'chatluna-proactive'

/** chatluna 服务不是立刻可用的，用 inject 等它（optional，缺了插件也不会挂） */
const inject = { required: ['http'], optional: ['chatluna', 'qqbotGuard'] }

const logger = new Logger('chatluna-proactive')

/** 主动发言用的伪身份，chatluna-vision 的 parseWhenUserIds 默认认这个值 */
const PROACTIVE_USER_ID = '__proactive_trigger__'
const PROACTIVE_USERNAME = 'proactive'

/** ChainMiddlewareRunStatus：我们不拦消息，一律往下放 */
const SKIPPED = 0
const CONTINUE = 2

/** 每个群历史池里最多留几张图的字节（防止长时间跑把内存吃满） */
const MAX_POOL_IMAGE_BYTES = 4 * 1024 * 1024
const MAX_POOL_IMAGES = 6
/** 热度时间戳最多留这么多条（90s 窗口最多也只需要几十条，够用又不涨内存） */
const HEAT_MAX = 240
/** 话题黑名单的判定窗口：只看最近这么多条非 direct 消息（"现在在聊什么"） */
const SKIP_TOPIC_WINDOW = 6
/** 闸门拒绝后池子截到只剩这么多条（留个上下文，别让下一轮瞎判） */
const KEEP_AFTER_SKIP = 3

const DEFAULT_ACTIVITY_PROMPT = [
  '【自动插话】群里的消息你一直在看着，现在轮到你说点什么了（不是有人叫你，是你自己想插一句）。',
  '当前时间：{date} {time}',
  '群聊名称：{group_name}',
  '你上次说话之后，群里又聊了这些：',
  '{history}',
  '',
  '上面的消息都不是在跟你说话。你只要判断一件事：这个话题你有没有想插一句的。',
  '想插话就只回你要说的那句话本身——短、口语、像群里的人随口接的一句，符合你平时的说话风格。',
  '不要 @ 任何人，不要复述别人说了什么，不要用"我注意到你们在聊"这种开场，不要解释你在做什么。',
  '★ 但**前提是你真的看懂了**：如果这波话题靠的是太新或太专的信息（电竞赛事与比赛进程、直播、',
  '实时比分、选手操作、股票行情这类），你并没有可靠来源，接了必然是外行话——',
  '那就**只输出 [SKIP]**，别硬接，也别用"确实""草""?"这种空洞附和凑数。',
].join('\n')

const DEFAULT_IDLE_PROMPT = [
  '【群聊冷场】这个群已经 {idle_minutes} 分钟没人说话了。',
  '当前时间：{date} {time}',
  '群聊名称：{group_name}',
  '你自己上次说话前后，群里是这样的（可能是空的）：',
  '{history}',
  '',
  '你可以主动起个话头，也可以就着上面的话题再补一句。',
  '只回你要说的那句话本身，短一点、自然一点，像群里的人随口说的；',
  '不要像客服一样问候，不要问"大家在忙什么""有人吗"这种空话，也不要 @ 任何人。',
  '如果上面什么都没聊过，就随便说一句你此刻在想的事。',
  '★ 但如果上面聊的是你根本插不进去的领域（电竞赛事、直播、行情这类太新太专的东西），',
  '那就**只输出 [SKIP]**——冷场不是你的责任，硬起话头更尴尬。',
].join('\n')

/**
 * 插话把关提示词（第六轮追加）。
 *
 * 用户原话：「插入对话前需要能够理解对话再插入，不然会出现**牛头不对马嘴**的情况，
 *   群在聊电竞的时候**直接不插入**，因为电竞信息太新了，即使是提供网页搜索也不可能明白」。
 *
 * 设计要点：
 *   - **默认是不说话**：只有"真看懂 + 有具体的话可接"才放行；
 *   - 明确点名"太新或太专"的领域（电竞赛事、直播、实时比分、行情、突发新闻）——
 *     bot 没有可靠来源，接了必然是外行话；
 *   - 输出只有两种、各一行，好解析：`SPEAK: …` / `SKIP: …`；
 *   - 解析不出来时**按 SKIP 处理**（宁可少说）。
 */
const DEFAULT_JUDGE_PROMPT = [
  '你在替一个 QQ 群里的机器人【把关】：它现在想主动插一句话，你判断该不该让它说。',
  '',
  '当前时间：{date} {time}',
  '群聊名称：{group_name}',
  '它上次说话之后，群里聊的是这些：',
  '{history}',
  '',
  '**只有同时满足下面两条，才允许它开口**：',
  '1. 你真的看懂了这波在聊什么——能一句话说清"大家在聊哪件事、聊到哪一步"；',
  '2. 有一句**具体**的话可接：接梗、给判断、答问题、补充信息都算。',
  '',
  '**出现下面任何一条，一律不许开口**：',
  '- 话题靠的是**太新或太专**的信息：电竞赛事与比赛进程、直播、实时比分、选手操作与战术、',
  '  股票行情、体育比分、突发新闻——它没有可靠来源，接了必然是外行话、马后炮；',
  '- 你只是"大概知道在聊什么"，说不出具体能接哪一句；',
  '- 你唯一能想到的只是"确实""草""?""笑死"这种没有信息量的附和；',
  '- 大家在聊私事、或者在跟某个特定的人说话，插进去是打扰；',
  '- 记录里没有实质内容（只有表情、图片、单字、@）。',
  '',
  '宁可不说，也不要为了刷存在感硬接一句。',
  '',
  '只输出下面两种之一，**一行，不要解释、不要多余的话**：',
  'SPEAK: <你想让它说的那句话本身>',
  'SKIP: <不超过 15 字的理由>',
].join('\n')

/**
 * 话题关键词黑名单（零成本硬拦：连判定模型都不调）。
 *
 * ★ 为什么有了判定模型还要这个：用户明确要求「群在聊电竞的时候**直接**不插入」——
 *   "直接"是硬要求，交给模型判就有失手率，这里按关键词确定性拦掉。
 * ★ 词表刻意**不放单字缩写**（瓦 / 狙 / jee 这种）：中文单字会误伤
 *   （"瓦"会命中"瓦斯""瓦片"），这类交给判定模型按上下文判。
 * ★ 匹配规则：纯拉丁/数字词按词边界（`VCT` 不会命中 `VCTF`），含中文/其它字符的词按包含匹配。
 */
const DEFAULT_SKIP_TOPICS = [
  '电竞',
  '比赛',
  '赛事',
  '比分',
  '战队',
  '选手',
  '直播',
  '排位',
  '上分',
  'VCT',
  'LPL',
  'KPL',
  'Valorant',
  '瓦罗兰特',
  '天禄',
]

const Config = Schema.intersect([
  Schema.object({
    enabled: Schema.boolean().default(true).description('总开关'),
    pollSeconds: Schema.natural()
      .default(5)
      .description('轮询间隔（秒）。每隔这么久检查一次活跃度与空闲'),
    cooldownSeconds: Schema.natural()
      .default(300)
      .description('两次主动发言之间的最小间隔（秒）。防刷屏的第一道闸'),
    failureCooldownSeconds: Schema.natural()
      .default(60)
      .description('主动发言失败后的退避时间（秒）'),
    historyLimit: Schema.natural()
      .default(20)
      .description('历史池容量，同时也是单次最多注入的条数'),
    quietHours: Schema.string()
      .default('01:00-08:00')
      .description(
        '免打扰时段（HH:MM-HH:MM，跨零点也认）。这段时间一律不主动开口——' +
          '半夜群里没人说话本来就是正常的，不需要它来暖场。留空则全天可发言'
      ),
    maxImages: Schema.natural()
      .default(3)
      .description('单次最多注入几张图（图片在记录时就抓成本地字节，避免 rkey 过期）'),
    activityPrompt: Schema.string()
      .role('textarea', { rows: [8, 20] })
      .default(DEFAULT_ACTIVITY_PROMPT)
      .description(
        '活跃度触发的提示词。可用变量：{history} {time} {date} {group_name} {user_name} {idle_minutes}'
      ),
    idlePrompt: Schema.string()
      .role('textarea', { rows: [8, 20] })
      .default(DEFAULT_IDLE_PROMPT)
      .description('空闲触发的提示词。可用变量同上'),
  }),
  Schema.object({
    judgeEnabled: Schema.boolean()
      .default(true)
      .description(
        '插话把关（第六轮）：真的开口之前，先让一个便宜模型判断"这波话题是否真看懂、是否真有话可接"。' +
          '判定为不可接就**直接放弃**，不烧主模型。默认开'
      ),
    judgeModel: Schema.string()
      .default('cc/q.memory')
      .description('把关用的模型。默认走免费档（`cc/q.memory`），拿不到就退到默认对话模型'),
    judgeTimeoutMs: Schema.natural()
      .role('ms')
      .default(30000)
      .description('把关调用的超时。★ 超时/报错一律**按不可接处理**（宁可少说）'),
    judgeSkipSeconds: Schema.natural()
      .default(240)
      .description('把关判定"不可接"之后，多少秒内不再重复判定（防止每 5 秒问一次模型）'),
    judgePrompt: Schema.string()
      .role('textarea', { rows: [12, 26] })
      .default(DEFAULT_JUDGE_PROMPT)
      .description('把关提示词。可用变量：{history} {time} {date} {group_name} {user_name} {idle_minutes}'),
    skipTopics: Schema.array(Schema.string())
      .role('table')
      .default(DEFAULT_SKIP_TOPICS)
      .description(
        '话题关键词黑名单：命中就**完全不插话**（零模型成本，连把关都不调）。' +
          '纯拉丁/数字词按词边界匹配，含中文的词按包含匹配。' +
          '默认拦掉电竞/赛事/实时比分这类"太新太专、接了必然外行"的话题'
      ),
  }).description('插话把关（理解之后再开口）'),
  Schema.object({
    groups: Schema.array(
      Schema.object({
        guildId: Schema.string().required().description('群号'),
        enableActivity: Schema.boolean()
          .default(true)
          .description('启用活跃度触发：群里聊得热乎时插一句'),
        activityThreshold: Schema.number()
          .min(0)
          .max(1)
          .step(0.05)
          .default(0.5)
          .description('活跃度阈值（0~1）。越大越难触发。0.5 对普通小群已经算敏感'),
        thresholdCeiling: Schema.number()
          .min(0)
          .max(1)
          .step(0.05)
          .default(0.65)
          .description(
            '阈值上限：每主动发言一次，阈值就往这里挪一点（越聊越克制）。' +
              '比 activityThreshold 小则反过来越聊越积极'
          ),
        activityMessageInterval: Schema.natural()
          .default(15)
          .description('消息数兜底：距上次发言累计这么多条群消息就触发一次（0 = 关）'),
        enableIdle: Schema.boolean()
          .default(true)
          .description('启用空闲触发：群里长时间没人说话时主动起个话头'),
        idleMinutes: Schema.natural().default(180).description('空闲多久算冷场（分钟）'),
        idleJitter: Schema.boolean()
          .default(true)
          .description('空闲触发加 ±10% 随机抖动，避免每天同一分钟开口'),
      })
    )
      .role('list')
      .default([])
      .description('要监控的群。不在这个列表里的群一律不管'),
  }),
])

// ------------------------------------------------------------------ 小工具

function pad(n) {
  return String(n).padStart(2, '0')
}

function formatTime(d) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function formatDate(d) {
  const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()]
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} 星期${week}`
}

/**
 * 元素标记 → 纯文本。只给兜底路径用（正常路径走下面逐元素翻译，翻得更准）。
 *
 * ★ 兜底**不能**直接退回 `session.content`（坑 58）：那是**元素标记**不是文字 ——
 *   图片消息会是 `<img src="https://…rkey=…" summary="" file="…" sub-type="0"/>`。
 *   原样用有两个后果：提示词里塞进带签名的长 URL；话题黑名单拿它当正文匹配，
 *   图片链接里凑巧出现 `lpl`/`vct` 这种子串就会**误判成在聊电竞**而闭嘴。
 */
function stripMarkup(text) {
  return String(text ?? '')
    .replace(/<img\b[^>]*\/?>/gi, '[图片]')
    .replace(/<at\b[^>]*\bid="?(\d+)"?[^>]*\/?>/gi, '@$1')
    .replace(/<(\/?[a-z][a-z0-9-]*)\b[^>]*\/?>/gi, '')
}

/**
 * 把一条消息压成一行纯文本。
 * 不直接用 session.content：那种"元素转文本"的结果对图片/表情/@ 的处理不好控，
 * 我们这里图片单独走 imgs，正文里只留文字与 @。
 */
function plainTextOf(session) {
  const parts = []
  for (const el of session.elements || []) {
    if (!el) continue
    if (el.type === 'text') parts.push(el.attrs?.content ?? '')
    else if (el.type === 'at') parts.push(`@${el.attrs?.name || el.attrs?.id || '某人'}`)
    else if (el.type === 'face') parts.push('[表情]')
    else if (el.type === 'img' || el.type === 'image') parts.push('[图片]')
    else if (el.type === 'video') parts.push('[视频]')
    else if (el.type === 'audio' || el.type === 'record') parts.push('[语音]')
  }
  const text = parts.join('').trim()
  return text || stripMarkup(session.content).trim()
}

/** 这条消息里的图片 URL（Koishi 的 img 元素属性名可能是 src / url / file） */
function imageUrlsOf(session) {
  const out = []
  for (const el of session.elements || []) {
    if (el?.type !== 'img') continue
    const a = el.attrs || {}
    const url = a.src || a.url || a.file
    if (url) out.push(String(url))
  }
  return out
}

/** 这条消息是不是在跟 bot 说话（@ / 开头叫昵称 / 引用 bot）——这类消息不进主动发言的上下文 */
function isTalkingToBot(session) {
  if (session.stripped?.appel || session.stripped?.atSelf) return true
  const selfId = String(session.selfId)
  if (
    session.elements?.some(
      (el) => el?.type === 'at' && String(el?.attrs?.id) === selfId
    )
  ) {
    return true
  }
  if (session.quote?.user?.id != null && String(session.quote.user.id) === selfId) {
    return true
  }
  return false
}

/**
 * 活跃度打分。公式照搬 chatluna-proactive-trigger（那部分跟 chatluna 版本无关，可放心用）：
 *   90s/20s 两个窗口的"条/分钟"速率 → logistic 平滑 → 0.65/0.35 加权
 *   30s 突发窗口超过 12 条/分钟再补 0~0.25
 *   最后乘一个"新鲜度"因子（半衰期 60s），越久没消息分数越低
 */
const WINDOW_RECENT = 90 * 1000
const WINDOW_INSTANT = 20 * 1000
const WINDOW_BURST = 30 * 1000
const RATE_SUSTAINED = 10
const RATE_INSTANT = 9
const RATE_BURST = 12

function logistic(x) {
  return 1 / (1 + Math.exp(-x))
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v))
}

function rateOf(timestamps, now, windowMs) {
  const cutoff = now - windowMs
  let count = 0
  for (const t of timestamps) if (t >= cutoff) count++
  return (count / windowMs) * 60000
}

function activityScore(timestamps, now) {
  if (timestamps.length === 0) return 0
  const recent = rateOf(timestamps, now, WINDOW_RECENT)
  const instant = rateOf(timestamps, now, WINDOW_INSTANT)
  const burst = rateOf(timestamps, now, WINDOW_BURST)
  let score =
    logistic((recent - RATE_SUSTAINED) / 3) * 0.65 +
    logistic((instant - RATE_INSTANT) / 2) * 0.35
  if (burst > RATE_BURST) score += clamp((burst - RATE_BURST) / 4, 0, 1) * 0.25
  const last = Math.max(...timestamps)
  const freshness = Math.exp((-(now - last) / 60000) * Math.LN2)
  return clamp(score * (0.55 + 0.45 * freshness), 0, 1)
}

/** 把 "HH:MM-HH:MM" 解析成分钟区间；支持跨零点（22:00-07:00）。解析不了就返回 null */
function parseQuietHours(text) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(String(text || ''))
  if (!m) return null
  const to = (h, min) => (Number(h) % 24) * 60 + Number(min)
  const start = to(m[1], m[2])
  const end = to(m[3], m[4])
  if (start === end) return null
  return { start, end }
}

function inQuietHours(range, date) {
  if (!range) return false
  const now = date.getHours() * 60 + date.getMinutes()
  return range.start < range.end
    ? now >= range.start && now < range.end
    : now >= range.start || now < range.end
}

/**
 * 造一个"主动发言者"的会话。
 *
 * ★ 为什么不是"克隆最后发言者的 session"（生态里那个插件就是这么干的）：
 *   Koishi 的 session 方法（`resolve` / `text` / `stripped` …）不是挂在原型上的，
 *   而是 `KoishiSession` 服务构造时 `ctx.mixin(this, { resolve: 'session.resolve', … })`
 *   **混入到实例上**的（`@koishijs/core/lib/index.cjs:1762-1785`）。
 *   照 `Object.getPrototypeOf(base)` + 拷 own descriptors 那套克隆，方法会全丢，实测报：
 *     [E] chatluna chat-chain: allow_reply error TypeError: session.resolve is not a function
 *     [E] chatluna TypeError: session.text is not a function
 *   所以这里走框架正路：`bot.session(event)` 拿一个**真的** Session 实例，
 *   只把 event 里跟"谁发的、说了什么"相关的字段换掉。
 *
 * 关键字段：
 *   - `event.user = { id: '__proactive_trigger__' }`：userId 不能是自己的 QQ 号，
 *     否则 `allow_reply` 开头 `if (ctx.bots[session.uid]) return STOP` 会当成 bot 自己的消息掐掉。
 *   - 删掉 `event.member`：satori 的 `author` getter 是 `{...event.user, ...event.member}`，
 *     留着 member 会让真实群名片盖掉我们的伪身份。
 */
function createProactiveSession(base, text, elements) {
  const event = { ...(base.event || {}) }
  event.selfId = base.selfId
  event.platform = base.platform
  event.timestamp = Date.now()
  event.user = { id: PROACTIVE_USER_ID, name: PROACTIVE_USERNAME }
  delete event.member
  event.message = {
    id: `proactive-${Date.now()}`,
    content: text,
    elements,
  }
  return base.bot.session(event)
}

// ------------------------------------------------------------------ 应用

function apply(ctx, config) {
  const profiles = new Map()
  for (const g of config.groups || []) {
    if (g?.guildId) profiles.set(String(g.guildId), g)
  }

  /** guildId -> { msgs: [], lastSession, lastMessageAt, groupName } */
  const pools = new Map()
  /** guildId -> { lastTriggerAt, msgCount, threshold, cooldownUntil, locked, failures } */
  const states = new Map()

  const quietRange = parseQuietHours(config.quietHours)
  /** 上次因为"作息表说在睡觉"而闭嘴的日志时间（节流用） */
  let quietLoggedAt = 0

  /** 指令前缀（`/` `.`）：指令消息不进历史池，也不算群活跃度 */
  const prefixes = (() => {
    const raw = ctx.root?.config?.prefix
    const list = Array.isArray(raw) ? raw : []
    return list.map((p) => String(p ?? '')).filter(Boolean)
  })()

  const log = (...a) => config.debug && logger.info(...a)

  function poolOf(guildId) {
    let p = pools.get(guildId)
    if (!p) {
      p = {
        msgs: [],
        // ★ 群聊"热度"时间戳，专门喂给 activityScore。
        //   为什么不直接用 msgs 算：msgs 的语义是"**bot 上次说话之后**群里聊了什么"，
        //   每轮正常回复都会被 proactive-pool-reset 清空（那是设计如此：别重复作答）。
        //   而活跃度衡量的是"这个群现在热不热"，跟 bot 看没看过无关 ——
        //   2026-10-03 的实测里，一群人在刷屏、中途 @ 了 bot 一句，池子立刻清零，
        //   热度跟着归零，于是那一波最该插话的时候分数永远起不来。
        heat: [],
        lastSession: null,
        lastMessageAt: 0,
        lastGuildId: guildId,
        groupName: '',
      }
      pools.set(guildId, p)
    }
    return p
  }

  function stateOf(guildId) {
    let s = states.get(guildId)
    if (!s) {
      s = { lastTriggerAt: 0, msgCount: 0, threshold: null, cooldownUntil: 0, locked: false, failures: 0, lastEvalLogAt: 0 }
      states.set(guildId, s)
    }
    return s
  }

  function thresholdOf(state, profile) {
    if (state.threshold == null) state.threshold = profile.activityThreshold
    return state.threshold
  }

  /**
   * 把消息里的图当场抓成本地字节，避免过一会儿 rkey 失效（引用/历史里的图最容易踩这个）。
   * 抓取是异步的、不阻塞消息处理；抓不完也不要紧，主动发言时有多少用多少。
   */
  function rememberImages(pool, msgIndex, urls) {
    for (const url of urls) {
      const count = pool.msgs.reduce((n, m) => n + (m.imgs?.length || 0), 0)
      if (count >= MAX_POOL_IMAGES) return
      ctx.http
        .file(url, { timeout: 15000 })
        .then((res) => {
          const data = res?.data
          if (!data) return
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
          if (!buf.length || buf.length > 3 * 1024 * 1024) return
          let mime = String(res.type || res.mime || 'image/jpeg').split(';')[0].trim()
          if (!/^image\//.test(mime)) mime = 'image/jpeg'
          const msg = pool.msgs[msgIndex]
          if (!msg) return
          msg.imgs = msg.imgs || []
          msg.imgs.push({ buf, mime })
          log('已缓存图片 %d 字节（群 %s）', buf.length, pool.groupName)
        })
        .catch((e) => log('图片缓存失败：%s', e.message))
    }
  }

  function renderPrompt(template, pool, idleMinutes) {
    const now = new Date()
    const lines = pool.msgs
      .filter((m) => !m.direct)
      .map((m) => `[${formatTime(new Date(m.ts))}] ${m.name}(${m.id}): ${m.content}`)
    const last = [...pool.msgs].reverse().find((m) => !m.direct)
    return String(template)
      .replaceAll('{history}', lines.join('\n') || '（这段时间群里没有新消息）')
      .replaceAll('{time}', formatTime(now))
      .replaceAll('{date}', formatDate(now))
      .replaceAll('{group_name}', pool.groupName || pool.lastGuildId || '')
      .replaceAll('{user_name}', last?.name || '')
      .replaceAll('{idle_minutes}', String(idleMinutes))
  }

  // ---------------------------------------------------------------- 插话把关（第六轮）

  /** 已经打过"把关模型就绪"日志的模型名（避免每轮刷屏） */
  const loggedJudgeModels = new Set()

  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  /**
   * 话题黑名单硬拦。命中返回命中的那个词，否则 null。
   * 只看"不是在跟 bot 说话"的消息（direct 的不算话题），**且只看最近几条**。
   *
   * ★ 为什么必须限定窗口（rig 55 第一次跑就打脸了）：一开始拿整个历史池去匹配，
   *   结果"比分"这两个字一旦出现，**在池子被清空之前每一轮都命中**——
   *   群里早就换话题了，bot 还在因为十分钟前的一句"看比分好像是2-0了"闭嘴。
   *   语义应该是"**现在**在聊这个话题"，不是"**聊过**这个话题"。
   */
  function hitSkipTopic(pool) {
    const list = (config.skipTopics || []).map((s) => String(s ?? '').trim()).filter(Boolean)
    if (!list.length) return null
    const recent = pool.msgs.filter((m) => !m.direct).slice(-SKIP_TOPIC_WINDOW)
    const text = recent
      .map((m) => m.content || '')
      .join('\n')
      .toLowerCase()
    if (!text) return null
    for (const raw of list) {
      const k = raw.toLowerCase()
      // 纯拉丁/数字词按词边界：`VCT` 不该命中 `VCTF`，也不该命中 `xxvct`
      if (/^[a-z0-9]+$/.test(k)) {
        if (new RegExp(`(^|[^a-z0-9])${escapeRe(k)}([^a-z0-9]|$)`, 'i').test(text)) return raw
      } else if (text.includes(k)) {
        return raw
      }
    }
    return null
  }

  /**
   * 闸门拒绝之后把池子截短。
   *
   * 池子的语义是"**下一次插话要看的材料**"。已经看过、判过、决定不说的东西留着，
   * 只会带来两个坏处：① 旧话题永久毒化后面的每一次判断（上面那个坑）；
   * ② 每轮都把同样的内容再喂给把关模型，白花调用。
   * 留最后几条是为了让下一轮**不是瞎判**（至少知道上一句在说什么）。
   */
  function trimPoolAfterSkip(pool) {
    if (pool.msgs.length > KEEP_AFTER_SKIP) {
      pool.msgs = pool.msgs.slice(-KEEP_AFTER_SKIP)
    }
  }

  /**
   * 调一次把关模型拿纯文本（带超时）。
   *
   * ★ 两个必须记住的 API 事实（episode 插件第一次写错过，rig 报 `model.invoke is not a function`）：
   *   1. `chatluna.createChatModel(name)` 是 **async** 的，要 await；
   *   2. 它返回的是**响应式 ref**，真模型在 `.value` 上。
   */
  async function invokeJudgeModel(prompt) {
    const chatluna = ctx.chatluna
    if (!chatluna || typeof chatluna.createChatModel !== 'function') {
      throw new Error('chatluna 服务不可用')
    }
    const names = [config.judgeModel, chatluna.config?.defaultModel].filter(Boolean)
    let lastError = '没有可用的模型名'
    for (const name of names) {
      try {
        const ref = await chatluna.createChatModel(name)
        const model = ref?.value
        if (!model || typeof model.invoke !== 'function') {
          lastError = `${name} 拿不到可用模型`
          continue
        }
        const timeout = config.judgeTimeoutMs
        let timer
        const response = await Promise.race([
          model.invoke(prompt, { timeout }),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('把关超时')), timeout)
          }),
        ]).finally(() => clearTimeout(timer))
        let text = typeof response === 'string' ? response : response?.content
        if (Array.isArray(text)) {
          text = text.map((c) => (typeof c === 'string' ? c : c?.text || '')).join('')
        }
        text = String(text || '').trim()
        if (!text) throw new Error('把关模型返回空')
        if (!loggedJudgeModels.has(name)) {
          loggedJudgeModels.add(name)
          logger.info('插话把关模型就绪：%s', name)
        }
        return text
      } catch (e) {
        lastError = `${name}: ${e.message}`
      }
    }
    throw new Error(lastError)
  }

  /**
   * 让把关模型判一次。返回 `{ speak, reason, draft }`。
   * ★ 解析不出来时**按不可接处理**（宁可少说）。
   */
  async function judgeInterjection(pool, kind, idleMinutes) {
    const prompt = renderPrompt(config.judgePrompt, pool, idleMinutes, kind === 'idle')
    const text = await invokeJudgeModel(prompt)
    const m = /^\s*(SPEAK|SKIP)\s*[:：]\s*([\s\S]*)$/i.exec(text)
    if (!m) {
      return { speak: false, reason: `把关输出无法解析：${text.replace(/\s+/g, ' ').slice(0, 60)}` }
    }
    if (m[1].toUpperCase() === 'SPEAK') {
      return { speak: true, draft: m[2].replace(/\s+/g, ' ').trim().slice(0, 120) }
    }
    return { speak: false, reason: m[2].replace(/\s+/g, ' ').trim().slice(0, 60) || '（没给理由）' }
  }

  /** 真正开口。`detail` 只用于日志：把"为什么决定插话"写清楚（分数/阈值/条数/安静多久） */
  async function speak(guildId, kind, profile, state, pool, detail) {
    if (state.locked) return false
    // R15：被屏蔽的群连"想说话"都不该想。链闸门（guard 插件）也能拦住，
    // 但那会白烧一次模型调用，所以这里先问一句。
    if (ctx.qqbotGuard?.isBlocked({ platform: 'onebot', channelId: guildId, guildId, isDirect: false })) {
      log('群 %s 处于屏蔽状态，跳过主动发言', guildId)
      return false
    }
    if (!pool.lastSession) {
      log('群 %s 还没有可用的 session，跳过', guildId)
      return false
    }
    // ★ 这一行**不随 debug 开关**：主动插话一天也就几次，"到底判没判它插话、
    //   是按什么判的"必须能在日志里一眼看到（排查"插话频率太低"时全靠它）。
    //   放在两道 early-return 之后：否则被屏蔽的群会每 5 秒刷一行。
    logger.info(
      '决定插话（%s）：群 %s%s',
      kind === 'idle' ? '空闲触发' : '活跃度触发',
      guildId,
      detail ? `｜${detail}` : ''
    )
    state.locked = true
    try {
      const now = Date.now()
      const idleMinutes = Math.floor((now - (pool.lastMessageAt || now)) / 60000)

      // ---------------- 第六轮：插话前两道闸（"理解之后再开口"） ----------------

      // 闸 A：话题黑名单（零成本硬拦）。用户要求「群在聊电竞的时候**直接**不插入」，
      //       这种"直接"必须是确定性的，不能交给模型判。
      const topic = hitSkipTopic(pool)
      if (topic) {
        state.cooldownUntil = Date.now() + config.judgeSkipSeconds * 1000
        state.msgCount = 0
        trimPoolAfterSkip(pool)
        logger.info(
          '放弃插话：命中话题黑名单「%s」（%d 秒内不再试）',
          topic,
          config.judgeSkipSeconds
        )
        return false
      }

      // 闸 B：把关模型判"是否真看懂、是否真有话可接"。
      //       用便宜模型（默认免费档）先挡一次，避免拿 1 万 token 的主链去试探。
      if (config.judgeEnabled) {
        let verdict
        try {
          verdict = await judgeInterjection(pool, kind, idleMinutes)
        } catch (e) {
          // ★ 把关失败**按不可接处理**：没确认看懂就不开口。
          state.cooldownUntil = Date.now() + config.failureCooldownSeconds * 1000
          logger.warn('插话把关调用失败，这次不插话：%s', e.message)
          return false
        }
        if (!verdict.speak) {
          state.cooldownUntil = Date.now() + config.judgeSkipSeconds * 1000
          state.msgCount = 0
          trimPoolAfterSkip(pool)
          logger.info(
            '放弃插话：把关判定不可接（%s）｜%d 秒内不再试',
            verdict.reason,
            config.judgeSkipSeconds
          )
          return false
        }
        logger.info(
          '把关通过，可以接：%s',
          verdict.draft ? `草稿「${verdict.draft}」` : '（没给草稿）'
        )
      }

      const template = kind === 'idle' ? config.idlePrompt : config.activityPrompt
      const text = renderPrompt(template, pool, idleMinutes, kind === 'idle')
      const els = [h.text(text)]
      let used = 0
      for (const m of pool.msgs) {
        for (const img of m.imgs || []) {
          if (used >= config.maxImages) break
          els.push(h.image(`data:${img.mime};base64,${img.buf.toString('base64')}`))
          used++
        }
      }
      const session = createProactiveSession(pool.lastSession, text, els)
      const msgCount = pool.msgs.length
      // ★ 先跟出站整形打个招呼：这一轮是"我自己想插一句"，不是回复谁 ——
      //   让 reply-style 别加引用/@（否则频道兜底会随便挑一条群消息挂上，
      //   还会 @ 一个没跟 bot 说话的群友，见 docs/04 坑 53）。
      //   ★ 用 `ctx.reflect.get('replyStyle')` 而不是 `ctx.replyStyle`：
      //     后者在服务没注册时每次访问都会打一条
      //     `property replyStyle is not registered, declare it as inject` 警告
      //     （`@cordisjs/core/lib/index.cjs:284`）；而写进 `inject.optional` 又要
      //     赌"服务不存在时插件照样加载"，插话是主功能，不值得为一行日志赌这个。
      const replyStyle = () => {
        try {
          return ctx.reflect?.get?.('replyStyle') ?? null
        } catch {
          return null
        }
      }
      // 120s 只是**兜底**（真出事时窗口不会一直挂着）；正常情况下下面 finally 里会收到 10s
      try {
        replyStyle()?.suppress?.(guildId, 120000)
      } catch (e) {
        logger.warn('通知 replyStyle 失败（不影响插话）：%s', e.message)
      }
      try {
        await ctx.chatluna.chatChain.receiveCommand(session, '', {
          message: els,
          is_proactive: true,
        })
      } finally {
        // ★ 这一轮的话已经发出去了（`request_conversation completed` 在发送之后），
        //   就赶紧把窗口收窄到 10 秒 —— 否则接下来的两分钟里，**同频道的正常回复**
        //   也会被一起放过（实测 2026-10-03 18:16 那次插话之后，18:17 的两条正常回复
        //   就白白丢了引用/@）。留 10 秒是给可能的分条/补充消息兜底。
        try {
          replyStyle()?.suppress?.(guildId, 10000)
        } catch {
          /* 收窄失败无所谓：120s 的兜底还在 */
        }
      }
      state.lastTriggerAt = Date.now()
      state.msgCount = 0
      state.failures = 0
      pool.msgs = []
      // 越聊越克制 / 越聊越积极：每次开口后把阈值往 ceiling 挪 10%
      const ceiling = profile.thresholdCeiling
      const step = (ceiling - profile.activityThreshold) * 0.1
      state.threshold = clamp(
        thresholdOf(state, profile) + step,
        Math.min(profile.activityThreshold, ceiling),
        Math.max(profile.activityThreshold, ceiling)
      )
      logger.info(
        '已主动发言（%s）：群 %s，池内 %d 条消息，%d 张图，阈值调到 %s',
        kind === 'idle' ? '空闲触发' : '活跃度触发',
        guildId,
        msgCount,
        used,
        state.threshold.toFixed(3)
      )
      return true
    } catch (e) {
      state.failures += 1
      state.cooldownUntil = Date.now() + config.failureCooldownSeconds * 1000
      logger.warn('主动发言失败（第 %d 次）：%s', state.failures, e.message)
      return false
    } finally {
      state.locked = false
    }
  }

  // ---------------------------------------------------------------- 1) 记消息

  ctx.middleware((session, next) => {
    try {
      if (config.enabled && !session.isDirect && session.guildId) {
        const guildId = String(session.guildId)
        const profile = profiles.get(guildId)
        if (profile && !ctx.bots[session.uid]) {
          const pool = poolOf(guildId)
          const content = plainTextOf(session)
          // 指令消息（/xxx、.xxx）不算"群聊热度"：它们不会进历史池，也不该把活跃度顶起来
          if (prefixes.some((p) => content.startsWith(p))) return next()
          const msg = {
            id: String(session.userId ?? ''),
            name: session.author?.name || session.username || String(session.userId ?? ''),
            content,
            ts: Date.now(),
            direct: isTalkingToBot(session),
            imgs: [],
          }
          pool.msgs.push(msg)
          pool.lastSession = session
          pool.lastMessageAt = msg.ts
          pool.lastGuildId = guildId
          pool.groupName = session.event?.group?.name || session.guildName || pool.groupName
          if (pool.msgs.length > config.historyLimit) {
            pool.msgs = pool.msgs.slice(-config.historyLimit)
          }
          rememberImages(pool, pool.msgs.length - 1, imageUrlsOf(session))
          // 热度只收"不是在跟 bot 说话"的消息，且**永不被清池影响**（见 poolOf 的注释）
          if (!msg.direct) {
            pool.heat.push(msg.ts)
            if (pool.heat.length > HEAT_MAX) pool.heat = pool.heat.slice(-HEAT_MAX)
          }
          const state = stateOf(guildId)
          state.msgCount += 1
          if (state.threshold == null) state.threshold = profile.activityThreshold
          // 有新消息就把评估日志节流器放开：下一条评估日志立刻可见
          state.lastEvalLogAt = 0
        }
      }
    } catch (e) {
      logger.warn('记录群消息时出错：%s', e.message)
    }
    return next()
  })

  // ---------------------------------------------------------------- 2) 轮询

  ctx.setInterval(() => {
    if (!config.enabled) return
    const now = Date.now()
    const nowDate = new Date(now)
    if (inQuietHours(quietRange, nowDate)) return
    // ★ 作息表（chatluna-routine）：睡觉时段不主动开口。
    //   和 quietHours 的分工：quietHours 是"这个钟点别出声"（纯时间规则），
    //   作息表是"bot 现在在睡觉"这个**状态**，还会把「我先去睡了」写进它自己的记忆。
    //   两者不冲突 —— 谁命中都闭嘴，用户只配一个也行。
    try {
      const routine = ctx.get('chatluna_routine')
      if (routine && typeof routine.isQuiet === 'function' && routine.isQuiet(now)) {
        // 每 10 分钟最多说一次，免得秒级轮询把日志刷爆
        if (!quietLoggedAt || now - quietLoggedAt > 600000) {
          quietLoggedAt = now
          logger.info('作息表：现在在「%s」，不主动开口', routine.state?.(now)?.label || '静默时段')
        }
        return
      }
    } catch (e) {
      logger.debug('读作息表失败（忽略）：%s', e.message)
    }
    for (const [guildId, profile] of profiles) {
      const pool = pools.get(guildId)
      const state = stateOf(guildId)
      if (!pool || pool.msgs.length === 0 || state.locked) continue
      if (now < state.cooldownUntil) continue
      if (state.lastTriggerAt && now - state.lastTriggerAt < config.cooldownSeconds * 1000) continue

      // 叫 bot 的那些消息不算"群聊热度"（它们已经被正常回复过了）。
      // ★ 热度用 pool.heat（清池也不会掉），不用 pool.msgs —— 原因见 poolOf 的注释。
      const eligible = pool.msgs.filter((m) => !m.direct)
      if (profile.enableActivity && pool.heat.length > 0) {
        const score = activityScore(pool.heat, now)
        const threshold = thresholdOf(state, profile)
        const byScore = score >= threshold
        const byCount =
          profile.activityMessageInterval > 0 && state.msgCount >= profile.activityMessageInterval
        // 每 60 秒最多打一条评估日志：轮询是秒级的，全打会把日志刷爆
        // （Koishi 的 logger 只认 %s/%d，不认 %.3f —— 写了会原样打出来并把参数挤到行尾）
        if (config.debug && (!state.lastEvalLogAt || now - state.lastEvalLogAt > 60000)) {
          state.lastEvalLogAt = now
          log(
            '群 %s 活跃度 %s / 阈值 %s（热度 %d 条，待插话 %d 条，计 %d 条）',
            guildId,
            score.toFixed(3),
            Number(threshold).toFixed(3),
            pool.heat.length,
            eligible.length,
            state.msgCount
          )
        }
        if (byScore || byCount) {
          void speak(
            guildId,
            'activity',
            profile,
            state,
            pool,
            `${byScore ? '分数达标' : '条数兜底'}｜活跃度 ${score.toFixed(3)} / 阈值 ${Number(
              threshold
            ).toFixed(3)}，热度 ${pool.heat.length} 条，待插话 ${eligible.length} 条`
          )
          continue
        }
      }

      if (profile.enableIdle) {
        const anchor = Math.max(pool.lastMessageAt || 0, state.lastTriggerAt || 0)
        if (anchor && now - anchor >= profile.idleMinutes * 60000) {
          void speak(
            guildId,
            'idle',
            profile,
            state,
            pool,
            `已安静 ${Math.floor((now - anchor) / 60000)} 分钟（阈值 ${profile.idleMinutes} 分钟）`
          )
        }
      }
    }
  }, Math.max(1, config.pollSeconds) * 1000)

  // ---------------------------------------------------------------- 3) 回复后清池

  ctx.inject(['chatluna'], (ctx2) => {
    const chain = ctx2.chatluna?.chatChain
    if (!chain || typeof chain.middleware !== 'function') {
      logger.warn('拿不到 chatluna.chatChain，主动发言用不了（历史池与轮询仍在跑）')
      return
    }
    chain
      .middleware(
        'proactive-pool-reset',
        async (session) => {
          try {
            // 能执行到这里 = 这一轮真的走到请求模型了（allow_reply 提前 STOP 就到不了）
            if (session.guildId) {
              const guildId = String(session.guildId)
              const pool = pools.get(guildId)
              if (pool && pool.msgs.length > 0) {
                log('群 %s 已在对话中回复，清空历史池（%d 条）', guildId, pool.msgs.length)
                pool.msgs = []
              }
              const state = states.get(guildId)
              if (state) state.msgCount = 0
            }
          } catch (e) {
            logger.warn('清历史池出错：%s', e.message)
          }
          return SKIPPED
        },
        ctx
      )
      .after('request_conversation')
    logger.info(
      '主动发言已挂载（监控 %d 个群；轮询 %ds；免打扰 %s；指令前缀 %s）',
      profiles.size,
      config.pollSeconds,
      config.quietHours || '关',
      prefixes.join(' ') || '（无）'
    )
  })

  // ---------------------------------------------------------------- 4) 指令

  ctx.command('proactive', '看主动发言当前状态', { authority: 1 }).action(({ session }) => {
    const guildId = String(session.guildId || '')
    const profile = profiles.get(guildId)
    if (!profile) return `这个群（${guildId || '私聊'}）没在主动发言的监控列表里。`
    const pool = pools.get(guildId)
    const state = stateOf(guildId)
    const now = Date.now()
    const cd = Math.max(0, Math.round((state.cooldownUntil - now) / 1000))
    const last = state.lastTriggerAt
      ? `${Math.round((now - state.lastTriggerAt) / 1000)} 秒前`
      : '还没开口过'
    return [
      `群 ${guildId}：`,
      `  历史池 ${pool?.msgs?.length ?? 0} 条（上限 ${config.historyLimit}）`,
      `  群聊热度 ${pool?.heat?.length ?? 0} 条（清池不会掉，活跃度就是按它算的）`,
      `  待插话 ${(pool?.msgs ?? []).filter((m) => !m.direct).length} 条｜其中在跟 bot 说话的 ${
        (pool?.msgs ?? []).filter((m) => m.direct).length
      } 条`,
      `  距上次发言 ${last}`,
      `  上次发言距今 ${state.lastTriggerAt ? Math.round((now - state.lastTriggerAt) / 1000) + ' 秒' : '—'}，冷却 ${config.cooldownSeconds} 秒`,
      `  失败退避剩余 ${cd} 秒，连续失败 ${state.failures} 次`,
      `  当前活跃度阈值 ${thresholdOf(state, profile).toFixed(3)}`,
      `  条数兜底：累计 ${state.msgCount} / ${profile.activityMessageInterval} 条`,
      `  免打扰时段：${config.quietHours || '关'}${inQuietHours(quietRange, new Date()) ? '（★ 现在正在免打扰里，不会开口）' : ''}`,
      `  作息表：${(() => {
        try {
          const r = ctx.get('chatluna_routine')
          if (!r) return '没装 chatluna-routine'
          const s = r.state?.()
          return `${s?.label || '醒着'}${s?.quiet ? '（★ 静默时段，不开口）' : ''}`
        } catch {
          return '读不到'
        }
      })()}`,
      `  空闲触发：${profile.enableIdle ? `${profile.idleMinutes} 分钟` : '关'}`,
      `  插话把关：${config.judgeEnabled ? `开（${config.judgeModel}，判不可接后静默 ${config.judgeSkipSeconds} 秒）` : '关'}`,
      `  话题黑名单 ${(config.skipTopics || []).length} 个词：${(config.skipTopics || []).slice(0, 8).join(' / ')}${(config.skipTopics || []).length > 8 ? ' …' : ''}`,
    ].join('\n')
  })

  // ★ 点号全名，别写 `proactive/speak`：斜杠写法的子指令名字只有 `speak`，
  //   而 Commander 是按整名查 _aliases 的（core:1411/1432）→ 用户敲 `/proactive.speak` 永远没反应。
  ctx
    .command('proactive.speak', '立刻主动发一次言（调试用）', { authority: 3 })
    .action(async ({ session }) => {
      const guildId = String(session.guildId || '')
      const profile = profiles.get(guildId)
      if (!profile) return `这个群（${guildId || '私聊'}）没在监控列表里。`
      const pool = pools.get(guildId)
      if (!pool) return '还没有任何群消息，没什么可说的。'
      const ok = await speak(guildId, 'activity', profile, stateOf(guildId), pool)
      return ok ? '已让它开口，等它自己发出来。' : '这次没发成，看日志。'
    })
}

module.exports = { name, inject, Config, apply }
