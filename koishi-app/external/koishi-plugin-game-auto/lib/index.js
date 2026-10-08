/**
 * koishi-plugin-game-auto
 *
 * 把本机的两个「游戏日常自动化」工具接进 bot：
 *   · 明日方舟 —— MAA（走**官方远程控制协议**，我们当任务源）
 *   · 终末地   —— MaaEnd / MXU（走它内置的 Web API + autoRunOnLaunch）
 *
 * ── 为什么是这两条路（评估结论见仓库根 `MAA接入需求评估.md`）──
 *   1. **不引入现成 MCP**：ChatLuna 的 MCP 客户端没有实现 elicitation
 *      （`koishi-plugin-chatluna-mcp-client/lib/index.mjs` 里 grep 不到 elicit/sampling），
 *      而 maa-mcp-adapter 的安全设计正建立在 elicitation 的确认表单上 —— 挂上去等于
 *      把它最值钱的「确认即所得」拆掉，还要多背十几个工具的 schema 进每轮上下文。
 *   2. **LLM 不进执行路径**：ChatLuna 工具只暴露白名单枚举（game/action），
 *      真实任务清单永远来自用户在 GUI 里保存的配置，绝不接受模型生成的任务参数。
 *      这样被 prompt injection 的最坏结果只是「多跑一次日常」，不会「花掉有限资源」。
 *   3. **MAA 侧我们当任务源**：MAA 以固定间隔（默认 1s）POST 来取任务，我们回
 *      `{tasks:[...]}`；每个任务跑完它 POST 回来报结果。
 *      协议：https://docs.maa.plus/zh-cn/protocol/remote-control-schema.html
 *      ★ 文档里的范例工作流标题就是「用 QQBot 控制 MAA」，我们不是硬凑。
 *
 * ── 2026-10-08 实测（决定了下面几个实现细节）──
 *   · 方舟七项日常实测 **19m52s**，而且 **MAA GUI 跑完就退出了** →
 *     「没开就拉起来」是**必需项不是优化项**，否则绝大多数时间触发都会静默失败。
 *   · **MAA 必须活着**（它是轮询的那一端），但**不需要人点任何按钮**：
 *     03:19 用 `F:\MAA\MAA.exe` 直接拉起、没人碰界面，gui.log 里就是每秒一条
 *     `HTTP: OK POST /maa/getTask?token=…`，直到 03:20:07 窗口被关掉。
 *     所以「按需拉起」只要把 exe spawn 起来就够了，不用去动它的远程控制开关。
 *   · **模拟器也得我们开**：MAA 的「启动模拟器」是另一套设置，它的 StartGame 只能
 *     启动模拟器**里的游戏**。群里喊一声就跑完整条链，模拟器这一环只能由 bot 补：
 *     `MuMuManager.exe control -v 0 launch`（官方 CLI，无 GUI 依赖），
 *     就绪判据用 `MuMuManager.exe info -v 0` 的 `is_android_started` ——
 *     adb 端口 16384 开得比系统开机早，只看端口会让 MAA 连上还没进桌面的系统。
 *   · MAA 只会 POST 一个 JSON、**不给自定义请求头** → 令牌只能走端点 URL 的查询串
 *     （`/maa/getTask?token=xxx`），这在协议里是允许的（"端点路径随意"）。
 *   · 所有本机调用一律走 `node:http`，**不用 fetch / ctx.http** ——
 *     后者可能吃到 HTTP_PROXY，把 127.0.0.1 的请求送进代理。
 *
 * ── 已验证 vs 未验证 ──
 *   · MAA 侧（端点 + 指令 + 工具）：已用模拟 MAA 客户端验过协议往返。
 *   · MAA / 模拟器的按需拉起：见上（MAA 拉起后自动轮询已实测）。
 *   · 终末地侧：**未做真机验证**（需要拉起 MaaEnd.exe），所以默认 `endfield.enabled = false`。
 *     开之前先跑 `/endfield.probe` 看真实状态结构。
 *
 * 自写，2026-10-08。
 */

const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const net = require('node:net')
const crypto = require('node:crypto')
const { spawn, execFileSync } = require('node:child_process')
const { Schema } = require('koishi')

const name = 'game-auto'

const inject = {
  required: ['server'],
  optional: ['chatluna'],
}

module.exports.name = name
module.exports.inject = inject

