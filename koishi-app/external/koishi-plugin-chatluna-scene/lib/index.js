/**
 * koishi-plugin-chatluna-scene
 *
 * R11「会话生命周期」——自写。
 *
 * 需求原文：「会话生命周期（如"开始游戏"→"达成/中断"需终止）」。
 * 落地成一句话：**让 bot 知道自己正处在什么"有始有终的互动"里，并且真的能把它结束掉。**
 *
 * 三件事：
 *   1. 状态机（落库，按会话隔离）：idle → active → ended
 *      模型自己调 `scene_begin` 开局（猜谜/问答/打赌/接龙/帮忙找东西…），
 *      调 `scene_end` 收局（达成 / 中断）。
 *   2. 提示词注入 `{scene()}`：让模型知道"现在没在玩" / "正在玩什么、还剩什么条件" /
 *      "上一局刚刚结束，别再提了"。
 *   3. **终止会话**：收局时把这条会话的上下文清掉（可配 clear/archive/mark），
 *      不能让"上一局游戏"的黑历史永远留在上下文里污染后面的聊天。
 *
 * ★★ 最容易踩的坑：**别在模型回合里清历史，会死锁。**
 *   `clearConversationHistory` 内部是 `withConversationLock`（`chat.cjs:3826`），
 *   而正在跑的这一轮聊天自己就占着同一个 conversationQueue
 *   （`chat()` → `withConversationAndPlatformLock`，`chat.cjs:3526/3685/3703`；
 *     队列是 RequestIdQueue，同一 key 同时只有一个 active，`utils/queue.cjs:45-89`）。
 *   在工具里直接清 = 等自己那一轮结束 → 永远等不到。
 *   连 `chatluna/after-chat` 事件也不能直接用：它是在**锁内**被 emit 的
 *   （`llm-core/chat/app.cjs:514-523`，而这段代码本身跑在 withConversationAndPlatformLock 的回调里）。
 *
 *   所以这里的做法是：**只登记"待终止"，由一个轮询任务（不在任何回合里）去执行**。
 *   轮询任务即使撞上正在进行的回合，也只是那一格 await 等一会儿，不会死锁。
 *
 * 另一个次要事实：conversationId 不用自己算（bindingKey 拼装函数没导出，见
 * index.cjs:4716 的 computeBaseBindingKey）。直接用 `chatluna/after-chat` 事件给的第 1 个参数，
 * 并把第 6 个参数（session）用来把 conversationId 映射回我们的 scope。
 */

const { Schema, Logger } = require('koishi')
const { StructuredTool } = require('@langchain/core/tools')
const z = require('zod')

const name = 'chatluna-scene'

/** chatluna 的服务不是立刻可用的，用 inject 等它 */
const inject = { required: ['database'], optional: ['chatluna', 'qqbotGuard'] }

const TABLE = 'chatluna_scene'

const logger = new Logger('chatluna-scene')

/** 上一次互动结束后，这条"已结束"的提示还要在提示词里挂多久（毫秒） */
const ENDED_HINT_MS = 10 * 60 * 1000

/** 终止动作的超时保护：宁可下一轮再试，也不要卡住轮询 */
const TERMINATE_TIMEOUT_MS = 20000

const Config = Schema.intersect([
  Schema.object({
    enabled: Schema.boolean().default(true).description('总开关'),
    variableName: Schema.string()
      .default('scene')
      .description('预设里引用的函数名，写作 {scene()}。★ 只能是 ASCII，中文名解析不了'),
    scopeMode: Schema.union([
      Schema.const('channel').description('按会话/群 —— 一个群共用一个进度（推荐，跟默认的群共享会话一致）'),
      Schema.const('user').description('按用户 —— 每个人各玩各的'),
    ])
      .default('channel')
      .description('互动的隔离范围'),
    endMode: Schema.union([
      Schema.const('clear').description('清空这条会话的历史消息（上下文归零，会话记录保留）—— 最贴"终止会话"'),
      Schema.const('archive').description('把这条会话归档，下次说话会另起一条新会话'),
      Schema.const('mark').description('只结束互动状态，不动会话（最保守）'),
    ])
      .default('clear')
      .description('互动结束时怎么"终止"'),
    abortIdleMinutes: Schema.natural()
      .default(30)
      .description('互动进行中，多久没人接话就判定"中断"并终止（分钟）。0 = 不因为空闲而中断'),
    maxMinutes: Schema.natural()
      .default(180)
      .description('单个互动的硬上限（分钟）。超了直接判"中断"，防止一个游戏永远挂着'),
    notifyOnAbort: Schema.boolean()
      .default(false)
      .description('自动中断时是否在群里说一句（比如"这局就算了吧"）。默认不说，只记日志'),
    enableTool: Schema.boolean().default(true).description('注册 scene_begin / scene_end 工具，让模型自己开局收局'),
    debug: Schema.boolean().default(false).description('打印每次状态变化的日志'),
  }),
  Schema.object({
    templates: Schema.array(
      Schema.object({
        title: Schema.string().required().description('互动名（会出现在提示词里）'),
        goal: Schema.string().default('').description('结束条件，写给模型看'),
      })
    )
      .role('table')
      .default([])
      .description('常用互动模板，仅作参考展示，模型也可以自己起新的'),
  }),
])

