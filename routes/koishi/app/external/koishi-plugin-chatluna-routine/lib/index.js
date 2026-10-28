/**
 * koishi-plugin-chatluna-routine —— 作息表（让 bot 有点生活气息）
 *
 * ============================================================================
 * 为什么要有它
 * ============================================================================
 * 原来只有 chatluna-proactive 的一个全局 `quietHours`（01:00-08:00）：那是"别出声"，
 * 不是"我在睡觉"。于是半夜被 @ 时，bot 跟白天一样精神 —— 群友觉得它是个 24 小时在线的客服。
 *
 * 这个插件把一天切成若干个**生活时段**，干三件事：
 *   1. 转换的那一刻，把生活事件**写进情景记忆**（chatluna-episode）：
 *      「我先去吃饭啦！」「我睡醒了。」—— 于是 {episode()} 里能看到"自己"说过这句话，
 *      过一会儿回来聊天时它记得自己刚去干嘛了。★ 默认**不真的发到群里**（见 announce）。
 *   2. 提供 {routine()} 变量：现在几点、你在哪个时段、这个时段到几点、
 *      **是不是被硬叫醒的**、今天的完整安排。模型据此决定语气（生气/迷糊/敷衍都行）。
 *   3. 给别的插件提供 `isQuiet()`：睡觉时段里主动插话/自动跟进要闭嘴。
 *
 * ============================================================================
 * 三条设计上的取舍（都踩过或想清楚了才这么写）
 * ============================================================================
 *   · **不外部改情绪**。被吵醒该不该生气，由对话模型自己调 emotion_set 决定
 *     （上一轮已经明确把情绪交还给它了）。这里只给事实，不给情绪。
 *   · **重启不补注入**。Koishi 重启后当前时段算"本来就在这个时段"，不补发进入语 ——
 *     否则每次重启群里就会冒一句"我去吃饭了"，那是 bug 不是生活气息。
 *   · **错过太久不补**。宕机 5 小时后已经过了饭点，再补一句"我去吃饭了"是穿越。
 *     超过 catchUpMinutes 的转换只更新状态、不写记忆。
 */

const { Schema, Logger } = require('koishi')

const name = 'chatluna-routine'
const inject = { required: [], optional: ['chatluna'] }
const logger = new Logger('chatluna-routine')

const KINDS = [
  { value: 'sleep', label: '睡觉' },
  { value: 'meal', label: '吃饭' },
  { value: 'work', label: '忙' },
  { value: 'free', label: '空闲' },
]

const Config = Schema.intersect([
  Schema.object({
    enabled: Schema.boolean().default(true).description('总开关'),
    blocks: Schema.array(
      Schema.object({
        id: Schema.string().description('时段标识（英文，日志和 /routine 里用），例如 sleep / lunch'),
        label: Schema.string().description('中文名，例如 睡觉 / 午饭'),
        kind: Schema.union(KINDS.map((k) => Schema.const(k.value).description(k.label)))
          .default('free')
          .description('时段类型：sleep 会被 isQuiet 认成"别出声"'),
        start: Schema.string().description('开始时间 HH:MM'),
        end: Schema.string().description('结束时间 HH:MM（小于 start 表示跨零点，例如 23:30~08:00）'),
        enterText: Schema.string()
          .default('')
          .description('进入这个时段时，作为"你自己说的话"写进情景记忆（会显示成 你（大肥鱼）: …）。留空 = 不写'),
        exitText: Schema.string()
          .default('')
          .description('离开这个时段时写进情景记忆的话。留空 = 不写'),
        jitterMinutes: Schema.natural()
          .min(0)
          .default(0)
          .description('起止时间每天前后浮动 ±N 分钟（同一天内固定，不会每次心跳都漂）。像真人一样不卡点'),
        quiet: Schema.boolean()
          .default(false)
          .description('这个时段是否压制主动插话/自动跟进（睡觉时段建议开）'),
        announce: Schema.boolean()
          .default(false)
          .description('★ 是否把 enter/exit 真的发到群里（默认只进记忆不出声）。开了要配 announceGroups'),
      })
    )
      .role('table')
      .default([
        {
          id: 'sleep',
          label: '睡觉',
          kind: 'sleep',
          start: '23:30',
          end: '08:00',
          enterText: '我先去睡了……别吵我。',
          exitText: '我睡醒了。',
          jitterMinutes: 25,
          quiet: true,
          announce: false,
        },
        {
          id: 'lunch',
          label: '午饭',
          kind: 'meal',
          start: '12:00',
          end: '12:40',
          enterText: '我先去吃饭啦！这个你测一下~',
          exitText: '吃完了，回来啦。',
          jitterMinutes: 15,
          quiet: false,
          announce: false,
        },
        {
          id: 'dinner',
          label: '晚饭',
          kind: 'meal',
          start: '18:30',
          end: '19:10',
          enterText: '到饭点了，我先去吃饭。',
          exitText: '吃完了。',
          jitterMinutes: 15,
          quiet: false,
          announce: false,
        },
      ])
      .description('作息表。时段之间留空的时间就是"醒着、手头没事"'),
    announceGroups: Schema.array(Schema.string())
      .role('table')
      .default([])
      .description('announce=true 的时段往这些群发（群号）。留空 = 一个都不发，只进记忆'),
    catchUpMinutes: Schema.natural()
      .default(20)
      .description('转换已经过去超过这么多分钟就不补写记忆（只更新状态）。防止宕机后"补播"出穿越的台词'),
    tickSeconds: Schema.natural().default(30).description('多久检查一次时段切换'),
    variableName: Schema.string().default('routine').description('预设里引用的函数名，写作 {routine()}。★ 只能 ASCII'),
    debug: Schema.boolean().default(true).description('打印时段切换与记忆注入的细节'),
  }),
])

