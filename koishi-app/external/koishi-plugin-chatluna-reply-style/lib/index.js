/**
 * koishi-plugin-chatluna-reply-style —— 出站消息形态：引用 + @
 *
 * 需求（用户原话，2026-10-03）：
 *   「ai引用消息(以及@群友)的功能，似乎目前还没实现？」
 *
 * ★ 结论：确实没实现，而且不是"配错了"。
 *   全仓搜过一遍：`chatluna` / `chatluna-followup` / `chatluna-vision` /
 *   `chatluna-proactive` 里出现的 `quote` **全是入站判定**（"这条消息引用了我吗"），
 *   出站侧一个 `h('quote')` 都没有；`@` 只有 followup 往 elements 前面插一个
 *   **指向 bot 自己**的 at（那是为了让 vision 认出来"这是在叫 bot"），
 *   不是 @ 说话的人。
 *   `chatluna` 核心里那个 `allowQuoteReply` 也是入站闸门
 *   （`lib/index.cjs:2952`：`if (config.allowQuoteReply && session.quote?.user?.id === botId)`），
 *   跟"回复时带引用"没关系。
 *
 * ★ 为什么挂在 `before-send` 而不是改 ChatLuna
 *   所有出站消息都要过 `@satorijs/core` 的 MessageEncoder：
 *   `encoder.send()` → `app.serial(session, 'before-send', ...)`（core:752），
 *   返回非空还能取消发送。挂这里等于**一个点覆盖全部出站路径**
 *   （对话回复 / 主动插话 / 指令输出 / 将来的新插件），和 chatluna-page
 *   自动出图是同一套思路。
 *
 * ★ 坑：before-send 的 session 里**拿不到触发消息的 id 和发言人**
 *   `Session` 的 `messageId` / `userId` 是原型上的 **getter**（core:188+），
 *   而 getter 在 class 体里是**不可枚举**的；出站时编码器只拷可枚举键
 *   （核心那段 `for (const key in this.options.session)`，core:739-742）。
 *   所以出站 session 的 `event` 是 `{type:'send', channel:{id,type}, guild}`
 *   —— `channelId`/`guildId`/`isDirect` 有（从 channel 里带过来的），
 *   `messageId` / `userId` **一律是 undefined**。
 *
 *   解法就是本项目已经踩过两次的那招（见 docs/04 坑 32）：在**入站**时用
 *   **普通赋值**往 session 上打一个标记，它是可枚举的，出站时会被自动拷过去。
 *   `chatluna-guard` 的 `__guardControl` 一直有效就是这个原因。
 *
 * ★ 顺序：必须在 `chatluna-page` **之后**加载
 *   page 的自动出图要求"整条消息都是纯文本"，前面多一个 quote/at 它就不出图了。
 *   我们默认 `skipCommands: true`（指令输出本来就不引用），所以正常情况下不会撞上；
 *   两边都做了防御：page 那边会把开头的 quote/at 当"前缀"跳过再判断，
 *   这边则保证只**前置**、不改动原有 elements。
 *
 * ★ 2026-10-08：**自主播报**也会掉进"频道兜底"（新的坑，见 skipBroadcasts）
 *   Steam 状态播报（koishi-plugin-steam-friend-status-fork）是定时器里
 *   `bot.sendMessage()` 直发的，出站 session 一样没有 `__rsTrigger`，于是
 *   `resolveTrigger` 的频道兜底把"本群最近一条入站消息"当成了它的触发消息。
 *   群里实测两次（群 1040488785）：
 *     20:54:08 播报被挂上「引用 1851993304 + @ 2377635116」（触发消息在 107s 前）
 *     20:59:08 播报被挂上「引用 2067386031 + @ 483531476」（触发消息在  40s 前）
 *   两次 @ 的都是**跟 bot 毫无关系**的群友，16 秒后群里就有人问"怎么还有@"。
 *   而且下游 chatluna-affinity 按 quote 记账，把它算成了"回复 2377635116"。
 *   对付办法就是下面的 `skipBroadcasts`：认出播报文案直接返回，不挂形态。
 */

const { Schema, Logger, h } = require('koishi')

const name = 'chatluna-reply-style'
const inject = { required: [], optional: ['qqbotGuard'] }
const logger = new Logger('replystyle')

/** 三档：off / first（一轮只加一次）/ always（每条都加） */
const MODES = ['off', 'first', 'always']

/**
 * 主动插话用的伪身份（与 chatluna-proactive 的 PROACTIVE_USER_ID 一致）。
 * 它的出站消息**不该**加引用/@：参见 before-send 里的注释。
 */
