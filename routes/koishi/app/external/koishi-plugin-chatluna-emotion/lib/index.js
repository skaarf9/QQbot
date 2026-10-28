/**
 * koishi-plugin-chatluna-emotion
 *
 * 给 ChatLuna 加情绪系统（需求 R14）：
 *   1. 情绪状态落库（sqlite），按「会话」隔离（一个群一种心情）
 *   2. 情绪随时间指数衰减回基线 —— 这是"像真的"的关键
 *   3. 向 ChatLuna 预设注入 {emotion()} 变量，让模型知道"我现在是什么心情"
 *   4. 注册 emotion_set 原生工具，让模型自己在被对话影响时改情绪
 *   5. 提供 /emotion 系列指令，便于人工查看与干预
 *
 * R16（情绪过期）—— 2026-09-30 加：
 *   6. **绝对保质期**：情绪从「被设置」那一刻起最多活 `expireMinutes` 分钟，
 *      到点无条件回到基线，不管强度还剩多少（半衰期只保证"越来越淡"，
 *      不保证"一定会消失"，halfLife 设大时能挂一整天）。
 *   7. **后台清扫**：`sweepSeconds` 周期性地由**插件逻辑代码**主动衰减/清除，
 *      不依赖"有没有人来读"。读完就删掉已经回到基线的行（过期=物理消失）。
 *   8. TTL 锚点单独存 `setAt`，不能复用 `updatedAt` —— 后者每次读取都会
 *      被惰性衰减回写刷新，拿它当锚点的话情绪永远不会过期。
 *   ★ 为什么必须由逻辑代码管：模型自己不会记得"该收心了"，把它交给模型等于
 *     没有过期。第 7 条是纯代码行为，模型无法影响也无法绕过。
 *
 * 关键 API 来源（照抄 chatluna-affinity@0.3.15 的实证用法）：
 *   - 注入变量：ctx.chatluna.promptRenderer.registerFunctionProvider(name, (args, vars, configurable) => string)
 *     ★ 注意是 FunctionProvider 而不是 VariableProvider：
 *       VariableProvider 的签名是 () => Record<string, unknown>，**拿不到 session**（运行时确实是无参调用），
 *       而 FunctionProvider 的第三个参数 configurable 里带 session。
 *   - 注册工具：ctx.chatluna.platform.registerTool(name, { createTool, selector, authorization, description })
 *     工具 _call(input, manager, runnable) 里用 runnable?.configurable?.session 取会话。
 *   - 建表：ctx.model.extend(表名, { 字段 }, { primary: [...] })
 */

const { Schema, Logger } = require('koishi')
const { StructuredTool } = require('@langchain/core/tools')
const z = require('zod')

const name = 'chatluna-emotion'

/** chatluna 的服务不是立刻可用的，用 inject 等它 */
const inject = {
  required: ['database'],
  optional: ['chatluna'],
}

const TABLE = 'chatluna_emotion'
const TOOL_NAME = 'emotion_set'

const logger = new Logger('chatluna-emotion')

const DEFAULT_EMOTIONS = [
  { name: '开心', desc: '心情不错，语气轻快，乐意多聊几句' },
  { name: '兴奋', desc: '情绪高涨，话变多、爱用感叹号' },
  { name: '平静', desc: '平常心，正常说话' },
  { name: '无聊', desc: '提不起劲，回复偏短、有点敷衍' },
  { name: '烦躁', desc: '不耐烦，语气冲，容易怼人' },
  { name: '生气', desc: '明显不悦，措辞强硬、不肯让步' },
  { name: '难过', desc: '情绪低落，语气消沉、话少' },
  { name: '委屈', desc: '觉得被误解，带点小情绪、会辩解' },
  { name: '得意', desc: '有点小骄傲，爱炫耀、爱卖弄' },
  { name: '害羞', desc: '被夸到不好意思，说话会绕弯' },
]

