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

/** 对一行记录施加时间衰减，返回当前真实状态 */
function applyDecay(row, config, now) {
  const base = config.baseline
  if (!row || !row.emotion) {
    return { emotion: base, intensity: 0, updatedAt: now }
  }
  const prev = row.updatedAt ? new Date(row.updatedAt).getTime() : now
  const minutes = Math.max(0, (now - prev) / 60000)
  const halfLife = Math.max(1, config.halfLife)
  let intensity = (Number(row.intensity) || 0) * Math.pow(0.5, minutes / halfLife)

  let emotion = row.emotion
  if (intensity < config.resetThreshold) {
    emotion = base
    intensity = 0
  }
  return { emotion, intensity, updatedAt: now }
}

async function readState(ctx, scopeKey, config) {
  const rows = await ctx.database.get(TABLE, { scopeKey })
  const row = rows[0]
  const now = Date.now()
  const state = applyDecay(row, config, now)

  // 惰性落盘：只有真的变了才写，避免每次渲染都产生写操作
  if (row && (row.emotion !== state.emotion || Math.abs((Number(row.intensity) || 0) - state.intensity) > 0.005)) {
    try {
      await ctx.database.upsert(TABLE, [
        { scopeKey, emotion: state.emotion, intensity: state.intensity, updatedAt: new Date(now) },
      ])
    } catch (e) {
      logger.warn('衰减回写失败：%s', e.message)
    }
  }
  if (config.debug) {
    logger.debug('读取情绪 %s -> %s(%s)', scopeKey, state.emotion, state.intensity.toFixed(3))
  }
  return state
}

async function writeState(ctx, config, scopeKey, emotion, intensity, reason) {
  const value = Math.max(0, Math.min(1, Number(intensity) || 0))
  await ctx.database.upsert(TABLE, [
    {
      scopeKey,
      emotion,
      intensity: value,
      reason: reason || null,
      updatedAt: new Date(),
    },
  ])
  if (config.debug) {
    logger.debug('写入情绪 %s -> %s(%s) %s', scopeKey, emotion, value.toFixed(3), reason || '')
  }
  return { emotion, intensity: value }
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
      updatedAt: { type: 'timestamp', nullable: true },
    },
    { primary: ['scopeKey'] }
  )

  // 2) 指令：查看 / 设置 / 列表
  ctx.command('emotion', '查看 bot 当前情绪').action(async ({ session }) => {
    const key = scopeKeyOf(session, config)
    const st = await readState(ctx, key, config)
    const pct = Math.round(st.intensity * 100)
    return `当前情绪：${st.emotion}${pct > 0 ? `（强度 ${pct}%）` : ''}\n作用域：${key}`
  })

  ctx
    .command('emotion/set <name:string> [intensity:number]', '设置 bot 当前情绪', { authority: 3 })
    .usage('强度 0~1，省略则按 1 计。例：/emotion/set 烦躁 0.8')
    .action(async ({ session }, name2, intensity) => {
      if (!name2) return '要指定情绪名。用 /emotion/list 看有哪些。'
      const def = (config.emotions || []).find((e) => e.name === name2)
      if (!def) return `没有「${name2}」这个情绪。用 /emotion/list 看有哪些。`
      const key = scopeKeyOf(session, config)
      const v = intensity == null ? 1 : intensity
      await writeState(ctx, config, key, name2, v, '手动指令设置')
      return `已把情绪设为「${name2}」，强度 ${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`
    })

  ctx.command('emotion/list', '列出所有可用情绪').action(() => {
    return (
      '可用情绪：\n' +
      (config.emotions || []).map((e) => `  ${e.name}  ${e.desc || ''}`).join('\n')
    )
  })

  ctx.command('emotion/reset', '把情绪重置回基线', { authority: 3 }).action(async ({ session }) => {
    const key = scopeKeyOf(session, config)
    await writeState(ctx, config, key, config.baseline, 0, '手动重置')
    return `已重置为「${config.baseline}」`
  })

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
