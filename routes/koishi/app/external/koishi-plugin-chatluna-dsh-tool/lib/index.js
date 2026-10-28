/**
 * koishi-plugin-chatluna-dsh-tool —— 把 DeepSeek Harness 变成 ChatLuna 的一只手。
 *
 * ── 为什么要有这个插件（2026-10-27 第二十二轮）──────────────────────────────
 * 原来的形态是二选一：
 *   A. 私聊全交给 DSH（dsh-connector 的 naturalLanguagePrivate）→ 私聊里 ChatLuna 那条链
 *      **完全不参与**，情绪 / 好感 / 长期记忆 / 情景记忆 / 表情包 / proactive / 人设 全停；
 *   B. 私聊留给 ChatLuna → DSH 只在人敲 `/dsh.*` 时才用，模型自己伸不了手。
 * 用户要的是第三种：**ChatLuna 当脑子（保留全部功能），DSH 当工具**。
 * 模型自己决定"这事得让 DSH 去干" → 调本插件的工具 → 只拿回结果。
 *
 * ── 为什么走 ingress 而不是 dsh-connector ───────────────────────────────────
 * `koishi-plugin-dsh-connector` 只注册 Koishi 指令（人敲的），**没有 service、没有
 * ChatLuna 工具**，模型调不动它（源码实测：只有 `ctx.command(...)`，没有 `ctx.provide`）。
 * 而 `dsh-astrbot-ingress` 的 `POST /inbound` 是**稳定的纯 HTTP + SSE** 契约：
 *   请求：{umo, text, senderId, chatType, files[]}
 *   事件：ack / text / status / file / error / done
 * 于是：本地（无）、市场（4818 条里没有 DSH×ChatLuna 的桥）都查过之后，自己写这一层。
 * 完整决策记录见 `docs/39-DSH当工具.md`。
 *
 * ── 省 token 的两个抓手（用户明确要求）─────────────────────────────────────
 * 1. **默认续用旧会话**：同一个 QQ 聊天固定映射成一个 umo，ingress 把 umo→sessionId
 *    持久化在 `~/.dsh/dsh-astrbot-ingress/sessions.json`。所以模型在同一个群里连着派活，
 *    DSH 那边是**同一个会话**，不用每次重读项目目录和文档。
 * 2. **`dsh_status` 会报上下文占用**（ingress 的 `status` 指令本来就给百分比/已用/上限），
 *    模型可以据此决定 `dsh_compact` 压一下，或者干脆 `mode: 'new'` 开新的。
 *
 * ── 返回给模型的文本为什么要截断 ──────────────────────────────────────────
 * 工具返回值会**原样进入 ChatLuna 的上下文**，而 ChatLuna 这边也是按 token 计费的。
 * DSH 一轮的输出可能上万字，全塞回去等于把省下来的又花掉。所以默认截到
 * `maxReturnChars`，并明确告诉模型"被截断了、要细节就自己再问"。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { Schema } = require('koishi')

const name = 'chatluna-dsh-tool'
const inject = { required: [], optional: ['chatluna'] }

const logger = (ctx) => ctx.logger('chatluna-dsh-tool')

const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('**启用**<br>关掉后模型完全看不到这几个工具'),

  ingressUrl: Schema.string()
    .default('')
    .description('**ingress 地址**<br>留空读同机信标 `~/.dsh/astrbot-ingress.json`'),
  token: Schema.string()
    .role('secret')
    .default('')
    .description('**ingress token**<br>留空读同机信标；信标由 ingress 每 30 秒刷新'),

  timeoutSec: Schema.natural()
    .min(30)
    .max(3600)
    .default(900)
    .description(
      '**单轮硬上限**<br>单位秒。超过就放弃这一轮（DSH 仍在跑，可用 dsh_last 捞）。' +
        '默认 900，因为实测重任务能跑 5 分钟以上'
    ),

  syncWaitSec: Schema.natural()
    .min(5)
    .max(600)
    .default(60)
    .description(
      '**同步等多久就转后台**<br>单位秒。短时间内完成就同步把结果交给模型转述；' +
        '超过就立即告诉模型"还在跑"，DSH 跑完由插件直接把结果发给用户。' +
        '**这个值决定用户最多干等多久**'
    ),

  privateEnabled: Schema.boolean()
    .default(true)
    .description('**私聊可用**<br>私聊里把工具给模型'),
  groups: Schema.array(Schema.string())
    .role('table')
    .default([])
    .description('**群白名单**<br>哪些群允许模型调 DSH；留空 = 群聊一律不给（防止在群里乱花钱）'),

  maxReturnChars: Schema.natural()
    .min(200)
    .max(20000)
    .default(3000)
    .description('**回传上限**<br>塞回 ChatLuna 上下文的字符数上限，超了截断'),

  ackEnabled: Schema.boolean()
    .default(true)
    .description('**先回执一句**<br>派活前立刻发一句，避免用户干等几分钟以为没收到'),
  ackText: Schema.string()
    .default('我让 DSH 去查了，出结果了回复你')
    .description(
      '**兜底回执文案**<br>正常由模型自己写（`dsh_run` 的 `ack` 参数），' +
        '只有模型没给 `ack` 时才用这句。`{task}` 会被替换成任务前 30 字'
    ),
  maxDirectChars: Schema.natural()
    .min(200)
    .max(20000)
    .default(3500)
    .description('**后台直发的上限**<br>只有 backgroundMode=raw 时才用：原文直发时的字符上限'),

  backgroundMode: Schema.union([
    Schema.const('notice').description('只发一句提示，原文留在插件缓存里等模型用 dsh_last 取（推荐）'),
    Schema.const('raw').description('兼容旧行为：把 DSH 原文直发到群里（调试用，会让群里看到未经人格加工的长文）'),
  ])
    .default('notice')
    .description(
      '**后台跑完怎么发**<br>长任务转后台后，完成时要么只发一句提示（notice，默认），' +
        '要么照旧把原文直发（raw，不推荐）'
    ),
  backgroundNotice: Schema.string()
    .default('跑完了，想看结果跟我说一声。')
    .description('**后台完成提示文案**<br>backgroundMode=notice 时发给群里的那一句话'),

  maxContinueRounds: Schema.natural()
    .min(1)
    .max(8)
    .default(3)
    .description('**dsh_continue 单次最多推几轮**<br>防止模型一次调用里无限自我推进'),
  includeStatus: Schema.boolean()
    .default(false)
    .description('**附带过程行**<br>把 ingress 的 status（进度摘要）也回给模型，通常没必要'),

  debug: Schema.boolean().default(false).description('**调试**<br>打印每个 SSE 事件'),
})

// ──────────────────────────────────────────────────────────── 信标与目标解析

/** 读 ingress 写的同机信标；读不到返回 null */
function readBeacon() {
  const file = path.join(os.homedir(), '.dsh', 'astrbot-ingress.json')
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!json || !json.url || !json.token) return null
    return { url: String(json.url).replace(/\/+$/, ''), token: String(json.token) }
  } catch {
    return null
  }
}

