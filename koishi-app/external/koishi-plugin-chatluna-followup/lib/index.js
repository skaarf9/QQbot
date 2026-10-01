/**
 * koishi-plugin-chatluna-followup
 *
 * 群聊"跟进"机制：用户 @ 了 bot（或叫了昵称、引用了 bot）之后的一段短时间内，
 * 他继续发的消息也算在跟 bot 对话，会尝试触发回复。
 *
 * 为什么需要它：ChatLuna 默认只对"叫过 bot"的消息开口说话，
 * 而手机端没法在 @ 的同时附图，只能先 @ 再发图 / 引用。
 * 没有这个机制，那些后续消息会被 `allow_reply` 直接 STOP 掉，bot 永远看不到图。
 *
 * 挂钩方式（源码依据，别凭印象改）：
 *   `ctx.chatluna.chatChain.middleware(name, fn, ctx)` 返回 ChainMiddleware，
 *   `.before('allow_reply')` 把它排到 allow_reply **之前**。
 *   —— `allow_reply` 是整条链的第一个中间件（`lib/index.cjs:2902` `.before("lifecycle-check")`），
 *      它返回 STOP 时后面所有中间件（含 transform / message_delay）都不会跑。
 *   —— 链里同一层的中间件是**并行**执行的（`chains/index.cjs:215` `_executeLevel`），
 *      所以必须靠 `.before()` 排到**上一层**，否则改 session 会有竞态。
 *
 * 让 allow_reply 放行的手段（两条都做，互为保险）：
 *   1. 在 elements 前面插一个指向自己的 `at` 元素
 *      —— `allow_reply` 用 `session.elements.some(el => el.type === "at" && el.attrs.id === botId)` 判断
 *   2. 清掉 `session._stripped` 缓存
 *      —— `session.stripped` 是带缓存的 getter，`allow_reply` 用 `stripped.atSelf` 判断；
 *         插了 at 之后必须让它按新 elements 重算
 *
 * 注意：插进去的 at 对提示词**没有副作用**——
 *   ChatLuna 的 at 拦截器对 `id === selfId` 什么都不加（`lib/index.cjs:3685-3697`），
 *   而 `h.select(elements, "text")` 也只看 text 元素。
 */

const { Schema, Logger, h } = require('koishi')

const name = 'chatluna-followup'
const inject = { optional: ['chatluna'] }

const logger = new Logger('chatluna-followup')

// ChainMiddlewareRunStatus（koishi-plugin-chatluna/chains）
const SKIPPED = 0
const CONTINUE = 2

const Config = Schema.intersect([
  Schema.object({
    enabled: Schema.boolean().default(true).description('总开关'),
    groupsOnly: Schema.boolean()
      .default(true)
      .description('只管群聊。私聊本来就会回，不需要这个机制'),
    windowSeconds: Schema.natural()
      .default(120)
      .description(
        '空闲时限（秒）。叫过 bot 之后，用户在这个时间内继续说话就仍然算在跟 bot 对话；' +
          '每接住一条就顺延一次'
      ),
    maxSeconds: Schema.natural()
      .default(600)
      .description('硬上限（秒）。从最后一次真正叫 bot 算起，超过就不再自动接了，防止一直被牵着走'),
    maxConsecutive: Schema.natural()
      .default(20)
      .description('一次叫 bot 之后最多自动接多少条，防止刷屏'),
    skipWhenAtOthers: Schema.boolean()
      .default(true)
      .description('消息里 @ 了别人 → 判定为在跟别人说话，不接'),
    unlistedGroupPolicy: Schema.union([
      Schema.const('inherit').description('沿用上面的全局参数'),
      Schema.const('off').description('不在列表里的群一律不跟进'),
    ])
      .default('inherit')
      .description(
        '★ 没写进下面「按群配置」的群怎么办。真群建议用 off —— ' +
          '活跃大群里每人各自开一个跟进窗口，叠加起来就是刷屏'
      ),
    groupMaxPerWindow: Schema.natural()
      .default(0)
      .description(
        '★ 整群熔断：同一个群在下面这个时间窗内最多自动接多少条（0 = 关）。' +
          '上面那些上限都是「按人」算的，30 人活跃群乘起来照样能刷屏 ——' +
          '2026-10-02 真群实测 2 分半发了 20 条、随后被腾讯限流（retcode 1200），' +
          '就是缺这一道整群闸。'
      ),
    groupWindowSeconds: Schema.natural()
      .default(60)
      .description('整群熔断的时间窗（秒）'),
  }),
  Schema.object({
    groups: Schema.array(
      Schema.object({
        guildId: Schema.string().required().description('群号'),
        enabled: Schema.boolean()
          .default(true)
          .description('这个群要不要跟进。关掉 = 只回应 @，不自动接话'),
        windowSeconds: Schema.natural()
          .default(0)
          .description('空闲时限（秒）。0 = 沿用全局'),
        maxSeconds: Schema.natural()
          .default(0)
          .description('硬上限（秒）。0 = 沿用全局'),
        maxConsecutive: Schema.number()
          .default(-1)
          .description('最多自动接多少条。-1 = 沿用全局'),
      })
    )
      .role('list')
      .description(
        '★ 按群覆盖参数。2026-10-02 加：真群「空弓玄天下第一！」里 ' +
          'followup 会在 600 秒内按人各接 20 条，几十条消息叠起来直接把 bot 刷成复读机，' +
          '还被腾讯限流（retcode 1200）—— 所以真群要单独压住'
      ),
  }),
  Schema.object({
    debug: Schema.boolean().default(false).description('打印每次判定'),
  }),
])

