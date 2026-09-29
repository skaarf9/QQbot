/**
 * koishi-plugin-chatluna-guard —— R15 群聊屏蔽开关（"立刻闭嘴"）
 *
 * 用户原始需求（2026-09-29）：
 *   「在拉入真实群之前，检查是否有屏蔽某个群聊的开关，因为进入新的群聊之后
 *     可能产生意料之外的结果，所以需要一个迅速响应的开关……
 *     需要做到我(2791932480)在需要屏蔽的群聊中发送指令后立刻停止该群的回复，
 *     同时，你自己也可以调用脚本停止」
 *
 * ---
 * ★ 为什么要"立刻"就必须是同步判定
 *
 * 屏蔽态放在内存 Map 里（启动与每 refreshSeconds 从库里重载），中间件里**不查库**。
 * 指令 / HTTP / 脚本三条写入口都会**同时**改内存 + 库，所以生效是当次消息级别的，
 * 不存在"等一个轮询周期"。脚本直写库的兜底路径最慢 refreshSeconds 秒。
 *
 * ---
 * ★ 三道闸门（缺一道都有漏网路径，这是实测出来的）
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
 *
 * 3. **指令自己的 authority** —— 拦"授权"。闸门 1 对控制词是**放行**的
 *    （否则被屏蔽的群里连"开口"都发不进去），真正的权限判定交给 Koishi 的
 *    `authority:N`（qqbot-auth 会在 attach-user 里把主人抬到 4）。
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
// 三组词都同时注册成**指令别名**（带前缀就能用：/开口、/闭嘴），
// 并且被中间件**原样放行**（被屏蔽的群里必须还能听见这几句，否则没法解封）。
// 裸词（不带前缀、不 @）走 next() 之后的兜底，见文件头说明。

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
        '静默：不在白名单里的群一律不回复（新群拉进来绝对安全，要先发 /开口 才会说话）'
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
      .description('预置黑名单（群号）。比 /闭嘴 更早生效，进群前就能先写好'),
    applyToPrivate: Schema.boolean()
      .default(false)
      .description('私聊是否也受这套开关管（默认不管 —— 私聊本来就只跟你说话）'),
    controlAuthority: Schema.natural()
      .default(3)
      .description('开关本群需要的最低等级（默认 3 管理员；主人是 4，永远够）'),
    bareKeywords: Schema.boolean()
      .default(true)
      .description('允许不带前缀、不 @ 直接打「开口 / 闭嘴」（推荐开，被屏蔽时最省事）'),
    confirmSeconds: Schema.natural()
      .default(5)
      .description('同一个群开关提示的冷却（秒），防止连点刷屏'),
    refreshSeconds: Schema.natural()
      .default(10)
      .description('从数据库重载屏蔽态的周期（秒）。0 = 只在启动时读一次'),
    debug: Schema.boolean().default(true).description('打印每次判定与开关'),
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

  /** 控制词识别。返回 { kind, bare } —— bare 表示"没前缀也没 @"（走 next() 之后的兜底） */
  function classify(session) {
    const raw = String(session.content ?? '').trim()
    if (!raw) return null

    const prefixes = []
    const p = ctx.root?.config?.prefix
    if (Array.isArray(p)) prefixes.push(...p)
    else if (typeof p === 'string' && p) prefixes.push(...p.split(''))

    let text = null
    let bare = false
    const hit = prefixes.find((x) => x && raw.startsWith(x))
    if (hit) {
      text = raw.slice(hit.length).trim()
    } else {
      const atSelf = !!session.elements?.some(
        (el) => el?.type === 'at' && String(el?.attrs?.id) === String(session.selfId)
      )
      if (atSelf) text = String(session.stripped?.content ?? '').trim()
      else if (cfg.bareKeywords) {
        text = raw
        bare = true
      }
    }
    if (!text) return null

    const word = text.split(/\s+/)[0].toLowerCase()
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
      // 私聊里没有"本群"可言，必须显式给群号（/闭嘴 123456），裸词一律不处理
      if (auth >= cfg.controlAuthority) {
        await confirm(session, '私聊里要带上群号，比如：/闭嘴 123456')
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
      await confirm(session, '好，我回来了。要我再闭嘴就发：/闭嘴')
    } else if (kind === 'mute') {
      await setGroup(groupIdOf(session), 'mute', {
        platform: platformOf(session),
        reason: '群内闭嘴',
        operatorId: session.userId,
        via: 'keyword',
      })
      logger.info('群 %s 由 %s 静默（裸词）', groupIdOf(session), session.userId)
      await confirm(session, '好，这个群我先不说话了。要恢复就发：/开口')
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

      // ---- 被屏蔽：除了控制词，一个字都不回 ----
      if (!cls) {
        log('静默丢弃：%s｜%s', describe(session), String(session.content ?? '').slice(0, 40))
        return
      }
      // 打标：这条会话是"开关操作"，它的回复（含指令的返回值）必须放出去，
      // 见闸门 4。标记加在 session 对象上，因为 MessageEncoder 用的就是同一个对象。
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
    } catch (e) {
      logger.warn('屏蔽判定出错（放行）：%s', e.message)
      return next()
    }
  }, true)

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
  ctx.on('before-send', (session) => {
    try {
      if (!session || session.__guardControl) return
      if (!cfg.enabled) return
      if (session.isDirect && !cfg.applyToPrivate) return
      if (isBlocked(session)) {
        log('发送前拦下（%s）', describe(session))
        return true
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
      '/闭嘴 [群号]   让 bot 立刻不在这个群说话（后面每句话都会被丢掉）',
      '/开口 [群号]   解除静默，正常回复',
      '/屏蔽状态 [群号]  看这个群现在是不是静默的',
      '/屏蔽列表      看所有被显式设置过的群',
      '/清除屏蔽 [群号]  删掉设置，回到默认策略',
      '不带群号 = 对当前群生效；在私聊里必须带群号',
    ].join('\n'))

  ctx
    .command('guard.mute [groupId:string]', '让 bot 立刻不在这个群说话', {
      authority: cfg.controlAuthority,
    })
    .alias(...MUTE_WORDS)
    .action(async ({ session }, groupId) => {
      const t = resolveGroupArg(session, groupId)
      if (!t) return '在群里直接发 /闭嘴；在私聊里要带上群号：/闭嘴 123456'
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
      return `好，群 ${t.groupId} 我闭嘴了，从现在起一个字都不回。要恢复：/开口`
    })

  ctx
    .command('guard.allow [groupId:string]', '解除静默，恢复正常回复', {
      authority: cfg.controlAuthority,
    })
    .alias(...ALLOW_WORDS)
    .action(async ({ session }, groupId) => {
      const t = resolveGroupArg(session, groupId)
      if (!t) return '在群里直接发 /开口；在私聊里要带上群号：/开口 123456'
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
    .alias(...STATUS_WORDS)
    .action(({ session }, groupId) => {
      const t = resolveGroupArg(session, groupId)
      if (!t) return '在群里直接发 /屏蔽状态；在私聊里要带上群号：/屏蔽状态 123456'
      return statusText(session, t.groupId)
    })

  ctx
    .command('guard.list', '看所有被显式设置过屏蔽状态的群', { authority: 2 })
    .alias(...LIST_WORDS)
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
    .alias(...RESET_WORDS)
    .action(async ({ session }, groupId) => {
      const t = resolveGroupArg(session, groupId)
      if (!t) return '在群里直接发 /清除屏蔽；在私聊里要带上群号：/清除屏蔽 123456'
      const r = await tryWrite(() => resetGroup(t.groupId, { platform: t.platform }))
      if (!r.ok) return `没能改成：${r.error}`
      const had = r.value
      logger.info('群 %s 的屏蔽设置已删除（%s 下发）', t.groupId, session.userId)
      const now = isBlocked({ ...session, channelId: t.groupId, guildId: t.groupId, isDirect: false })
      return had
        ? `群 ${t.groupId} 的设置已删除 → 按默认策略现在是「${now ? '静默' : '正常'}」`
        : `群 ${t.groupId} 本来就没有显式设置`
    })

  // ---------------------------------------------------------- 对外服务（给别的插件问）

  ctx.provide(SERVICE, {
    isBlocked,
    stateOf: (session) => rowOf(session)?.state ?? null,
    status: () => statusPayload(),
    setGroup,
    resetGroup,
    reload: () => reload(true),
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
  })

  if (cfg.refreshSeconds > 0) {
    ctx.setInterval(() => reload(true), cfg.refreshSeconds * 1000)
  }
}

module.exports = { name, inject, Config, apply }
