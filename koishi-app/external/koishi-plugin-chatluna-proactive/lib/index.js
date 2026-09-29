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
const inject = { required: ['http'], optional: ['chatluna'] }

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
  '实在没什么想说的，就回一句极短的附和（比如"草"、"确实"、"?"），别硬找话题。',
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
].join('\n')

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
  }
  const text = parts.join('').trim()
  return text || (session.content || '').trim()
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

  const log = (...a) => config.debug && logger.info(...a)

  function poolOf(guildId) {
    let p = pools.get(guildId)
    if (!p) {
      p = { msgs: [], lastSession: null, lastMessageAt: 0, lastGuildId: guildId, groupName: '' }
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

  /** 真正开口 */
  async function speak(guildId, kind, profile, state, pool) {
    if (state.locked) return false
    if (!pool.lastSession) {
      log('群 %s 还没有可用的 session，跳过', guildId)
      return false
    }
    state.locked = true
    try {
      const now = Date.now()
      const idleMinutes = Math.floor((now - (pool.lastMessageAt || now)) / 60000)
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
      await ctx.chatluna.chatChain.receiveCommand(session, '', {
        message: els,
        is_proactive: true,
      })
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
          const msg = {
            id: String(session.userId ?? ''),
            name: session.author?.name || session.username || String(session.userId ?? ''),
            content: plainTextOf(session),
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
    for (const [guildId, profile] of profiles) {
      const pool = pools.get(guildId)
      const state = stateOf(guildId)
      if (!pool || pool.msgs.length === 0 || state.locked) continue
      if (now < state.cooldownUntil) continue
      if (state.lastTriggerAt && now - state.lastTriggerAt < config.cooldownSeconds * 1000) continue

      // 叫 bot 的那些消息不算"群聊热度"（它们已经被正常回复过了）
      const eligible = pool.msgs.filter((m) => !m.direct)
      if (profile.enableActivity && eligible.length > 0) {
        const score = activityScore(eligible.map((m) => m.ts), now)
        const threshold = thresholdOf(state, profile)
        const byScore = score >= threshold
        const byCount =
          profile.activityMessageInterval > 0 && state.msgCount >= profile.activityMessageInterval
        // 每 60 秒最多打一条评估日志：轮询是秒级的，全打会把日志刷爆
        // （Koishi 的 logger 只认 %s/%d，不认 %.3f —— 写了会原样打出来并把参数挤到行尾）
        if (config.debug && (!state.lastEvalLogAt || now - state.lastEvalLogAt > 60000)) {
          state.lastEvalLogAt = now
          log(
            '群 %s 活跃度 %s / 阈值 %s（候选 %d 条，计 %d 条）',
            guildId,
            score.toFixed(3),
            Number(threshold).toFixed(3),
            eligible.length,
            state.msgCount
          )
        }
        if (byScore || byCount) {
          void speak(guildId, 'activity', profile, state, pool)
          continue
        }
      }

      if (profile.enableIdle) {
        const anchor = Math.max(pool.lastMessageAt || 0, state.lastTriggerAt || 0)
        if (anchor && now - anchor >= profile.idleMinutes * 60000) {
          void speak(guildId, 'idle', profile, state, pool)
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
      '主动发言已挂载（监控 %d 个群；轮询 %ds；免打扰 %s）',
      profiles.size,
      config.pollSeconds,
      config.quietHours || '关'
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
      `  距上次发言 ${last}`,
      `  上次发言距今 ${state.lastTriggerAt ? Math.round((now - state.lastTriggerAt) / 1000) + ' 秒' : '—'}，冷却 ${config.cooldownSeconds} 秒`,
      `  失败退避剩余 ${cd} 秒，连续失败 ${state.failures} 次`,
      `  当前活跃度阈值 ${thresholdOf(state, profile).toFixed(3)}`,
      `  免打扰时段：${config.quietHours || '关'}${inQuietHours(quietRange, new Date()) ? '（★ 现在正在免打扰里，不会开口）' : ''}`,
      `  空闲触发：${profile.enableIdle ? `${profile.idleMinutes} 分钟` : '关'}`,
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