// ---------------------------------------------------------------- 工具函数

/** 这次会话对应的状态隔离键 */
function scopeKeyOf(session, config) {
  const platform = session?.platform || 'onebot'
  if (config.scopeMode === 'user') {
    return `${platform}:user:${session?.userId ?? 'unknown'}`
  }
  const cid = session?.channelId || session?.guildId || session?.userId || 'unknown'
  return `${platform}:channel:${cid}`
}

function minutesSince(ts, now) {
  if (!ts) return 0
  return Math.max(0, Math.round((now - new Date(ts).getTime()) / 60000))
}

async function loadRow(ctx, scopeKey) {
  const rows = await ctx.database.get(TABLE, { scopeKey })
  return rows[0] || null
}

/** 把一行记录描述成给模型看的一句话 */
function describeRow(row, now) {
  if (!row || !row.status || row.status === 'idle') {
    return '（现在没有进行中的互动，正常聊天就行）'
  }
  if (row.status === 'active') {
    const goal = row.goal ? `｜结束条件：${row.goal}` : ''
    return (
      `【进行中】${row.title || '一场互动'}${goal}` +
      `｜已经进行了 ${minutesSince(row.startedAt, now)} 分钟` +
      `｜这一局已经聊了 ${row.turnCount || 0} 轮`
    )
  }
  // ended
  if (row.endedAt && now - new Date(row.endedAt).getTime() < ENDED_HINT_MS) {
    const summary = row.summary ? `（${row.summary}）` : ''
    return `（上一场互动「${row.title || '互动'}」刚刚${row.result || '结束'}${summary}，已经收局了，别再提它）`
  }
  return '（现在没有进行中的互动，正常聊天就行）'
}

// ---------------------------------------------------------------- 应用