const Config = Schema.intersect([
  Schema.object({
    baseline: Schema.string().default('平静').description(
      '基线情绪。情绪强度衰减到阈值以下时回到这里。'
    ),
    halfLife: Schema.natural().default(60).description(
      '情绪衰减半衰期（分钟）。每过这么久，强度减半。设大=情绪更持久。'
    ),
    resetThreshold: Schema.number().min(0).max(1).step(0.05).default(0.15).description(
      '强度低于这个值就回到基线情绪，避免"永远残留一点点情绪"。'
    ),
    expireMinutes: Schema.number().min(0).default(180).description(
      '情绪保质期（分钟）。从「情绪被设置」那一刻算起，超过就无条件回到基线——' +
        '不管强度还剩多少。半衰期只管"越来越淡"，保质期负责"一定会消失"。' +
        '填 0 = 不过期（只靠半衰期衰减，不推荐）。'
    ),
    sweepSeconds: Schema.natural().default(60).description(
      '后台清扫间隔（秒）。由插件逻辑代码周期性衰减/清除过期情绪，不依赖有没有人说话。' +
        '填 0 = 关掉清扫（退化成只在读取时惰性衰减）。'
    ),
    scopeMode: Schema.union([
      Schema.const('channel').description('按会话/群 —— bot 在一个群里是一种心情（推荐）'),
      Schema.const('user').description('按用户 —— 对不同人有不同情绪'),
      Schema.const('global').description('全局共用一种情绪'),
    ]).default('channel').description('情绪的隔离范围'),
    variableName: Schema.string().default('emotion').description(
      '预设里引用的函数名，写作 {emotion()}。改完要同步改预设。'
    ),
    enableTool: Schema.boolean().default(true).description(
      '注册 emotion_set 原生工具，让模型自己改情绪。关掉后只能用指令手动改。'
    ),
    debug: Schema.boolean().default(false).description('打印每次情绪读写的日志'),
  }),
  Schema.object({
    emotions: Schema.array(
      Schema.object({
        name: Schema.string().required().description('情绪名，会直接出现在提示词里'),
        desc: Schema.string().default('').description('这个情绪下该怎么说话'),
      })
    ).default(DEFAULT_EMOTIONS).description('可用情绪列表'),
  }),
])

// ---------------------------------------------------------------- 状态存取

/** 算出这次会话对应的情绪隔离键 */
function scopeKeyOf(session, config) {
  if (!session) return 'global'
  if (config.scopeMode === 'global') return 'global'
  const platform = session.platform || 'onebot'
  if (config.scopeMode === 'user') {
    return `${platform}:user:${session.userId ?? 'unknown'}`
  }
  // channel：群里按群，私聊按对方
  const cid = session.channelId || session.guildId || session.userId || 'unknown'
  return `${platform}:channel:${cid}`
}

/** 这一行是不是已经回到基线了（=可以删掉） */
function isBaseline(row, config) {
  return (
    !row ||
    !row.emotion ||
    (row.emotion === config.baseline && (Number(row.intensity) || 0) === 0)
  )
}

/**
 * 对一行记录施加时间衰减 + 保质期检查，返回当前真实状态。
 *
 * 两条独立的规则，缺一不可：
 *   半衰期：intensity *= 0.5 ^ (分钟 / halfLife)   —— 让情绪"越来越淡"
 *   保质期：now - setAt > expireMinutes → 直接归零 —— 让情绪"一定会没"
 * 半衰期是指数衰减，理论上永远到不了 0；halfLife 一大就会挂很久，所以必须有保质期兜底。
 */
function applyDecay(row, config, now) {
  const base = config.baseline
  if (!row || !row.emotion) {
    return { emotion: base, intensity: 0, setAt: null, updatedAt: now, expired: false }
  }

  const setAt = row.setAt ? new Date(row.setAt).getTime() : null
  const expireMs = (Number(config.expireMinutes) || 0) * 60000

  // ★ 老数据兜底：R16 之前写进去的行没有 setAt（当时还没有这一列）。
  //   不补的话这些行 TTL 永远为 null = 永不过期，正是要消灭的"僵尸情绪"。
  //   这里就地把锚点定成"现在"，让它从这一刻起最多再活一个保质期。
  //   （不能拿 updatedAt 当锚点——它每次读取都会被衰减回写刷新。）
  const anchoredSetAt =
    setAt == null && row.emotion !== base ? now : setAt

  // ★ 保质期优先于衰减：先看"是不是该过期了"
  if (expireMs > 0 && anchoredSetAt != null && now - anchoredSetAt >= expireMs) {
    return { emotion: base, intensity: 0, setAt: null, updatedAt: now, expired: true }
  }

  const prev = row.updatedAt ? new Date(row.updatedAt).getTime() : now
  const minutes = Math.max(0, (now - prev) / 60000)
  const halfLife = Math.max(1, config.halfLife)
  let intensity = (Number(row.intensity) || 0) * Math.pow(0.5, minutes / halfLife)

  let emotion = row.emotion
  let expired = false
  if (intensity < config.resetThreshold) {
    emotion = base
    intensity = 0
    expired = true
  }
  // 已经回到基线的行不再保留锚点
  const nextSetAt = emotion === base && intensity === 0 ? null : anchoredSetAt
  return { emotion, intensity, setAt: nextSetAt, updatedAt: now, expired }
}

