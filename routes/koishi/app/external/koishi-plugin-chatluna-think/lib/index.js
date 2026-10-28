/**
 * koishi-plugin-chatluna-think —— 思考过程展示
 *
 * 需求（用户原话，2026-10-03）：
 *   「另外我想要一个展示思考过程的命令(同样发图片)，前提是模型提供了思考过程，
 *     没有的话略过这一条(这个也理应不调用 api，逻辑代码处理)」
 *
 * ★ 不调用 API 是怎么做到的
 *   模型返回的 reasoning 会**随回复一起**到达，ChatLuna 在 `chatluna/after-chat`
 *   事件里把这条回复对象（第 3 个参数）直接交出来。所以这里只是**接住它、存下来**，
 *   `/think` 再把存下来的东西出图 —— 全程零请求。事件签名（实测源码）：
 *
 *     @chatluna 系 app.cjs:515
 *       ctx.parallel('chatluna/after-chat',
 *                    conversationId, arg.message, displayResponse,
 *                    variables, chatInterface, session)
 *                                      ^^^^^^^^^^^^^^^ 第 3 个就是 AI 回复
 *
 * ★ reasoning 到底在哪个字段
 *   适配器（`@chatluna/v1-shared-adapter`）把增量拼进
 *   `additional_kwargs.reasoning_content`（index.cjs:949-996 非流式 / 1173-1236 流式）。
 *   但它**不落库**：`chatluna_message` 表 56 行里 `additional_kwargs_binary` 全为 NULL
 *   （2026-10-03 实测），所以只能从事件现场抓，事后查库是查不到的。
 *
 * ★ 现状提醒（2026-10-03 实测，别误判成插件坏了）
 *   库里 24 次调用的 `usageMetadata.output_token_details.reasoning` **全是 0** ——
 *   `stealth/space-bunny-alpha` 和 `deepseek/deepseek-v4.1-flash` 当前都不吐 reasoning。
 *   所以 `/think` 现在大概率会回一句「这次没有思考过程」。这是上游的事实，不是本插件的问题；
 *   哪天队列里换成会思考的模型，这里**不用改代码**就会开始有内容。
 *   用 `/think.status` 可以看「捕获到多少次、其中有几次真的带了 reasoning」。
 *
 * ★ 安全：reasoning 是**不可信输入**
 *   它终究是模型生成的，而模型受用户影响。这段文字要进 HTML 页面，所以先把
 *   `& < >` 转义掉再交给渲染 —— 页面本来就禁 JS、拦外网（chatluna-render 的默认姿态），
 *   转义是第二道，防的是「用一段 HTML 把页面排版搞烂」。
 */

const { Schema, Logger } = require('koishi')

const name = 'chatluna-think'
const inject = { required: [], optional: ['chatluna', 'chatlunaPage'] }
const logger = new Logger('think')

const Config = Schema.intersect([
  Schema.object({
    enabled: Schema.boolean().default(true).description('总开关。关掉后 /think 直接说没开启'),
    keepPerScope: Schema.natural().default(3).description('每个会话保留最近几条思考过程'),
    maxScopes: Schema.natural().default(200).description('最多记住多少个会话（超了淘汰最旧的）'),
    maxChars: Schema.natural()
      .default(6000)
      .description('单次展示的字符上限，超了截断。★ 思考过程可能很长，不截会出一张几万像素的图'),
    commandName: Schema.string().default('think').description('指令名。改了要同步改 koishi.yml 里的提权表（如果加过）'),
  }),
  Schema.object({
    showWhenEmpty: Schema.boolean()
      .default(true)
      .description('模型没给思考过程时，回一句说明。关掉则完全静默（用户会以为指令没反应）'),
    debug: Schema.boolean().default(false).description('抓到 reasoning 时打印明细，用来确认字段有没有变'),
  }),
])