/**
 * 读 ingress 的 umo → 会话绑定表。读不到返回 null。
 * 这是**跨聊天看全局**的唯一来源：ingress 没有"列会话"的 HTTP 端点，
 * 但每轮都会把这个表落到 `~/.dsh/dsh-astrbot-ingress/sessions.json`。
 */
function readSessionsFile() {
  const file = path.join(os.homedir(), '.dsh', 'dsh-astrbot-ingress', 'sessions.json')
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'))
    return json && typeof json === 'object' ? json : null
  } catch {
    return null
  }
}

function resolveTarget(config) {  const beacon = readBeacon()
  const url = (config.ingressUrl || beacon?.url || '').replace(/\/+$/, '')
  const token = config.token || beacon?.token || ''
  if (!url || !token) {
    return {
      error:
        'DSH 桥没拿到地址或 token。同机部署请确认 DSH 里启用了 `dsh-astrbot-ingress`' +
        '（它会写 `~/.dsh/astrbot-ingress.json`），本插件配置留空即可。',
    }
  }
  return { url, token }
}

/** 这个聊天对应的 DSH 会话键。同一个群/同一个人固定同一个 umo → ingress 那边就复用同一条会话 */
function umoOf(session) {
  if (session.guildId) return `koishi:group:${session.guildId}`
  return `koishi:private:${session.userId}`
}

// ──────────────────────────────────────────────────────────── HTTP + SSE

/**
 * 调 `POST /inbound`，把 SSE 流读完。
 * @returns {Promise<{ok:boolean, text:string, statuses:string[], files:any[], error?:string, sessionId?:string}>}
 */
async function callInbound({ url, token, body, timeoutMs, onEvent }) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs)

  let res
  try {
    res = await fetch(`${url}/inbound`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    })
  } catch (e) {
    clearTimeout(timer)
    const msg = e?.message === 'timeout' ? `等待 DSH 超时（${Math.round(timeoutMs / 1000)} 秒）` : `连不上 DSH：${e?.message ?? e}`
    return { ok: false, text: '', statuses: [], files: [], error: msg }
  }

  if (!res.ok) {
    clearTimeout(timer)
    return { ok: false, text: '', statuses: [], files: [], error: `DSH 返回 HTTP ${res.status}` }
  }

  const texts = []
  const statuses = []
  const files = []
  let error
  let sessionId

  const decoder = new TextDecoder('utf-8')
  let buf = ''

  /** 处理一个 SSE 块（event: X\ndata: {...}） */
  const handleBlock = (block) => {
    let event = 'message'
    const dataLines = []
    for (const rawLine of block.split('\n')) {
      const line = rawLine.replace(/\r$/, '')
      if (!line || line.startsWith(':')) continue
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
    }
    if (!dataLines.length) return
    let data
    try {
      data = JSON.parse(dataLines.join('\n'))
    } catch {
      return
    }
    onEvent?.(event, data)
    switch (event) {
      case 'text':
        if (data?.text) texts.push(String(data.text))
        break
      case 'status':
        if (data?.text) statuses.push(String(data.text))
        break
      case 'file':
        files.push(data)
        break
      case 'error':
        error = String(data?.message ?? data?.error ?? '未知错误')
        break
      case 'ack':
        if (data?.sessionId) sessionId = data.sessionId
        break
      case 'done':
        if (data?.sessionId) sessionId = data.sessionId
        break
    }
  }

  try {
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true })
      let idx
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        handleBlock(block)
      }
    }
    if (buf.trim()) handleBlock(buf)
  } catch (e) {
    const msg = e?.name === 'AbortError' || e?.message === 'timeout'
      ? `等待 DSH 超时（${Math.round(timeoutMs / 1000)} 秒）；任务可能仍在 DSH 里跑`
      : `读 DSH 流时出错：${e?.message ?? e}`
    return { ok: false, text: texts.join('\n'), statuses, files, error: msg, sessionId }
  } finally {
    clearTimeout(timer)
  }

  const text = texts.join('\n').trim()
  if (!text && !error) return { ok: false, text: '', statuses, files, error: 'DSH 这一轮没有返回任何正文', sessionId }
  return { ok: !error, text, statuses, files, error, sessionId }
}