const PROACTIVE_USER_ID = '__proactive_trigger__'

const Config = Schema.intersect([
  Schema.object({
    enabled: Schema.boolean().default(true).description('总开关'),
    quote: Schema.union(MODES)
      .default('first')
      .description(
        '引用：把 bot 这条回复挂在"触发它的那条消息"下面。' +
          "`first` = 一轮回复里只第一条带引用（推荐，QQ 里连发时不会每条都挂）；" +
          "`always` = 每条都带；`off` = 不引用"
      ),
    mention: Schema.union(MODES)
      .default('first')
      .description(
        '@ 对方：群聊里让回复带上 @。' +
          "`first` = 一轮里第一条 @（推荐）；`always` = 每条都 @；`off` = 不 @。" +
          '私聊永远不 @（没有意义），由 mentionInDirect 单独控制'
      ),
    mentionInDirect: Schema.boolean().default(false).description('私聊里也 @ 对方（默认关，私聊没这个必要）'),
    maxAgeSeconds: Schema.natural()
      .default(180)
      .description(
        '触发消息超过这么久还没回完，就不再引用它 —— 避免"回复 A 的时候引用了三分钟前那句 B"'
      ),
    skipCommands: Schema.boolean()
      .default(true)
      .description(
        '指令自己的输出不引用 / 不 @。指令回执是功能性输出，挂引用只是噪声；' +
          '而且 chatluna-page 的自动出图要求整条消息纯文本，加了前置元素它会放弃出图'
      ),
    skipBroadcasts: Schema.boolean()
      .default(true)
      .description(
        '自主播报（Steam 状态播报这类"不是回复谁"的出站消息）不引用 / 不 @。' +
          '它们没有触发消息，会被下面的频道兜底挂上"本群最近一条群消息"的作者 —— 实测 @ 错人'
      ),
  }),
  Schema.object({
    debug: Schema.boolean().default(false).description('打印每次出站的形态判定'),
  }),
])