module.exports.Config = Schema.object({
  minAuthority: Schema.natural()
    .description('触发自动化所需的最低权限等级。<b>4 = 主人</b>；调低等于把「代肝」开给别人。')
    .default(4),
  allowGroups: Schema.array(String)
    .role('table')
    .description('允许触发的群号白名单。<b>留空 = 不限制群</b>（仍然要满足权限等级）。')
    .default([]),
  notifyPrefix: Schema.string().description('回报消息前缀。').default('[游戏自动化]'),
  debug: Schema.boolean().description('打印端点往返明细。').default(true),

  // ---------------- 明日方舟 / MAA ----------------
  maaEnabled: Schema.boolean().description('启用明日方舟（MAA 远程控制）。').default(true),
  maaExePath: Schema.string()
    .description('MAA GUI 可执行文件。远程控制要求它<b>常驻</b>，所以触发时会按需拉起。')
    .default('F:\\MAA\\MAA.exe'),
  maaGetTaskPath: Schema.string().description('「获取任务」端点路径。').default('/maa/getTask'),
  maaReportStatusPath: Schema.string().description('「汇报任务」端点路径。').default('/maa/reportStatus'),
  maaToken: Schema.string()
    .description(
      '端点令牌。留空 = 自动生成一次并写到 <code>data/game-auto-control.json</code>，重启复用（MAA 存的是死 URL，令牌一变你填的端点就失效）。' +
        'MAA 不给自定义请求头，所以只能走端点 URL 的查询串 <code>?token=...</code>。'
    )
    .default(''),
  maaLaunchIfDown: Schema.boolean()
    .description('触发时 MAA 没在跑就自动拉起来（实测它跑完会自己退出，所以这个基本必须开）。')
    .default(true),
  maaCheckEmulator: Schema.boolean()
    .description(
      '下发前先确认模拟器真的开机了。关掉 = 直接下发、让 MAA 自己去连（旧行为）。' +
        '判据优先问 MuMu 官方 CLI 的 <code>is_android_started</code>，问不到就退回 TCP 探 <code>maaEmulatorAdb</code>。'
    )
    .default(true),
  maaLaunchEmulator: Schema.boolean()
    .description(
      '模拟器没开就自动拉起来。<b>这是必需的一环</b>：MAA 只能启动<b>模拟器里的游戏本体</b>，' +
        '开不了模拟器本身（它的「启动模拟器」是另一套设置）。'
    )
    .default(true),
  maaEmulatorExePath: Schema.string()
    .description(
      'MuMu 的 <code>MuMuManager.exe</code>（官方 CLI，没有 GUI 依赖）。用它查开机状态、' +
        '以及 <code>control -v N launch</code> 开机。<b>用别的模拟器就留空</b>，此时只按 TCP 探地址。'
    )
    .default('D:\\Program Files\\Netease\\MuMu\\nx_main\\MuMuManager.exe'),
  maaEmulatorVmIndex: Schema.string()
    .description('多开实例序号（对应 CLI 的 <code>-v</code>，主实例是 <code>0</code>）；留空 = 不加 -v。')
    .default('0'),
  maaEmulatorAdb: Schema.string()
    .description('模拟器 adb 地址，TCP 兜底探测用。<b>要和 MAA 连接设置里的地址一致</b>。')
    .default('127.0.0.1:16384'),
  maaEmulatorWaitSeconds: Schema.natural()
    .description('开机最多等多少秒；超时就回报失败、**不下发任务**（免得让 MAA 自己空转到失败）。')
    .default(180),
  maaDispatchTimeoutMinutes: Schema.natural()
    .description('下发后多久没被 MAA 领走就判失败并回报（MAA 没起来/端点填错时会走到这里）。')
    .default(5),

  // ---------------- 终末地 / MaaEnd ----------------
  endfieldEnabled: Schema.boolean()
    .description('启用终末地（MaaEnd）。<b>未做真机验证，先保持关闭</b>，验完再开。')
    .default(false),
  endfieldExePath: Schema.string()
    .description('MaaEnd.exe（内核是 MXU）。')
    .default('D:\\MaaEnd-win-x86_64-v2.3.0\\MaaEnd.exe'),
  endfieldMxuConfigPath: Schema.string()
    .description('MXU 的配置文件。我们会改两个字段：<code>lastActiveInstanceId</code> 与 <code>autoRunOnLaunch</code>。')
    .default('D:\\MaaEnd-win-x86_64-v2.3.0\\config\\mxu-MaaEnd.json'),
  endfieldInstanceName: Schema.string()
    .description('跑哪个已保存实例（按名字匹配 MXU 里的标签页）。')
    .default('全套日常'),
  endfieldHost: Schema.string().description('MXU Web 服务地址。<b>永远别开 allowLanAccess</b>（它没有鉴权）。').default('127.0.0.1'),
  endfieldPort: Schema.natural().description('MXU Web 服务端口。').default(12701),
  endfieldRestartIfRunning: Schema.boolean()
    .description(
      'MaaEnd 已在运行时就重启它。<code>autoRunOnLaunch</code> 只在启动瞬间生效，不重启就开跑不了；但重启会打断你手动在用它的会话。'
    )
    .default(false),

  // ---------------- ChatLuna 工具 ----------------
  toolEnabled: Schema.boolean()
    .description('注册 ChatLuna 工具，让「帮我清理方舟日常」这种自然语言也能触发。')
    .default(true),
})

