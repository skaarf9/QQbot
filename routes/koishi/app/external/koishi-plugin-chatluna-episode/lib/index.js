/**
 * koishi-plugin-chatluna-episode
 *
 * 短期情景记忆（episodic memory）+ 专注模式（focus）。自写，第五轮。
 *
 * 需求原文（用户）：
 *   ① 「ai 已经无法看到我所引用的信息……我想要提供一个专注模式，通过命令开启，
 *      开启后直到结束前，都会将当前的所有信息添加到上下文中（可以压缩掉一些不重要的信息，
 *      甚至是达到一定程度自动总结什么的）……之后如果玩一些长时间的游戏，比如海龟汤之类，
 *      需要记忆的点很多，而且需要做到精确」
 *   ② 「这个对话信息应当记到短期记忆吧……之前 ai 和我说了晚安，但是我只隔了 2 小时
 *      直接和她对话，却没有惊异于我起这么早（或者没睡），缺少了短期记忆」
 *
 * 为什么必须另起一层（三条源码实证，决定了本插件的存在理由）：
 *   1. **没触发 bot 的群消息根本不落库**：ChatLuna 只把"触发过的"消息写进 `chatluna_message`
 *      （`koishi-plugin-chatluna/lib/index.cjs:2908-2977`，只 emit `chatluna/message-observed`
 *      然后 STOP）。所以"群里刚才说了什么"从来没有持久化过。
 *   2. **bot 自己说的话也不在**：OneBot 不回显自己发的消息，`{latest_message(n)}` 拿不到它
 *      （docs/22 §3.3 已记载）。于是"我上一句说了啥"只能靠会话历史 —— 而会话历史会被清。
 *   3. **归档会物理删消息**：`autoArchive: 3600` 到点后 `archiveConversationById` 里
 *      `ctx.database.remove('chatluna_message', { conversationId })`（`services/chat.cjs:2594`），
 *      只剩 `.jsonl.gz` 且必须显式 `restoreConversation()` 才回上下文。
 *   → 结论：模型的"近况"必须有一份**自己维护、带时间戳、含自己发言、不被归档删除**的副本。
 *
 * 本插件做四件事：
 *   1. **落库**：`chatluna/message-observed`（回复判定之前触发，非触发消息也拿得到）
 *      + `before-send`（出站咽喉，含 bot 自己的话；被 guard 拦下的也照记）
 *      → 表 `chatluna_episode`，双层上限（保留小时数 + 最大条数）。
 *      ★ 出站那半条咽喉 2026-10-03 之前**一直是断的**（uid 形状写错，静默 return，一条没记），
 *        见 `before-send` 处的坑 59 与 docs/04。
 *   2. **注入**：`{episode()}` —— 近期原话（窗口层）+ 更早的滚动总结（总结层）+ 引用关系标注。
 *   3. **检索**：`recall` 工具 —— 回答"X 点那会儿说了啥"，给原话和时间戳，模型不用再编。
 *   4. **专注模式**：`/focus <名字> [目标]` 开局后窗口放宽到整局、每个字落库，配 `focus_note`
 *      事实账本（**账本永不被总结压缩掉** —— 这是"精确"的关键）。
 *
 * ★ 三个必须记住的实现事实：
 *   - `chatluna/message-observed` 的 payload 类型 `ChatLunaObservedMessage` 已知全字段
 *     （`lib/types.d.ts`）：id/at/session/platform/selfId/userId/username/guildId/channelId/
 *     isDirect/content/elements。`session.quote` 在里面能直接读到。
 *   - **别在模型回合里动会话**（清历史/归档会死锁，见 scene 插件头部注释）。本插件只写自己的表，
 *     一次都不碰 `chatluna_message`，因此天然没有这个风险。
 *   - **`%` 格式串别写 `%.1f`**（坑 43：Node `util.format` 不支持精度），用 `%s` + toFixed。
 */

const { Schema, Logger, h } = require('koishi')
const { StructuredTool } = require('@langchain/core/tools')
const z = require('zod')

const name = 'chatluna-episode'

const inject = { required: ['database'], optional: ['chatluna', 'qqbotGuard'] }

/** 原始情景消息 */
const TABLE = 'chatluna_episode'
/** 每个 scope 一行的滚动总结与压缩游标 */
const SUM_TABLE = 'chatluna_episode_summary'
/** 专注模式（一局一行） */
const FOCUS_TABLE = 'chatluna_focus'

const logger = new Logger('chatluna-episode')

/** 一次 upsert 最多写多少行（sqlite 变量数有限，分批更稳） */
const INSERT_CHUNK = 40
/** 队列上限：真被刷屏时宁可丢最新的，也不能把内存顶爆 */
const QUEUE_MAX = 2000
/** 账本字符上限：专注模式再重要也不能让提示词无限长 */
const LEDGER_MAX_CHARS = 8000
/** 单条消息存进库时的截断长度 */
const TEXT_MAX = 1500

/**
 * 主动插话用的**伪身份**（与 chatluna-proactive 的 PROACTIVE_USER_ID 保持一致）。
 *
 * ★ 为什么这里要专门认它：ChatLuna 把 `chatChain.receiveCommand(session, '', { message, is_proactive })`
 *   塞进去的那段提示词，也当成一条普通消息 emit 了 `chatluna/message-observed`
 *   （payload 的 userId 正是这个假 id）。照收就会把【自动插话】/【群聊冷场】**整段提示词**
 *   当成"群里某个人说的话"写进近况，下一轮 {episode()} 又把它注回提示词里——
 *   既白烧上下文，又容易被模型当成群友发言（实测 1040488785 的 39 条近况里就有 2 条是它）。
 */
const PROACTIVE_USER_ID = '__proactive_trigger__'
/** 兜底：万一哪天伪身份换了名字，按提示词开头也认得出 */
const PROACTIVE_PROMPT_RE = /^【(自动插话|群聊冷场)】/

/**
 * 角色展示名。★ 优先问**人设卡片**（chatluna-persona），没有就退回内置的。
 *
 * 为什么值得专门抽一个函数：这个名字会出现在三个地方（近况渲染、总结提示词、recall 结果），
 * 硬编码三份 "大肥鱼" 的下场是"换人设时漏改一处，模型就以为自己在跟别人说话"。
 * 用 `ctx.get()` 而不是 `ctx.chatluna_persona`：前者拿不到时静默返回 undefined，
 * 后者会往日志里写"服务不存在"的警告（插件没装不是错误）。
 */
function botDisplayName(ctx) {
  try {
    const p = ctx.get('chatluna_persona')
    const n = (p && (typeof p.displayName === 'function' ? p.displayName() : p.name)) || ''
    if (n) return String(n)
  } catch {
    /* 人设卡片不可用 → 用内置名 */
  }
  return '大肥鱼'
}

/** 人设卡片里给"记忆/总结"阶段准备的那段话（解释"哪句是机器人说的"）。没有就返回空串 */
function selfBlockForSummary(ctx) {
  try {
    const p = ctx.get('chatluna_persona')
    return (p && typeof p.block === 'function' && p.block('summary')) || ''
  } catch {
    return ''
  }
}