function apply(ctx, config) {
  const cfg = {
    enabled: true,
    quote: 'first',
    mention: 'first',
    mentionInDirect: false,
    maxAgeSeconds: 180,
    skipCommands: true,
    skipBroadcasts: true,
    debug: false,
    ...(config ?? {}),
  }

  const log = (...a) => cfg.debug && logger.info(...a)

  /**
   * 频道 -> 屏蔽截止时间戳。主动插话（chatluna-proactive）开口前会调 `suppress()`，
   * 让这一轮出站**不加引用/@**。为什么必须由它来打招呼、而不能靠 session 上的标记：
   *   ChatLuna 回复是走 `session.bot.sendMessage(channelId, content)` 发出去的
   *   （`chatluna/lib/index.cjs:7866`），**出站 session 是新建的** ——
   *   既没有 `__rsTrigger`，`userId` 也不是触发者的（更不是主动插话的伪身份
   *   `__proactive_trigger__`）。所以出站侧根本认不出"这轮是谁在说话"，
   *   只能由发起方显式告知。
   */
  const suppressedUntil = new Map()
  const SUPPRESS_DEFAULT_MS = 120000

  function suppress(channelId, ms = SUPPRESS_DEFAULT_MS) {
    const cid = String(channelId ?? '')
    if (!cid) return false
    suppressedUntil.set(cid, Date.now() + Math.max(1000, Number(ms) || SUPPRESS_DEFAULT_MS))
    return true
  }

  function isSuppressed(channelId, now = Date.now()) {
    const until = suppressedUntil.get(String(channelId ?? ''))
    if (!until) return 0
    if (now >= until) {
      suppressedUntil.delete(String(channelId ?? ''))
      return 0
    }
    return until
  }

  // 运行时覆盖（`/replystyle.*` 改的就是这里；不落盘，重启回到配置值）
  const override = { quote: null, mention: null }
  const modeOf = (key) => {
    const v = override[key] ?? cfg[key]
    return MODES.includes(v) ? v : 'first'
  }

  // ------------------------------------------------------------------ 入站：打标记

  /**
   * 触发信息表。key = 触发消息 id，value = { userId, ts, used }。
   *
   * 为什么要存下来而不是只挂在 session 上：
   *   出站 session 是**每条消息**新建的，同一轮回复里 bot 可能连发好几条
   *   （实测 2026-05-xx 的回复里就是两个 text 元素分两条发出去的）。
   *   `first` 模式要保证"一整轮只引用一次"，就得记在插件自己的表里。
   */
  const triggers = new Map()
  /** channelId -> 这个频道最近一条入站消息（`__rsTrigger` 拿不到时的兜底） */
  const lastByChannel = new Map()
  const MAX_ENTRIES = 500

  function sweep(now) {
    if (triggers.size < MAX_ENTRIES) return
    for (const [k, v] of triggers) if (now - v.ts > 600000) triggers.delete(k)
  }

  // ★ 为什么用 prepend 中间件，而不是 `ctx.on('message')`
  //
  //   两个坑叠在一起，rig 44/45 各踩了一次，两次的现象都是"插件装好了但完全没效果"：
  //
  //   ① **普通 `ctx.on('message')` 来得太晚。**
  //      Koishi 的中间件链不是在 dispatch 里跑的，而是在一个 `message` 监听器里：
  //      `@koishijs/core:679` —— `Processor` 构造时就 `ctx.on("message", this._handleMessage)`，
  //      而 `_handleMessage` 的最后一步才是 `if (result) await session.send(result)`（core:839）。
  //      Processor 是随 app 一起建的，我们注册的监听器永远排在它**后面** ——
  //      等我们来打标记，回复早就发出去了（实测每一条出站都打印「出站无触发记录」）。
  //
  //   ② **`ctx.before('message', fn)` 根本不是"排在 message 前面"。**
  //      `@koishijs/core:2399` 的实现是给事件名加前缀：
  //          before(name, listener, append) {
  //            seg[seg.length - 1] = "before-" + seg[seg.length - 1]
  //            return this.on(seg.join("/"), listener, !append)
  //          }
  //      于是它注册的是 `before-message` —— 一个**没人 emit 的事件**。
  //      这种写法不报错、不警告、也不生效，是最难查的一类（rig 44 第二次跑仍然零效果）。
  //
  //   中间件这条路在本项目里是**已经验证过的**：`chatluna-guard` 的闸门 1 就是
  //   `ctx.middleware(fn, true)`，它的注释写着"是 unshift，所以在插件加载期注册就一定排第一，
  //   比 attach、指令派发、ChatLuna 都早"。我们只需要"早"，不需要拦，所以打完标记就 next()。
  ctx.middleware((session, next) => {
    try {
      if (cfg.enabled && session?.messageId) {
        if (String(session.userId) !== String(session.selfId)) {
          const info = {
            userId: session.userId,
            channelId: session.channelId,
            isDirect: !!session.isDirect,
            messageId: session.messageId,
            ts: Date.now(),
          }
          // ★ 普通赋值 = 可枚举 = 出站时会被编码器拷过去（这就是整个插件的关键一行）
          session.__rsTrigger = info

          sweep(info.ts)
          triggers.set(String(info.messageId), info)
          if (info.channelId != null) {
            lastByChannel.set(String(info.channelId), String(info.messageId))
          }
          log('记下触发消息 %s（%s，%s）', info.messageId, info.userId, info.isDirect ? '私聊' : '群聊')
        }
      }
    } catch (e) {
      logger.warn('记录触发消息失败（不影响收发）：%s', e.message)
    }
    return next()
  }, true)

  // ------------------------------------------------------------------ 出站：加形态

  function wanted(mode, alreadyUsed) {
    if (mode === 'off') return false
    if (mode === 'always') return true
    return !alreadyUsed // 'first'
  }

  /**
   * 这条出站消息是不是"自主播报"（不是回复任何人的消息）。
   *
   * 目前唯一的来源是 koishi-plugin-steam-friend-status-fork 的游戏状态播报：
   * 定时器里 `bot.sendMessage(channel.id, ...)` 直发，出站 session 里既没有
   * `__rsTrigger`、也没有任何"谁在等回复"的线索，于是和 ChatLuna 的回复一样
   * 掉进 `resolveTrigger` 的频道兜底，被挂上"本群最近一条入站消息"的作者。
   *
   * 三条模板（照抄插件 src/index.ts 里的拼接）：
   *   `${name} 开始玩 ${game} 了`
   *   `${name} 不玩 ${game} 了[，玩了 ${playTime}]`
   *   `${name} 不玩 ${old} 了，玩了 ${playTime}，开始玩 ${new} 了`
   * 第三种也能被下面这条正则吃掉（`，玩了 .+` 是贪婪的）。
   *
   * ★ 为什么按文案认，而不是找个更"结构化"的依据：
   *   出站 session 里**没有**任何能区分"ChatLuna 回复"和"别的插件直发"的字段 ——
   *   两边都是 `bot.sendMessage()` 新建的 session（chatluna/lib/index.cjs:7866）。
   *   要做成结构化的，只能由发送方自己声明；proactive 走的就是那条路
   *   （开口前调 `ctx.replyStyle.suppress`）。第三方插件改不动，这里退一步按文案认。
   *   认错的代价只是那条回复少一次引用/@，**不会误发**，所以可以接受。
   */
  const BROADCAST_TEXT = /^(?:\S.* )?(?:开始玩|不玩) .+ 了(?:，玩了 .+)?$/

  function isAutonomousBroadcast(session) {
    if (!cfg.skipBroadcasts) return false
    const els = Array.isArray(session.elements) ? session.elements : []
    // 只看文本元素：万一前面已经被别的插件挂了 quote/at，也不会影响文案判定
    const text = h.select(els, 'text').join('').trim()
    return !!text && BROADCAST_TEXT.test(text)
  }

  /**
   * 找出这条出站消息该引用谁。
   *
   * 首选 `session.__rsTrigger`（入站时打的可枚举标记，编码器会拷过来）。
   * 拿不到时退到"这个频道最近一条入站消息" —— 覆盖两种情况：
   *   ① 别的插件不经入站 session 直接 `bot.sendMessage`（比如定时任务）；
   *   ② 万一将来 Koishi 不拷可枚举键了。
   * 兜底也受 maxAgeSeconds 和 used 约束，不会引用一句三分钟前的话。
   */
  function resolveTrigger(session) {
    const direct = session.__rsTrigger
    if (direct?.messageId) return direct
    const cid = session.channelId
    if (cid == null) return null
    const mid = lastByChannel.get(String(cid))
    if (!mid) return null
    const t = triggers.get(mid)
    if (!t) return null
    log('用频道兜底触发消息 %s（%s）', mid, cid)
    return t
  }

  ctx.on('before-send', (session) => {
    try {
      if (!cfg.enabled || !session) return

      // ★ 主动插话（chatluna-proactive）不加引用/@。
      //   理由两条：
      //     ① 语义上它不是"回复某人"，是 bot 自己想插一句；挂上引用就成了"针对某人的回话"，
      //        提示词里那句"不要 @ 任何人"也就白写了；
      //     ② 更要命的是 resolveTrigger 的频道兜底会**随便挑一条最近的群消息**挂上去 ——
      //        2026-10-03 17:09 那次插话就被挂成"引用 1951933551 + @ 3912578627"，
      //        等于凭空 @ 了一个没跟 bot 说话的群友。
      //   ★ 靠 `session.userId` 认不出来（出站 session 是 ChatLuna 新建的），
      //     所以由发起方在开口前调 `ctx.replyStyle.suppress(channelId)`（见文件上方的注释）。
      const cid = String(session.channelId ?? session.guildId ?? '')
      const until = isSuppressed(cid)
      if (until) {
        log('本频道正在主动插话窗口内（还剩 %ds），不加引用/@', Math.round((until - Date.now()) / 1000))
        return
      }
      // 兜底：万一哪天出站 session 真的带上了伪身份
      if (String(session.userId || '') === PROACTIVE_USER_ID) {
        log('主动插话，不加引用/@')
        return
      }

      // ★ 自主播报（Steam 状态播报等）：它不是"回复谁"，频道兜底会随便挑一条
      //   最近的群消息挂上去 —— 2026-10-08 实测 @ 错了两次人。直接放行。
      if (isAutonomousBroadcast(session)) {
        log('自主播报，不加引用/@')
        return
      }

      const t = resolveTrigger(session)
      if (!t?.messageId) {
        log('出站无触发记录（主动插话 / 定时任务？），原样发送')
        return
      }

      // 太旧的触发消息不再引用：模型跑了很久才回，引用了反而对不上
      const age = Date.now() - (t.ts || 0)
      if (cfg.maxAgeSeconds > 0 && age > cfg.maxAgeSeconds * 1000) {
        log('触发消息已过 %ds，不引用', Math.round(age / 1000))
        return
      }

      // 指令输出放行（见配置项注释）
      const isCommand = !!(session.__pageCommand || session.__guardIsCommand || session.argv?.command)
      if (cfg.skipCommands && isCommand) {
        log('指令输出，不加引用/@')
        return
      }

      const els = Array.isArray(session.elements) ? session.elements : []
      if (!els.length) return

      // 已经带了引用就算了（别的插件加的，别叠）
      const hasQuote = els[0]?.type === 'quote'
      const hasAt = els.some((el) => el?.type === 'at' && String(el?.attrs?.id) !== String(session.selfId))

      const rec = triggers.get(String(t.messageId))
      const used = !!rec?.used
      const wantQuote = !hasQuote && wanted(modeOf('quote'), used)
      const isGroup = !t.isDirect
      const wantAt =
        !hasAt &&
        (isGroup || cfg.mentionInDirect) &&
        String(t.userId) !== String(session.selfId) &&
        wanted(modeOf('mention'), used)

      if (!wantQuote && !wantAt) {
        log('不需要加形态（quote=%s mention=%s hasQuote=%s hasAt=%s）', wantQuote, wantAt, hasQuote, hasAt)
        return
      }

      const add = []
      // ★ 顺序不能反：onebot 适配器要求 reply 必须在**第一个**
      //   （adapter `lib/index.js:346` 解入站时就是 `elements[0].type === 'reply'` 才当引用；
      //    出站同理，`[CQ:reply][CQ:at]` 才是合法顺序）
      if (wantQuote) add.push(h('quote', { id: String(t.messageId) }))
      if (wantAt) add.push(h('at', { id: String(t.userId) }))

      session.elements = [...add, ...els]
      if (rec) rec.used = true

      logger.info(
        '出站形态：%s（%s）',
        [wantQuote ? `引用 ${t.messageId}` : null, wantAt ? `@ ${t.userId}` : null]
          .filter(Boolean)
          .join(' + '),
        t.isDirect ? '私聊' : `群 ${t.channelId}`
      )
    } catch (e) {
      // ★ 这里绝对不能抛：before-send 抛错会被当成"取消发送"，消息就没了
      logger.warn('加引用/@ 失败（原样发送）：%s', e.message)
    }
  })

  // ------------------------------------------------------------------ 指令

  function statusText(session) {
    const q = modeOf('quote')
    const m = modeOf('mention')
    const lines = [
      `引用：${q}${override.quote ? '（运行时覆盖）' : ''}`,
      `@ 对方：${m}${override.mention ? '（运行时覆盖）' : ''}`,
      `私聊也 @：${cfg.mentionInDirect ? '是' : '否'}`,
      `指令输出跳过：${cfg.skipCommands ? '是' : '否'}`,
      `播报跳过：${cfg.skipBroadcasts ? '是' : '否'}`,
      `引用时效：${cfg.maxAgeSeconds}s`,
      `记录中的触发消息：${triggers.size} 条`,
    ]
    return lines.join('\n')
  }

  ctx
    .command('replystyle', '看/改 bot 回复的引用与 @ 形态', { authority: 1 })
    .action((argv) => statusText(argv.session))

  ctx
    .command('replystyle.quote <mode:string>', '设置引用形态：off / first / always', { authority: 3 })
    .action((_argv, mode) => {
      const v = String(mode || '').toLowerCase()
      if (!MODES.includes(v)) return `只认这三个：${MODES.join(' / ')}`
      override.quote = v
      return `引用已设为 ${v}（临时，重启回到配置文件的值）`
    })

  ctx
    .command('replystyle.mention <mode:string>', '设置 @ 形态：off / first / always', { authority: 3 })
    .action((_argv, mode) => {
      const v = String(mode || '').toLowerCase()
      if (!MODES.includes(v)) return `只认这三个：${MODES.join(' / ')}`
      override.mention = v
      return `@ 已设为 ${v}（临时，重启回到配置文件的值）`
    })

  // ---------------------------------------------------------- 对外服务（给主动插话用）

  /**
   * `ctx.replyStyle.suppress(channelId, ms)`：让这个频道接下来这段时间的出站
   * **不加引用/@**。目前只有 chatluna-proactive 会调（主动插话不是"回复谁"）。
   *
   * 为什么不是"谁都能调"的通用开关：这个状态是**频道级 + 时间窗**的，
   * 窗口内同频道的**正常回复**也会被一起放过（概率很低，代价只是少一次引用）。
   * 真要精确到"这一条"，出站侧拿不到那个信息 —— 见文件上方的注释。
   */
  ctx.provide('replyStyle', {
    suppress,
    isSuppressed,
    /** 还剩多少毫秒（0 = 没在窗口内） */
    suppressedFor: (channelId) => {
      const until = isSuppressed(channelId)
      return until ? until - Date.now() : 0
    },
  })

  logger.info(
    '出站形态已挂载（引用 %s / @ %s%s；指令输出%s；自主播报%s）',
    cfg.quote,
    cfg.mention,
    cfg.mentionInDirect ? '（私聊也 @）' : '',
    cfg.skipCommands ? '跳过' : '也加',
    cfg.skipBroadcasts ? '跳过' : '也加'
  )
}

module.exports = { name, inject, Config, apply }