// ------------------------------------------------------------------ 时间工具

function parseHHMM(s) {
  const m = /^\s*(\d{1,2})\s*[:：]\s*(\d{1,2})\s*$/.exec(String(s ?? ''))
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (h > 23 || mi > 59) return null
  return h * 60 + mi
}

function hhmm(minutes) {
  const m = ((minutes % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/** 当天的日期键（本地时区），抖动按它固定 */
function dateKey(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 稳定的字符串散列（同一天同一个时段永远得到同一个抖动，重启也不变） */
function hash32(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** 把 "HH:MM + 抖动" 化成当天的绝对分钟数，并处理跨零点 */
function blockWindow(block, dayStart, key) {
  const s = parseHHMM(block.start)
  const e = parseHHMM(block.end)
  if (s === null || e === null) return null
  const jitter = Number(block.jitterMinutes) || 0
  let off = 0
  if (jitter > 0) {
    const span = jitter * 2 + 1
    off = (hash32(`${key}|${block.id}|${block.start}`) % span) - jitter
  }
  const start = s + off
  let end = e + off
  const overnight = e <= s
  if (overnight) end += 1440
  return { start, end, overnight, offset: off }
}

// ------------------------------------------------------------------ 应用

function apply(ctx, config) {
  const log = (...a) => config.debug && logger.info(...a)

  /** 规范化 + 过滤掉时间写错的时段（写错了就跳过它，不能让整个插件挂掉） */
  const blocks = (config.blocks || [])
    .filter((b) => b && b.id && parseHHMM(b.start) !== null && parseHHMM(b.end) !== null)
    .map((b) => ({ ...b, id: String(b.id) }))
  for (const b of config.blocks || []) {
    if (b && b.id && parseHHMM(b.start) === null) logger.warn('时段 %s 的 start 不合法，已跳过', b.id)
  }

  /**
   * 某个时刻落在哪个时段。跨零点的时段要**跨两天**看：
   * 03:00 落在昨天 23:30 开始的 sleep 里，所以昨天和今天都要算一遍。
   */
  function stateAt(now) {
    const d = new Date(now)
    const today = new Date(d.getFullYear(), d.getMonth(), d.getDate())
    const yesterday = new Date(today.getTime() - 86400000)
    let best = null
    for (const [base, key] of [
      [yesterday, dateKey(yesterday)],
      [today, dateKey(today)],
    ]) {
      const baseMin = base.getTime() / 60000
      const nowMin = d.getTime() / 60000
      for (const b of blocks) {
        const w = blockWindow(b, base, key)
        if (!w) continue
        const absStart = baseMin + w.start
        const absEnd = baseMin + w.end
        if (nowMin >= absStart && nowMin < absEnd) {
          if (!best || absStart > best.absStart) {
            best = {
              id: b.id,
              label: b.label || b.id,
              kind: b.kind || 'free',
              quiet: !!b.quiet,
              enterText: b.enterText || '',
              exitText: b.exitText || '',
              // ★★ 单位：**毫秒**。第一版这里存的是"epoch 分钟"（baseMin + w.start），
              //   而 tick() 里算的是 `(now - cur.absStart) / 60000`（now 是毫秒）——
              //   两个单位一混，任何"进入某个时段"的转换都会算出 2 千万分钟，
              //   直接命中 tooLate 分支 → **进入语永远不写记忆**。
              //   生产实测（2026-10-04 11:46）：「作息切换：awake → 午饭，已开始 29850929 分钟
              //   （★ 错过太久，只更新状态、不写记忆）」—— 29850929 分钟 ≈ 56 年，就是它。
              //   只有"离开时段 → 醒着"那一侧是对的（醒着的 absStart 是 null），
              //   所以 07:48「我睡醒了。」/ 12:26「吃完了，回来啦。」都正常，
              //   唯独 11:46「我先去吃饭啦」被吞掉 —— 这类"只有一半生效"的 bug 最容易被放过。
              absStart: absStart * 60000,
              absEnd: absEnd * 60000,
            }
          }
        }
      }
    }
    if (best) {
      // startedAt / endsAt 是**日期对象**（absStart 已经是毫秒），渲染与 humanSpan 都靠它
      best.startedAt = new Date(best.absStart)
      best.endsAt = new Date(best.absEnd)
      return best
    }
    return {
      id: 'awake',
      label: '醒着',
      kind: 'free',
      quiet: false,
      enterText: '',
      exitText: '',
      absStart: null,
      absEnd: null,
      startedAt: null,
      endsAt: null,
    }
  }

  /** 今天剩下的安排（含正在进行的那个），用来渲染 {routine()} */
  function todayPlan(now) {
    const d = new Date(now)
    const today = new Date(d.getFullYear(), d.getMonth(), d.getDate())
    const yesterday = new Date(today.getTime() - 86400000)
    const key = dateKey(today)
    const baseMin = today.getTime() / 60000
    const nowMin = d.getTime() / 60000
    const list = []
    for (const b of blocks) {
      const w = blockWindow(b, today, key)
      if (!w) continue
      // 今天凌晨那一段属于"昨天开始"的时段（例如睡觉）：按**昨天**的抖动算，
      // 否则同一次睡眠在两处显示的时间会差一个抖动（最多 ±25 分钟，事后极难查）
      if (w.overnight && nowMin < baseMin + w.end) {
        const y = blockWindow(b, yesterday, dateKey(yesterday))
        list.unshift({
          label: b.label || b.id,
          from: '昨天 ' + hhmm(y.start),
          to: hhmm(y.end),
          running: true,
        })
        continue
      }
      if (w.start >= 1440) continue
      list.push({
        label: b.label || b.id,
        from: hhmm(w.start),
        to: hhmm(w.end),
        running: nowMin >= baseMin + w.start && nowMin < baseMin + w.end,
      })
    }
    return list
  }

  /** 相对时长：3 小时 42 分 */
  function humanSpan(ms) {
    const min = Math.max(0, Math.round(ms / 60000))
    if (min < 1) return '刚开始'
    if (min < 60) return `${min} 分钟`
    const h = Math.floor(min / 60)
    const m = min % 60
    return m ? `${h} 小时 ${m} 分` : `${h} 小时`
  }

  // ------------------------------------------------------------ 状态机

  let last = { id: null, absStart: null, checkedAt: 0 }

  const episode = () => {
    try {
      return ctx.get('chatluna_episode') || null
    } catch {
      return null
    }
  }

  /** 往情景记忆里写一条"bot 自己说的话"（广播到所有群会话） */
  async function remember(text, now) {
    const api = episode()
    if (!api || typeof api.broadcastBotLine !== 'function') {
      logger.warn('chatluna-episode 不可用，作息事件没写进记忆：%s', text)
      return { scopes: 0, written: 0 }
    }
    try {
      const r = await api.broadcastBotLine(text, { ts: now, kind: 'life' })
      log('作息事件进记忆（%d/%d 个会话）：%s', r.written, r.scopes, text)
      return r
    } catch (e) {
      logger.warn('写作息事件失败：%s', e.message)
      return { scopes: 0, written: 0 }
    }
  }

  /** 真发到群里（announce=true 的时段才走这里） */
  async function announce(text) {
    if (!config.announceGroups?.length) return
    for (const gid of config.announceGroups) {
      try {
        const bot =
          (ctx.bots || []).find((b) => String(b.platform) === 'onebot') || (ctx.bots || [])[0]
        await bot?.sendMessage(String(gid), text)
        log('作息播报 → 群 %s：%s', gid, text)
      } catch (e) {
        logger.warn('作息播报失败（群 %s）：%s', gid, e.message)
      }
    }
  }

  async function tick(now = Date.now(), { startup = false } = {}) {
    if (!config.enabled) return
    const cur = stateAt(now)
    const prev = last
    last = { id: cur.id, absStart: cur.absStart, checkedAt: now }
    if (prev.id === null) return // 本进程第一次：只认状态，不补台词
    if (prev.id === cur.id) return

    const prevLabel = prev.id
    const lateMin = cur.absStart ? (now - cur.absStart) / 60000 : 0
    const tooLate = lateMin > config.catchUpMinutes
    logger.info(
      '作息切换：%s → %s%s（%s）',
      prevLabel,
      cur.label,
      cur.absStart ? `，已开始 ${Math.round(lateMin)} 分钟` : '',
      tooLate ? '★ 错过太久，只更新状态、不写记忆' : '写入记忆'
    )
    if (startup || tooLate) return
    // ★ 离开上个时段的那句话要去 blocks 里按 id 找 —— `last` 里只存了 id/absStart，
    //   直接读 `prev.exitText` 会拿到 undefined（第一版就是这么写的，静默不写"我睡醒了"）。
    const prevBlock = blocks.find((b) => b.id === prev.id)
    if (prevBlock?.exitText) await remember(prevBlock.exitText, now)
    if (cur.enterText) {
      await remember(cur.enterText, now)
      if (!cur.quiet) await announce(cur.enterText)
    }
  }

  // 启动时不补台词：只把当前状态记下来
  tick(Date.now(), { startup: true }).catch(() => {})
  ctx.setInterval(() => {
    tick().catch((e) => logger.warn('作息心跳出错：%s', e.message))
  }, Math.max(5, config.tickSeconds) * 1000)

  // ------------------------------------------------------------ 对外接口

  ctx.set('chatluna_routine', {
    /** 当前时段 */
    state: (now = Date.now()) => stateAt(now),
    /** 现在是"别出声"的时段吗（chatluna-proactive / chatluna-followup 用） */
    isQuiet: (now = Date.now()) => !!stateAt(now).quiet,
    /** 一行式状态，给日志/指令用 */
    summary(now = Date.now()) {
      const s = stateAt(now)
      return s.absStart
        ? `${s.label}（${hhmm(new Date(s.absStart).getHours() * 60 + new Date(s.absStart).getMinutes())} 起，还有 ${humanSpan(s.endsAt - now)} 结束）`
        : '醒着（没有作息时段）'
    },
    /** 手动触发一次检查（测试用） */
    tick: (now) => tick(now ?? Date.now()),
  })

  // ------------------------------------------------------------ {routine()} 变量

  ctx.inject(['chatluna'], (ctx2) => {
    const renderer = ctx2.chatluna?.promptRenderer
    if (!renderer || typeof renderer.registerFunctionProvider !== 'function') {
      logger.warn('promptRenderer 不可用，{routine()} 未注册')
      return
    }
    renderer.registerFunctionProvider(config.variableName || 'routine', async () => {
      const now = Date.now()
      const s = stateAt(now)
      const d = new Date(now)
      const p = (n) => String(n).padStart(2, '0')
      const clk = `${p(d.getHours())}:${p(d.getMinutes())}`
      const out = [`【你现在的时间表】现在是 ${p(d.getMonth() + 1)}-${p(d.getDate())} ${clk}`]
      if (s.kind === 'sleep') {
        const st = new Date(s.startedAt)
        const en = new Date(s.endsAt)
        out.push(
          `★ 你正在【${s.label}】（${p(st.getHours())}:${p(st.getMinutes())} 上床，` +
            `睡到 ${p(en.getHours())}:${p(en.getMinutes())}，已经睡了 ${humanSpan(now - s.startedAt)}）。`
        )
        out.push(
          '正常这个点你根本不该出声 —— 如果现在有人找你，说明你是**被硬叫醒的**。' +
            '按你的性格反应就行（迷糊、不爽、先抱怨一句再干活、或者干脆怼回去），别装作没事；' +
            '真被吵烦了就把心情也改掉（emotion_set），别只在嘴上凶。但也别真的骂人。'
        )
      } else if (s.absStart) {
        out.push(
          `你现在在【${s.label}】（${p(new Date(s.startedAt).getHours())}:${p(
            new Date(s.startedAt).getMinutes()
          )} 开始，还有 ${humanSpan(s.endsAt - now)} 结束）。`
        )
      } else {
        out.push('你现在醒着、手头没什么事。')
      }
      const plan = todayPlan(now)
      if (plan.length) {
        out.push(
          '今天的安排：' +
            plan.map((x) => `${x.from}~${x.to} ${x.label}${x.running ? '（正在）' : ''}`).join(' → ')
        )
      }
      out.push(
        '这些是你自己的生活节奏，不是别人给的设定：别在睡觉时说"我刚睡醒"，也别在饭点前说"我刚吃完"。'
      )
      const text = out.join('\n')
      // 每次渲染留一行证据：注入到底有没有生效，只看"变量注册成功"是不够的
      log('{%s()} 被渲染：%s，%d 字', config.variableName || 'routine', s.label, text.length)
      return text
    })
    logger.info('已注册作息变量：{%s()}（%d 个时段）', config.variableName || 'routine', blocks.length)
  })

  // ------------------------------------------------------------ 指令

  ctx
    .command('routine.status', '看作息表与当前所处时段', { authority: 2 })
    .action(async () => {
      const now = Date.now()
      const s = stateAt(now)
      const d = new Date(now)
      const p = (n) => String(n).padStart(2, '0')
      const lines = [
        `【作息表】现在 ${p(d.getHours())}:${p(d.getMinutes())}，共 ${blocks.length} 个时段`,
        `当前：${s.absStart ? `${s.label}（${s.kind}）${s.quiet ? '｜★ 静默时段' : ''}` : '醒着（空闲）'}`,
      ]
      if (s.absStart) {
        lines.push(`  本时段：${new Date(s.startedAt).toLocaleString()} 起，还有 ${humanSpan(s.endsAt - now)} 结束`)
      }
      lines.push('')
      for (const b of blocks) {
        const w = blockWindow(b, new Date(d.getFullYear(), d.getMonth(), d.getDate()), dateKey(d))
        lines.push(
          `· ${b.label || b.id}（${b.id}｜${b.kind}）${hhmm(w.start)}~${hhmm(w.end)}` +
            `${w.offset ? `（今天抖动 ${w.offset > 0 ? '+' : ''}${w.offset} 分）` : ''}` +
            `${b.quiet ? '｜静默' : ''}${b.announce ? '｜播报' : ''}`
        )
        if (b.enterText) lines.push(`    进入：${b.enterText}`)
        if (b.exitText) lines.push(`    离开：${b.exitText}`)
      }
      const api = episode()
      lines.push('')
      lines.push(`记忆注入：${api ? '可用（chatluna-episode）' : '★ 不可用，作息事件不会进对话历史'}`)
      lines.push(`播报群：${config.announceGroups?.length ? config.announceGroups.join(', ') : '（无，只进记忆不出声）'}`)
      return lines.join('\n')
    })

  ctx
    .command('routine.push <text:text>', '手动往对话历史里写一条"自己说过的话"（测试注入用）', {
      authority: 3,
    })
    .action(async (_a, text) => {
      const t = String(text || '').trim()
      if (!t) return '要写什么？'
      const r = await remember(t, Date.now())
      return r.written
        ? `已写进 ${r.written} 个群会话的情景记忆：${t}`
        : `没写进去（情景记忆不可用，或还没有任何群会话记录）。scopes=${r.scopes}`
    })

  logger.info(
    '作息表已就绪：%d 个时段（%s）；静默时段 %d 个',
    blocks.length,
    blocks.map((b) => b.id).join('/') || '无',
    blocks.filter((b) => b.quiet).length
  )
}

module.exports = { name, inject, Config, apply }