const Config = Schema.intersect([
  Schema.object({
    enabled: Schema.boolean().default(true).description('总开关'),
    // ---- 落库范围 ----
    storeScopes: Schema.union([
      Schema.const('allow').description('只记 guard 放行的群 + 跟 bot 的私聊（推荐，库最干净）'),
      Schema.const('all').description('所有群都记（新群不用改配置，代价是库长得快）'),
    ])
      .default('allow')
      .description('记哪些范围的聊天'),
    groups: Schema.array(Schema.string())
      .role('table')
      .default([])
      .description('storeScopes=all 时若填了这里，就只记这些群；空 = 真的全记'),
    ignorePrefixes: Schema.array(Schema.string())
      .role('table')
      .default(['/', '.'])
      .description('以这些字符开头的消息不进情景库（默认是指令前缀，避免 /help 刷屏）'),
    // ---- 容量 ----
    retainHours: Schema.natural()
      .default(48)
      .description('原始消息保留多少小时（超过就删）'),
    maxRowsPerScope: Schema.natural()
      .default(800)
      .description('每个会话最多留多少条原始消息（超出删最旧的）'),
    // ---- 提示词 ----
    variableName: Schema.string()
      .default('episode')
      .description('预设里引用的函数名，写作 {episode()}。★ 只能是 ASCII'),
    windowMessages: Schema.natural()
      .default(18)
      .description('注入提示词的近期原话条数'),
    windowMinutes: Schema.natural()
      .default(90)
      .description('注入提示词的近期时间窗（分钟）。两者取先满足的：条数够或时间到'),
    focusWindowMessages: Schema.natural()
      .default(400)
      .description('★ 专注模式下的窗口条数（专注期间不受上面那个小窗口限制）'),
    focusWindowMinutes: Schema.natural()
      .default(1440)
      .description('专注模式下的时间窗（分钟，默认 24 小时 = 整局都在）'),
    quoteHint: Schema.boolean()
      .default(true)
      .description('标注"这条引用了谁在什么时候说的话"（本次事故的直接成因就是引用关系不可见）'),
    // ---- 滚动总结 ----
    summaryEnabled: Schema.boolean().default(true).description('把更早的消息压成滚动总结（总结层）'),
    summaryModel: Schema.string()
      .default('')
      .description('做总结的模型，留空 = 用 chatluna 的默认模型。建议填 q.memory 组那个免费模型'),
    summaryTriggerMessages: Schema.natural()
      .default(60)
      .description('累计多少条新消息才总结一次（够了才跑，省调用）'),
    summaryMaxChars: Schema.natural()
      .default(1200)
      .description('滚动总结的字符上限（超过就再压一次）'),
    summaryTimeoutMs: Schema.natural()
      .default(60000)
      .description('单次总结的超时（毫秒），超了就下轮再来'),
    // ---- 检索 ----
    enableRecallTool: Schema.boolean().default(true).description('注册 recall 工具，让模型能翻旧账'),
    recallDefaultHours: Schema.natural().default(24).description('recall 不写时间范围时默认往前查多少小时'),
    recallMaxLimit: Schema.natural().default(120).description('recall 一次最多返回多少条'),
    // ---- 专注模式 ----
    enableFocus: Schema.boolean().default(true).description('注册 /focus 指令与 focus_note 工具'),
    focusVariableName: Schema.string().default('focus').description('专注模式的函数变量名，写作 {focus()}'),
    focusMaxMinutes: Schema.natural()
      .default(360)
      .description('单局专注的硬上限（分钟）。超了自动收局，防止永远挂着'),
    focusIdleMinutes: Schema.natural()
      .default(90)
      .description('多久没人说话自动收局（分钟）。0 = 不因空闲自动收'),
    focusLedgerTools: Schema.boolean().default(true).description('注册 focus_note 工具（让模型自己记事实账本）'),
    focusNotify: Schema.boolean().default(true).description('开局/收局时在群里说一句'),
    // ---- 维护 ----
    sweepSeconds: Schema.natural().default(120).description('清理过期消息 / 跑滚动总结的间隔（秒）'),
    debug: Schema.boolean().default(true).description('打印落库、总结、专注模式的细节日志'),
  }),
])

// ---------------------------------------------------------------- 工具函数

const pad = (n) => String(n).padStart(2, '0')