async function readState(ctx, scopeKey, config) {
  const rows = await ctx.database.get(TABLE, { scopeKey })
  const row = rows[0]
  const now = Date.now()
  const state = applyDecay(row, config, now)

  // 惰性落盘：只有真的变了才写，避免每次渲染都产生写操作
  if (
    row &&
    (row.emotion !== state.emotion ||
      Math.abs((Number(row.intensity) || 0) - state.intensity) > 0.005 ||
      (row.setAt ? new Date(row.setAt).getTime() : null) !== state.setAt)
  ) {
    try {
      await writeState(ctx, config, scopeKey, state.emotion, state.intensity, {
        setAt: state.setAt,
        // 过期/衰减回基线时把"上次为什么有情绪"也一起抹掉，别留误导性的旧理由
        reason: isBaseline(state, config) ? null : row.reason,
      })
      if (config.debug && state.expired) {
        logger.debug('情绪已过期/衰减回基线 %s -> %s', scopeKey, state.emotion)
      }
    } catch (e) {
      logger.warn('衰减回写失败：%s', e.message)
    }
  }
  if (config.debug) {
    logger.debug('读取情绪 %s -> %s(%s)', scopeKey, state.emotion, state.intensity.toFixed(3))
  }
  return state
}

/**
 * 写情绪。
 *   opts.setAt —— TTL 锚点（毫秒时间戳或 null）。不传 = 用当前时间（= 刚被设置）。
 *   opts.reason —— 变化原因
 */
async function writeState(ctx, config, scopeKey, emotion, intensity, reasonOrOpts) {
  const opts =
    reasonOrOpts != null && typeof reasonOrOpts === 'object'
      ? reasonOrOpts
      : { reason: reasonOrOpts }
  const value = Math.max(0, Math.min(1, Number(intensity) || 0))
  const isBase = emotion === config.baseline && value === 0
  const setAt =
    opts.setAt === undefined ? (isBase ? null : new Date()) : opts.setAt
  await ctx.database.upsert(TABLE, [
    {
      scopeKey,
      emotion,
      intensity: value,
      reason: opts.reason === undefined ? null : opts.reason,
      setAt,
      updatedAt: new Date(),
    },
  ])
  if (config.debug) {
    logger.debug('写入情绪 %s -> %s(%s) %s', scopeKey, emotion, value.toFixed(3), opts.reason || '')
  }
  return { emotion, intensity: value, setAt: setAt ? new Date(setAt).getTime() : null }
}

/**
 * 后台清扫：由**插件逻辑代码**周期性执行，不依赖有没有人来读。
 *   - 该衰减的衰减，该过期的过期
 *   - 已经回到基线的行**直接删掉**（过期 = 物理上消失，不留下"僵尸情绪行"）
 * 返回 { scanned, expired, dropped }
 */
async function sweep(ctx, config, scopeKey) {
  const where = scopeKey ? { scopeKey } : {}
  let rows = []
  try {
    rows = await ctx.database.get(TABLE, where)
  } catch (e) {
    logger.warn('清扫时读表失败：%s', e.message)
    return { scanned: 0, expired: 0, dropped: 0 }
  }
  const now = Date.now()
  let expired = 0
  let dropped = 0
  for (const row of rows) {
    const state = applyDecay(row, config, now)
    if (isBaseline(state, config)) {
      try {
        await ctx.database.remove(TABLE, { scopeKey: row.scopeKey })
        dropped++
        if (state.expired) expired++
      } catch (e) {
        logger.warn('删除过期情绪失败 %s：%s', row.scopeKey, e.message)
      }
      continue
    }
    const changed =
      row.emotion !== state.emotion ||
      Math.abs((Number(row.intensity) || 0) - state.intensity) > 0.005
    if (changed) {
      try {
        await ctx.database.upsert(TABLE, [
          {
            scopeKey: row.scopeKey,
            emotion: state.emotion,
            intensity: state.intensity,
            reason: row.reason,
            setAt: state.setAt ? new Date(state.setAt) : null,
            updatedAt: new Date(now),
          },
        ])
      } catch (e) {
        logger.warn('清扫回写失败 %s：%s', row.scopeKey, e.message)
      }
    }
  }
  return { scanned: rows.length, expired, dropped }
}