/**
 * 解析某个群实际生效的参数。
 * 返回 null = 这个群不跟进（直接 SKIPPED）。
 */
function resolveProfile(config, profiles, guildId) {
  const globalProfile = {
    windowSeconds: config.windowSeconds,
    maxSeconds: config.maxSeconds,
    maxConsecutive: config.maxConsecutive,
  }
  const g = guildId == null ? null : profiles.get(String(guildId))
  if (!g) {
    return config.unlistedGroupPolicy === 'off' ? null : globalProfile
  }
  if (g.enabled === false) return null
  return {
    windowSeconds:
      Number(g.windowSeconds) > 0 ? Number(g.windowSeconds) : globalProfile.windowSeconds,
    maxSeconds:
      Number(g.maxSeconds) > 0 ? Number(g.maxSeconds) : globalProfile.maxSeconds,
    maxConsecutive:
      Number(g.maxConsecutive) >= 0
        ? Number(g.maxConsecutive)
        : globalProfile.maxConsecutive,
  }
}

/** 这条消息是不是在跟 bot 说话（@ / 开头叫昵称 / 引用 bot 的消息） */
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
  // 引用 bot 自己的消息
  if (session.quote?.user?.id != null && String(session.quote.user.id) === selfId) {
    return true
  }
  return false
}

/** 这条消息 @ 了别人吗 */
function atsSomeoneElse(session) {
  const selfId = String(session.selfId)
  return !!session.elements?.some(
    (el) => el?.type === 'at' && String(el?.attrs?.id) !== selfId
  )
}