/** `HH:MM`（给人看的近况用） */
function hhmm(date) {
  const d = new Date(date)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** `MM-DD HH:MM` */
function stamp(date) {
  const d = new Date(date)
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hhmm(d)}`
}

/** 相对时间描述：刚刚 / N 分钟前 / N 小时前 / N 天前 */
function ago(date, now = Date.now()) {
  const ms = now - new Date(date).getTime()
  if (ms < 60_000) return '刚刚'
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} 分钟前`
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)} 小时前`
  return `${Math.round(ms / 86_400_000)} 天前`
}

/** 会话隔离键：跟 scene 保持同一种形状，便于两个插件互相认 */
function scopeKeyOf(session) {
  const platform = session?.platform || 'onebot'
  if (session?.isDirect) {
    return `${platform}:private:${session.selfId || 'bot'}:${session.userId ?? 'unknown'}`
  }
  const cid = session?.guildId || session?.channelId || session?.userId || 'unknown'
  return `${platform}:channel:${cid}`
}

/** 从 scopeKey 反解出平台与会话号，用来发系统提示 */
function parseScopeKey(scopeKey) {
  const parts = String(scopeKey).split(':')
  return { platform: parts[0] || 'onebot', kind: parts[1] || 'channel', id: parts[2] || '' }
}

/** 消息正文：优先 session.content（已含 @ / 图片占位），退到纯文本 */
function contentOf(session) {
  const direct = typeof session?.content === 'string' ? session.content.trim() : ''
  if (direct) return direct
  try {
    const els = session?.elements || []
    return els
      .map((el) => (el?.type === 'text' ? el.attrs?.content || '' : `[${el?.type || '未知'}]`))
      .join('')
      .trim()
  } catch {
    return ''
  }
}

/**
 * 元素标记 → 能读的纯文本（**渲染前必过**）。
 *
 * ★ 为什么必须有这一步（坑 58）：`session.content` 是**元素标记**，不是纯文本 ——
 *   `<img src="https://…rkey=…"/>`、`<at id="123"/>` 都是。原样存库、原样打出来的后果有两层：
 *   1) 给模型看的那份提示词里塞满带签名的长 URL（一张图就能占几百字符），纯噪音；
 *   2) `/mem`（episode.preview）的**输出**会被 Koishi 按元素解析 —— `<img src="…">` 变成真的
 *      图片元素，NapCat 去下载那个**早就过期**的 rkey 链接 → `retcode 1200 下载文件失败: Bad Request`
 *      → **整条消息一个字都发不出去**（10-03 19:18 / 19:23 两次 /mem 就是这么死的）；
 *      `<at id="…">` 更糟，会真的 @ 到别人。
 *
 * 图片条数已经由 `［含 N 张图］` 单独标注，所以 img 标记直接丢；@ 谁是有用信息，留成 `@123`。
 */
const ELEMENT_RE = /<(\/?[a-z][a-z0-9-]*)\b[^>]*\/?>/gi
function plainText(text) {
  return String(text ?? '')
    .replace(/<img\b[^>]*\/?>/gi, '')
    .replace(/<at\b[^>]*\bid="?(\d+)"?[^>]*\/?>/gi, '@$1')
    .replace(ELEMENT_RE, '')
    .trim()
}

/** 引用的描述：只留"谁、什么时候"，内容本身在库里另有它自己那条 */
function quoteOf(session) {
  const quote = session?.quote
  if (!quote) return null
  const who = quote.user?.name || quote.user?.id || '某人'
  const at = quote.timestamp ? `${stamp(quote.timestamp)} ` : ''
  return `${who} ${at}`.trim()
}

function isCommandText(text, prefixes) {
  if (!text) return false
  return (prefixes || []).some((p) => p && text.startsWith(p))
}

// ---------------------------------------------------------------- 应用

function apply(ctx, config) {
  // ---- 表 ----
  ctx.model.extend(
    TABLE,
    {
      id: { type: 'string', length: 64 },
      scopeKey: { type: 'string', length: 128 },
      platform: { type: 'string', length: 32, nullable: true },
      channelId: { type: 'string', length: 128, nullable: true },
      guildId: { type: 'string', length: 128, nullable: true },
      selfId: { type: 'string', length: 128, nullable: true },
      ts: { type: 'timestamp' },
      speakerId: { type: 'string', length: 128, nullable: true },
      speakerName: { type: 'string', length: 128, nullable: true },
      isBot: { type: 'boolean', initial: false },
      text: { type: 'text' },
      kind: { type: 'string', length: 16, initial: 'chat' },
      quoteWho: { type: 'string', length: 128, nullable: true },
      images: { type: 'integer', initial: 0 },
      mentionedBot: { type: 'boolean', initial: false },
      triggered: { type: 'boolean', initial: false },
    },
    { primary: ['id'] }
  )

  ctx.model.extend(
    SUM_TABLE,
    {
      scopeKey: { type: 'string', length: 128 },
      summary: { type: 'text', nullable: true },
      summarizedUntil: { type: 'timestamp', nullable: true },
      lastSummarizedAt: { type: 'timestamp', nullable: true },
      newSinceSummary: { type: 'integer', initial: 0 },
      totalRows: { type: 'integer', initial: 0 },
      totalSummaries: { type: 'integer', initial: 0 },
      lastError: { type: 'text', nullable: true },
    },
    { primary: ['scopeKey'] }
  )

  ctx.model.extend(
    FOCUS_TABLE,
    {
      scopeKey: { type: 'string', length: 128 },
      status: { type: 'string', length: 16, initial: 'idle' },
      title: { type: 'text', nullable: true },
      goal: { type: 'text', nullable: true },
      /** JSONL：每一行一条事实 { ts, kind, text } */
      ledger: { type: 'text', nullable: true },
      ledgerCount: { type: 'integer', initial: 0 },
      startedBy: { type: 'string', length: 128, nullable: true },
      startedAt: { type: 'timestamp', nullable: true },
      lastActiveAt: { type: 'timestamp', nullable: true },
      endedAt: { type: 'timestamp', nullable: true },
      endReason: { type: 'string', length: 64, nullable: true },
    },
    { primary: ['scopeKey'] }
  )

  const log = (...a) => config.debug && logger.info(...a)

  // ------------------------------------------------------------ 落库

  /** 写队列：中间件里只 push，不 await（不能拖慢消息处理） */
  const pending = []
  /** 去重集合（同一条消息可能被 observed 与 before-send 各看到一次） */
  const seen = new Set()

  function remember(row) {
    if (!row || !row.text) return
    if (seen.has(row.id)) return
    seen.add(row.id)
    if (seen.size > 4000) {
      // 简单粗暴地清一半：这些只是防重复的短窗口，不需要精确 LRU
      let n = seen.size / 2
      for (const key of seen) {
        seen.delete(key)
        if (--n <= 0) break
      }
    }
    if (pending.length >= QUEUE_MAX) pending.shift()
    pending.push(row)
  }

  async function flush() {
    if (!pending.length) return
    const rows = pending.splice(0, pending.length)
    try {
      for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
        await ctx.database.upsert(TABLE, rows.slice(i, i + INSERT_CHUNK))
      }
      log('落库 %d 条情景消息', rows.length)
    } catch (e) {
      logger.warn('情景消息落库失败（丢 %d 条）：%s', rows.length, e.message)
    }
  }

  ctx.setInterval(() => void flush(), 2000)

  /**
   * 这个会话该不该记？
   * 私聊：只记跟 bot 的（guard 的 isBlocked 只管群，私聊这里自己判"是不是在跟 bot 说话"）
   * 群聊：allow 模式看 guard 放行名单；all 模式看 groups（空 = 全记）
   */
  function shouldStore(session) {
    if (!config.enabled) return false
    if (session.isDirect) return true
    const guildId = String(session.guildId ?? '')
    if (config.storeScopes === 'all') {
      if (!config.groups?.length) return true
      return config.groups.map(String).includes(guildId)
    }
    const guard = ctx.qqbotGuard
    if (guard && typeof guard.isAllowed === 'function') {
      try {
        // ★ 三态：true=放行、false=屏蔽、null=guard 还没把库读出来。
        //   null 时**不记** —— "不知道"不能当成"放行"，否则启动窗口里会把被静音的群收进来。
        return guard.isAllowed({
          platform: session.platform || 'onebot',
          // ★ 只传群号和 isDirect：`isBlocked` 内部用 groupIdOf 取群，多传一个
          //   `channelId: 'private:xxx'` 之类的形状反而可能让它按"库里的 mute 行"命中别的 scope。
          //   入库地址由 makeRow 自己从真 session 上取。
          guildId,
          isDirect: false,
        }) === true
      } catch {
        /* 落到下面的兜底 */
      }
    }
    // 拿不到 guard（或它太老没有 isAllowed）时**不记**：宁缺勿滥，避免把没放行的群也收进来
    return false
  }

  /** 一条入库记录（内部统一入口） */
  function makeRow(session, text, kind, extra = {}) {
    if (!text) return null
    const ts = new Date(extra.ts || session?.timestamp || Date.now())
    const speakerId = String(extra.speakerId ?? session?.userId ?? '')
    const speakerName =
      extra.speakerName ?? (session?.author?.name || session?.username || speakerId)
    return {
      // ★ id 里带"10ms 桶"是为了让同一句话的重复观测塌成一条：
      //   入站回显与出站 before-send 的时间戳会差几毫秒，直接拿毫秒做键会双双落库。
      id: `${scopeKeyOf(session)}|${Math.floor(ts.getTime() / 10)}|${speakerId}`,
      scopeKey: scopeKeyOf(session),
      platform: session?.platform || 'onebot',
      channelId: session?.channelId ? String(session.channelId) : null,
      guildId: session?.guildId ? String(session.guildId) : null,
      selfId: session?.selfId ? String(session.selfId) : null,
      ts,
      speakerId,
      speakerName,
      isBot: !!extra.isBot,
      text: String(text).slice(0, TEXT_MAX),
      kind,
      quoteWho: extra.quoteWho ? String(extra.quoteWho).slice(0, 128) : null,
      images: extra.images || 0,
      mentionedBot: !!extra.mentionedBot,
      triggered: !!extra.triggered,
    }
  }

  // ------------------------------------------------------------ 对外接口
  //
  // 给别的插件往情景库里写一条「bot 自己说的话」（目前只有 chatluna-routine 作息在用：
  // 「我去吃饭了」「我睡醒了」这类生活事件，**只进记忆、不真的发到群里**）。
  //
  // ★ 为什么不让调用方自己写表：scopeKey 的形状（`onebot:channel:<群号>`）、10ms 去重桶、
  //   isBot/speakerName 这几个约定都长在这个插件里，外面复制一份必然漂 —— 漂了的表现是
  //   "作息事件进了库，但 {episode()} 里显示成某个群友说的"，很难查。
  function scopeSession(scopeKey) {
    const { platform, kind, id } = parseScopeKey(scopeKey)
    if (kind === 'private') return null // 作息事件不往私聊写
    return { platform, isDirect: false, guildId: id, channelId: id }
  }

  /** 往一个会话追加一条 bot 自己说过的话（不发送）。返回是否写进队列 */
  function appendBotLine(scopeKey, text, opts = {}) {
    const session = scopeSession(scopeKey)
    if (!session || !text) return false
    const row = makeRow(session, text, opts.kind || 'life', {
      ts: opts.ts || Date.now(),
      isBot: true,
      speakerId: 'bot',
      speakerName: botDisplayName(ctx),
    })
    if (!row) return false
    remember(row)
    return true
  }

  ctx.set('chatluna_episode', {
    TABLE,
    scopeKeyOf,
    parseScopeKey,
    appendBotLine,
    /**
     * 往**所有群会话**各追加一条 bot 自己的话（作息事件用）。
     * @param {string} text
     * @param {{ts?:number, kind?:string, guildIds?:string[]}} [opts]
     * @returns {Promise<{scopes:number, written:number}>}
     */
    async broadcastBotLine(text, opts = {}) {
      const want = Array.isArray(opts.guildIds) && opts.guildIds.length
        ? new Set(opts.guildIds.map(String))
        : null
      const keys = (await knownScopes()).filter((k) => {
        const info = parseScopeKey(k)
        if (info.kind !== 'channel') return false
        return !want || want.has(String(info.id))
      })
      let written = 0
      for (const k of keys) if (appendBotLine(k, text, opts)) written++
      log('作息事件写进 %d/%d 个群会话：%s', written, keys.length, text)
      return { scopes: keys.length, written }
    },
  })

  /** 入口 1：ChatLuna 观看到的群消息（**在回复判定之前触发**，没叫 bot 的也在内） */
  ctx.on('chatluna/message-observed', (msg) => {
    try {
      const session = msg?.session
      if (!session) return
      if (!shouldStore(session)) return
      const text = contentOf(session)
      if (!text) return
      // ★ 主动插话的提示词不是群友发言，别落库（见 PROACTIVE_USER_ID 的注释）
      if (String(msg.userId || '') === PROACTIVE_USER_ID) return
      if (PROACTIVE_PROMPT_RE.test(text)) return
      if (isCommandText(text, config.ignorePrefixes)) return
      const images = (msg.elements || []).filter((el) => el?.type === 'img' || el?.type === 'image').length
      const quoteWho = quoteOf(session)
      remember(
        makeRow(session, text, msg.isDirect ? 'private' : 'chat', {
          ts: msg.at || Date.now(),
          speakerId: msg.userId,
          speakerName: msg.username,
          quoteWho,
          images,
          mentionedBot: false,
        })
      )
      touchFocus(scopeKeyOf(session))
    } catch (e) {
      logger.warn('记录群消息失败：%s', e.message)
    }
  })

  /**
   * ★ 刻意**没有**订阅 `chatluna/after-chat` 去回填"这轮触发了对话"：
   *   after-chat 是**在会话锁内**被 emit 的（`llm-core/chat/app.cjs:514-523`），
   *   在里面 await 一次数据库写就是往锁里塞 I/O；而且实测那个 payload 里没有 userId，
   *   靠"最后一条 pending"去猜是错的（会标错人）。缺的这点信息不值得这个代价。
   */

  /**
   * 出站消息的正文与图片数（**只能从 elements 重建**，见下面的坑 59 第二层）。
   *
   * 元素 → 纯文本的映射刻意**不产生尖括号**：这些字最后会进提示词、也会被 `/mem` 打印出来，
   * 而 Koishi 会把指令返回值和 `h.parse` 出来的标记当真元素（坑 58）。
   *
   * ★ 必须**递归**：模型回复里写 `<p>…</p>` 时，编码器会把它解析成真的 `p` 元素，
   *   文字在 `children` 里而不是 `attrs.content` —— 第一版只取后者，实测把
   *   `在。\n\n<p>……有话就说</p>` 记成了 `在。  [p]`（尾巴整段丢了）。
   */
  function walkElement(el, out, depth = 0) {
    if (!el || depth > 4) return
    const type = String(el.type || '')
    if (type === 'text') {
      out.parts.push(String(el.attrs?.content ?? ''))
      return
    }
    if (type === 'img' || type === 'image') {
      out.images++
      return
    }
    if (type === 'at') {
      out.parts.push(`@${el.attrs?.id ?? ''}`)
      return
    }
    if (type === 'face') {
      out.parts.push('[表情]')
      return
    }
    // 引用是别的插件（reply-style）加的前缀，不是"我说的话"，丢了
    if (type === 'quote') return
    if (type === 'br') {
      out.parts.push('\n')
      return
    }
    const kids = Array.isArray(el.children) ? el.children : []
    if (!kids.length) {
      out.parts.push(`[${type || '未知'}]`)
      return
    }
    for (const kid of kids) walkElement(kid, out, depth + 1)
    // 块级容器补一个换行，免得两段话粘成一句
    if (type === 'p' || type === 'div') out.parts.push('\n')
  }

  function outboundParts(session) {
    const els = Array.isArray(session?.elements) ? session.elements : []
    const out = { parts: [], images: 0 }
    for (const el of els) walkElement(el, out)
    let text = out.parts.join('').replace(/\n{2,}/g, '\n').trim()
    const images = out.images
    // 纯图消息：光靠 images 计数渲染会得到"你（大肥鱼）: "这样一行空的，给个占位。
    // ★ 占位里已经写了张数，就把 images 归零，免得渲染成「［图片 ×1］［含 1 张图］」那种重复注解；
    //   有正文又有图（配文）时仍然走 `［含 N 张图］`，和入站消息一个规矩。
    let stored = images
    if (!text && images > 0) {
      text = `［图片 ×${images}］`
      stored = 0
    }
    return { text, images: stored, rawImages: images, count: els.length }
  }

  /**
   * 入口 2：bot 自己发出去的话（含被 guard 拦下的）——出站咽喉
   *
   * ★★ 坑 59（2026-10-03 发现，这条咽喉**从来没通过**）：
   *   1. **`session.uid` 是两段式，不是三段式**：`@satorijs/core` 里
   *      `get uid() { return \`${this.platform}:${this.userId}\` }`（src/session.ts:79-81），
   *      而原来这里用的是 `/^(platform):(channel):(bot)$/` —— 永远匹配不上，每条出站消息
   *      都在第一行静默 return。症状极隐蔽：不报错、不打日志，只是"bot 自己说的话"
   *      一条都没进库（生产库 417 条情景记录里 isBot=1 的 **0 条**，
   *      历次日志里 `其中 bot 自己 N 条` 也**全是 0**；rig 52 没抓到是因为它的判据
   *      只看窗口条数，不看 isBot）。
   *   2. **`session.content` 在出站 session 上是"同一段内容的标记形式"**：`@satorijs/core` 里
   *      它是 `get content() { return this.event.message?.elements?.join('') }`，
   *      也就是把当前 elements 拼回**标记串**（还带 reply-style 刚加的 `<quote id="…"/>`
   *      `<at id="…"/>` 前缀）。照它入库就是把标记写进情景库 —— 坑 58 的同类（`/mem`
   *      打出来会被当元素解析、`<at>` 还会真的 @ 到人）。真正要发的内容只在 `session.elements` 里，
   *      page / replyshaper / reply-style 三个插件读的也都是 elements，这里跟它们保持一致。
   *   3. 出站 session 上 `userId` 是触发者、`selfId` 才是 bot（`uid` 又是 `platform:userId`），
   *      所以 platform / channelId / selfId 要一个个单独取。
   */
  ctx.on('before-send', (session) => {
    try {
      if (!config.enabled) return
      if (session?.__guardIsCommand) return
      const platform = String(session?.platform || 'onebot')
      const selfId = String(session?.selfId || '')
      const channelId = String(session?.channelId ?? session?.guildId ?? '')
      if (!selfId || !channelId) return
      // 私聊频道号是 `private:<对方>`；群里就是群号
      const isDirect = channelId.startsWith('private:') || !!session?.isDirect
      const peerId = isDirect ? channelId.replace(/^private:/, '') : ''
      // 群聊时 guildId 就是群号；QQ 频道那种 guild≠channel 的形态下取真 guildId，
      // 否则出站会落到 `onebot:channel:<频道号>`、和入站的 `onebot:channel:<服务器号>` 分成两个 scope
      const guildId = isDirect ? null : String(session?.guildId || channelId)
      const { text, images, rawImages, count } = outboundParts(session)
      if (!text) return
      const pseudo = {
        platform,
        selfId,
        // ★ 私聊时 userId 必须是**对方**（scopeKeyOf 用它拼 scope，见下）
        userId: isDirect ? peerId : selfId,
        username: 'bot',
        guildId,
        // ★ 私聊时 channelId 必须是空：`scopeKeyOf` 会退到 session.userId，
        //   如果这里填了 "private:xxx"，同一个私聊就会分裂成两个 scope（入站一个、出站一个），
        //   表现是"bot 自己说的话进不了这条会话的近况"。
        channelId: isDirect ? null : channelId,
        isDirect,
        timestamp: Date.now(),
      }
      // 出站消息不按放行名单过滤：bot 既然发出去了，就该记得自己说过
      const row = makeRow(pseudo, text, 'reply', {
        isBot: true,
        speakerId: selfId,
        speakerName: '大肥鱼',
        images,
      })
      if (row) {
        // 这行是"出站到底记没记上、记成了什么"的唯一直接证据（rig 57 就拿它当判据）
        log(
          '记录出站消息：%s ｜元素 %d 个（图 %d）｜content 字段=%s｜入库=%s',
          scopeKeyOf(pseudo),
          count,
          rawImages,
          JSON.stringify(String(session?.content ?? '')).slice(0, 60),
          text.replace(/\n/g, ' ').slice(0, 80)
        )
        remember(row)
      }
    } catch (e) {
      logger.warn('记录出站消息失败：%s', e.message)
    }
  })

  // ------------------------------------------------------------ 查询与清理

  /** 取某个 scope 在时间窗内的消息（升序） */
  async function fetchWindow(scopeKey, { sinceMs, limit }) {
    const cond = { scopeKey }
    if (sinceMs) cond.ts = { $gte: new Date(Date.now() - sinceMs) }
    const rows = limit
      ? await ctx.database
          .get(TABLE, cond, { sort: { ts: 'desc' }, limit })
          .then((r) => r.reverse())
      : await ctx.database.get(TABLE, cond, { sort: { ts: 'asc' } })
    return rows
  }

  async function loadSum(scopeKey) {
    const rows = await ctx.database.get(SUM_TABLE, { scopeKey })
    return rows[0] || null
  }

  async function saveSum(scopeKey, patch) {
    const row = (await loadSum(scopeKey)) || { scopeKey }
    const merged = { ...row, ...patch, scopeKey }
    delete merged.id
    await ctx.database.upsert(SUM_TABLE, [merged])
    return merged
  }

  /** 本轮出现过的会话号（用来找出"还没建过总结行"的新会话） */
  async function knownScopes() {
    const keys = new Set()
    try {
      const [sums, focuses, recent] = await Promise.all([
        ctx.database.get(SUM_TABLE, {}),
        ctx.database.get(FOCUS_TABLE, {}),
        ctx.database.get(TABLE, {}, { sort: { ts: 'desc' }, limit: 300 }),
      ])
      for (const r of [...sums, ...focuses, ...recent]) if (r?.scopeKey) keys.add(r.scopeKey)
    } catch (e) {
      logger.warn('取会话列表失败：%s', e.message)
    }
    return [...keys]
  }

  /** 清两件事：超过 retainHours 的、以及每个 scope 超过 maxRowsPerScope 的最旧的那些 */
  async function sweep() {
    const cutoff = new Date(Date.now() - config.retainHours * 3600_000)
    try {
      const removed = await ctx.database.remove(TABLE, { ts: { $lt: cutoff } })
      if (removed?.removed) log('清理过期情景消息 %d 条', removed.removed)
    } catch (e) {
      logger.warn('清理过期情景消息失败：%s', e.message)
    }
    try {
      // 每个 scope 单独看条数。会话数很少（放行的群 + 私聊），代价可以接受；
      // 关键是**不要**写"取全表再筛"那种查询，那会把整个库拉进内存。
      for (const scopeKey of await knownScopes()) {
        const rows = await ctx.database.get(TABLE, { scopeKey }, { sort: { ts: 'desc' } })
        if (rows.length <= config.maxRowsPerScope) continue
        const drop = rows.slice(config.maxRowsPerScope).map((r) => r.id)
        for (let i = 0; i < drop.length; i += INSERT_CHUNK) {
          await ctx.database.remove(TABLE, { id: { $in: drop.slice(i, i + INSERT_CHUNK) } })
        }
        log('会话 %s 超出条数上限，删掉最旧 %d 条', scopeKey, drop.length)
      }
    } catch (e) {
      logger.warn('按条数裁剪失败：%s', e.message)
    }
  }

  // ------------------------------------------------------------ 渲染

  /**
   * 把若干条消息渲染成提示词里的时间轴。
   *
   * ★ `opts.view` 决定**用第几人称指代 bot**，这不是美化问题（见 chatluna-persona 的注释）：
   *   - `self`（默认）：渲染给**对话模型**看，用「你（大肥鱼）」——它就是这个角色。
   *   - `third`：渲染给**总结/记忆模型**看，用「大肥鱼（机器人）」——那些模型不是这个角色，
   *     对它说"你"会让摘要里冒出一堆无主的"你"（实测总结正文出现过「你答应了他」，
   *     而读它的是对话模型，谁是"你"完全没法还原）。
   */
  function renderLines(rows, opts = {}) {
    const me =
      opts.view === 'third'
        ? `${botDisplayName(ctx)}（机器人）`
        : `你（${botDisplayName(ctx)}）`
    return rows
      .map((r) => {
        const who = r.isBot ? me : r.speakerName || r.speakerId || '某人'
        const quote = r.quoteWho && config.quoteHint ? `  ← 引用了 ${r.quoteWho} 说的话` : ''
        const img = r.images > 0 ? `［含 ${r.images} 张图］` : ''
        const time = hhmm(r.ts)
        // ★ plainText 不是美化，是**止血**：见它的注释（坑 58）
        return `[${time}] ${who}: ${plainText(r.text).replace(/\n/g, ' ')}${img}${quote}`
      })
      .join('\n')
  }

  // ------------------------------------------------------------ 滚动总结

  let summarizing = false

  /** 已经打过"总结模型就绪"日志的模型名（避免每轮刷屏） */
  const loggedModels = new Set()

  /**
   * 调一次模型拿纯文本（带超时）。总结与再压缩共用。
   *
   * ★★ 两个必须记住的 API 事实（第一次写错，rig 报 "model.invoke is not a function"）：
   *   1. `chatluna.createChatModel(name)` 是 **async** 的，要 await；
   *   2. 它返回的不是模型，而是一个**响应式 ref**，真模型在 `.value` 上
   *      （`services/chat.cjs:5112` 返回 `computed(...)`；vision 插件的用法就是
   *       `const ref = await ctx.chatluna.createChatModel(name); const model = ref?.value`，
   *       见 `external/koishi-plugin-chatluna-vision/lib/index.js:496-498`）。
   *   拿错的表现不是"报错说方法不对"，而是 `invoke is not a function`——很容易误判成模型名写错。
   */
  async function invokeModel(prompt) {
    const chatluna = ctx.chatluna
    if (!chatluna || typeof chatluna.createChatModel !== 'function') {
      throw new Error('chatluna 服务不可用')
    }
    const names = [config.summaryModel, chatluna.config?.defaultModel].filter(Boolean)
    let lastError = '没有可用的模型名'
    for (const name of names) {
      try {
        const ref = await chatluna.createChatModel(name)
        const model = ref?.value
        if (!model || typeof model.invoke !== 'function') {
          lastError = `${name} 拿不到可用模型`
          continue
        }
        const response = await Promise.race([
          model.invoke(prompt, { timeout: config.summaryTimeoutMs }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('总结超时')), config.summaryTimeoutMs)
          ),
        ])
        let text = typeof response === 'string' ? response : response?.content
        if (Array.isArray(text)) {
          text = text.map((c) => (typeof c === 'string' ? c : c?.text || '')).join('')
        }
        text = String(text || '').trim()
        if (!text) throw new Error('模型返回空总结')
        if (!loggedModels.has(name)) {
          loggedModels.add(name)
          logger.info('总结模型就绪：%s', name)
        }
        return text
      } catch (e) {
        lastError = `${name}: ${e.message}`
      }
    }
    throw new Error(lastError)
  }

  async function summarizeScope(scopeKey) {
    const sum = (await loadSum(scopeKey)) || { scopeKey, summarizedUntil: null, summary: '' }
    const cond = { scopeKey }
    if (sum.summarizedUntil) cond.ts = { $gt: new Date(sum.summarizedUntil) }
    // 单次最多处理这么多条：超出的留到下一轮，避免一次 prompt 太大
    const rows = await ctx.database.get(TABLE, cond, {
      sort: { ts: 'asc' },
      limit: config.summaryTriggerMessages * 3,
    })
    if (rows.length < config.summaryTriggerMessages) return false

    // 留最后一批不总结：它们多半马上要进窗口层，重复概括没意义还费钱。
    // ★ 这个数**必须跟着触发条数缩放**：第一版写死 12，结果 rig 里
    //   `summaryTriggerMessages: 6` 时"取 13 条 → 留 12 条 → 只有 1 条可总结"，
    //   每轮只总结一条老消息、游标几乎不动；生产是 60 触发（留 15），数值凑巧能看，
    //   但一旦有人把触发条数调到 10 以下，这条链就退化成"一次一条"。
    const keepTail = Math.max(4, Math.min(20, Math.floor(config.summaryTriggerMessages / 4)))
    const batch = rows.slice(0, Math.max(0, rows.length - keepTail))
    log(
      '总结候选：%s 取到 %d 条（%s ~ %s），留尾 %d 条后待总结 %d 条',
      scopeKey,
      rows.length,
      rows.length ? stamp(rows[0].ts) : '—',
      rows.length ? stamp(rows[rows.length - 1].ts) : '—',
      keepTail,
      batch.length
    )
    if (!batch.length) return false

    // ★ 用 third 视图：给总结模型看的记录里，bot 的发言标成「大肥鱼（机器人）」而不是「你」
    const transcript = batch.map((r) => renderLines([r], { view: 'third' })).join('\n')
    const previous = sum.summary
      ? `（下面这段是**更早的总结**，只用来衔接上下文，别把它原样抄进新总结）\n${sum.summary}\n\n`
      : ''
    // 人设卡片里"这个群里的机器人是谁"那段：告诉总结模型哪一行是机器人说的（没有卡片时为空）
    const selfBlock = selfBlockForSummary(ctx)
    const prompt =
      (selfBlock ? `${selfBlock}\n\n` : '') +
      `你是聊天记录整理器。下面是一个 QQ 群的聊天片段。\n` +
      `${previous}把这段记录压缩成不超过 ${config.summaryMaxChars} 字的中文总结，供 bot 之后回忆用。要求：\n` +
      `1. 按时间顺序，保留**具体事实**：谁说了什么、约定/结论/承诺、重要事件、情绪变化、正在进行的游戏及进度；\n` +
      `2. 保留人名、数字、专有名词的原样，别概括成"某人说了某事"；\n` +
      `3. **分清是谁说的**：标着「${botDisplayName(ctx)}（机器人）」的行是那个机器人的发言，` +
      `写总结时用「${botDisplayName(ctx)}」称呼它，别写成"你"，也别把它的发言安到群友头上；\n` +
      `4. 过滤寒暄与重复内容；\n` +
      `5. 直接输出总结正文，不要任何前言、标题或解释。\n\n` +
      `聊天记录：\n${transcript}`

    try {
      let text = await invokeModel(prompt)
      // ★ 超长就**让模型自己再压一次**，不要 slice：
      //   直接截断会把刚说过的结尾丢掉，而且留下半句话，比没有总结更误导。
      if (text.length > config.summaryMaxChars * 1.5) {
        text = await invokeModel(
          `把下面这段中文总结再压缩到 ${config.summaryMaxChars} 字以内，只保留最重要的具体事实（人名、数字、约定、结论、游戏进度），` +
            `直接输出正文，不要前言：\n\n${text}`
        )
      }

      const lastTs = batch[batch.length - 1].ts
      await saveSum(scopeKey, {
        summary: text,
        summarizedUntil: lastTs,
        lastSummarizedAt: new Date(),
        newSinceSummary: 0,
        totalSummaries: (sum.totalSummaries || 0) + 1,
        lastError: null,
      })
      logger.info(
        '滚动总结已更新：%s（%d 条 → %d 字，游标 %s）',
        scopeKey,
        batch.length,
        text.length,
        stamp(lastTs)
      )
      return true
    } catch (e) {
      await saveSum(scopeKey, { lastError: String(e.message || e).slice(0, 200) })
      logger.warn('滚动总结失败（%s）：%s', scopeKey, e.message)
      return false
    }
  }

  /** 轮询里跑：只处理"累计够条数"的 scope */
  async function summarizeTick() {
    if (summarizing || !config.summaryEnabled) return
    summarizing = true
    try {
      for (const scopeKey of await knownScopes()) {
        const sum = await loadSum(scopeKey)
        const cond = { scopeKey }
        if (sum?.summarizedUntil) cond.ts = { $gt: new Date(sum.summarizedUntil) }
        // 只取到触发条数为止：够不够一眼就知道，不用 count 全表
        const probe = await ctx.database.get(TABLE, cond, { limit: config.summaryTriggerMessages })
        if (probe.length >= config.summaryTriggerMessages) await summarizeScope(scopeKey)
      }
    } catch (e) {
      logger.warn('滚动总结巡检出错：%s', e.message)
    } finally {
      summarizing = false
    }
  }

  // ------------------------------------------------------------ 专注模式

  const focusCache = new Map() // scopeKey -> 是否进行中（给同步的 selector 用）
  /** 专注模式下"最近有人说话"的时间戳节流（每一分钟最多写一次库） */
  const focusTouchAt = new Map()

  /** 专注模式还开着的时候，有人说话就算这一局有进展 —— 否则会被 focusIdleMinutes 误收 */
  function touchFocus(scopeKey) {
    if (!focusCache.get(scopeKey)) return
    const now = Date.now()
    if (now - (focusTouchAt.get(scopeKey) || 0) < 60_000) return
    focusTouchAt.set(scopeKey, now)
    // ★ 必须走 saveFocus（它先读旧行再合并）：`ctx.database.upsert` 是**整行替换**，
    //   直接 upsert {scopeKey,status,lastActiveAt} 会把 title / ledger / startedAt 全抹成 null，
    //   表现就是"聊着聊着账本没了"。scene 插件里也有同一个坑的注释。
    saveFocus(scopeKey, { lastActiveAt: new Date() }).catch((e) =>
      log('刷新专注模式活跃时间失败：%s', e.message)
    )
  }

  async function loadFocus(scopeKey) {
    const rows = await ctx.database.get(FOCUS_TABLE, { scopeKey })
    return rows[0] || null
  }

  async function saveFocus(scopeKey, patch) {
    const row = (await loadFocus(scopeKey)) || { scopeKey }
    const merged = { ...row, ...patch, scopeKey }
    delete merged.id
    await ctx.database.upsert(FOCUS_TABLE, [merged])
    if (merged.status) focusCache.set(scopeKey, merged.status === 'active')
    return merged
  }

  function ledgerLines(row) {
    if (!row?.ledger) return []
    return String(row.ledger)
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try {
          const item = JSON.parse(l)
          return `- [${hhmm(item.ts)}]（${item.kind || 'fact'}）${item.text}`
        } catch {
          return `- ${l}`
        }
      })
  }

  async function focusNote(scopeKey, text, kind = 'fact') {
    const row = await loadFocus(scopeKey)
    if (!row || row.status !== 'active') return null
    const item = JSON.stringify({ ts: Date.now(), kind, text: String(text).slice(0, 500) })
    let ledger = `${row.ledger ? `${row.ledger}\n` : ''}${item}`
    if (ledger.length > LEDGER_MAX_CHARS) {
      // 超长就从最旧的开始丢，保住最近的事实
      const lines = ledger.split('\n')
      while (lines.length > 1 && lines.join('\n').length > LEDGER_MAX_CHARS) lines.shift()
      ledger = lines.join('\n')
    }
    const count = ledger.split('\n').filter(Boolean).length
    await saveFocus(scopeKey, { ledger, ledgerCount: count, lastActiveAt: new Date() })
    return count
  }

  async function beginFocus(session, title, goal, via = '指令') {
    const scopeKey = scopeKeyOf(session)
    const now = new Date()
    const row = await saveFocus(scopeKey, {
      status: 'active',
      title: title || '专注模式',
      goal: goal || '',
      ledger: '',
      ledgerCount: 0,
      startedBy: String(session.userId ?? ''),
      startedAt: now,
      lastActiveAt: now,
      endedAt: null,
      endReason: null,
    })
    logger.info('专注模式开始：%s 标题=%s 目标=%s（%s）', scopeKey, row.title, row.goal || '（没写）', via)
    return row
  }

  async function endFocus(scopeKey, reason) {
    const row = await loadFocus(scopeKey)
    if (!row || row.status !== 'active') return null
    const ended = await saveFocus(scopeKey, {
      status: 'ended',
      endedAt: new Date(),
      endReason: reason || '手动',
    })
    logger.info(
      '专注模式结束：%s（%s）｜账本 %d 条',
      scopeKey,
      reason || '手动',
      ended.ledgerCount || 0
    )
    return ended
  }

  /** 给群里发一句系统提示（绕过会话管线，所以自己问一次 guard 是不是被屏蔽了） */
  async function notify(scopeKey, text) {
    if (!config.focusNotify) return
    const { platform, kind, id } = parseScopeKey(scopeKey)
    if (kind === 'private') return
    if (
      ctx.qqbotGuard?.isBlocked?.({
        platform,
        channelId: id,
        guildId: id,
        isDirect: false,
      })
    ) {
      return
    }
    try {
      const bot =
        ctx.bots.find((b) => String(b.platform) === platform && String(b.selfId) === id) ||
        ctx.bots[0]
      await bot?.sendMessage(id, text)
    } catch (e) {
      log('系统提示发送失败：%s', e.message)
    }
  }

  // ------------------------------------------------------------ 提示词注入

  ctx.inject(['chatluna'], (ctx2) => {
    const chatluna = ctx2.chatluna
    if (!chatluna) {
      logger.warn('chatluna 服务不可用，{episode()} / {focus()} / recall 均未注册')
      return
    }

    const renderer = chatluna.promptRenderer
    if (renderer && typeof renderer.registerFunctionProvider === 'function') {
      // ---- {episode()}：带时间戳的近况 ----
      renderer.registerFunctionProvider(config.variableName || 'episode', async (_args, _vars, configurable) => {
        // ★ 进函数就先打一行（**在任何 await 之前**）：这样"变量到底有没有被求值"和
        //   "求值了但中途失败"能一眼分开。调试注入问题时只靠内部日志会误判 ——
        //   曾经因为看不到渲染日志，误以为变量没注册，其实是它被调用了但走了别的分支。
        log('{%s()} 被调用：session=%s', config.variableName || 'episode', configurable?.session ? '有' : '无')
        const session = configurable?.session
        if (!session) return ''
        const scopeKey = scopeKeyOf(session)
        try {
          const focus = await loadFocus(scopeKey)
          const focusing = focus?.status === 'active'
          focusCache.set(scopeKey, focusing)
          const sum = await loadSum(scopeKey)
          const winMs = (focusing ? config.focusWindowMinutes : config.windowMinutes) * 60_000
          const winLimit = focusing ? config.focusWindowMessages : config.windowMessages
          const rows = await fetchWindow(scopeKey, { sinceMs: winMs, limit: winLimit })
          if (!rows.length && !sum?.summary) {
            return '（还没有近况记录。正常聊就行。）'
          }
          const out = []
          if (sum?.summary) {
            out.push(`【更早的概括（到 ${sum.summarizedUntil ? stamp(sum.summarizedUntil) : '—'} 为止）】`)
            out.push(sum.summary)
            out.push('')
          }
          out.push(
            focusing
              ? `【本局全部发言（专注模式，时间从旧到新）｜共 ${rows.length} 条】`
              : `【最近 ${rows.length} 条发言（时间从旧到新）】`
          )
          out.push(renderLines(rows))
          // ★ 这里只留一行"格式说明"就够：行为规则（别否认自己说过 / 注意时间差 / 想不起用 recall）
          //   已经写在预设的【最近发生的事】那一段里。两边都写一遍 = 每次请求白烧 ~200 字，
          //   而且 2026-10-03 的实测提示词里确实出现了两段几乎一样的说明。
          out.push('')
          out.push(`（格式 \`[时:分] 谁: 说了什么\`；写着"你（${botDisplayName(ctx)}）"的是你自己说过的话。）`)
          // 这一行是"注入到底有没有生效"的唯一直接证据：条数、时间跨度、多少条是 bot 自己说的
          log(
            '渲染 {%s()}：%s → %d 条（%s ~ %s，其中 bot 自己 %d 条）%s',
            config.variableName || 'episode',
            scopeKey,
            rows.length,
            rows.length ? hhmm(rows[0].ts) : '—',
            rows.length ? hhmm(rows[rows.length - 1].ts) : '—',
            rows.filter((r) => r.isBot).length,
            focusing ? '［专注模式：全窗口］' : ''
          )
          return out.join('\n')
        } catch (e) {
          logger.warn('渲染 {episode()} 失败：%s', e.message)
          return '（近况读取失败，先正常聊。）'
        }
      })

      // ---- {focus()}：专注模式的状态 + 事实账本 ----
      renderer.registerFunctionProvider(
        config.focusVariableName || 'focus',
        async (_args, _vars, configurable) => {
          const session = configurable?.session
          if (!session) return ''
          const scopeKey = scopeKeyOf(session)
          try {
            const row = await loadFocus(scopeKey)
            const focusing = row?.status === 'active'
            focusCache.set(scopeKey, focusing)
            if (!focusing) return '（现在没有开专注模式，正常聊就行）'
            const lines = ledgerLines(row)
            const minutes = row.startedAt
              ? Math.max(0, Math.round((Date.now() - new Date(row.startedAt).getTime()) / 60000))
              : 0
            return [
              `【专注模式：${row.title || '进行中'}】`,
              row.goal ? `这一局的目标/结束条件：${row.goal}` : null,
              `已经进行了 ${minutes} 分钟｜账本 ${row.ledgerCount || 0} 条`,
              '',
              '【本局事实账本（这些是你自己记下来的，**按它为准，别改口**）】',
              lines.length ? lines.join('\n') : '（还是空的。想到关键线索/规则/猜测，就用 focus_note 记一条。）',
              '',
              '专注模式的要求：这一局里发生的每句话都在你的近况里（不会因为太久而被丢掉），',
              '有关键信息（线索、规则、谁猜了什么、约定）就立刻用 focus_note 记下来；',
              '轮到自己不确定时，先用 recall 查原话再回答。',
            ]
              .filter((l) => l !== null)
              .join('\n')
          } catch (e) {
            logger.warn('渲染 {focus()} 失败：%s', e.message)
            return ''
          }
        }
      )
      logger.info('已注册情景记忆变量：{%s()} 与 {%s()}', config.variableName || 'episode', config.focusVariableName || 'focus')
    } else {
      logger.warn('promptRenderer.registerFunctionProvider 不可用，情景记忆变量未注册')
    }

    // ---- 工具 ----
    const platform = chatluna.platform
    if (!platform || typeof platform.registerTool !== 'function') {
      logger.warn('platform.registerTool 不可用，recall / focus_note 未注册')
      return
    }

    if (config.enableRecallTool) {
      const desc =
        '回忆群里的旧聊天记录（短期情景记忆）。当你需要知道"之前说过什么/什么时候说的/谁说的"' +
        '（比如对方提到几小时前的事、你记不清某个细节、引用了一句你看不到出处的话），' +
        '就用它按关键词或时间范围查**原话**。宁可查一次，也不要凭印象编。'
      platform.registerTool('recall', {
        selector: () => true,
        authorization: () => true,
        description: desc,
        createTool: () =>
          new (class extends StructuredTool {
            name = 'recall'
            description = desc
            schema = z.object({
              keyword: z.string().optional().describe('要查的关键词或话题，比如"熬夜""海龟汤""火锅"。不填就按时间范围取最近的'),
              hours: z
                .number()
                .optional()
                .describe(`往前查多少小时，默认 ${24}。想查"刚才"就填 1，想查昨天就填 30`),
              speaker: z.string().optional().describe('只看某个人说的话，填昵称或 QQ 号'),
              limit: z.number().optional().describe('最多返回多少条，默认 30'),
            })
            async _call(input, _manager, runnable) {
              const session = runnable?.configurable?.session
              if (!session) return '拿不到会话信息，查不了。'
              const scopeKey = scopeKeyOf(session)
              const hours = Number(input.hours) > 0 ? Number(input.hours) : config.recallDefaultHours
              const limit = Math.min(
                Number(input.limit) > 0 ? Number(input.limit) : 30,
                config.recallMaxLimit
              )
              try {
                const rows = await ctx.database.get(
                  TABLE,
                  { scopeKey, ts: { $gte: new Date(Date.now() - hours * 3600_000) } },
                  { sort: { ts: 'asc' } }
                )
                let hit = rows
                const kw = String(input.keyword || '').trim()
                if (kw) {
                  const terms = kw.split(/\s+/).filter(Boolean)
                  hit = rows.filter((r) => terms.some((t) => String(r.text).includes(t)))
                }
                const sp = String(input.speaker || '').trim()
                if (sp) {
                  hit = hit.filter(
                    (r) => String(r.speakerName || '').includes(sp) || String(r.speakerId || '') === sp
                  )
                }
                if (!hit.length) {
                  return `最近 ${hours} 小时内没有找到${kw ? `含"${kw}"的` : ''}记录。**没查到就说没查到，不要编。**`
                }
                const picked = hit.length > limit ? hit.slice(-limit) : hit
                const head = `查到 ${hit.length} 条（显示${hit.length > limit ? '最近的' : ''} ${picked.length} 条），从旧到新：`
                return `${head}\n${picked
                  .map((r) => {
                    const who = r.isBot ? `你（${botDisplayName(ctx)}）` : r.speakerName || r.speakerId
                    return `[${stamp(r.ts)}｜${ago(r.ts)}] ${who}: ${String(r.text).replace(/\n/g, ' ')}`
                  })
                  .join('\n')}`
              } catch (e) {
                logger.warn('recall 查询失败：%s', e.message)
                return `查询出错：${e.message}`
              }
            }
          })(),
      })
      logger.info('回忆工具已注册：recall')
    }

    if (config.enableFocus && config.focusLedgerTools) {
      const desc =
        '在专注模式（长局游戏，比如海龟汤）里记一条事实。线索、规则、谁猜了什么、已经排除的可能、' +
        '和对方的约定……凡是**这一局结束前不能忘**的，都记一条。记下来的东西不会被压缩丢掉，' +
        '每一轮都会原样出现在你眼前。没开专注模式时不要调用。'
      platform.registerTool('focus_note', {
        selector: () => [...focusCache.values()].some(Boolean),
        authorization: () => true,
        description: desc,
        createTool: () =>
          new (class extends StructuredTool {
            name = 'focus_note'
            description = desc
            schema = z.object({
              text: z.string().describe('要记住的事实本身，一句话，写清楚（谁/什么/数值/结论）'),
              kind: z
                .enum(['fact', 'clue', 'rule', 'guess', 'todo'])
                .optional()
                .describe('分类：fact 既定事实、clue 线索、rule 规则、guess 猜测与结果、todo 待办'),
            })
            async _call(input, _manager, runnable) {
              const session = runnable?.configurable?.session
              if (!session) return '拿不到会话信息，没记下来。'
              const scopeKey = scopeKeyOf(session)
              const count = await focusNote(scopeKey, input.text, input.kind || 'fact')
              if (count === null) return '现在没有开专注模式，不用记。'
              await saveFocus(scopeKey, { lastActiveAt: new Date() })
              return `已记进本局账本（第 ${count} 条）。`
            }
          })(),
      })
      logger.info('专注模式记账工具已注册：focus_note')
    }
  })

  // ------------------------------------------------------------ 巡检

  ctx.setInterval(() => {
    if (!config.enabled) return
    void (async () => {
      try {
        // 专注模式的自动收局
        const actives = await ctx.database.get(FOCUS_TABLE, { status: 'active' })
        for (const row of actives) {
          focusCache.set(row.scopeKey, true)
          const now = Date.now()
          const lastAt = row.lastActiveAt ? new Date(row.lastActiveAt).getTime() : 0
          const startedAt = row.startedAt ? new Date(row.startedAt).getTime() : 0
          if (config.focusIdleMinutes > 0 && lastAt && now - lastAt >= config.focusIdleMinutes * 60_000) {
            await endFocus(row.scopeKey, `${config.focusIdleMinutes} 分钟没人说话`)
            await notify(row.scopeKey, '（这段时间没人说话，专注模式先收起来了。）')
            continue
          }
          if (config.focusMaxMinutes > 0 && startedAt && now - startedAt >= config.focusMaxMinutes * 60_000) {
            await endFocus(row.scopeKey, '超过单局时长上限')
            await notify(row.scopeKey, '（这一局开太久了，专注模式先收起来。）')
          }
        }
        // 缓存里已结束的清掉，避免 focus_note 的 selector 一直为真
        const stillActive = new Set(actives.map((r) => r.scopeKey))
        for (const key of [...focusCache.keys()]) {
          if (!stillActive.has(key)) focusCache.set(key, false)
        }
      } catch (e) {
        logger.warn('专注模式巡检出错：%s', e.message)
      }
      await summarizeTick()
    })()
  }, Math.max(10, config.sweepSeconds) * 1000)

  ctx.setInterval(() => {
    if (!config.enabled) return
    void sweep()
  }, Math.max(60, config.sweepSeconds * 5) * 1000)

  // 退出前把队列里的消息落盘（否则重启会丢最后几秒）
  ctx.on('dispose', () => void flush())

  // ------------------------------------------------------------ 指令

  ctx
    .command('focus <title:string> [goal:text]', '开启专注模式：这一局的每句话都记住，直到收局', { authority: 1 })
    .alias('专注')
    .usage('例：/focus 海龟汤 猜出汤底（我答对或者你说放弃）')
    .action(async ({ session }, title, goal) => {
      if (!config.enableFocus) return '专注模式没开启（配置里 enableFocus=false）。'
      if (!title) return '要给这一局起个名字，比如：/focus 海龟汤 猜出汤底'
      const scopeKey = scopeKeyOf(session)
      const old = await loadFocus(scopeKey)
      const row = await beginFocus(session, title, goal, '指令')
      const extra = old?.status === 'active' ? `（之前那局「${old.title || '—'}」被这局顶掉了）` : ''
      return (
        `已开启专注模式「${row.title}」${row.goal ? `，目标：${row.goal}` : ''}。${extra}\n` +
        `从现在到收局为止，这一局的每句话都会留在我眼前（不会被时间挤掉），\n` +
        `我也会把线索、规则、猜测记进账本。收局：/focus.end\n` +
        `作用域：${scopeKey}`
      )
    })

  ctx
    .command('focus.end', '收掉当前专注模式', { authority: 1 })
    .usage('例：/focus.end —— 这一局结束（猜出来了 / 不玩了），不用再特别记着了')
    .action(async ({ session }) => {
      const scopeKey = scopeKeyOf(session)
      const ended = await endFocus(scopeKey, '手动指令')
      if (!ended) return '当前没有开着的专注模式。'
      return `专注模式「${ended.title || '—'}」已收局，本局账本 ${ended.ledgerCount || 0} 条（都还在短期记忆里，之后可以 recall 查）。`
    })

  ctx
    .command('focus.note <text:text>', '手动往本局账本里记一条事实', { authority: 1 })
    .usage('例：/focus.note 汤底跟"水"有关 —— 主人也可以直接帮我记')
    .action(async ({ session }, text) => {
      const scopeKey = scopeKeyOf(session)
      const count = await focusNote(scopeKey, text, 'fact')
      if (count === null) return '当前没有开着的专注模式，先用 /focus <名字> 开局。'
      return `已记进账本（第 ${count} 条）。`
    })

  ctx
    .command('focus.status', '看专注模式与短期记忆的现状', { authority: 1 })
    .action(async ({ session }) => {
      const scopeKey = scopeKeyOf(session)
      const row = await loadFocus(scopeKey)
      const sum = await loadSum(scopeKey)
      const rows = await ctx.database.get(TABLE, { scopeKey }, { sort: { ts: 'desc' } })
      const oldest = rows.length ? rows[rows.length - 1].ts : null
      const newest = rows.length ? rows[0].ts : null
      const lines = [
        row?.status === 'active'
          ? `专注模式：进行中「${row.title || '—'}」${row.goal ? `｜目标：${row.goal}` : ''}｜账本 ${row.ledgerCount || 0} 条｜已 ${Math.round((Date.now() - new Date(row.startedAt).getTime()) / 60000)} 分钟`
          : '专注模式：未开启',
        `短期记忆：${rows.length} 条${oldest ? `（${stamp(oldest)} ~ ${stamp(newest)}）` : ''}`,
        `滚动总结：${sum?.summary ? `${sum.summary.length} 字，到 ${sum.summarizedUntil ? stamp(sum.summarizedUntil) : '—'} 为止` : '（还没有）'}`,
        sum?.lastError ? `上次总结出错：${sum.lastError}` : null,
        `保留策略：${config.retainHours} 小时 / 每会话 ${config.maxRowsPerScope} 条`,
        `作用域：${scopeKey}`,
      ]
      // 标题/目标是用户写的原文，可能带 `<…>` —— 转义后再交出去（坑 58）
      return h.escape(lines.filter(Boolean).join('\n'))
    })

  /**
   * 看「模型眼里的近况」到底长什么样。
   *
   * 为什么要专门开一条指令：`{episode()}` 是**渲染期**求值的，从日志里只能看到它引发的 SQL，
   * 看不到它交出去的那段文本 —— 出问题时（比如窗口取到 0 条、时间戳不对、引用标注没生效）
   * 光看 SQL 判断不了。这条指令走的是**和 provider 完全一样的渲染函数**，所以它打印什么，
   * 模型就看到什么。
   */
  ctx
    .command('episode.preview', '按模型看到的原样打印「最近发生的事」（改动注入逻辑后必看）', { authority: 2 })
    .usage('例：/episode.preview —— 排查"模型为什么不记得刚才说过的话"时先看这个')
    .action(async ({ session }) => {
      const scopeKey = scopeKeyOf(session)
      const [focus, sum] = await Promise.all([loadFocus(scopeKey), loadSum(scopeKey)])
      const focusing = focus?.status === 'active'
      const rows = await fetchWindow(scopeKey, {
        sinceMs: (focusing ? config.focusWindowMinutes : config.windowMinutes) * 60_000,
        limit: focusing ? config.focusWindowMessages : config.windowMessages,
      })
      const total = await ctx.database.get(TABLE, { scopeKey }, { sort: { ts: 'desc' } })
      const head = [
        `作用域：${scopeKey}`,
        `模式：${focusing ? `专注「${focus.title}」` : '普通'}`,
        `窗口：${focusing ? config.focusWindowMinutes : config.windowMinutes} 分钟内、最多 ${focusing ? config.focusWindowMessages : config.windowMessages} 条`,
        `实取：${rows.length} 条${rows.length ? `（${stamp(rows[0].ts)} ~ ${stamp(rows[rows.length - 1].ts)}，其中 bot 自己 ${rows.filter((r) => r.isBot).length} 条）` : ''}`,
        `库里共：${total.length} 条`,
        sum?.summary ? `总结层：${sum.summary.length} 字（到 ${sum.summarizedUntil ? stamp(sum.summarizedUntil) : '—'}）` : '总结层：（空）',
        '────── 下面是模型实际看到的内容 ──────',
      ]
      if (sum?.summary) head.push(`【更早的概括】`, sum.summary, '')
      head.push(
        rows.length ? renderLines(rows) : '（窗口里没有任何消息 —— 模型这段会是空的）'
      )
      /**
       * ★ 出口必须转义（坑 58）：这段里混着**用户原文**（群友消息、专注标题）和**模型产出**
       *   （滚动总结），只要含 `<…>` 就会被 Koishi 当元素解析 —— 轻则发成图片元素去下载过期
       *   链接、整条消息 retcode 1200 发不出去，重则 `<at id="…">` 真的 @ 到别人。
       *   已实测 `h.parse(h.escape(s)) === s`，所以用户看到的字符不变。
       */
      return h.escape(head.join('\n'))
    })

  logger.info(
    '短期情景记忆已挂载（%s；保留 %d 小时 / 每会话 %d 条；窗口 %d 条或 %d 分钟；专注模式 %s）',
    config.storeScopes === 'all' ? '记录全部会话' : '只记放行的群与私聊',
    config.retainHours,
    config.maxRowsPerScope,
    config.windowMessages,
    config.windowMinutes,
    config.enableFocus ? '开' : '关'
  )
}

module.exports = { name, inject, Config, apply }