async function getBinding({ url, token, umo }) {
  const res = await fetch(`${url}/binding?umo=${encodeURIComponent(umo)}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`/binding 返回 HTTP ${res.status}`)
  return res.json()
}

// ──────────────────────────────────────────────────────── 会话 / 工作区命令的解析
// ingress 只把结果当"给人看的文本"吐出来，所以这里把它的输出解析回结构化数据。
// 格式（dsh-astrbot-ingress 0.3.23 实测）：
//   ls     "1. 标题\n    `abcd1234`"
//   ws     "1. 标题 — `D:\path`"，首行 "当前 cwd：`...`"
//   switch "已切换工作区到 `D:\path`\n新会话 `abcd1234`。"

/** 解析 `/dsh ls` 的会话行 */
function parseSessionRows(text) {
  const rows = []
  const re = /(?:^|\n)\s*(\d+)\.\s*([^\n]*)\n\s*`([0-9a-f]{6,})`/g
  let m
  while ((m = re.exec(String(text ?? '')))) {
    rows.push({ n: Number(m[1]), title: (m[2] || '').trim() || '（无标题）', id: m[3] })
  }
  return rows
}

/** 解析 `/dsh ws` 的工作区列表 */
function parseWorkspaceList(text) {
  const s = String(text ?? '')
  const cwd = /当前 cwd：`([^`]+)`/.exec(s)?.[1] || ''
  const items = []
  const re = /(?:^|\n)\s*(\d+)\.\s*([^\n]*?)\s*—\s*`([^`]+)`/g
  let m
  while ((m = re.exec(s))) items.push({ n: Number(m[1]), title: (m[2] || '').trim(), path: m[3] })
  return { cwd, items }
}

/** 解析 `/dsh ws <目标>` 的回执 */
function parseWsSwitch(text) {
  const s = String(text ?? '')
  return {
    path: /已切换工作区到 `([^`]+)`/.exec(s)?.[1] || '',
    newId: /新会话 `([0-9a-f]{6,})`/.exec(s)?.[1] || '',
  }
}

/** sessionId → 绑定它的聊天（umo）。用来提醒模型"这条会话是别人在用的" */
function buildOwners() {
  const table = readSessionsFile() || {}
  const owners = new Map()
  for (const [umo, v] of Object.entries(table)) {
    const id = String(v?.sessionId || '')
    if (id) owners.set(id, umo)
  }
  return owners
}

function ownerOfShort(owners, shortId) {
  if (!shortId) return ''
  for (const [id, umo] of owners) if (id.includes(shortId)) return umo
  return ''
}

/** 把会话行渲染成给模型看的小列表 */
function renderRows(rows, owners, currentId) {
  const cur = String(currentId || '')
  return rows
    .map((row) => {
      const owner = ownerOfShort(owners, row.id)
      const here = cur && cur.includes(row.id) ? ' ← 当前' : ''
      const who = owner ? `（绑在 ${owner}）` : ''
      return `- ${row.n}. ${row.title} \`${row.id}\`${who}${here}`
    })
    .join('\n')
}

// ──────────────────────────────────────────────────────────── 插件主体

// ──────────────────────────────────── "打回继续"的判断（纯函数，放在模块级便于单测）

/** 命中这些特征 = 必须由真人决定（要权限/要密钥/要拍板），不该自己替用户定 */
const HUMAN_ASK = [
  /(?:请|需要|麻烦)(?:你|您|用户|人工|真人)[^。\n]{0,8}(?:确认|决定|拍板|授权|提供|输入|回复|选择|答复)/,
  // "请提供 API key / 请告诉我密码" 这种没有"你"字的也要算
  /(?:请|需要|麻烦)(?:你|您)?\s*(?:提供|输入|告知|告诉我)[^。\n]{0,12}(?:密钥|密码|口令|token|api[ _-]?key|账号|api)/i,
  /(?:需要|缺少|没有)(?:管理员)?(?:权限|授权|密钥|token|api[ _-]?key|账号|密码)/i,
  /(?:是否|要不要)(?:继续|执行|删除|覆盖|重启|清空)/,
  /等待(?:你|您|用户)(?:确认|回复|提供|授权)/,
]

/** @returns {string} 命中的片段；空串 = 不需要真人 */
function needsHuman(text) {
  const s = String(text ?? '')
  for (const re of HUMAN_ASK) {
    const m = re.exec(s)
    if (m) return m[0]
  }
  return ''
}

/** 最后一行是不是问句（DSH 常以"要不要我…？"结尾等人接话） */
function asksQuestion(text) {
  const lines = String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const last = lines.length ? lines[lines.length - 1] : ''
  return /[?？]\s*$/.test(last)
}

function apply(ctx, config) {
  const log = logger(ctx)
  if (!config.enabled) {
    log.info('已禁用')
    return
  }

  const cfg = config
  // 每个 umo 同时在跑的 dsh_run。ingress 的 /inbound 对**同一条会话**是"后来者把前一回合顶掉"
  // （旧 SSE 被写「被新消息打断」然后关掉），所以同一 umo 的 continue 必须串行，不然先派的活会丢结果。
  const inflight = new Map() // umo -> { t0, mode }
  const call = (body) => {
    const target = resolveTarget(cfg)
    // 解析失败时也要返回同形状的结果，调用方就不用到处判空
    if (target.error) {
      return Promise.resolve({ ok: false, text: '', statuses: [], files: [], error: target.error })
    }
    return callInbound({
      url: target.url,
      token: target.token,
      body,
      timeoutMs: cfg.timeoutSec * 1000,
      onEvent: cfg.debug ? (e, d) => log.debug('sse %s %o', e, d) : undefined,
    })
  }

  /** 把结果裁成能塞回 ChatLuna 上下文的形状 */
  const shape = (r, { extraStatus = false } = {}) => {
    if (!r.ok) {
      // 失败也要把已经说出来的部分带上：DSH 常常先干完一半才炸
      const partial = r.text ? `\n（DSH 已经说出来的部分：\n${clean(r.text)}\n）` : ''
      return `调用 DSH 失败：${r.error}${partial}`
    }
    let out = clean(r.text)
    const truncated = out.length > cfg.maxReturnChars
    if (truncated) out = out.slice(0, cfg.maxReturnChars)
    let tail = ''
    if (truncated) {
      tail += `\n\n（已截断到 ${cfg.maxReturnChars} 字。要更多细节就针对具体那一点再问一次，别整段重发。）`
    }
    if (r.files.length) tail += `\n（DSH 另外产出了 ${r.files.length} 个文件，需要的话让它直接发出来。）`
    if (extraStatus && r.statuses.length) tail += `\n（过程：${r.statuses.join(' / ')}）`
    return out + tail
  }

  /**
   * 去掉 ingress 给 IM 看的尾巴。`—— 本回合结束` 这类标记是给人看的，
   * 塞回模型上下文只会浪费 token，还会让模型以为那是正文的一部分。
   */
  const clean = (text) => {
    let s = String(text ?? '').trim()
    s = s.replace(/\n*——\s*本回合结束\s*$/u, '')
    return s.trim()
  }

  /** 直发给用户看的结果（不经过模型），比回给模型的宽松一点 */
  const direct = (r) => {
    let out = clean(r.text)
    if (!out) return '那件事跑完了，但 DSH 没留下正文（可能中途被停）。'
    if (out.length > cfg.maxDirectChars) {
      out = `${out.slice(0, cfg.maxDirectChars)}\n\n（后面还有 ${out.length - cfg.maxDirectChars} 字没发完，要完整版就让它再贴一次）`
    }
    if (r.files?.length) out += `\n（另外产出 ${r.files.length} 个文件，要的话让它直接发出来）`
    return out
  }

  /** 回执文案：模型没给 `ack` 时的兜底 */
  const ackText = (task) => {
    const base = String(cfg.ackText ?? '').trim() || '我让 DSH 去查了，出结果了回复你'
    return base.replace(/\{task\}/g, String(task ?? '').replace(/\s+/g, ' ').slice(0, 30))
  }

  /** 超时哨兵：`Promise.race` 用它区分"真的返回了"和"到点了" */
  const WAIT_EXPIRED = Symbol('wait-expired')

  // ─────────────────────────────── 后台结果缓存 + 后台收尾（2026-10-27）
  // 背景：转后台的任务以前跑完会把 DSH 原文（上千字技术报告）直接 send 进群，
  //       AI 角色完全没参与，群里体验很差。现在的约定是：
  //         · 转后台的完整输出只进插件内存缓存（bgCache），不往群里贴；
  //         · 群里只收到一句提示（cfg.backgroundNotice）；
  //         · 模型要结果时用 dsh_last 从缓存里取全文，再用它自己的语气总结。
  // 缓存结构：umo -> { text(完整输出), ok, error, files(数量), at(时间戳) }
  const bgCache = new Map()
  const BG_CACHE_MAX = 50

  const rememberBg = (umo, r) => {
    bgCache.set(umo, {
      text: clean(r.text),
      ok: !!r.ok,
      error: r.error,
      files: Array.isArray(r.files) ? r.files.length : 0,
      at: Date.now(),
    })
    // 简单上限：只留最近 50 条，避免长跑把内存堆满
    while (bgCache.size > BG_CACHE_MAX) bgCache.delete(bgCache.keys().next().value)
  }

  /** 转后台完成时发给群里的那句话（notice 模式**不带任何原文**） */
  const bgNotice = (r) => {
    const base = String(cfg.backgroundNotice ?? '').trim() || '跑完了，想看结果跟我说一声。'
    return r.ok ? base : `${base}（不过这一轮没跑完，可以让我接着弄）`
  }

  /**
   * 后台收尾：缓存全文 + 只发一句提示。
   * `backgroundMode=raw` 只是为了留个逃生口（默认关，开了会在日志里告警）。
   */
  const finishBackground = async (session, umo, r) => {
    rememberBg(umo, r)
    let body
    if (cfg.backgroundMode === 'raw') {
      log.warn('backgroundMode=raw：把 DSH 原文直发到会话（不推荐，会绕过人格）')
      body = r.ok
        ? direct(r)
        : `⚠️ 那件事没跑完：${r.error}` +
          (r.text ? `\n\n已经出来的部分：\n${clean(r.text)}` : '') +
          '\n\n（DSH 那边可能还在跑，过一会儿让它 dsh_last 捞一下）'
    } else {
      body = bgNotice(r)
    }
    try {
      await session.send(body)
    } catch (e) {
      // 发不出去也要留证据：全文已进 bgCache 和 DSH 会话，用户追问还能捞回来
      log.warn('后台提示发送失败（结果仍在缓存与 DSH 会话里）：%s', e?.message ?? e)
    }
  }

  /**
   * 在**同一条 DSH 会话**上推进一轮（dsh_continue 用）。
   * 快慢两路与 dsh_run 一致：waitSec 内跑完直接把结果交给模型；跑不完转后台，
   * 但后台收尾走 finishBackground —— 只发提示、全文进缓存，不回群里贴原文。
   * @returns {Promise<{kind:'done', r:object} | {kind:'bg'} | {kind:'busy', ago:number}>}
   */
  const advanceOnce = async ({ session, umo, text, t0, waitSec }) => {
    const busy = inflight.get(umo)
    if (busy) return { kind: 'busy', ago: Math.max(1, Math.round((Date.now() - busy.t0) / 1000)) }

    inflight.set(umo, { t0, mode: 'continue' })
    const job = call({
      umo,
      text,
      senderId: String(session.userId ?? ''),
      chatType: session.guildId ? 'group' : 'private',
    })
    const quick = await Promise.race([
      job,
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(WAIT_EXPIRED), waitSec * 1000)
        timer.unref?.()
      }),
    ])

    if (quick !== WAIT_EXPIRED) {
      inflight.delete(umo)
      // 这一轮已经有更新的输出了，旧的后台缓存不能再冒充"最近一轮"
      bgCache.delete(umo)
      return { kind: 'done', r: quick }
    }

    log.info('dsh_continue 转后台（超过 %d 秒）：%s', waitSec, umo)
    job
      .then(async (r) => {
        inflight.delete(umo)
        log.info(
          'dsh_continue 后台完成：%s / %d ms / 回 %d 字%s',
          r.ok ? 'ok' : 'fail',
          Date.now() - t0,
          r.text.length,
          r.error ? `（${r.error}）` : ''
        )
        await finishBackground(session, umo, r)
      })
      .catch((e) => {
        inflight.delete(umo)
        log.warn('dsh_continue 后台异常：%s', e?.message ?? e)
      })
    return { kind: 'bg' }
  }

  ctx.inject(['chatluna'], (ctx2) => {
    const platform = ctx2.chatluna?.platform
    if (!platform || typeof platform.registerTool !== 'function') {
      log.warn('platform.registerTool 不可用，DSH 工具未注册')
      return
    }

    let toolFactory
    try {
      toolFactory = require('@langchain/core/tools').tool
    } catch (e) {
      log.warn('拿不到 @langchain/core/tools，DSH 工具未注册：%s', e.message)
      return
    }
    const z = require('zod')

    /** 只在配置允许的会话里把工具给模型 */
    const selector = (session) => {
      if (!session) return false
      if (session.guildId) return cfg.groups.map(String).includes(String(session.guildId))
      return cfg.privateEnabled
    }

    // ── ① dsh_run：派活
    const runDesc =
      '把一件**需要动真格**的事交给 DeepSeek Harness（DSH）去执行，拿回结果。' +
      'DSH 有自己的工作区、能读写文件、跑命令、装插件、派子 agent——这些你自己做不到。' +
      '什么时候用：改代码、查项目资料、跑脚本、批量处理文件、需要看真实文件内容的调研。' +
      '什么时候**不要**用：闲聊、安慰人、单纯的知识问答、发图发文件——那些你自己就能做，' +
      '调它反而慢而且贵。' +
      '它和你不是同一个人：它没有你的语气、情绪、好感度，也不知道你们聊过什么，' +
      '所以要把任务说得自包含，别写"就刚才那个"。' +
      '\n\n**【先选工作区，再选会话】** DSH 的会话挂在**工作区**（= 项目根目录）下面，' +
      '一个工作区可以有好几条会话。顺序是：' +
      '\n① 这活属于**另一个项目** → 先 `dsh_ws(action=switch, path=项目路径)`。' +
      '切过去会开一条新会话，并在返回里列出那个项目已有的会话；要接着以前的活就 `dsh_use` 切过去。' +
      '**绝对不要**在 A 项目的工作区里改 B 项目的文件。' +
      '\n② 属于**当前工作区** → 默认 mode=continue，接着这条会话说。它记得之前几轮，' +
      '不用重复交代背景、也不用报告路径——这是最省的做法，优先用它。' +
      '\n③ 只有"上下文快满了"或者"跟这条会话正在干的事完全无关"才 mode=new（同工作区另起一条）。' +
      '新建的会话要重新读项目目录和 AGENTS.md，明显更慢更贵。' +
      '\n看现状：`dsh_status` = 当前工作区/会话/上下文占用；`dsh_sessions` = 本工作区有哪些会话。' +
      '\n\n**【长任务怎么走】** 60 秒内跑完就直接把结果给你；跑不完会立即告诉你"已转后台"。' +
      '**后台跑完插件只发一句提示，不会把原文贴到群里**。所以转后台之后别猜结果、别复述，' +
      '简短交代一句就行；用户问结果（或你想主动汇报）就调 dsh_last 取完整输出，' +
      '再用你自己的语气总结给他。' +
      '\n\n**【不满意就接着推】** 拿到结果后要它改、要它查、或者回答它反问的问题，' +
      '用 dsh_continue 把话送回**同一条** DSH 会话，可以在一次调用里连续推几轮；' +
      '只有必须真人拍板（权限、密钥账号、选方案、删东西）时才停下来问用户。'

    platform.registerTool('dsh_run', {
      selector,
      description: runDesc,
      createTool: () =>
        toolFactory(
          async (input, runnableConfig) => {
            const session = runnableConfig?.configurable?.session
            if (!session) return '拿不到当前会话，没法确定交给哪个 DSH 会话。请用文字回复。'

            const task = String(input?.task ?? '').trim()
            if (!task) return '任务内容为空，没有派活。'

            const mode = input?.mode === 'new' ? 'new' : 'continue'
            const umo = umoOf(session)
            const senderId = String(session.userId ?? '')
            const chatType = session.guildId ? 'group' : 'private'
            const t0 = Date.now()

            log.info(
              'dsh_run 被模型调用：mode=%s / %d 字 / %s',
              mode,
              task.length,
              session.channelId ?? session.userId ?? '?'
            )

            // ★ 同一条会话不许并发（2026-10-27 实测的"累计几个任务后回复失效"）。
            //   ingress 的 /inbound 对同一 sessionId 是"后来者顶掉前一回合"：新的 POST 会把旧
            //   SSE flush + 写「被新消息打断」+ done，然后关掉它。于是先派的那件活拿不到正文，
            //   插件只能回报"DSH 这一轮没有返回任何正文"，用户看到的就是"没回复"。
            //   mode=new 换了一条会话（sessionId 不同），旧会话继续跑，所以不受这条限制。
            const busy = inflight.get(umo)
            if (busy && mode === 'continue') {
              const ago = Math.max(1, Math.round((Date.now() - busy.t0) / 1000))
              log.info('dsh_run 撞上正在跑的回合（%d 秒），拒绝重复派活：%s', ago, umo)
              return (
                `这条会话上一件还在跑（已经 ${ago} 秒），现在再派会把它顶掉、那件活的结果就丢了。` +
                `你可以：① 等它跑完再派；② 这是另一件不相干的事 → 用 mode=new 另起一条会话；` +
                `③ 这是另一个项目的活 → 先 dsh_ws 切过去（不同工作区互不打断）。` +
                `真要打断它，先跟用户确认。`
              )
            }

            // ★ 回执：DSH 一轮动辄几十秒到几分钟，用户看不到任何动静会以为没收到。
            //   **文案由模型自己写**（`ack` 参数），因为固定一句"我让 DSH 去查了"太像机器
            //   自动回复，跟大肥鱼的语气对不上。插件只负责原样发出去——不经过模型后处理，
            //   所以不会被人格/美化链路改写，也不额外花一次模型调用。
            //   模型没给 `ack` 时退回配置里的兜底文案。
            //   发送失败（风控/限流）不能挡住正事，所以只记日志。
            if (cfg.ackEnabled) {
              const said = String(input?.ack ?? '').trim() || ackText(task)
              try {
                await session.send(said)
              } catch (e) {
                log.warn('回执发送失败（不影响派活）：%s', e?.message ?? e)
              }
            }

            try {
              if (mode === 'new') {
                // ingress 的桥指令是**裸命令**（不带 /dsh 前缀）：`/^new$/i` → 只建新会话、不跑模型
                const reset = await call({ umo, text: 'new', senderId, chatType })
                if (!reset.ok) log.warn('新建会话失败：%s', reset.error)
              }

              // ★ 快慢两路：`syncWaitSec` 内跑完就同步返回（模型能接着结果说话）；
              //   跑不完就转后台，由插件自己 send——这样**长任务不会再卡死整轮对话**。
              //
              //   为什么必须这么做（2026-10-27 实测）：群里几个重任务每轮要 255~287 秒，
              //   而原来 timeoutSec=300，于是 22:08 / 22:16 / 22:28 连着三次撞超时，
              //   用户看到的是"回了句我让 DSH 去查了，然后五分钟没动静，最后来一句不相干的闲聊"。
              //   超时那几轮其实 DSH 都干完了 —— 白干。
              inflight.set(umo, { t0, mode })
              // 新一轮开始时清掉上一次的后台缓存：dsh_last 只该拿到"最近这一轮"的结果
              bgCache.delete(umo)
              const job = call({ umo, text: task, senderId, chatType })

              const quick = await Promise.race([
                job,
                new Promise((resolve) => {
                  const timer = setTimeout(() => resolve(WAIT_EXPIRED), cfg.syncWaitSec * 1000)
                  timer.unref?.()
                }),
              ])

              if (quick !== WAIT_EXPIRED) {
                inflight.delete(umo)
                log.info(
                  'dsh_run 同步完成：%s / %d ms / 回 %d 字%s',
                  quick.ok ? 'ok' : 'fail',
                  Date.now() - t0,
                  quick.text.length,
                  quick.error ? `（${quick.error}）` : ''
                )
                return shape(quick, { extraStatus: cfg.includeStatus })
              }

              // ── 转后台
              log.info('dsh_run 转后台（超过 %d 秒）：%s', cfg.syncWaitSec, umo)
              job
                .then(async (r) => {
                  inflight.delete(umo)
                  log.info(
                    'dsh_run 后台完成：%s / %d ms / 回 %d 字%s',
                    r.ok ? 'ok' : 'fail',
                    Date.now() - t0,
                    r.text.length,
                    r.error ? `（${r.error}）` : ''
                  )
                  // ★ 2026-10-27 改动：以前这里是 `session.send(direct(r))`，把 DSH 原文
                  //   （最多 maxDirectChars 字的技术报告）直接甩进群。现在改成：
                  //   全文进 bgCache，群里只发一句提示，等模型用 dsh_last 取回去自己总结。
                  await finishBackground(session, umo, r)
                })
                .catch((e) => {
                  inflight.delete(umo)
                  log.warn('dsh_run 后台异常：%s', e?.message ?? e)
                })

              return (
                `已派活，DSH 跑得比 ${cfg.syncWaitSec} 秒久，已转后台。` +
                `插件跑完只会发一句提示、**不会把原文贴出来**，完整结果留在插件缓存里。` +
                `所以你现在：① 不要猜结果、不要复述结论；` +
                `② 用一两句说清你派了什么、大概要多久；` +
                `③ 用户问结果或进度，就调 dsh_last 取完整输出，再用你自己的语气讲给他。`
              )
            } catch (e) {
              inflight.delete(umo)
              log.warn('dsh_run 异常：%s', e?.message ?? e)
              return `派活时出错（${e?.message ?? e}）。可以用文字先回，别重试同一条。`
            }
          },
          {
            name: 'dsh_run',
            description: runDesc,
            schema: z.object({
              task: z
                .string()
                .describe(
                  '交给 DSH 的完整任务描述。要自包含：它看不到你们刚才的聊天。' +
                    '写清要动哪个目录/文件、期望产出什么。'
                ),
              ack: z
                .string()
                .max(200)
                .describe(
                  '**马上要发给用户的那句话**（20~60 字）。它会**原样**发出去，' +
                    '不经过你的后处理——所以要有你自己的语气，像"我去翻一遍那几个插件目录，等我一下🐋"。' +
                    '说清你派了什么活、大概多久；**不要**在这里报结论（那时还没有结论）。'
                ),
              mode: z
                .enum(['continue', 'new'])
                .optional()
                .describe(
                  'continue（默认）= 接着这个聊天现有的 DSH 会话干，它记得前几轮，省 token；' +
                    'new = 另起一条干净会话（**话题完全无关**或上下文快满了才用，代价是要重读项目）'
                ),
            }),
          }
        ),
    })

    // ── ② dsh_status：这条会话在做什么 + 上下文占用
    const statusDesc =
      '查**这个聊天**在 DSH 那边那条会话的状态：标题（它现在在忙什么）、工作区、' +
      '上下文用了多少、累计花了多少 token，以及**最近一轮的结论摘要**。' +
      '什么时候用：① 拿不准该 continue 还是 new 之前；② 用户问"它在干嘛/跑到哪了"；' +
      '③ 打算派一个很长的活，先看上下文够不够（快满了就先 dsh_compact）。' +
      '想看**别的**聊天那条会话，用 dsh_sessions。'

    platform.registerTool('dsh_status', {
      selector,
      description: statusDesc,
      createTool: () =>
        toolFactory(
          async (_input, runnableConfig) => {
            const session = runnableConfig?.configurable?.session
            if (!session) return '拿不到当前会话。'
            const target = resolveTarget(cfg)
            if (target.error) return target.error
            const umo = umoOf(session)
            const senderId = String(session.userId ?? '')
            const chatType = session.guildId ? 'group' : 'private'

            try {
              const binding = await getBinding({ ...target, umo })
              if (!binding?.bound) {
                return (
                  '这个聊天还没绑定 DSH 会话——第一次 dsh_run 会自动新建一条。' +
                  '也就是说现在没有"旧会话"可接，直接用 dsh_run 派活就是最省的做法。'
                )
              }

              const [st, last] = await Promise.all([
                call({ umo, text: 'status', senderId, chatType }),
                // 捞最近一轮的结论：光看标题不够，模型要判断"新旧任务有没有关系"
                call({ umo, text: 'last 1', senderId, chatType }).catch(() => null),
              ])

              const parts = []
              if (st.ok && st.text) parts.push(st.text)
              else parts.push(`已绑定会话 ${binding.sessionId}（工作区 ${binding.cwd || '未知'}）；查上下文占用失败：${st.error}`)

              if (inflight.has(umo)) {
                parts.push('\n（这条会话此刻有回合在跑——别再在同一会话上派 continue，会把它顶掉。）')
              }

              if (last?.ok && last.text) {
                const brief = clean(last.text).replace(/\s+/g, ' ').slice(0, 300)
                if (brief) parts.push(`\n最近一轮的结论（前 300 字）：\n${brief}`)
              }
              return parts.join('\n')
            } catch (e) {
              return `查 DSH 状态失败（${e?.message ?? e}）。`
            }
          },
          { name: 'dsh_status', description: statusDesc, schema: z.object({}) }
        ),
    })

    // ── ③ dsh_last：捞最近几轮的输出（后台结果的主要取回口）
    const lastDesc =
      '把 DSH 这条会话**最近 N 轮**（1~3，默认 1）的完整输出捞回来。' +
      '什么时候用：① dsh_run 转后台了，用户问"结果呢"——**后台结果就在插件缓存里，先查这里**；' +
      '② 之前那轮超时了，但 DSH 其实干完了；③ 你只记得大概方向、需要原文细节。' +
      '它**不会**让 DSH 重新干活，只是把已经产生的输出读出来，所以又快又便宜。' +
      '**拿到之后用你自己的语气总结给用户**，别把原文照搬。'

    platform.registerTool('dsh_last', {
      selector,
      description: lastDesc,
      createTool: () =>
        toolFactory(
          async (input, runnableConfig) => {
            const session = runnableConfig?.configurable?.session
            if (!session) return '拿不到当前会话。'
            const target = resolveTarget(cfg)
            if (target.error) return target.error
            const umo = umoOf(session)
            const n = Math.min(3, Math.max(1, Number(input?.turns) || 1))

            // ★ 2026-10-27：转后台那一轮的完整输出就在 bgCache 里，优先读它 ——
            //   比再打一次 ingress 快，也不会被后续回合覆盖。缓存只代表"最近一轮"，
            //   所以要看 2~3 轮时仍然走 ingress。
            const cached = n === 1 ? bgCache.get(umo) : null
            if (cached) {
              const age = Math.max(1, Math.round((Date.now() - cached.at) / 1000))
              const body = shape({
                ok: cached.ok,
                text: cached.text,
                statuses: [],
                files: [],
                error: cached.error,
              })
              return body + `\n\n（来自后台缓存，${age} 秒前；完整结果已在插件里，不用重跑）`
            }

            try {
              const r = await call({
                umo,
                text: `last ${n}`,
                senderId: String(session.userId ?? ''),
                chatType: session.guildId ? 'group' : 'private',
              })
              if (!r.ok) return `捞取失败：${r.error}`
              const hint = r.statuses.length ? `（${r.statuses.join(' / ')}）\n` : ''
              return hint + shape(r, { extraStatus: false })
            } catch (e) {
              return `捞取失败（${e?.message ?? e}）。`
            }
          },
          {
            name: 'dsh_last',
            description: lastDesc,
            schema: z.object({
              turns: z
                .number()
                .int()
                .min(1)
                .max(3)
                .optional()
                .describe('要几轮，默认 1。多看几轮能看清上下文，但会占 token'),
            }),
          }
        ),
    })

    // ── ③-b dsh_continue：把一句话送回同一条会话继续干（"打回继续"）
    const continueDesc =
      '把一句话送回**同一条 DSH 会话**继续跑：不满意就让它接着改/查，或者回答它反问的问题。' +
      '什么时候用：① 你拿到 dsh_run / dsh_last 的结果，觉得没写全、方向不对、要它再改；' +
      '② DSH 在输出里反问你（要方案、要确认、要密钥），你把用户的回答送回去；' +
      '③ 想一次推进多轮 —— 把后续几句按顺序放进 rounds（前面的问了/要真人决定就提前停）。' +
      '\n**什么时候必须停**：要权限、要密钥/账号、要删东西、要拍板方案 —— 这些别替用户决定，' +
      '停下来把问题转给他。插件也会在输出像"等你确认/需要提供密钥"时提醒你停。' +
      '\n它不另起会话，就是接着同一会话说下一句；如果某一轮超过等待时间会转后台，' +
      '结果留在缓存里，用 dsh_last 取。'

    platform.registerTool('dsh_continue', {
      selector,
      description: continueDesc,
      createTool: () =>
        toolFactory(
          async (input, runnableConfig) => {
            const session = runnableConfig?.configurable?.session
            if (!session) return '拿不到当前会话。'
            const target = resolveTarget(cfg)
            if (target.error) return target.error

            const first = String(input?.text ?? '').trim()
            if (!first) return '要继续就得给一句话（text 不能为空），比如"第 3 点再展开"或"用方案 B 重做"。'

            const followUps = Array.isArray(input?.rounds)
              ? input.rounds.map((s) => String(s ?? '').trim()).filter(Boolean)
              : []
            // 单次最多推 cfg.maxContinueRounds 轮，防止模型在一次调用里无限自我推进
            const cap = Math.min(8, Math.max(1, Number(cfg.maxContinueRounds) || 3))
            const steps = [first, ...followUps].slice(0, cap)
            const waitSec = Math.max(1, Math.min(600, Number(input?.waitSec) || cfg.syncWaitSec))
            const stopOnQuestion = input?.stopOnQuestion !== false
            const umo = umoOf(session)
            const t0 = Date.now()
            const parts = []

            for (let i = 0; i < steps.length; i++) {
              log.info('dsh_continue 第 %d/%d 轮：%d 字 / %s', i + 1, steps.length, steps[i].length, umo)
              let out
              try {
                out = await advanceOnce({ session, umo, text: steps[i], t0, waitSec })
              } catch (e) {
                return `继续时出错（${e?.message ?? e}）。`
              }

              if (out.kind === 'busy') {
                return `这条 DSH 会话还在跑（已经 ${out.ago} 秒），等它跑完再继续。`
              }
              if (out.kind === 'bg') {
                return (
                  `这一轮超过 ${waitSec} 秒，已转后台（插件跑完只发一句提示，不会贴原文）。` +
                  `结果留在缓存里；用户问或你要汇报时用 dsh_last 取。`
                )
              }

              const r = out.r
              parts.push(`【第 ${i + 1} 轮】\n${r.ok ? clean(r.text) : `失败：${r.error}`}`)
              if (!r.ok) break

              // 出现"必须真人决定"的信号 → 停下来交给用户，别自己替他拍板
              const human = needsHuman(r.text)
              if (human) {
                parts.push(`⏸ 这一轮 DSH 像是在等真人决定（命中"${human}"）。把问题转给用户，别替他拍板。`)
                break
              }
              if (stopOnQuestion && asksQuestion(r.text)) {
                parts.push('⏸ DSH 这一轮以问句结尾，可能在等下一句话。需要用户拍板就先问他，别硬推。')
                break
              }
            }

            // 复用 shape()：统一截到 maxReturnChars，并带上"被截断"的提示
            return shape({ ok: true, text: parts.join('\n\n'), statuses: [], files: [] })
          },
          {
            name: 'dsh_continue',
            description: continueDesc,
            schema: z.object({
              text: z
                .string()
                .describe('这一轮要送回去的话：回答它的问题，或提出新要求（要自包含，别写"就刚才那个"）'),
              rounds: z
                .array(z.string())
                .max(5)
                .optional()
                .describe('后续还要追着说的话，按顺序一次发完（前面以问句结尾/要真人决定时会提前停）'),
              waitSec: z
                .number()
                .int()
                .min(10)
                .max(600)
                .optional()
                .describe('单轮最多等多少秒，默认用插件配置的 syncWaitSec；超了就转后台'),
              stopOnQuestion: z
                .boolean()
                .optional()
                .describe('DSH 以问句结尾时是否停下（默认 true）。只有确定它已经干完、你要连推时才设 false'),
            }),
          }
        ),
    })

    // ── ④ dsh_sessions：本工作区有哪些会话（各自绑在哪个聊天）
    const sessionsDesc =
      '列出**当前工作区**（= 当前项目目录）里的所有 DSH 会话：序号、标题、短 id，' +
      '以及这条会话是不是正被**别的聊天**用着（标了「绑在 koishi:group:xxx」的别去动）。' +
      '用它来回答"这个项目我之前干过什么"，续旧活、别重复读项目。' +
      '当前这条会标「← 当前」。要接着某条旧会话干就用 dsh_use 切过去；换项目用 dsh_ws。'

    platform.registerTool('dsh_sessions', {
      selector,
      description: sessionsDesc,
      createTool: () =>
        toolFactory(
          async (_input, runnableConfig) => {
            const session = runnableConfig?.configurable?.session
            if (!session) return '拿不到当前会话。'
            const target = resolveTarget(cfg)
            if (target.error) return target.error
            const umo = umoOf(session)
            const base = { umo, senderId: String(session.userId ?? ''), chatType: session.guildId ? 'group' : 'private' }
            try {
              const [binding, r] = await Promise.all([
                getBinding({ ...target, umo }).catch(() => null),
                call({ ...base, text: 'ls' }),
              ])
              if (!r.ok) return `列会话失败：${r.error}`
              const rows = parseSessionRows(r.text)
              const cwd = binding?.cwd || '未知'
              if (!rows.length) return `当前工作区 \`${cwd}\` 还没有会话。第一次 dsh_run 会新建一条。`
              return (
                `当前工作区：\`${cwd}\`\n` +
                `这个工作区里的会话（共 ${rows.length} 条，序号可以直接给 dsh_use）：\n` +
                renderRows(rows, buildOwners(), binding?.sessionId)
              )
            } catch (e) {
              return `列会话失败（${e?.message ?? e}）。`
            }
          },
          { name: 'dsh_sessions', description: sessionsDesc, schema: z.object({}) }
        ),
    })

    // ── ⑤ dsh_ws：工作区（= 项目目录）管理
    const wsDesc =
      '管理 **DSH 工作区**。工作区就是项目根目录，会话挂在它下面：一个工作区可以有若干条会话，' +
      '会话的 cwd 就是工作区路径。' +
      '\n用 action=list 看有哪些工作区、当前在哪个。' +
      '\n用 action=switch + path 切到另一个工作区（任务属于别的项目时必须先切，别在 A 项目的工作区里改 B 项目的文件）。' +
      'switch 会先开一条新会话，并把那个工作区**已有的会话**一起列出来；' +
      '如果用户是在接着以前的活，把返回里的序号交给 dsh_use 切回去（也可以直接用 resume 参数一步到位）。' +
      '\n路径写绝对路径（`D:\\proj\\xxx`）；没登记过的路径会自动登记。'

    platform.registerTool('dsh_ws', {
      selector,
      description: wsDesc,
      createTool: () =>
        toolFactory(
          async (input, runnableConfig) => {
            const session = runnableConfig?.configurable?.session
            if (!session) return '拿不到当前会话。'
            const target = resolveTarget(cfg)
            if (target.error) return target.error
            const umo = umoOf(session)
            const base = { umo, senderId: String(session.userId ?? ''), chatType: session.guildId ? 'group' : 'private' }
            try {
              if (input?.action !== 'switch') {
                const r = await call({ ...base, text: 'ws' })
                if (!r.ok) return `查工作区失败：${r.error}`
                return clean(r.text)
              }

              const where = String(input?.path ?? '').trim()
              if (!where) return '切工作区必须给 path（绝对路径，或 dsh_ws 列表里的序号）。'

              const r = await call({ ...base, text: `ws ${where}` })
              if (!r.ok) return `切工作区失败：${r.error}`
              const sw = parseWsSwitch(r.text)
              let out = clean(r.text)

              const ls = await call({ ...base, text: 'ls' }).catch(() => null)
              const rows = ls?.ok ? parseSessionRows(ls.text) : []
              const others = rows.filter((row) => row.id !== sw.newId)
              if (others.length) {
                out +=
                  `\n\n这个工作区里已经有 ${others.length} 条会话（接着以前的活用 dsh_use 切过去）：\n` +
                  renderRows(others, buildOwners())
              }

              const resume = String(input?.resume ?? '').trim()
              if (resume) {
                const pick = /^\d+$/.test(resume)
                  ? others.find((row) => row.n === Number(resume))
                  : others.find((row) => row.id.toLowerCase().startsWith(resume.replace(/^session-/, '').toLowerCase()))
                if (!pick) return `${out}\n\n（没找到要续的会话：${resume}）`
                const used = await call({ ...base, text: `use ${pick.n}` })
                out += used.ok
                  ? `\n\n已切到旧会话：\n${clean(used.text)}`
                  : `\n\n切旧会话失败：${used.error}`
              }
              return out
            } catch (e) {
              return `工作区操作失败（${e?.message ?? e}）。`
            }
          },
          {
            name: 'dsh_ws',
            description: wsDesc,
            schema: z.object({
              action: z
                .enum(['list', 'switch'])
                .optional()
                .describe('list（默认）= 列出工作区与当前 cwd；switch = 切到 path 指定的工作区'),
              path: z
                .string()
                .optional()
                .describe('action=switch 时必填：项目根目录的绝对路径，或工作区列表里的序号'),
              resume: z
                .string()
                .optional()
                .describe(
                  '可选：切过去之后顺便接上哪个旧会话（那个工作区 dsh_sessions 里的序号或短 id）。' +
                    '用户说"继续上次那个"时用'
                ),
            }),
          }
        ),
    })

    // ── ⑥ dsh_use：切到本工作区里的一条已有会话
    const useDesc =
      '把当前聊天切到**本工作区**里已有的某条会话（序号来自 dsh_sessions，或短 id）。' +
      '切过去之后 dsh_run 就续那条会话的上下文，不用重新读项目。' +
      '⚠️ 标记「绑在别的聊天」的会话是别的群/私聊正在用的，别抢——除非用户明确说要用。'

    platform.registerTool('dsh_use', {
      selector,
      description: useDesc,
      createTool: () =>
        toolFactory(
          async (input, runnableConfig) => {
            const session = runnableConfig?.configurable?.session
            if (!session) return '拿不到当前会话。'
            const target = resolveTarget(cfg)
            if (target.error) return target.error
            const arg = String(input?.target ?? '').trim()
            if (!arg) return '要给序号或短 id（先 dsh_sessions 看一眼）。'
            try {
              const r = await call({
                umo: umoOf(session),
                text: `use ${arg}`,
                senderId: String(session.userId ?? ''),
                chatType: session.guildId ? 'group' : 'private',
              })
              return r.ok ? clean(r.text) : `切换失败：${r.error}`
            } catch (e) {
              return `切换失败（${e?.message ?? e}）。`
            }
          },
          {
            name: 'dsh_use',
            description: useDesc,
            schema: z.object({
              target: z.string().describe('dsh_sessions 里的序号（1、2…）或短 id（如 a9a9e919）'),
            }),
          }
        ),
    })

    // ── ③ dsh_compact：上下文快满时压缩
    const compactDesc =
      '让 DSH 压缩它当前会话的上下文（保留结论、丢掉过程）。' +
      '你在 dsh_status 里看到占用很高、又还需要在这个会话上继续干，就用它。' +
      '压缩之后旧的细枝末节会没掉，所以别在还需要精确细节的时候压缩。'

    platform.registerTool('dsh_compact', {
      selector,
      description: compactDesc,
      createTool: () =>
        toolFactory(
          async (_input, runnableConfig) => {
            const session = runnableConfig?.configurable?.session
            if (!session) return '拿不到当前会话。'
            const target = resolveTarget(cfg)
            if (target.error) return target.error
            try {
              const r = await call({
                umo: umoOf(session),
                text: 'compact',
                senderId: String(session.userId ?? ''),
                chatType: session.guildId ? 'group' : 'private',
              })
              return r.ok ? r.text || '已让 DSH 压缩上下文。' : `压缩失败：${r.error}`
            } catch (e) {
              return `压缩失败（${e?.message ?? e}）。`
            }
          },
          { name: 'dsh_compact', description: compactDesc, schema: z.object({}) }
        ),
    })

    log.info(
      'DSH 工具已注册：dsh_run / dsh_status / dsh_last / dsh_continue / dsh_sessions / dsh_ws / dsh_use / dsh_compact（私聊=%s，群白名单 %d 个，后台=%s）',
      cfg.privateEnabled ? '开' : '关',
      cfg.groups.length,
      cfg.backgroundMode === 'raw' ? 'raw(直发原文)' : 'notice(只发提示)'
    )
  })
}

module.exports = { name, inject, Config, apply }

// 给单元测试用（不参与 Koishi 装配）
module.exports.__test = {
  readBeacon,
  resolveTarget,
  umoOf,
  callInbound,
  getBinding,
  parseSessionRows,
  parseWorkspaceList,
  parseWsSwitch,
  buildOwners,
  renderRows,
  needsHuman,
  asksQuestion,
}