function apply(ctx, config) {
  const log = (...a) => config.debug && logger.info(...a)

  /**
   * key -> { idleUntil, hardUntil, count }
   * key 用 频道+用户：同一个人在别的群不受影响，同一个群里的别人也不受影响
   */
  const state = new Map()
  const keyOf = (session) =>
    `${session.platform}:${session.channelId}:${session.userId}`

  /** guildId -> 该群的覆盖配置 */
  const profiles = new Map()
  for (const g of config.groups || []) {
    if (g?.guildId) profiles.set(String(g.guildId), g)
  }

  /**
   * 整群熔断计数器：guildId -> { count, resetAt }
   * ★ 按人的上限挡不住"很多人各自说一句"，必须有整群口径的闸。
   */
  const burst = new Map()
  function allowByBurst(guildId, now) {
    const limit = Number(config.groupMaxPerWindow) || 0
    if (limit <= 0) return true
    const winMs = Math.max(1, Number(config.groupWindowSeconds) || 60) * 1000
    let b = burst.get(guildId)
    if (!b || now >= b.resetAt) {
      b = { count: 0, resetAt: now + winMs }
      burst.set(guildId, b)
    }
    if (b.count >= limit) return false
    b.count += 1
    return true
  }

  // 顺手清掉过期条目，别让 Map 无限长
  function sweep(now) {
    if (state.size < 256) return
    for (const [k, v] of state) if (now > v.hardUntil) state.delete(k)
  }

  ctx.inject(['chatluna'], (ctx2) => {
    const chain = ctx2.chatluna?.chatChain
    if (!chain || typeof chain.middleware !== 'function') {
      logger.warn('拿不到 chatluna.chatChain，跟进机制未生效')
      return
    }

    /**
     * 排序自检（只在第一次被调用时报一次）。
     *
     * 为什么不在挂载时或 ready 时查：
     *   ChatLuna 的链中间件是在 `apply43` 的 ready 里调 `setupEntryPoint`，
     *   而 entryPointPlugin **自己又等一次 ready** 才 `initializeComponents` 注册全部中间件
     *   （`lib/index.cjs:8114-8132`）。
     *   所以注入回调跑的时候链上只有我们自己 —— 那时候查必然误报。
     *   等到中间件真被调用，`build()` 一定已经成功跑过了，这时看层号才是真的。
     */
    let orderChecked = false
    function checkOrder() {
      orderChecked = true
      try {
        const levels = chain._graph?.build?.()
        if (!Array.isArray(levels)) return
        const levelOf = (n) =>
          levels.findIndex((lv) => lv?.some?.((m) => m.name === n))
        const a = levelOf('followup')
        const b = levelOf('allow_reply')
        if (a < 0 || b < 0) {
          logger.warn('排序自检：链上找不到节点（followup=%d, allow_reply=%d）', a, b)
        } else if (a < b) {
          logger.info('排序自检通过：followup 在第 %d 层，allow_reply 在第 %d 层', a, b)
        } else {
          logger.warn(
            '排序自检失败：followup 在第 %d 层，allow_reply 在第 %d 层，应该更靠前才是',
            a,
            b
          )
        }
      } catch (e) {
        logger.warn('排序自检抛错（不影响主流程）：%s', e.message)
      }
    }

    chain
      .middleware(
        'followup',
        async (session, context) => {
          try {
            if (!orderChecked) checkOrder()

            if (!config.enabled) return SKIPPED
            if (config.groupsOnly && session.isDirect) return SKIPPED
            // bot 自己发的消息不参与（跟 allow_reply 一致）
            if (ctx.bots[session.uid]) return SKIPPED

            const now = Date.now()
            const key = keyOf(session)
            sweep(now)

            // ---- 0) 这个群实际生效的参数（null = 该群不跟进）----
            const profile = resolveProfile(
              config,
              profiles,
              session.guildId ?? session.channelId
            )
            if (!profile) return SKIPPED

            // ---- 1) 这条就是"叫 bot"：记录/刷新窗口 ----
            if (isTalkingToBot(session)) {
              const windowMs = profile.windowSeconds * 1000
              state.set(key, {
                idleUntil: now + windowMs,
                hardUntil: now + profile.maxSeconds * 1000,
                count: 0,
              })
              log(
                '%s 叫了 bot，开启 %ds 跟进窗口',
                session.userId,
                profile.windowSeconds
              )
              return SKIPPED
            }

            // ---- 2) 没叫 bot，看还在不在窗口里 ----
            const st = state.get(key)
            if (!st) return SKIPPED
            if (now > st.hardUntil) {
              state.delete(key)
              log('%s 超过硬上限，跟进结束', session.userId)
              return SKIPPED
            }
            if (now > st.idleUntil) {
              state.delete(key)
              log('%s 空闲超时，跟进结束', session.userId)
              return SKIPPED
            }
            if (st.count >= profile.maxConsecutive) {
              state.delete(key)
              log('%s 连续接了 %d 条，停手', session.userId, st.count)
              return SKIPPED
            }
            if (config.skipWhenAtOthers && atsSomeoneElse(session)) {
              log('%s 在 @ 别人，跳过', session.userId)
              return SKIPPED
            }
            // 命令有自己的处理路径，不掺和
            if (context.command != null) return SKIPPED

            // ---- 2.5) 整群熔断：按人算完还要看整群总额 ----
            const gid = String(session.guildId ?? session.channelId ?? '')
            if (!allowByBurst(gid, now)) {
              log(
                '群 %s 触发整群熔断（%ds 内最多 %d 条），跳过 %s',
                gid,
                config.groupWindowSeconds,
                config.groupMaxPerWindow,
                session.userId
              )
              return SKIPPED
            }

            // ---- 3) 注入"@了 bot"，让 allow_reply 放行 ----
            const els = session.elements ? Array.from(session.elements) : []
            session.elements = [h('at', { id: session.selfId }), ...els]
            session._stripped = undefined

            st.count += 1
            st.idleUntil = now + profile.windowSeconds * 1000
            log(
              '%s 跟进触发（第 %d 条，还剩 %ds 硬上限）',
              session.userId,
              st.count,
              Math.round((st.hardUntil - now) / 1000)
            )
            return CONTINUE
          } catch (e) {
            logger.warn('跟进判定出错：%s', e.message)
            return SKIPPED
          }
        },
        ctx
      )
      .before('allow_reply')

    logger.info(
      '群聊跟进机制已挂载（空闲 %ds / 硬上限 %ds / 最多 %d 条 / %s；按群覆盖 %d 个，未列出的群=%s；整群熔断 %s）',
      config.windowSeconds,
      config.maxSeconds,
      config.maxConsecutive,
      config.groupsOnly ? '仅群聊' : '群聊+私聊',
      profiles.size,
      config.unlistedGroupPolicy === 'off' ? '不跟进' : '沿用全局',
      Number(config.groupMaxPerWindow) > 0
        ? `${config.groupWindowSeconds}s 内 ${config.groupMaxPerWindow} 条`
        : '关'
    )
  })

  // 人工看一眼当前有哪些人处于跟进窗口内
  ctx.command('followup', '看当前处于跟进窗口内的用户', { authority: 3 }).action(() => {
    const now = Date.now()
    const rows = [...state.entries()].filter(([, v]) => now <= v.hardUntil)
    if (rows.length === 0) return '当前没有人在跟进窗口内'
    return rows
      .map(
        ([k, v]) =>
          `${k}｜已接 ${v.count} 条｜空闲剩 ${Math.max(0, Math.round((v.idleUntil - now) / 1000))}s｜硬上限剩 ${Math.round((v.hardUntil - now) / 1000)}s`
      )
      .join('\n')
  })
}

module.exports = { name, inject, Config, apply }