function apply(ctx, config) {
  ctx.model.extend(
    TABLE,
    {
      scopeKey: { type: 'string', length: 128 },
      platform: { type: 'string', length: 32, nullable: true },
      channelId: { type: 'string', length: 128, nullable: true },
      guildId: { type: 'string', length: 128, nullable: true },
      selfId: { type: 'string', length: 128, nullable: true },
      status: { type: 'string', length: 16, initial: 'idle' },
      title: { type: 'text', nullable: true },
      goal: { type: 'text', nullable: true },
      result: { type: 'string', length: 32, nullable: true },
      summary: { type: 'text', nullable: true },
      startedAt: { type: 'timestamp', nullable: true },
      lastActiveAt: { type: 'timestamp', nullable: true },
      endedAt: { type: 'timestamp', nullable: true },
      turnCount: { type: 'integer', initial: 0 },
      conversationId: { type: 'string', length: 256, nullable: true },
      pendingMode: { type: 'string', length: 16, nullable: true },
      attempts: { type: 'integer', initial: 0 },
      notifyText: { type: 'text', nullable: true },
    },
    { primary: ['scopeKey'] }
  )

  const log = (...a) => config.debug && logger.info(...a)

  async function save(scopeKey, patch) {
    const row = (await loadRow(ctx, scopeKey)) || { scopeKey }
    // upsert 是"整行替换"，所以要把老字段带上
    const merged = { ...row, ...patch, scopeKey }
    delete merged.id
    await ctx.database.upsert(TABLE, [merged])
    return merged
  }

  // ------------------------------------------------------------ 终止（轮询里做）

  let draining = false

  async function drainTerminations() {
    if (draining) return
    draining = true
    try {
      // ★ 不要写 `{ pendingMode: { $ne: null } }`：翻成 SQL 就是 `<> NULL`，
      //   永远不成立（NULL 的比较结果是 NULL 而不是 true），查出来会是空集。
      //   这里按 status 取、在 JS 里筛，行数很少。
      const rows = await ctx.database.get(TABLE, { status: 'ended' })
      for (const row of rows) {
        if (!row.pendingMode) continue
        const mode = row.pendingMode
        if (mode === 'mark' || !row.conversationId) {
          await save(row.scopeKey, { pendingMode: null, attempts: 0 })
          continue
        }
        const conversation = await ctx.chatluna.conversation
          .getConversation(row.conversationId)
          .catch(() => null)
        if (!conversation) {
          // 会话已经不在了（被删/被清），目的已经达到
          await save(row.scopeKey, { pendingMode: null, attempts: 0 })
          continue
        }
        try {
          if (mode === 'archive') {
            await withTimeout(
              ctx.chatluna.conversation.archiveConversationById(row.conversationId)
            )
          } else {
            const runtime = ctx.chatluna.conversationRuntime
            const fn =
              (runtime && typeof runtime.clearConversationHistory === 'function'
                ? runtime.clearConversationHistory.bind(runtime)
                : null) ||
              (typeof ctx.chatluna.conversation.clearConversationHistory === 'function'
                ? ctx.chatluna.conversation.clearConversationHistory.bind(
                    ctx.chatluna.conversation
                  )
                : null)
            if (!fn) throw new Error('这个 chatluna 版本没有 clearConversationHistory')
            await withTimeout(fn(conversation))
          }
          await save(row.scopeKey, { pendingMode: null, attempts: 0 })
          logger.info(
            '会话已终止（%s）：scope=%s conversation=%s',
            mode,
            row.scopeKey,
            row.conversationId
          )
        } catch (e) {
          const attempts = (row.attempts || 0) + 1
          await save(row.scopeKey, { attempts })
          logger.warn(
            '终止会话失败（第 %d 次，%s）：%s',
            attempts,
            e.message,
            row.scopeKey
          )
        }
      }
    } catch (e) {
      logger.warn('清理待终止会话时出错：%s', e.message)
    } finally {
      draining = false
    }
  }

  function withTimeout(promise) {
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('等待会话锁超时')), TERMINATE_TIMEOUT_MS)
      ),
    ])
  }

  // ------------------------------------------------------------ 状态机动作

  async function beginScene(session, title, goal) {
    const scopeKey = scopeKeyOf(session, config)
    const now = new Date()
    const row = await save(scopeKey, {
      platform: session.platform,
      channelId: session.channelId ?? null,
      guildId: session.guildId ?? null,
      selfId: session.selfId ?? null,
      status: 'active',
      title: title || '一场互动',
      goal: goal || '',
      result: null,
      summary: null,
      startedAt: now,
      lastActiveAt: now,
      endedAt: null,
      turnCount: 0,
      pendingMode: null,
      attempts: 0,
    })
    logger.info('互动开始：scope=%s 标题=%s 结束条件=%s', scopeKey, row.title, row.goal || '（没写）')
    return row
  }

  async function endScene(scopeKey, result, summary, reason) {
    const row = await loadRow(ctx, scopeKey)
    if (!row || row.status !== 'active') {
      log('互动结束被忽略：scope=%s 当前状态=%s', scopeKey, row?.status || '无')
      return null
    }
    const ended = await save(scopeKey, {
      status: 'ended',
      result: result || '中断',
      summary: summary || null,
      endedAt: new Date(),
      pendingMode: config.endMode,
      attempts: 0,
    })
    logger.info(
      '互动结束：scope=%s 结果=%s（%s）→ 会话处置 %s',
      scopeKey,
      ended.result,
      reason || '模型判定',
      config.endMode
    )
    if (
      config.notifyOnAbort &&
      reason &&
      reason !== '模型判定' &&
      ended.channelId &&
      // R15：被屏蔽的群一个字都不发（这条提示是绕过会话管线的直发，必须自己问一次）
      !ctx.qqbotGuard?.isBlocked({
        platform: 'onebot',
        channelId: String(ended.channelId),
        guildId: String(ended.channelId),
        isDirect: false,
      })
    ) {
      // 自动中断才提示一句；模型自己收的局它自己会说
      try {
        const bot = ctx.bots.find((b) => String(b.selfId) === String(ended.selfId)) || ctx.bots[0]
        await bot?.sendMessage(ended.channelId, '……行吧，那这局就算了。')
      } catch (e) {
        log('中断提示发送失败：%s', e.message)
      }
    }
    void drainTerminations()
    return ended
  }

  /** 轮询：自动中断 + 执行待终止 */
  ctx.setInterval(() => {
    if (!config.enabled) return
    void (async () => {
      try {
        const now = Date.now()
        const actives = await ctx.database.get(TABLE, { status: 'active' })
        for (const row of actives) {
          const idleMs = config.abortIdleMinutes * 60000
          const lastAt = row.lastActiveAt ? new Date(row.lastActiveAt).getTime() : 0
          const startedAt = row.startedAt ? new Date(row.startedAt).getTime() : 0
          if (idleMs > 0 && lastAt && now - lastAt >= idleMs) {
            await endScene(
              row.scopeKey,
              '中断',
              `${Math.round((now - lastAt) / 60000)} 分钟没人接话`,
              '空闲超时'
            )
            continue
          }
          if (config.maxMinutes > 0 && startedAt && now - startedAt >= config.maxMinutes * 60000) {
            await endScene(row.scopeKey, '中断', '超过单局时长上限', '超时')
          }
        }
      } catch (e) {
        logger.warn('互动超时检查出错：%s', e.message)
      }
      await drainTerminations()
    })()
  }, 15000)

  // ------------------------------------------------------------ 挂 chatluna

  ctx.inject(['chatluna'], (ctx2) => {
    const chatluna = ctx2.chatluna
    if (!chatluna) {
      logger.warn('chatluna 服务不可用，{scene()} 与 scene_* 工具未注册')
      return
    }

    // 1) 提示词变量
    const renderer = chatluna.promptRenderer
    if (renderer && typeof renderer.registerFunctionProvider === 'function') {
      renderer.registerFunctionProvider(
        config.variableName || 'scene',
        async (_args, _variables, configurable) => {
          const session = configurable?.session
          if (!session) return ''
          try {
            const row = await loadRow(ctx2, scopeKeyOf(session, config))
            return describeRow(row, Date.now())
          } catch (e) {
            logger.warn('取互动状态失败：%s', e.message)
            return ''
          }
        }
      )
      logger.info('已注册互动状态变量：{%s()}', config.variableName || 'scene')
    } else {
      logger.warn('promptRenderer.registerFunctionProvider 不可用，互动状态变量未注册')
    }

    // 2) after-chat：把 conversationId 绑到 scope 上，并给进行中的互动计轮数
    ctx.on('chatluna/after-chat', async (conversationId, _message, _response, _variables, _iface, session) => {
      try {
        if (!session) return
        const scopeKey = scopeKeyOf(session, config)
        const row = await loadRow(ctx, scopeKey)
        if (!row) return
        const patch = { conversationId }
        if (row.status === 'active') {
          patch.turnCount = (row.turnCount || 0) + 1
          patch.lastActiveAt = new Date()
        }
        await save(scopeKey, patch)
      } catch (e) {
        logger.warn('记录会话 ID 失败：%s', e.message)
      }
    })

    // 3) 工具：开局 / 收局
    if (!config.enableTool) return
    const platform = chatluna.platform
    if (!platform || typeof platform.registerTool !== 'function') {
      logger.warn('platform.registerTool 不可用，scene_* 工具未注册')
      return
    }

    const beginDesc =
      '开始一场"有始有终的互动"：猜谜、问答、打赌、接龙、讲个连载、帮对方查/找东西、约好的任务……' +
      '只要这件事需要一个明确的收尾（达成目标 或者 对方不玩了），就在开始的时候调用它记下来。' +
      '普通的闲聊不要调用。开始之后，你们可以来回聊很多轮，结束时要记得调用 scene_end。'
    platform.registerTool('scene_begin', {
      selector: () => true,
      authorization: () => true,
      description: beginDesc,
      createTool: () =>
        new (class extends StructuredTool {
          name = 'scene_begin'
          description = beginDesc
          schema = z.object({
            title: z.string().describe('这场互动的名字，比如"猜数字"、"成语接龙"'),
            goal: z.string().describe('什么情况下算结束、算达成，一句话，写给未来的你看'),
          })
          async _call(input, _manager, runnable) {
            const session = runnable?.configurable?.session
            if (!session) return '拿不到会话信息，没能记下来。'
            const row = await beginScene(session, input.title, input.goal)
            return `已记下这场互动：「${row.title}」（结束条件：${row.goal}）。结束的时候记得调用 scene_end。`
          }
        })(),
    })

    const endDesc =
      '结束当前这场互动。达成目标、对方放弃、玩不下去、或者你自己搞砸了，都要调用它收局——' +
      '不要让一场互动永远挂着。收局之后不要再提这件事。'
    platform.registerTool('scene_end', {
      selector: () => true,
      authorization: () => true,
      description: endDesc,
      createTool: () =>
        new (class extends StructuredTool {
          name = 'scene_end'
          description = endDesc
          schema = z.object({
            result: z.enum(['达成', '中断']).describe('达成 = 目标完成了；中断 = 没完成就结束了'),
            summary: z.string().optional().describe('一句话结果，比如"他猜中了 42"、"他不想玩了"'),
          })
          async _call(input, _manager, runnable) {
            const session = runnable?.configurable?.session
            if (!session) return '拿不到会话信息，没能收局。'
            const scopeKey = scopeKeyOf(session, config)
            const ended = await endScene(scopeKey, input.result, input.summary, '模型判定')
            if (!ended) return '现在没有进行中的互动，不用收局。'
            return `这场互动已经结束（${ended.result}）${input.summary ? `：${input.summary}` : ''}。接下来正常聊就行，别再提它了。`
          }
        })(),
    })

    logger.info(
      '互动状态机已挂载（%s 级隔离；结束处置=%s；空闲 %d 分钟判中断）',
      config.scopeMode === 'user' ? '用户' : '会话',
      config.endMode,
      config.abortIdleMinutes
    )
  })

  // ------------------------------------------------------------ 指令

  ctx.command('scene', '看当前互动（游戏/任务）的状态', { authority: 1 }).action(async ({ session }) => {
    const scopeKey = scopeKeyOf(session, config)
    const row = await loadRow(ctx, scopeKey)
    if (!row || !row.status || row.status === 'idle') {
      return `当前没有进行中的互动。\n作用域：${scopeKey}`
    }
    const now = Date.now()
    const lines = [
      `状态：${row.status === 'active' ? '进行中' : '已结束'}`,
      `互动：${row.title || '（没名字）'}`,
      row.goal ? `结束条件：${row.goal}` : null,
      row.status === 'active'
        ? `已进行 ${minutesSince(row.startedAt, now)} 分钟｜${row.turnCount || 0} 轮`
        : `结果：${row.result || '—'}${row.summary ? `（${row.summary}）` : ''}｜结束于 ${minutesSince(row.endedAt, now)} 分钟前`,
      `会话 ID：${row.conversationId || '（还没绑定）'}`,
      `待终止：${row.pendingMode || '无'}${row.attempts ? `（已重试 ${row.attempts} 次）` : ''}`,
      `作用域：${scopeKey}`,
    ]
    return lines.filter(Boolean).join('\n')
  })

  // ★ 子指令必须用**点号全名**注册：`ctx.command('a/b')` 出来的子指令名字只有 `b`，
  //   而 Commander._resolve 是拿整名去 `_commandList` 里查 `_aliases` 的
  //   （core:1411 get / core:1432 _resolve），查 `a.b` 永远查不到 → **用户根本敲不出来**。
  //   实测：`/scene.begin 猜数字 …` 完全没反应（日志里连 `command scene` 都不打），
  //   同一次会话里 `/scene` 正常 —— 因为父指令的名字就是 `scene`。
  ctx
    .command('scene.begin <title:string> [goal:text]', '手动开一局互动（调试/主人用）', { authority: 3 })
    .usage('例：/scene.begin 猜数字 对方猜中我出的数')
    .action(async ({ session }, title, goal) => {
      const row = await beginScene(session, title, goal)
      return `已开始互动「${row.title}」（结束条件：${row.goal || '没写'}）。作用域：${row.scopeKey}`
    })

  ctx
    .command('scene.end', '强制结束当前互动并终止会话', { authority: 2 })
    .usage('例：/scene.end —— 把正在进行的游戏收掉，并清掉这条会话的上下文')
    .action(async ({ session }) => {
      const scopeKey = scopeKeyOf(session, config)
      const ended = await endScene(scopeKey, '中断', '被手动结束', '手动指令')
      if (!ended) return '当前没有进行中的互动。'
      return `已结束「${ended.title}」，会话处置：${config.endMode}`
    })
}

module.exports = { name, inject, Config, apply }
