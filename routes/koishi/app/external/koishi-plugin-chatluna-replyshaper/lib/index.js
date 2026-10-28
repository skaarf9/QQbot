/**
 * koishi-plugin-chatluna-replyshaper —— 回复整形
 *
 * 解决两件事（都在"发送口"动手，因为这里是所有出站消息的**唯一必经之路**，
 * 普通回复、R9 主动插话、指令回执都会经过它）：
 *
 *   1. **去掉空行**：模型偶尔会在回复里吐出一个空行（两段之间多个 \n），
 *      在 QQ 上表现为一条消息中间空一行，很出戏。这里把连续的换行压成一个，
 *      再去掉首尾换行；整段变空的文本元素直接丢掉。
 *
 *   2. **"是否回复"判断**（R9 的插话时机 / 生气时不说话）：
 *      预设里告诉模型「这一轮不想说话就只输出 `[SKIP]`」。
 *      本插件在发送口看到整条消息**只有**这个哨兵时，取消发送。
 *      —— 模型因此可以"攒着一句话不说"，用于择机插话与赌气沉默。
 *
 * 挂载点：`before-send`（@satorijs/core MessageEncoder，见 core:752）
 *   - 签名 `(session, options)`；**返回非空即取消发送**（encode 里 `return []`）。
 *   - 此时 `session.elements` 已经被 `session.transform()` 建好，
 *     改它就能改实际发出去的内容（render 在 before-send 之后才跑）。
 *   - `session.elements` 有 setter，直接整体替换最省事。
 *
 * 与 chatluna-guard 的关系：guard 的 `before-send` 是"屏蔽总闸"（静默/限流），
 * 本插件是"内容整形"，两者互不干扰；guard 自己的开关回执带 `__guardControl` 标记，
 * 本插件对带标记的消息**只清理空行、不做哨兵判定**，避免误吞回执。
 */

const { Schema, Logger, h } = require('koishi')

const name = 'chatluna-replyshaper'
const inject = { required: [] }
const logger = new Logger('chatluna-replyshaper')

// 归一化一个候选哨兵：去掉空白与常见标点，转小写
const normalizeToken = (s) =>
  String(s ?? '')
    .replace(/[\s，,。.、！!？?~～…；;：:【】\[\]（）()「」“”"']/g, '')
    .toLowerCase()

const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('总开关'),
  cleanBlankLines: Schema.boolean()
    .default(true)
    .description('去掉回复里的空行（连续换行压成一个，并去掉首尾换行）'),
  stripTrailingSpaces: Schema.boolean()
    .default(true)
    .description('去掉每行末尾的多余空格（QQ 里看不见，但会让排版变乱）'),
  skipTokens: Schema.array(Schema.string())
    .role('table')
    .default(['[SKIP]', '【不回复】', '（不回复）'])
    .description(
      '「这轮不回复」哨兵。模型整条回复**只**等于其中之一时，取消发送。' +
        '比较时会忽略空白与标点。改这里的同时记得同步改预设里的说法。'
    ),
  skipWhenEmpty: Schema.boolean()
    .default(true)
    .description('整形之后整条消息空了，就不发（避免 QQ 上出现一条空消息）'),
  debug: Schema.boolean().default(false).description('打印每次整形与哨兵命中'),
})

function apply(ctx, config) {
  const cfg = {
    enabled: true,
    cleanBlankLines: true,
    stripTrailingSpaces: true,
    skipTokens: ['[SKIP]', '【不回复】', '（不回复）'],
    skipWhenEmpty: true,
    debug: false,
    ...(config ?? {}),
  }

  const log = (...a) => cfg.debug && logger.info(...a)
  const normalizedSkip = new Set((cfg.skipTokens || []).map(normalizeToken).filter(Boolean))

  const textOf = (el) => (el?.type === 'text' ? String(el?.attrs?.content ?? '') : null)

  /** 清理一段文本：去行尾空格 → 压掉空行 → 去首尾换行 */
  function shape(text) {
    let s = String(text)
    if (cfg.stripTrailingSpaces) s = s.replace(/[ \t]+$/gm, '')
    if (cfg.cleanBlankLines) s = s.replace(/\n{2,}/g, '\n')
    if (cfg.cleanBlankLines) s = s.replace(/^\n+|\n+$/g, '')
    return s
  }

  ctx.on('before-send', (session) => {
    try {
      if (!cfg.enabled || !session) return
      const els = session.elements
      if (!Array.isArray(els) || els.length === 0) return

      const textParts = els.map(textOf)
      const allText = textParts.every((v) => v !== null)

      // ---- 2) 哨兵：整条消息只有文本、且归一化后等于某个"不回复"标记 → 取消发送 ----
      // 带 __guardControl 标记的是 guard 自己的开关回执，绝不当成哨兵吞掉。
      if (allText && !session.__guardControl) {
        const joined = textParts.join('\n').trim()
        if (joined && normalizedSkip.has(normalizeToken(joined))) {
          log('模型选择不回复（命中哨兵「%s」），取消发送', joined.slice(0, 24))
          return true
        }
      }

      // ---- 1) 去空行：逐段整形，空的文本元素丢掉 ----
      const next = []
      let changed = false
      for (let i = 0; i < els.length; i++) {
        const el = els[i]
        const raw = textParts[i]
        if (raw === null) {
          next.push(el)
          continue
        }
        const cleaned = shape(raw)
        if (cleaned !== raw) changed = true
        if (cleaned.length === 0) {
          changed = true
          continue // 整段变空 → 丢掉这个元素
        }
        next.push(cleaned === raw ? el : h('text', { content: cleaned }))
      }

      if (!changed) return

      if (next.length === 0) {
        if (cfg.skipWhenEmpty) {
          log('整形后整条消息为空，取消发送')
          return true
        }
        return
      }

      session.elements = next
      log('已整形：%d 个元素 → %d 个', els.length, next.length)
    } catch (e) {
      logger.warn('回复整形出错（放行原样）：%s', e.message)
    }
  })

  ctx.command('replyshaper', '回复整形：状态与自检', { authority: 3 }).action(() => [
    `回复整形：${cfg.enabled ? '开' : '关'}`,
    `去空行：${cfg.cleanBlankLines ? '开' : '关'}｜去行尾空格：${cfg.stripTrailingSpaces ? '开' : '关'}`,
    `不回复哨兵（共 ${normalizedSkip.size} 个）：${[...normalizedSkip].join(' / ')}`,
    `整形后为空则不发：${cfg.skipWhenEmpty ? '开' : '关'}`,
  ])

  logger.info(
    '回复整形已挂载（去空行 %s；哨兵 %d 个）',
    cfg.cleanBlankLines ? '开' : '关',
    normalizedSkip.size
  )
}

module.exports = { name, inject, Config, apply }