function apply(ctx, config) {
  const cfg = {
    enabled: true,
    keepPerScope: 3,
    maxScopes: 200,
    maxChars: 6000,
    commandName: 'think',
    showWhenEmpty: true,
    debug: false,
    ...(config ?? {}),
  }

  const log = (...a) => cfg.debug && logger.info(...a)

  /** scopeKey -> [{ text, at, model, tokens, ttft, totalMs }]，最新的在最后 */
  const store = new Map()
  const stats = { seen: 0, withReasoning: 0, lastAt: 0, lastModel: '', chars: 0 }

  const scopeOf = (session) =>
    String(session?.guildId ?? session?.channelId ?? session?.userId ?? session?.selfId ?? 'unknown')

  // ------------------------------------------------------------------ 提取

  /** 从 AI 回复对象里把 reasoning 抠出来。多路探测，因为不同适配器放的层不一样 */
  function extractReasoning(msg) {
    if (!msg || typeof msg !== 'object') return ''
    const parts = []
    const push = (v) => {
      if (typeof v === 'string' && v.trim()) parts.push(v.trim())
    }

    const kw = msg.additional_kwargs ?? {}
    push(kw.reasoning_content)
    push(kw.reasoning)
    push(msg.reasoning_content)
    push(msg.response_metadata?.reasoning_content)

    // 有些适配器把思考过程当 content 数组里的一种块
    if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b && typeof b === 'object' && /reason|think/i.test(String(b.type ?? ''))) {
          push(b.reasoning ?? b.thinking ?? b.text ?? b.content)
        }
      }
    }
    return parts.join('\n\n').trim()
  }

  /** 模型名：先在回复对象上找，找不到就退回会话当前模型 */
  function modelOf(msg, conversationId) {
    const cands = [
      msg?.response_metadata?.model,
      msg?.response_metadata?.model_name,
      msg?.response_metadata?.modelName,
      msg?.additional_kwargs?.model,
      msg?.response_metadata?.chatluna?.model,
    ]
    for (const c of cands) if (typeof c === 'string' && c.trim()) return c.trim()
    try {
      const c = ctx.chatluna?.conversation?.get?.(conversationId)
      if (c?.model) return String(c.model)
    } catch {}
    return ''
  }

  function metricsOf(msg) {
    const m = msg?.response_metadata?.chatluna_invocation_metrics
    if (!m) return null
    const u = m.usageMetadata ?? {}
    return {
      input: u.input_tokens ?? null,
      output: u.output_tokens ?? null,
      reasoningTokens: u.output_token_details?.reasoning ?? null,
      ttft: m.timing?.ttftMs ?? null,
      total: m.timing?.totalMs ?? null,
      tps: m.timing?.tps ?? null,
    }
  }

  // ------------------------------------------------------------------ 捕获

  ctx.inject(['chatluna'], (ctx2) => {
    ctx2.on('chatluna/after-chat', (conversationId, _source, responseMessage, _vars, _iface, session) => {
      if (!cfg.enabled) return
      try {
        stats.seen++
        stats.lastAt = Date.now()

        const text = extractReasoning(responseMessage)
        const model = modelOf(responseMessage, conversationId)
        if (model) stats.lastModel = model

        if (!text) {
          // 上游没给思考过程：这是绝大多数情况，别刷屏
          log(
            '本次回复没有 reasoning（会话 %s）。response_metadata 的键：%s',
            conversationId,
            Object.keys(responseMessage?.response_metadata ?? {}).join(', ') || '(空)'
          )
          return
        }

        stats.withReasoning++
        stats.chars += text.length
        const key = scopeOf(session)
        const list = store.get(key) ?? []
        list.push({
          text,
          at: Date.now(),
          model,
          metrics: metricsOf(responseMessage),
          conversationId,
        })
        while (list.length > cfg.keepPerScope) list.shift()
        store.set(key, list)

        // 会话数上限：淘汰「最久没更新」的那个
        if (store.size > cfg.maxScopes) {
          let oldestKey = null
          let oldestAt = Infinity
          for (const [k, v] of store) {
            const t = v[v.length - 1]?.at ?? 0
            if (t < oldestAt) {
              oldestAt = t
              oldestKey = k
            }
          }
          if (oldestKey) store.delete(oldestKey)
        }

        logger.info(
          '捕获到思考过程：%d 字符，模型 %s（会话 %s）',
          text.length,
          model || '(未知)',
          conversationId
        )
      } catch (e) {
        logger.warn('捕获思考过程出错（不影响对话）：%s', e.message)
      }
    })
  })

  // ------------------------------------------------------------------ 出图

  const esc = (s) =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')

  function trimFence(text) {
    // 模型有时把整个过程包在 ``` 里，那样整页都变成代码块，很丑
    const t = text.trim()
    const m = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(t)
    return m ? m[1] : t
  }

  function thinkMarkdown(entry, index, total) {
    const truncated = entry.text.length > cfg.maxChars
    const body = truncated ? entry.text.slice(0, cfg.maxChars) : entry.text
    const m = entry.metrics
    const when = new Date(entry.at).toLocaleString('zh-CN', { hour12: false })

    const meta = [
      `| 项 | 值 |`,
      `| --- | --- |`,
      `| 时间 | ${esc(when)} |`,
      `| 模型 | ${entry.model ? `\`${esc(entry.model)}\`` : '（未记录）'} |`,
    ]
    if (m) {
      meta.push(
        `| 用量 | 输入 ${m.input ?? '?'} · 输出 ${m.output ?? '?'} tokens${
          m.reasoningTokens ? ` （其中思考 ${m.reasoningTokens}）` : ''
        } |`
      )
      if (m.ttft != null) meta.push(`| 耗时 | 首字 ${m.ttft} ms · 共 ${m.total ?? '?'} ms |`)
    }
    meta.push(`| 长度 | ${entry.text.length} 字符${truncated ? ` （已截断到 ${cfg.maxChars}）` : ''} |`)

    return [
      `# 思考过程`,
      ``,
      total > 1 ? `第 ${index}/${total} 条（1 = 最新）` : `模型这一轮的内部推理`,
      ``,
      ...meta,
      ``,
      `---`,
      ``,
      esc(trimFence(body)),
      ``,
      `<div class="pg-foot">这是模型自己输出的推理内容，**不是**给用户看的回复。<br>` +
        `发 <code>/think 2</code> 看更早的一条；发 <code>/think.status</code> 看捕获统计。</div>`,
    ].join('\n')
  }

  async function reply(session, md) {
    const pg = ctx.get('chatlunaPage')
    if (pg && pg.available()) return pg.output(session, md)
    return md
  }

  const CMD = cfg.commandName || 'think'

  ctx
    .command(`${CMD} [index:number]`, '看模型最近一次的思考过程（出图）', { authority: 1 })
    .action(async ({ session }, index) => {
      if (!cfg.enabled) return '思考过程展示没开。'

      const list = store.get(scopeOf(session)) ?? []
      if (!list.length) {
        if (!cfg.showWhenEmpty) return
        const why = stats.seen
          ? `这个会话还没有捕获到带思考过程的回复（已观察 ${stats.seen} 次模型回复，其中 ${stats.withReasoning} 次带 reasoning）。`
          : `还没观察到模型回复。先跟我说句话，我再看有没有思考过程。`
        return [
          `这次没有思考过程。`,
          ``,
          why,
          ``,
          `当前模型 \`${stats.lastModel || '(未知)'}\` 的返回里没有 reasoning 字段。`,
          `换一个会「先思考再回答」的模型后，这里会自动有内容 —— 不用改配置。`,
        ].join('\n')
      }

      const n = Math.min(Math.max(Number(index) || 1, 1), list.length)
      const entry = list[list.length - n]
      return reply(session, thinkMarkdown(entry, n, list.length))
    })

  ctx
    .command(`${CMD}.status`, '看思考过程的捕获统计', { authority: 2 })
    .action(async ({ session }) => {
      const scopes = store.size
      let kept = 0
      for (const v of store.values()) kept += v.length
      const rate = stats.seen ? ((stats.withReasoning / stats.seen) * 100).toFixed(1) : '0.0'
      const md = [
        `# 思考过程 · 捕获统计`,
        ``,
        `| 项 | 值 |`,
        `| --- | --- |`,
        `| 观察到的模型回复 | ${stats.seen} 次 |`,
        `| 其中带 reasoning | **${stats.withReasoning}** 次（${rate}%） |`,
        `| 累计思考字数 | ${stats.chars} |`,
        `| 保留中 | ${kept} 条，分布在 ${scopes} 个会话 |`,
        `| 最近一次模型 | ${stats.lastModel ? `\`${esc(stats.lastModel)}\`` : '（未记录）'} |`,
        ``,
        `<div class="pg-foot">` +
          `**捕获 0 次是正常的**：实测当前队列里的模型（space-bunny-alpha / deepseek-v4.1-flash）` +
          `返回的 usage 里 reasoning token 恒为 0，即上游根本没吐思考过程。<br>` +
          `换成会思考的模型后这张表会自己开始涨。</div>`,
      ].join('\n')
      return reply(session, md)
    })

  ctx.on('ready', () => {
    logger.info(
      '思考过程展示已挂载（指令 /%s；每会话保留 %d 条；上限 %d 字符）',
      CMD,
      cfg.keepPerScope,
      cfg.maxChars
    )
  })
}

module.exports = { name, inject, Config, apply }