/** 距离过期还剩多久（毫秒）；不过期/没有锚点返回 null */
function remainingMs(row, config) {
  const expireMs = (Number(config.expireMinutes) || 0) * 60000
  if (expireMs <= 0 || !row || !row.setAt) return null
  return Math.max(0, new Date(row.setAt).getTime() + expireMs - Date.now())
}

function formatRemaining(ms) {
  if (ms == null) return '不过期'
  const m = Math.floor(ms / 60000)
  if (m >= 60) return `${Math.floor(m / 60)} 小时 ${m % 60} 分`
  if (m >= 1) return `${m} 分 ${Math.floor((ms % 60000) / 1000)} 秒`
  return `${Math.floor(ms / 1000)} 秒`
}

// ---------------------------------------------------------------- 提示词变量

function describeState(state, config) {
  const def = (config.emotions || []).find((e) => e.name === state.emotion)
  const pct = Math.round(state.intensity * 100)
  if (state.emotion === config.baseline && state.intensity === 0) {
    return `${state.emotion}（基线状态）`
  }
  const how = def && def.desc ? `——${def.desc}` : ''
  return `${state.emotion}（强度 ${pct}%）${how}`
}

// ---------------------------------------------------------------- 应用

function apply(ctx, config) {
  // 1) 建表
  ctx.model.extend(
    TABLE,
    {
      scopeKey: { type: 'string', length: 128 },
      emotion: { type: 'string', length: 32, initial: '' },
      intensity: { type: 'float', initial: 0 },
      reason: { type: 'text', nullable: true },
      // ★ TTL 锚点：情绪"被设置"的时刻。绝不能用 updatedAt 代替——那个每次读取
      //   都会被惰性衰减回写刷新，拿它当锚点 = 情绪永远不会过期。
      setAt: { type: 'timestamp', nullable: true },
      updatedAt: { type: 'timestamp', nullable: true },
    },
    { primary: ['scopeKey'] }
  )

  // 2) 指令：查看 / 设置 / 列表
  ctx.command('emotion', '查看 bot 当前情绪').action(async ({ session }) => {
    const key = scopeKeyOf(session, config)
    const st = await readState(ctx, key, config)
    const pct = Math.round(st.intensity * 100)
    const rows = await ctx.database.get(TABLE, { scopeKey: key })
    const left = formatRemaining(remainingMs(rows[0], config))
    return [
      `当前情绪：${st.emotion}${pct > 0 ? `（强度 ${pct}%）` : ''}`,
      `作用域：${key}`,
      `距离过期：${left}（保质期 ${config.expireMinutes || 0} 分钟）`,
    ].join('\n')
  })

  // ★★ 子指令必须写**点号全名**（`emotion.set`），不能写 `emotion/set`：
  //   `ctx.command('a/b')` 注册出来的子指令名字只有 `b`（`ctx.command('a.b')` 才是整名 `a.b`），
  //   而 Commander 解析时是拿整名去 flat 的 `_commandList` 里查 `_aliases`
  //   （`@koishijs/core` core:1411 `get` / core:1432 `_resolve`）。
  //   所以 `/emotion.set` 会**完全没反应**（连 `command emotion` 都不打），只有 `/emotion` 能用。
  //   实测踩到：R11 的 `/scene.begin` 就是这么哑掉的。改之前先看这里。
  ctx
    .command('emotion.set <name:string> [intensity:number]', '设置 bot 当前情绪', { authority: 3 })
    .usage('强度 0~1，省略则按 1 计。例：/emotion.set 烦躁 0.8')
    .action(async ({ session }, name2, intensity) => {
      if (!name2) return '要指定情绪名。用 /emotion.list 看有哪些。'
      const def = (config.emotions || []).find((e) => e.name === name2)
      if (!def) return `没有「${name2}」这个情绪。用 /emotion.list 看有哪些。`
      const key = scopeKeyOf(session, config)
      const v = intensity == null ? 1 : intensity
      await writeState(ctx, config, key, name2, v, '手动指令设置')
      return `已把情绪设为「${name2}」，强度 ${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`
    })

  ctx.command('emotion.list', '列出所有可用情绪').action(() => {
    return (
      '可用情绪：\n' +
      (config.emotions || []).map((e) => `  ${e.name}  ${e.desc || ''}`).join('\n')
    )
  })

  ctx.command('emotion.reset', '把情绪重置回基线', { authority: 3 }).action(async ({ session }) => {
    const key = scopeKeyOf(session, config)
    await writeState(ctx, config, key, config.baseline, 0, '手动重置')
    return `已重置为「${config.baseline}」`
  })

  // R16：手动触发一次过期清扫（逻辑代码那套东西的人工按钮）
  ctx
    .command('emotion.sweep', '立刻清扫一次过期情绪', { authority: 3 })
    .action(async () => {
      const r = await sweep(ctx, config)
      return `清扫完成：扫了 ${r.scanned} 行，过期/回落 ${r.expired} 行，删除 ${r.dropped} 行。`
    })

  // R16：后台清扫 —— 纯逻辑代码，模型既不知道也影响不了。
  // ★ 用 ctx.setInterval（而不是 setInterval），插件卸载/重载时会被 cordis 自动清掉。
  if (Number(config.sweepSeconds) > 0) {
    const period = Number(config.sweepSeconds) * 1000
    ctx.setInterval(async () => {
      try {
        const r = await sweep(ctx, config)
        if (r.dropped > 0 && config.debug) {
          logger.debug('情绪清扫：删除 %d 行（过期 %d）', r.dropped, r.expired)
        }
      } catch (e) {
        logger.warn('情绪清扫出错：%s', e.message)
      }
    }, period)
    logger.info(
      '情绪过期已启用：保质期 %s 分钟，每 %s 秒清扫一次',
      config.expireMinutes || 0,
      config.sweepSeconds
    )
  } else {
    logger.info('情绪保质期 %s 分钟（后台清扫已关闭，只在读取时惰性衰减）', config.expireMinutes || 0)
  }

  // 3) 需要 chatluna 的部分：注入变量 + 注册工具
  ctx.inject(['chatluna'], (ctx2) => {
    const chatluna = ctx2.chatluna
    if (!chatluna) {
      logger.warn('chatluna 服务不可用，情绪变量与工具未注册')
      return
    }

    // 3a) 注入 {emotion()} 变量
    const renderer = chatluna.promptRenderer
    if (renderer && typeof renderer.registerFunctionProvider === 'function') {
      const provider = async (_args, _variables, configurable) => {
        const session = configurable?.session
        const key = scopeKeyOf(session, config)
        try {
          const st = await readState(ctx2, key, config)
          return describeState(st, config)
        } catch (e) {
          logger.warn('取情绪失败：%s', e.message)
          return config.baseline
        }
      }
      renderer.registerFunctionProvider(config.variableName || 'emotion', provider)
      logger.info('已注册情绪变量：{%s()}', config.variableName || 'emotion')
    } else {
      logger.warn('promptRenderer.registerFunctionProvider 不可用，情绪变量未注册')
    }

    // 3b) 注册原生工具，让模型自己改情绪
    if (!config.enableTool) return
    const platform = chatluna.platform
    if (!platform || typeof platform.registerTool !== 'function') {
      logger.warn('platform.registerTool 不可用，emotion_set 工具未注册')
      return
    }

    const names = (config.emotions || []).map((e) => e.name)
    if (names.length === 0) return
    const desc =
      '调整你自己当前的情绪状态。当你被对话内容影响到、心情发生变化时调用它。' +
      '只有真的产生情绪波动时才调用，不要每轮都调；情绪会随时间自动衰减回基线。'

    platform.registerTool(TOOL_NAME, {
      selector: () => true,
      authorization: () => true,
      description: desc,
      createTool: () =>
        new (class extends StructuredTool {
          name = TOOL_NAME
          description = desc
          schema = z.object({
            emotion: z.enum(names).describe('新的情绪'),
            intensity: z.number().min(0).max(1).describe('强度，0=几乎没有，1=非常强烈'),
            reason: z.string().optional().describe('为什么情绪变了，一句话'),
          })

          async _call(input, _manager, runnable) {
            const session = runnable?.configurable?.session
            const key = scopeKeyOf(session, config)
            await writeState(ctx2, config, key, input.emotion, input.intensity, input.reason)
            return `情绪已更新为「${input.emotion}」，强度 ${Math.round(input.intensity * 100)}%`
          }
        })(),
    })
    logger.info('已注册情绪工具：%s（可选情绪 %d 个）', TOOL_NAME, names.length)
  })
}

module.exports = { name, inject, Config, apply }