module.exports.apply = (ctx, config) => {
  const cfg = { ...module.exports.Config(), ...(config ?? {}) }
  const logger = ctx.logger(name)
  const log = (...a) => cfg.debug && logger.info(...a)

  // ================================================================ 状态

  const stateFile = path.join(ctx.baseDir ?? process.cwd(), 'data', 'game-auto.json')
  const controlFile = path.join(ctx.baseDir ?? process.cwd(), 'data', 'game-auto-control.json')

  /**
   * 端点令牌。
   * ★ 与 chatluna-guard 的差别：MAA **没法**自己去读我们的落盘文件（它只在设置里存一个死 URL），
   *   所以这个令牌必须**跨重启稳定** —— 每次启动随机一个新的，就等于每次重启都把你填进
   *   MAA 的端点 URL 弄失效。做法：生成一次 → 落盘 → 以后复用。
   */
  let maaToken = String(cfg.maaToken ?? '').trim()
  if (!maaToken) {
    try {
      const prev = JSON.parse(fs.readFileSync(controlFile, 'utf8'))
      if (prev?.token) maaToken = String(prev.token)
    } catch (e) {
      /* 首次运行，没有这个文件 */
    }
    if (!maaToken) maaToken = crypto.randomBytes(16).toString('hex')
  }

  /** 内存态；`save()` 落盘，重启后「谁在跑/欠谁一句回报」不丢 */
  const state = {
    tasks: [], // {id,type,params,status:'pending'|'dispatched'|'done'|'failed',queuedAt,dispatchedAt,doneAt,note}
    job: null, // {kind:'maa'|'endfield',label,startedAt,notify:{platform,selfId,channelId},instanceId?}
    maa: { seenAt: 0, user: '', device: '', heartbeatTaskId: '', heartbeatAt: 0, lastStatus: '' },
    lastResult: null, // {label,ok,at,note}
  }

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
      if (Array.isArray(raw.tasks)) state.tasks = raw.tasks
      if (raw.job) state.job = raw.job
      if (raw.maa) Object.assign(state.maa, raw.maa)
      if (raw.lastResult) state.lastResult = raw.lastResult
      log('已恢复状态：%s 个任务、job=%s', state.tasks.length, state.job ? state.job.label : '无')
    } catch (e) {
      if (e.code !== 'ENOENT') logger.warn('状态文件读取失败（忽略）：%s', e.message)
    }
  }

  let saveTimer = null
  function save() {
    if (saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      try {
        fs.mkdirSync(path.dirname(stateFile), { recursive: true })
        fs.writeFileSync(stateFile, JSON.stringify(state, null, 2))
      } catch (e) {
        logger.warn('状态落盘失败：%s', e.message)
      }
    }, 200)
    saveTimer.unref?.()
  }

  /**
   * 启动对账：**没有这一步插件会被永久卡死**。
   *
   * 为什么必须有：`state.job` 是「现在有人在跑」的唯一真相，而它落在磁盘上。
   * 只要有一次 `LinkStart` 没被 MAA 领走（MAA 没开、端点没填、跑到一半 bot 重启），
   * 那个 job 就会永远留在文件里 —— 之后每一次 /maa.daily 都会回
   * 「已经有一个在跑了：方舟日常，已跑 3 天 7 小时」。实测踩过。
   *
   * 判据：maa 的 job 在磁盘上却**没有任何未完结的任务**（pending/dispatched）→ 是残留，清掉。
   * 另加一条兜底：任何超过 MAX_JOB_MS 的 job 一律作废（跑不了这么久）。
   */
  const MAX_JOB_MS = 6 * 3600_000
  function reconcileJob() {
    const job = state.job
    if (!job) return
    const age = Date.now() - Number(job.startedAt ?? 0)
    const clear = (why) => {
      state.job = null
      logger.warn('启动对账：清掉残留的任务槽（%s，开始于 %s 前）—— %s', job.label ?? job.kind, fmtMin(age), why)
      save()
    }

    if (age > MAX_JOB_MS) return clear('超过了 6 小时上限，不可能还在跑')

    if (job.kind !== 'maa') {
      // 终末地那侧没有任务条目，无法用任务判定；留给 /endfield.status 去问 MXU 要真相
      logger.info('启动对账：终末地任务槽保留（%s，开始于 %s 前），用 /endfield.status 核对', job.label, fmtMin(age))
      return
    }

    // maa：只有「还在等 MAA 来领」的窗口内才算活着；窗口早过了就是残留
    const waitMs = Math.max(1, cfg.maaDispatchTimeoutMinutes) * 60_000
    const fresh = pendingTasks().filter((t) => Date.now() - Number(t.queuedAt ?? 0) < waitMs)
    if (fresh.length) {
      logger.info('启动对账：方舟任务还在等 MAA 来领（%s），重新武装看门狗', job.label)
      for (const t of fresh) armDispatchWatchdog(t)
      return
    }
    const orphan = pendingTasks()
    if (orphan.length) {
      for (const t of orphan) {
        t.status = 'failed'
        t.note = '重启对账：MAA 没来领任务'
        t.doneAt = Date.now()
      }
    }
    clear(orphan.length ? '任务过了等待窗口仍没被 MAA 领走' : '磁盘上没有任何未完结的任务')
  }

  // ================================================================ 小工具

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  /** 本机 JSON 请求。刻意不用 fetch / ctx.http —— 它们可能吃到 HTTP_PROXY。 */
  function httpJson(method, url, body, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      let u
      try {
        u = new URL(url)
      } catch (e) {
        return reject(new Error(`URL 不合法：${url}`))
      }
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
      const req = http.request(
        {
          method,
          hostname: u.hostname,
          port: u.port || 80,
          path: u.pathname + u.search,
          headers: payload
            ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
            : {},
          timeout: timeoutMs,
        },
        (res) => {
          const chunks = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            resolve({ status: res.statusCode, text })
          })
        }
      )
      req.on('timeout', () => req.destroy(new Error(`请求超时（${timeoutMs}ms）`)))
      req.on('error', reject)
      if (payload) req.write(payload)
      req.end()
    })
  }

  function authorityOf(session) {
    return Number(session?.user?.authority ?? 1)
  }

  function groupAllowed(session) {
    const list = (cfg.allowGroups ?? []).map(String).filter(Boolean)
    if (!list.length) return true
    const gid = String(session?.guildId ?? session?.channelId ?? '')
    return list.includes(gid)
  }

  /** 命令与工具共用的闸门：等级够 + 群在白名单里
   *
   *  ★ 实测（2026-10-08，rig 25）：命令上那层 `{ authority: N }` 是**框架先判**的 ——
   *    等级不够时 Koishi 自己就回了一句「权限不足」，**根本轮不到这里**。
   *    所以下面 `null`（静默）那条分支只在 ChatLuna 工具那条路上真正生效；
   *    命令这条路仍然留着它是为了纵深（万一以后有人把命令的 authority 调低，这里还有一道）。
   */
  function gate(session) {
    if (!session) return '拿不到会话信息，做不了。'
    if (authorityOf(session) < cfg.minAuthority) return null // 静默：不告诉外人这里有代肝
    if (!groupAllowed(session)) return '这个群没开游戏自动化。'
    return undefined // 放行
  }

  function notifyTarget(session) {
    return {
      platform: session.platform,
      selfId: String(session.selfId ?? ''),
      channelId: String(session.channelId ?? session.guildId ?? ''),
      isDirect: !!session.isDirect,
    }
  }

  async function sendNotify(target, text) {
    if (!target?.channelId) return
    try {
      const bot =
        ctx.bots.find((b) => String(b.platform) === String(target.platform) && String(b.selfId) === target.selfId) ||
        ctx.bots.find((b) => String(b.platform) === String(target.platform)) ||
        ctx.bots[0]
      if (!bot) return logger.warn('回报失败：没有可用的 bot 实例')
      await bot.sendMessage(target.channelId, `${cfg.notifyPrefix} ${text}`)
      log('已回报到 %s：%s', target.channelId, text)
    } catch (e) {
      logger.warn('回报失败：%s', e.message)
    }
  }

  const fmtMin = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000))
    return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`
  }

  // ================================================================ MAA 侧

  function maaTokenOk(koa) {
    if (!maaToken) return true
    const q = koa.query ?? {}
    const h = koa.request?.headers ?? {}
    return String(q.token ?? '') === maaToken || String(h['x-maa-token'] ?? '') === maaToken
  }

  function pendingTasks() {
    return state.tasks.filter((t) => t.status === 'pending' || t.status === 'dispatched')
  }

  function enqueue(type, params, label) {
    const task = {
      id: crypto.randomUUID(),
      type,
      params,
      status: 'pending',
      queuedAt: Date.now(),
      label: label ?? type,
    }
    state.tasks.push(task)
    save()
    return task
  }

  function clearOldTasks() {
    const keep = 40
    if (state.tasks.length <= keep) return
    state.tasks = state.tasks.slice(-keep)
  }

  /** 任务发下去后一直没被 MAA 领走 → 判失败并回报（多半是 MAA 没起来或端点填错） */
  function armDispatchWatchdog(task) {
    const timer = setTimeout(async () => {
      if (task.status !== 'pending') return
      task.status = 'failed'
      task.note = 'MAA 没有来领任务'
      const job = state.job
      state.job = null
      state.lastResult = { label: task.label, ok: false, at: Date.now(), note: task.note }
      save()
      if (job) {
        await sendNotify(
          job.notify,
          `${job.label} 没能开始：${cfg.maaDispatchTimeoutMinutes} 分钟内 MAA 没来领任务。\n` +
            `检查：① MAA 有没有起来（${cfg.maaExePath}）② MAA 设置→远程控制里两个端点填的是不是本机这两个：\n` +
            `  ${endpointUrl(cfg.maaGetTaskPath)}\n  ${endpointUrl(cfg.maaReportStatusPath)}`
        )
      }
    }, Math.max(1, cfg.maaDispatchTimeoutMinutes) * 60_000)
    timer.unref?.()
    return timer
  }

  function endpointUrl(p) {
    const token = maaToken ? `?token=${encodeURIComponent(maaToken)}` : ''
    return `http://127.0.0.1:${ctx.server?.port ?? 5140}${p}${token}`
  }

  /** POST /maa/getTask —— MAA 每秒来取任务；对同一个 id 重复返回是协议允许的（它自己去重） */
  ctx.server.post(cfg.maaGetTaskPath, async (koa) => {
    if (!cfg.maaEnabled) {
      koa.body = { tasks: [] }
      return
    }
    if (!maaTokenOk(koa)) {
      koa.status = 403
      koa.body = { error: 'token 不对' }
      logger.warn('getTask 令牌不匹配，已拒绝（检查 MAA 端点 URL 里的 ?token=）')
      return
    }
    const body = koa.request?.body ?? {}
    const first = !state.maa.seenAt
    state.maa.seenAt = Date.now()
    state.maa.user = String(body.user ?? state.maa.user ?? '')
    state.maa.device = String(body.device ?? state.maa.device ?? '')
    if (first) {
      logger.info('MAA 首次来取任务：user=%s device=%s', state.maa.user, state.maa.device)
    }

    const out = []
    for (const t of pendingTasks()) {
      if (t.status === 'pending') {
        t.status = 'dispatched'
        t.dispatchedAt = Date.now()
        log('下发任务 %s (%s)', t.type, t.id)
      }
      const item = { id: t.id, type: t.type }
      if (t.params !== undefined && t.params !== null) item.params = t.params
      out.push(item)
    }
    save()
    koa.body = { tasks: out }
  })

  /** POST /maa/reportStatus —— 每跑完一个任务 MAA 报一次结果 */
  ctx.server.post(cfg.maaReportStatusPath, async (koa) => {
    if (!maaTokenOk(koa)) {
      koa.status = 403
      koa.body = { error: 'token 不对' }
      return
    }
    const body = koa.request?.body ?? {}
    const taskId = String(body.task ?? '')
    const status = String(body.status ?? '')
    const payload = typeof body.payload === 'string' ? body.payload : ''
    const t = state.tasks.find((x) => x.id === taskId)
    log('MAA 回报：task=%s status=%s payload=%s', taskId, status, payload.slice(0, 120))

    if (t) {
      t.status = status === 'FAILED' ? 'failed' : 'done'
      t.doneAt = Date.now()
      // ★ 截图类任务的 payload 是几十 MB 的 base64，绝不进状态文件
      if (payload && payload.length < 500) t.note = payload
    }

    if (t?.type === 'HeartBeat') {
      state.maa.heartbeatTaskId = payload
      state.maa.heartbeatAt = Date.now()
      save()
      koa.body = { ok: true }
      return
    }

    if (t?.type === 'StopTask') {
      if (state.job) {
        const job = state.job
        state.job = null
        state.lastResult = { label: job.label, ok: false, at: Date.now(), note: '被手动停止' }
        await sendNotify(job.notify, `${job.label} 已停止。`)
      }
      save()
      koa.body = { ok: true }
      return
    }

    // LinkStart（一键长草）= 整条队列跑完才有这一次回报 → 收尾并回报群里
    if (t?.type === 'LinkStart' && state.job && state.job.kind === 'maa') {
      const job = state.job
      state.job = null
      const ok = t.status === 'done'
      state.lastResult = { label: job.label, ok, at: Date.now(), note: t.note ?? '' }
      clearOldTasks()
      save()
      // ★ 用 dispatchedAt（MAA 真正领走的时刻）而不是 startedAt：
      //   否则「bot 入队 → MAA 才起来把它领走」这段等待会被算进"用时"。
      //   实测踩过：一个 4 分 49 秒前入队、刚被领走就报完的任务，显示成"用时 4 分 49 秒"。
      const beganAt = Number(t.dispatchedAt ?? job.startedAt)
      await sendNotify(
        job.notify,
        ok
          ? `${job.label} 跑完了（用时 ${fmtMin(Date.now() - beganAt)}）。`
          : `${job.label} 结束了，但 MAA 报的是 FAILED${t.note ? `：${t.note}` : ''}。`
      )
    } else {
      save()
    }
    koa.body = { ok: true }
  })

  function maaLooksRunning() {
    return state.maa.seenAt > 0 && Date.now() - state.maa.seenAt < 15_000
  }

  // ---------------------------------------------------------------- 模拟器（MuMu）

  /** TCP 连通性探测。凑不到 adb 端口就说明 VM 根本没起。 */
  function tcpUp(hostport, timeoutMs = 1200) {
    return new Promise((resolve) => {
      const s = String(hostport ?? '')
      const i = s.lastIndexOf(':')
      const host = i < 0 ? s : s.slice(0, i)
      const port = Number(i < 0 ? 0 : s.slice(i + 1))
      if (!host || !port) return resolve(false)
      const sock = new net.Socket()
      let settled = false
      const done = (ok) => {
        if (settled) return
        settled = true
        try {
          sock.destroy()
        } catch (e) {
          /* 已断开 */
        }
        resolve(ok)
      }
      sock.setTimeout(timeoutMs)
      sock.once('connect', () => done(true))
      sock.once('timeout', () => done(false))
      sock.once('error', () => done(false))
      sock.connect(port, host)
    })
  }

  /**
   * 问 MuMu 官方 CLI 一个实例的状态。
   * ★ 为什么不用「adb 端口通了」当唯一判据：端口开得比系统开机早 ——
   *   VM 的 adbd 一起来就监听 16384，此时安卓还没进桌面，MAA 连上去会白等。
   *   `is_android_started` 才是「真的开机完成」。
   */
  function emulatorInfo() {
    const exe = String(cfg.maaEmulatorExePath ?? '').trim()
    if (!exe || !fs.existsSync(exe)) return null
    const idx = String(cfg.maaEmulatorVmIndex ?? '').trim()
    try {
      const out = execFileSync(exe, ['info', ...(idx ? ['-v', idx] : [])], {
        encoding: 'utf8',
        timeout: 10_000,
        windowsHide: true,
      })
      const json = JSON.parse(out)
      // 单实例直接返回对象；某些参数组合下会包一层 { "0": {...} }
      return (idx && json?.[idx]) || json
    } catch (e) {
      log('读模拟器状态失败（忽略，退回 TCP 探测）：%s', e.message)
      return null
    }
  }

  /** 读一次 is_android_started。known=false 表示字段缺失/不是布尔 —— 那是"不知道"，不是"没开机"。 */
  function emulatorStarted() {
    const info = emulatorInfo()
    if (!info || typeof info !== 'object') return { known: false, up: false, raw: null }
    const v = info.is_android_started
    if (typeof v !== 'boolean') return { known: false, up: false, raw: info }
    return { known: true, up: v, raw: info }
  }

  /**
   * ★ 实测（2026-10-08 19:31:31）：模拟器明明开着、早就进桌面了，MuMu CLI 却报
   *   `is_android_started: false`，于是这里判成"没在跑" → 白拉起一次、白等几秒才下发。
   *   空闲时连问 30 次全是 true，说明它偶发地回陈旧快照。所以：
   *     ① 字段缺失/不是布尔 → 退回 TCP 探（不能拿"没这个字段"当"没开机"）；
   *     ② 报 false → 1.5 秒后复查一次，两次都说 false 才认；
   *     ③ 判"没在跑"时把 player_state/error_code 打进日志，下次再遇到就有证据。
   */
  async function emulatorUp() {
    if (!cfg.maaCheckEmulator) return true
    const first = emulatorStarted()
    if (!first.known) return tcpUp(cfg.maaEmulatorAdb)
    if (first.up) return true
    await new Promise((r) => setTimeout(r, 1500))
    const second = emulatorStarted()
    if (!second.known) return tcpUp(cfg.maaEmulatorAdb)
    if (second.up) {
      logger.info('模拟器状态第一次报"没开机"、复查为"已开机"（MuMu CLI 陈旧快照），按已就绪处理')
      return true
    }
    logger.info(
      '模拟器：MuMu 报没开机（player_state=%s error_code=%s）',
      second.raw?.player_state,
      second.raw?.error_code
    )
    return false
  }

  function launchEmulator() {
    const exe = String(cfg.maaEmulatorExePath ?? '').trim()
    if (!exe || !fs.existsSync(exe)) {
      logger.warn('拉起模拟器失败：MuMuManager 路径不对（%s）', cfg.maaEmulatorExePath)
      return false
    }
    const idx = String(cfg.maaEmulatorVmIndex ?? '').trim()
    const args = ['control', ...(idx ? ['-v', idx] : []), 'launch']
    try {
      spawn(exe, args, { detached: true, stdio: 'ignore', cwd: path.dirname(exe) }).unref()
      logger.info('已拉起模拟器：%s %s', exe, args.join(' '))
      return true
    } catch (e) {
      logger.warn('拉起模拟器失败：%s', e.message)
      return false
    }
  }

  /** 等模拟器就绪；超时返回 false（调用方负责回报，别让任务悬着） */
  async function waitEmulatorUp() {
    const waitMs = Math.max(10, Number(cfg.maaEmulatorWaitSeconds) || 180) * 1000
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline) {
      await sleep(3000)
      if (await emulatorUp()) return true
    }
    return false
  }

  function launchMaa() {
    try {
      if (!fs.existsSync(cfg.maaExePath)) {
        logger.warn('拉起 MAA 失败：文件不存在（%s）', cfg.maaExePath)
        return false
      }
      // cwd 落在 exe 所在目录：MAA 用它自己的目录找 config/resource
      const child = spawn(cfg.maaExePath, [], {
        detached: true,
        stdio: 'ignore',
        cwd: path.dirname(cfg.maaExePath),
      })
      child.unref()
      logger.info('已拉起 MAA：%s', cfg.maaExePath)
      return true
    } catch (e) {
      logger.warn('拉起 MAA 失败：%s', e.message)
      return false
    }
  }

  /** 占住任务槽（此时还没入队）。phase=preparing 表示「正在等模拟器」。 */
  function startMaaJob(label, notify) {
    state.job = { kind: 'maa', label, startedAt: Date.now(), notify, phase: 'preparing' }
    state.lastResult = null
    save()
  }

  /** 真的入队 + 武装「迟迟没被领走」看门狗。**必须在模拟器就绪之后**调用。 */
  function dispatchMaaJob() {
    const job = state.job
    if (!job) return null
    job.phase = 'queued'
    const task = enqueue('LinkStart', undefined, job.label)
    save()
    armDispatchWatchdog(task)
    return task
  }

  /** 触发一次方舟日常。返回给用户/模型的即时回执（**不等它跑完**） */
  async function maaStartDaily(session, label = '方舟日常') {
    if (!cfg.maaEnabled) return '方舟这条通道没开（配置里 maaEnabled = false）。'
    if (state.job) {
      return `已经有一个在跑了：${state.job.label}，已跑 ${fmtMin(Date.now() - state.job.startedAt)}。要停就 /maa.stop。`
    }

    const notify = notifyTarget(session)
    const notes = []

    // ★ MAA 是「主动轮询」的那一端：它必须是活的，但它**不需要人点任何按钮**。
    //   实测 2026-10-08 03:19-03:20：用 exe 直接拉起、没人碰界面，gui.log 里就是
    //   每秒一条 `HTTP: OK POST http://127.0.0.1:5140/maa/getTask?token=…`，
    //   一直到窗口被关掉（`Shutdown called by OnClose`）才停。
    const maaUp = maaLooksRunning()
    if (!maaUp && cfg.maaLaunchIfDown) {
      if (launchMaa()) notes.push('MAA 没在跑，已把它拉起来')
    } else if (!maaUp) {
      notes.push('⚠️ MAA 没在跑，而「按需拉起」是关的 —— 它不会自己开始，你得先打开 MAA')
    }

    // ★ 模拟器：MAA 只能启动**模拟器里的游戏**，它开不了模拟器本身。
    //   所以「群里喊一声就跑」这条链上，模拟器这一环只能由我们补。
    if (cfg.maaCheckEmulator && !(await emulatorUp())) {
      if (!cfg.maaLaunchEmulator) {
        return (
          `模拟器没在跑（${cfg.maaEmulatorAdb} 不通），而「按需拉起模拟器」是关的。\n` +
          `先把模拟器打开，或者把配置里的 maaLaunchEmulator 打开。`
        )
      }
      startMaaJob(label, notify)
      if (!launchEmulator()) {
        state.job = null
        save()
        return `拉起模拟器失败，检查 maaEmulatorExePath：${cfg.maaEmulatorExePath}`
      }
      const waitSec = Math.max(10, Number(cfg.maaEmulatorWaitSeconds) || 180)
      logger.info('模拟器没在跑（%s），已拉起；最多等 %s 秒开机完成再下发', cfg.maaEmulatorAdb, waitSec)
      // 不阻塞回执：开机要 30-60 秒，先回一句，起来了再真的下发
      waitEmulatorUp()
        .then(async (ok) => {
          const job = state.job
          if (!job || job.phase !== 'preparing') return // 等待期间被 /maa.stop 或启动对账清掉了
          if (!ok) {
            state.job = null
            state.lastResult = { label, ok: false, at: Date.now(), note: '模拟器没起来' }
            save()
            await sendNotify(
              notify,
              `${label} 没能开始：等了 ${fmtMin(waitSec * 1000)} 模拟器还是没就绪（${cfg.maaEmulatorAdb}）。`
            )
            return
          }
          dispatchMaaJob()
          log('模拟器就绪，方舟任务已下发')
        })
        .catch((e) => logger.warn('等模拟器就绪出错：%s', e.message))
      return (
        `${notes.length ? `${notes.join('；')}\n` : ''}` +
        `模拟器没在跑，我已经把它拉起来了，正在等它开机（最多 ${waitSec} 秒）……\n` +
        `就绪后我自动下发方舟日常，跑完在这儿说一声。中途想看进度：/maa.status`
      )
    }

    startMaaJob(label, notify)
    dispatchMaaJob()
    logger.info('已下发方舟日常（%s）', notes.join('；') || 'MAA 与模拟器都在')
    return (
      `好，方舟日常已下发${notes.length ? `\n（${notes.join('；')}）` : ''}\n` +
      `预计 20 分钟左右（实测上次 19m52s），跑完我在这儿说一声。中途想看进度：/maa.status`
    )
  }

  async function maaProbe() {
    const task = enqueue('HeartBeat', undefined, '心跳探针')
    return (
      `已下发心跳探针（任务 ${task.id.slice(0, 8)}）。\n` +
      `如果 MAA 正在运行且远程控制配好了，几秒内就会回报 —— 用 /maa.status 看「最近心跳」。`
    )
  }

  async function maaStop() {
    if (!state.job) return '现在没有在跑的任务。'
    // 还在「等模拟器开机」阶段：本地撤销就行，别往 MAA 扔 StopTask（它那边没任务可停）
    if (state.job.phase === 'preparing') {
      const job = state.job
      state.job = null
      state.lastResult = { label: job.label, ok: false, at: Date.now(), note: '取消（还没下发）' }
      save()
      return `已取消「${job.label}」——它还在等模拟器开机，所以没往 MAA 下发任何东西。`
    }
    enqueue('StopTask', undefined, '停止')
    return '已下发停止指令（StopTask）。MAA 收到后会结束当前任务。'
  }

  async function maaStatusText() {
    const lines = []
    const seen = state.maa.seenAt ? `${fmtMin(Date.now() - state.maa.seenAt)}前` : '从没来过'
    lines.push(`MAA 连接：${seen}${state.maa.device ? `（device ${state.maa.device.slice(0, 8)}…）` : ''}`)
    if (cfg.maaCheckEmulator) {
      const up = await emulatorUp()
      lines.push(
        `模拟器：${
          up
            ? `已就绪（${cfg.maaEmulatorAdb}）`
            : `没在跑（${cfg.maaEmulatorAdb}）${cfg.maaLaunchEmulator ? '，触发时我会拉起来' : '，自动拉起是关的'}`
        }`
      )
    }
    if (state.maa.heartbeatAt) {
      const cur = state.maa.heartbeatTaskId
      lines.push(
        `最近心跳：${fmtMin(Date.now() - state.maa.heartbeatAt)}前，当前任务 ${
          cur ? `#${cur}` : '（空闲）'
        }`
      )
    }
    if (state.job) {
      const phase = state.job.phase === 'preparing' ? '（正在等模拟器开机，还没下发）' : ''
      lines.push(`★ 正在跑：${state.job.label}${phase}，已跑 ${fmtMin(Date.now() - state.job.startedAt)}`)
    } else {
      lines.push('当前没有在跑的任务。')
    }
    const pend = pendingTasks()
    if (pend.length) {
      lines.push(`未完结的任务：${pend.map((t) => `${t.type}(${t.status})`).join('、')}`)
    }
    if (state.lastResult) {
      const r = state.lastResult
      lines.push(
        `上次结果：${r.label} ${r.ok ? '成功' : '失败'}（${fmtMin(Date.now() - r.at)}前）${r.note ? ` — ${r.note}` : ''}`
      )
    }
    lines.push(
      `\n端点：${endpointUrl(cfg.maaGetTaskPath)}`
    )
    return lines.join('\n')
  }

  // ================================================================ 终末地侧

  const mxuBase = () => `http://${cfg.endfieldHost}:${cfg.endfieldPort}`

  async function mxuJson(method, apiPath, body, timeoutMs = 5000) {
    const res = await httpJson(method, `${mxuBase()}${apiPath}`, body, timeoutMs)
    let parsed = null
    try {
      parsed = res.text ? JSON.parse(res.text) : null
    } catch (e) {
      parsed = res.text
    }
    return { status: res.status, body: parsed, text: res.text }
  }

  async function mxuReady() {
    try {
      const r = await mxuJson('GET', '/api/maa/state', undefined, 1500)
      return r.status >= 200 && r.status < 500
    } catch (e) {
      return false
    }
  }

  function readMxuConfig() {
    const raw = fs.readFileSync(cfg.endfieldMxuConfigPath, 'utf8')
    return { raw, json: JSON.parse(raw) }
  }

  function pickEndfieldInstance(json) {
    const list = Array.isArray(json.instances) ? json.instances : []
    return list.find((i) => String(i.name ?? '') === cfg.endfieldInstanceName) ?? null
  }

  /**
   * 把「跑哪个实例」写进 MXU 配置。
   * ★ 为什么用 autoRunOnLaunch 而不是 Web API 的 tasks/start：
   *   tasks/start 要请求方自己把界面选项解析成 pipelineOverride（那段逻辑在前端 TS 里），
   *   而且 Web API **暴露不了 preActions**（MXU Issue #348）—— 而「全套日常」正有一个
   *   preAction 负责启动 Endfield.exe。走 autoRunOnLaunch 等于让 MXU 自己按保存的配置全套跑，
   *   选项与前置动作都不会丢，代价是每次换实例要改配置、且只在启动瞬间生效。
   */
  function patchMxuConfig(instanceId) {
    const { raw, json } = readMxuConfig()
    const backup = `${cfg.endfieldMxuConfigPath}.qqbot-bak`
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, raw)
    json.lastActiveInstanceId = instanceId
    json.settings = json.settings ?? {}
    json.settings.autoRunOnLaunch = true
    fs.writeFileSync(cfg.endfieldMxuConfigPath, JSON.stringify(json, null, 2))
    logger.info('已改 MXU 配置：lastActiveInstanceId=%s, autoRunOnLaunch=true（原文件备份在 %s）', instanceId, backup)
  }

  function killMaaEnd() {
    try {
      spawn('taskkill', ['/IM', 'MaaEnd.exe', '/T', '/F'], { detached: true, stdio: 'ignore' }).unref()
      logger.info('已请 taskkill 收掉 MaaEnd.exe（含子进程）')
      return true
    } catch (e) {
      logger.warn('收 MaaEnd 失败：%s', e.message)
      return false
    }
  }

  function launchMaaEnd() {
    try {
      spawn(cfg.endfieldExePath, [], { detached: true, stdio: 'ignore', cwd: path.dirname(cfg.endfieldExePath) }).unref()
      logger.info('已拉起 MaaEnd：%s', cfg.endfieldExePath)
      return true
    } catch (e) {
      logger.warn('拉起 MaaEnd 失败：%s', e.message)
      return false
    }
  }

  async function endfieldStartDaily(session, label = '终末地日常') {
    if (!cfg.endfieldEnabled) return '终末地这条通道还没开（配置里 endfieldEnabled = false，等真机验证过再开）。'
    if (state.job) {
      return `已经有一个在跑了：${state.job.label}，已跑 ${fmtMin(Date.now() - state.job.startedAt)}。要停就 /endfield.stop。`
    }
    let inst
    try {
      inst = pickEndfieldInstance(readMxuConfig().json)
    } catch (e) {
      return `读不到 MXU 配置（${cfg.endfieldMxuConfigPath}）：${e.message}`
    }
    if (!inst) return `MXU 配置里没有叫「${cfg.endfieldInstanceName}」的实例。`

    if (await mxuReady()) {
      if (!cfg.endfieldRestartIfRunning) {
        return (
          `MaaEnd 已经在运行了。\n` +
          `autoRunOnLaunch 只在**启动瞬间**生效，所以我现在不会让它开跑 —— 免得打断你正在用的会话。\n` +
          `两个选择：① 先关掉 MaaEnd 再喊我；② 把配置里的「已在运行时重启」打开（会强制重启它）。`
        )
      }
      killMaaEnd()
      await sleep(4000)
    }

    patchMxuConfig(inst.id)
    const launched = launchMaaEnd()
    // 等 Web 服务起来（最多 60s）
    let up = false
    for (let i = 0; i < 30; i++) {
      await sleep(2000)
      if (await mxuReady()) {
        up = true
        break
      }
    }
    state.job = {
      kind: 'endfield',
      label,
      startedAt: Date.now(),
      notify: notifyTarget(session),
      instanceId: inst.id,
      instanceName: inst.name,
    }
    state.lastResult = null
    save()
    if (!up) {
      return (
        `已按「${inst.name}」准备好并${launched ? '拉起' : '尝试拉起'} MaaEnd，但 60 秒内没等到它的 Web 服务（${mxuBase()}）。\n` +
        `可能它还在启动/在自我更新。用 /endfield.status 再看一眼。`
      )
    }
    return (
      `已按「${inst.name}」开跑（MaaEnd 由它自己按保存的配置跑，含启动游戏的前置动作）。\n` +
      `⚠️ 终末地是 Win32 前台独占：**这段时间这台电脑的鼠标键盘会被它占用**。\n` +
      `状态：/endfield.status　停止：/endfield.stop`
    )
  }

  async function endfieldStatusText() {
    const lines = []
    if (state.job?.kind === 'endfield') {
      lines.push(`★ 正在跑：${state.job.label}（实例「${state.job.instanceName}」），已跑 ${fmtMin(Date.now() - state.job.startedAt)}`)
    } else {
      lines.push('当前没有在跑的终末地任务。')
    }
    try {
      const st = await mxuJson('GET', '/api/maa/state', undefined, 4000)
      lines.push(`Web 服务：HTTP ${st.status}`)
      lines.push(`state：${JSON.stringify(st.body).slice(0, 600)}`)
    } catch (e) {
      lines.push(`连不上 Web 服务（${mxuBase()}）：${e.message}`)
      lines.push('→ MaaEnd 没起来，或它的 Web 服务被关掉了（设置→Web 服务）。')
    }
    return lines.join('\n')
  }

  async function endfieldStop() {
    if (state.job?.kind !== 'endfield') return '现在没有在跑的终末地任务。'
    const id = state.job.instanceId
    try {
      const r = await mxuJson('POST', `/api/maa/instances/${id}/tasks/stop`, undefined, 5000)
      const job = state.job
      state.job = null
      state.lastResult = { label: job.label, ok: false, at: Date.now(), note: '被手动停止' }
      save()
      await sendNotify(job.notify, `${job.label} 已停止。`)
      return `已下发停止（HTTP ${r.status}）。`
    } catch (e) {
      return `停止失败：${e.message}`
    }
  }

  /** 真机验证用：把 MXU 的原始状态/配置结构打出来，不改任何东西 */
  async function endfieldProbe() {
    const out = []
    out.push(`MXU 配置：${cfg.endfieldMxuConfigPath}`)
    try {
      const j = readMxuConfig().json
      const list = Array.isArray(j.instances) ? j.instances : []
      out.push(`实例（${list.length}）：${list.map((i) => `${i.name}${i.id ? `#${i.id}` : ''}`).join('、')}`)
      out.push(`lastActiveInstanceId=${j.lastActiveInstanceId}　autoRunOnLaunch=${j.settings?.autoRunOnLaunch}`)
    } catch (e) {
      out.push(`读配置失败：${e.message}`)
    }
    out.push(`Web 服务：${mxuBase()}　running=${await mxuReady()}`)
    try {
      const st = await mxuJson('GET', '/api/maa/state', undefined, 4000)
      out.push(`GET /api/maa/state → HTTP ${st.status}\n${st.text.slice(0, 1200)}`)
    } catch (e) {
      out.push(`GET /api/maa/state 失败：${e.message}`)
    }
    return out.join('\n')
  }

  // ================================================================ 指令

  const CMD = { authority: Math.max(1, Number(cfg.minAuthority) || 4) }

  /** 统一的命令外壳：闸门 → 干活 → 把返回值发回去 */
  function define(def, desc, handler) {
    ctx.command(def, desc, CMD).action(async ({ session }) => {
      const denied = gate(session)
      if (denied === null) return // 等级不够：静默
      if (denied) return denied
      try {
        return await handler(session)
      } catch (e) {
        logger.warn('%s 执行出错：%s', def, e.message)
        return `出错了：${e.message}`
      }
    })
  }

  define('maa.daily', '方舟：跑一次当前 GUI 队列的日常（一键长草）', (s) => maaStartDaily(s))
  define('maa.status', '方舟：看 MAA 连接、进度与上次结果', () => maaStatusText())
  define('maa.stop', '方舟：停止当前任务', () => maaStop())
  define('maa.probe', '方舟：下发一个心跳探针，验证远程控制链路', () => maaProbe())

  define('endfield.daily', '终末地：按保存的实例跑一次日常', (s) => endfieldStartDaily(s))
  define('endfield.status', '终末地：看 MaaEnd / MXU 状态', () => endfieldStatusText())
  define('endfield.stop', '终末地：停止当前任务', () => endfieldStop())
  define('endfield.probe', '终末地：打印 MXU 原始状态结构（真机验证用，不改任何东西）', () => endfieldProbe())

  // ================================================================ ChatLuna 工具

  ctx.inject(['chatluna'], (ctx2) => {
    if (!cfg.toolEnabled) return
    const platform = ctx2.chatluna?.platform
    if (!platform || typeof platform.registerTool !== 'function') {
      logger.warn('platform.registerTool 不可用，game_auto 工具未注册')
      return
    }
    const { StructuredTool } = require('@langchain/core/tools')
    const z = require('zod')

    const desc =
      '操作本机上的游戏日常自动化（明日方舟 / 终末地）。' +
      '用户说「帮我清理方舟日常」「把终末地的日常跑一下」「游戏在跑吗」「停一下」时用它。' +
      '★ 只能从这些动作里选，不能自己编任务、关卡、次数 —— 真实任务清单来自用户游戏工具里保存的配置。' +
      '★ 这个工具只对主人可用；调用后立刻返回「已开始」，不要谎称已经跑完。'

    platform.registerTool('game_auto', {
      // 只在允许的群里露面
      selector: (messages) => {
        const session = messages?.configurable?.session
        return session ? groupAllowed(session) : true
      },
      authorization: (session) => authorityOf(session) >= cfg.minAuthority,
      description: desc,
      createTool: () =>
        new (class extends StructuredTool {
          name = 'game_auto'
          description = desc
          schema = z.object({
            game: z.enum(['arknights', 'endfield']).describe('arknights = 明日方舟，endfield = 终末地'),
            action: z
              .enum(['daily', 'status', 'stop'])
              .describe('daily = 跑一次日常；status = 查询状态；stop = 停止当前任务'),
          })
          async _call(input, _manager, runnable) {
            const session = runnable?.configurable?.session
            const denied = gate(session)
            if (denied === null) return '这件事你做不了。'
            if (denied) return denied
            const { game, action } = input
            try {
              if (game === 'arknights') {
                if (action === 'daily') return await maaStartDaily(session, '方舟日常')
                if (action === 'status') return maaStatusText()
                return await maaStop()
              }
              if (action === 'daily') return await endfieldStartDaily(session, '终末地日常')
              if (action === 'status') return await endfieldStatusText()
              return await endfieldStop()
            } catch (e) {
              logger.warn('game_auto 失败：%s', e.message)
              return `操作失败：${e.message}`
            }
          }
        })(),
    })
    logger.info('已注册 ChatLuna 工具：game_auto')
  })

  // ================================================================ 启动

  load()
  reconcileJob()

  /**
   * ★ 时序坑：插件 `ready` 时 `ctx.server.port` **还是 undefined** —— server 是在 ready 之后
   *   才 `listen()` 的（实测日志里 "就绪：端口 (未知)" 恰好排在 "server listening" 之前）。
   *   所以端点 URL 与落盘动作必须**延后到端口真正绑上**，否则 test 实例（5141）会被写成 5140。
   */
  function writeControlFile() {
    const port = ctx.server?.port ?? null
    const info = {
      port,
      host: '127.0.0.1',
      getTaskUrl: endpointUrl(cfg.maaGetTaskPath),
      reportStatusUrl: endpointUrl(cfg.maaReportStatusPath),
      token: maaToken,
    }
    try {
      fs.mkdirSync(path.dirname(controlFile), { recursive: true })
      fs.writeFileSync(controlFile, JSON.stringify(info, null, 2))
    } catch (e) {
      logger.warn('控制信息落盘失败：%s', e.message)
    }
    return info
  }

  ctx.on('ready', () => {
    // 等端口绑上再报（server plugin 在 ready 之后才 listen）
    ctx.setTimeout(() => {
      const port = ctx.server?.port ?? null
      if (cfg.maaEnabled && !String(cfg.maaToken ?? '').trim()) writeControlFile()
      logger.info('就绪：端口 %s，终末地 %s', port ?? '(未知)', cfg.endfieldEnabled ? '已启用' : '未启用')
      if (cfg.maaEnabled && cfg.maaCheckEmulator) {
        emulatorUp()
          .then((up) => {
            logger.info('模拟器：%s（%s）', up ? '已就绪' : '没在跑', cfg.maaEmulatorAdb)
            if (!up && cfg.maaLaunchEmulator) {
              logger.info('  触发时会用 %s control -v %s launch 把它拉起来', cfg.maaEmulatorExePath, cfg.maaEmulatorVmIndex)
            }
          })
          .catch(() => {})
      }
      if (cfg.maaEnabled) {
        logger.info('★ 把这两条原样填进 MAA「设置 → 远程控制」：')
        logger.info('   获取任务端点：%s', endpointUrl(cfg.maaGetTaskPath))
        logger.info('   汇报任务端点：%s', endpointUrl(cfg.maaReportStatusPath))
        logger.info('  （令牌 %s，重启不会变）', String(cfg.maaToken ?? '').trim() ? '来自配置' : `已写到 ${controlFile}`)
      }
    }, 2500)
  })
}
