/**
 * koishi-plugin-chatluna-help —— 指令帮助体系（三级图片）
 *
 * 需求（用户原话，2026-10-03）：
 *   「我私聊过 bot，可以看到命令主要以文字形式返回，而且不好看……目前的命令似乎不是
 *     完整的命令，补全一下并按类型逐级展示」
 *
 * ★ 为什么必须重写而不是改文案
 *   原来 `/help` 打印的是 `qqbot-auth` 里**手写的 8 行字**，只覆盖 `qqbot.*`。
 *   而运行期指令表实际有 **135 条**（含 ChatLuna / 表情包 / 好感度 / 记忆 …）。
 *   手写清单必然越写越旧，所以这里**不在代码里列指令** —— 一律从
 *   `ctx.$commander._commandList` 现场枚举。装一个新插件，帮助页自动多出它的指令。
 *
 * ★ 四级结构（用户要的「按类型逐级展示」+ 2026-10-03 要的「别名抽象层」）
 *   ① `/help`              → 常用页：**只列别名**（英文单词），来自 chatluna-alias
 *   ② `/help -all`         → 总览：全部原始指令有哪些类目、各多少条、我能不能用
 *   ③ `/help <类目>`       → 类目页：这一类里每条指令一行，分页
 *   ④ `/help <指令|别名>`  → 详情页：用法、参数、选项、等级、原名与别名的对应
 *   每一页底部都写着「下一步发什么」，这样用户不用记语法。
 *
 *   ★ 为什么首页要换成别名层（用户原话）
 *     「现在的命令列表的命令有前缀，有的甚至使用的发 "xingyuan" 这个过时的名称前缀……
 *      只有那些可能经常用到的命令才列出来；只显示别名（英文，一个单词，不重复）」。
 *     147 条里绝大多数是诊断/运维指令，一次性用完就再也不敲；首页全列出来等于没重点。
 *     别名表在 chatluna-alias 里维护（一处配置），这边只负责**读它、画它**；
 *     读不到服务就退回原来的全量总览 —— 少装一个插件也不会开天窗。
 *
 * ★ 等级怎么算（别只读自己的）
 *   一个指令的**有效门槛 = 它自己与所有祖先指令上 `authority:N` 的最大值**
 *   （`@koishijs/core` 判定时整条链都要过）。所以这里沿 `cmd.parent` 往上取最大，
 *   和 `qqbot-auth` 的 `effectiveLevel()` 是同一套算法 —— 那边管**提权**，这边管**展示**，
 *   两边必须同源，否则帮助页会显示错的等级。
 *
 * ★ 注册名用 `help`，并**要求关掉 `@koishijs/plugin-help`**
 *   实测框架那个 help 插件会注册 `ctx.command("help [command:string]", {authority:0})`
 *   （`@koishijs/plugin-help/lib/index.js:129`）。两个 help 撞在一起时，命令的多个 action
 *   是**按顺序取第一个非空返回**，所以谁先谁生效 —— 留着它我们这个 action 可能永远不执行。
 *   已在 `koishi.yml` 里摘掉 `help:`，并在启动时自检 `help` 到底解析到谁。
 */

const { Schema, Logger } = require('koishi')

const name = 'chatluna-help'
const inject = { required: [], optional: ['chatlunaPage', 'qqbotGuard', 'chatlunaAlias'] }
const logger = new Logger('help')

/** 五级权限的展示名（与 qqbot-auth 的 LEVEL_NAMES 保持一致） */
const LEVEL_NAMES = { 0: '拉黑', 1: '普通', 2: '信任', 3: '管理员', 4: '主人' }
/** 没声明 authority 的指令走 Koishi 的默认值（Schema.natural().default(1)） */
const DEFAULT_LEVEL = 1

const DEFAULT_CATEGORIES = [
  { id: 'auth', name: '权限与身份', prefixes: ['qqbot'] },
  { id: 'memory', name: '长期记忆', prefixes: ['chatluna.memory', 'chatluna_long_memory'] },
  // ★ affinity 的指令根是**它配置里的 scopeId**，不是插件名 —— 它拿 scopeId 当命名空间
  //   （koishi.yml: `chatluna-affinity.scopeId: affinity`）。
  //   2026-10-04 之前那个 scopeId 叫 `xingyuan`（小号的旧名"星源"），按用户要求换成了
  //   功能性名字 `affinity`；这里连同下面 alias 的 target 一起改，别只改一半。
  { id: 'affinity', name: '好感度', prefixes: ['affinity'] },
  { id: 'chat', name: '对话与模型', prefixes: ['chatluna'] },
  { id: 'media', name: '表情包与图片', prefixes: ['sticker', 'vision', 'emojiluna'] },
  { id: 'emotion', name: '情绪与人格', prefixes: ['emotion'] },
  { id: 'guard', name: '群管理与限流', prefixes: ['guard'] },
  { id: 'interact', name: '互动与剧情', prefixes: ['scene', 'proactive', 'followup', 'focus', 'episode'] },
  // ★ 第九轮（2026-10-04）：人设卡片（chatluna-persona）与作息表（chatluna-routine）。
  //   这两类原来会掉进「其他」，而它们恰好是主人最常要看的两块状态（"我是谁"、"现在几点在干嘛"）。
  { id: 'persona', name: '人设与作息', prefixes: ['persona', 'routine'] },
  {
    id: 'ext',
    name: '扩展与运维',
    // ★ `assign` / `authorize` / `user` / `channel` 来自 @koishijs/plugin-admin；
    //   `replyshaper` 是自研的回复整形。生产 143 条指令里有 7 条原本落进「其他」，
    //   就是这几个（rig 只有 124 条所以没暴露出来）。
    prefixes: [
      'selfext',
      'render',
      'page',
      'localemb',
      'cmdname',
      'admin',
      'command',
      'status',
      'plugin',
      'assign',
      'authorize',
      'user',
      'channel',
      'replyshaper',
      'replystyle',
    ],
  },
  { id: 'basic', name: '基础指令', prefixes: ['help', 'echo', 'think'] },
]

const Config = Schema.intersect([
  Schema.object({
    enabled: Schema.boolean().default(true).description('总开关。关掉后回退到一行纯文字提示'),
    pageSize: Schema.natural().default(18).description('类目页每页几条指令。★ 直接决定图片高度与体积：18 条约 330 KB'),
    showUnavailable: Schema.boolean()
      .default(true)
      .description('显示自己等级不够用的指令（灰掉并标注等级）。关掉则只列自己能用的'),
    showHidden: Schema.boolean().default(false).description('连标记为 hidden 的指令也列出来'),
    textFallback: Schema.boolean().default(true).description('出图不可用时回退成文字清单'),
  }),
  Schema.object({
    categories: Schema.array(
      Schema.object({
        id: Schema.string().description('ASCII 代号，`/help <代号>` 用它'),
        name: Schema.string().description('显示名'),
        prefixes: Schema.array(String).description('指令名前缀，匹配时**最长前缀优先**'),
      })
    )
      .role('table')
      .default(DEFAULT_CATEGORIES)
      .description('类目规则。没匹配上的进「其他」。改完不用重启缓存会自己失效（按内容哈希）'),
  }),
  Schema.object({
    debug: Schema.boolean().default(false).description('打印指令表扫描明细'),
  }),
  Schema.object({
    unknownHint: Schema.boolean().default(true).description(
      '★ 敲了不存在的指令时，回一句"没有这个指令 + 你是不是想看哪个类目"，而不是让模型接话。' +
        '2026-10-03 实测：用户看到总览表里写着 `ext` 就发了 `/ext`，' +
        '结果那条既不是指令、也没人管，直接漏给 ChatLuna，模型回了句' +
        '「这命令不是给我的吧，群里就我们俩」——用户以为"命令没效果"。'
    ),
    unknownHintInGroup: Schema.boolean().default(true).description(
      '群聊里是否也回这句。关掉则只在私聊提示（群里少刷屏）'
    ),
  }),
])

function apply(ctx, config) {
  const cfg = {
    enabled: true,
    pageSize: 18,
    showUnavailable: true,
    showHidden: false,
    textFallback: true,
    categories: DEFAULT_CATEGORIES,
    unknownHint: true,
    unknownHintInGroup: true,
    debug: false,
    ...(config ?? {}),
  }

  const log = (...a) => cfg.debug && logger.info(...a)

  /** 类目规则：按前缀长度从长到短，保证 `chatluna.memory` 先于 `chatluna` 命中 */
  function rules() {
    const list = Array.isArray(cfg.categories) && cfg.categories.length ? cfg.categories : DEFAULT_CATEGORIES
    return list.map((c) => ({
      id: String(c.id || '').trim() || 'other',
      name: String(c.name || c.id || '其他'),
      prefixes: (Array.isArray(c.prefixes) ? c.prefixes : []).map(String).filter(Boolean),
    }))
  }

  function categoryOf(cmdName) {
    const n = String(cmdName)
    let best = null
    for (const r of rules()) {
      for (const p of r.prefixes) {
        // 前缀要么就是它本身，要么后面跟一个点（避免 `chatlunaX` 命中 `chatluna`）
        if (n === p || n.startsWith(p + '.')) {
          if (!best || p.length > best.len) best = { r, len: p.length }
        }
      }
    }
    return best ? best.r : { id: 'other', name: '其他', prefixes: [] }
  }

  // ------------------------------------------------------------------ 目录

  function commander() {
    const c = ctx.$commander || ctx.root?.$commander
    return c && Array.isArray(c._commandList) ? c : null
  }

  /** 有效等级：自己 + 所有祖先上的 authority 取最大 */
  function effectiveLevel(cmd) {
    let max = null
    let node = cmd
    const guard = new Set()
    while (node && !guard.has(node)) {
      guard.add(node)
      for (const p of node.config?.permissions ?? []) {
        const m = /^authority:(\d+)$/.exec(p)
        if (m) max = Math.max(max ?? 0, +m[1])
      }
      node = node.parent
    }
    return max
  }

  /**
   * 取一条本地化文案。
   *
   * ★ 为什么不能用 `cmd.toJSON().description`
   *   实测（rig 40-help-pages，2026-10-03）：**124 条指令的 description 全是
   *   `[object Object]`**。根因在 Koishi 的 i18n：
   *     `I18n.get(key, locales)` 返回的是 **locale → 文案 的映射对象**，不是字符串
   *     （@koishijs/core/lib/index.cjs:1648-1655，`const result = {}; … result[locale] = …`）
   *   而 `Command.toJSON()` 正是用 `ctx.i18n.get(...)` 填 description 的（同文件 1125 行）。
   *   框架自己的 help 插件也绕开了 toJSON，改用 `session.text(['commands.X.description',''])`
   *   渲染（plugin-help/lib/index.js:170）。
   *
   *   这里照做，但**不用 session** —— 用 `ctx.i18n.render([], [path, ''], params)`，好处是
   *   结果与「谁在问」无关（启动自检时没有 session 也能拿到文案）。
   *   第二段路径 `''` 是兜底：文案缺失时返回空串而**不会**打一条 `missing` 警告，
   *   否则 124 条里只要有一条没写说明，日志就会被刷屏。
   */
  function t(path, params) {
    try {
      return ctx.i18n.render([], [path, ''], params ?? {}).join('')
    } catch {
      return ''
    }
  }

  function argDesc(name, arg) {
    return {
      name: arg.name,
      type: typeof arg.type === 'string' ? arg.type : 'string',
      required: !!arg.required,
      description: t(`commands.${name}.arguments.${arg.name}`),
    }
  }

  function optDesc(name, oname, opt) {
    return {
      name: oname,
      type: typeof opt.type === 'string' ? opt.type : 'string',
      description: t(`commands.${name}.options.${oname}`),
      hidden: !!opt.hidden,
    }
  }

  function usageOf(cmd, args, options) {
    const parts = [`/${cmd.displayName || cmd.name}`]
    for (const a of args) {
      parts.push(a.required ? `<${a.name}:${a.type}>` : `[${a.name}:${a.type}]`)
    }
    if (options.length) parts.push('[选项]')
    return parts.join(' ')
  }

  /** 现场枚举整张指令表 → 规范化条目。**不缓存成静态清单**，因为插件是异步挂载的 */
  function catalogue() {
    const cmdr = commander()
    if (!cmdr) return []
    const out = []
    const seen = new Set()
    for (const cmd of cmdr._commandList) {
      if (!cmd || typeof cmd.name !== 'string' || !cmd.name) continue
      if (seen.has(cmd.name)) continue
      seen.add(cmd.name)
      if (!cfg.showHidden && cmd.config?.hidden) continue

      const args = (cmd._arguments ?? []).map((a) => argDesc(cmd.name, a))
      const options = Object.entries(cmd._options ?? {})
        .map(([oname, o]) => optDesc(cmd.name, oname, o))
        .filter((o) => !o.hidden)

      const aliases = Object.keys(cmd._aliases ?? {})
      const level = effectiveLevel(cmd) ?? DEFAULT_LEVEL
      out.push({
        name: cmd.name,
        display: cmd.displayName || cmd.name,
        aliases: aliases.filter((a) => a !== (cmd.displayName || cmd.name)),
        description: t(`commands.${cmd.name}.description`),
        args,
        options,
        level,
        usage: usageOf(cmd, args, options),
        category: categoryOf(cmd.name),
      })
    }
    out.sort((a, b) => a.name.localeCompare(b.name))
    return out
  }

  function levelBadge(level, mine) {
    const cls = `lv lv${level}${mine != null && level > mine ? ' lv-off' : ''}`
    return `<span class="${cls}">${level} ${LEVEL_NAMES[level] ?? '未知'}</span>`
  }

  // ------------------------------------------------------------------ 别名层

  /**
   * 读 chatluna-alias 的别名表。
   *
   * ★ 拿不到服务就返回空表 —— 调用方（首页）据此退回全量总览。
   *   两个插件是各自独立的：alias 没装/没启用时，/help 不该开天窗。
   * ★ 只收注册成功的条目：帮助页里出现一条敲不出来的别名，比不出现更糟。
   */
  function aliasEntries() {
    try {
      const list = ctx.get('chatlunaAlias')?.entries?.()
      return Array.isArray(list) ? list.filter((e) => e && e.alias && e.ok !== false) : []
    } catch {
      return []
    }
  }

  const esc = (s) =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
  /** 表格里的说明文字：竖线会破坏表格，换行会破坏行 */
  const cell = (s) => esc(String(s ?? '').replace(/\|/g, '｜').replace(/\s*\n\s*/g, ' ')).trim()

  // ------------------------------------------------------------------ 四张页面

  /**
   * 首页：**只列别名**（用户要的那层抽象）。
   *
   * 返回 null = 拿不到别名表，调用方改画全量总览。
   *
   * ★ 用途那一列优先用别名表里的 note，其次才是指令自己的 i18n 说明 ——
   *   有几条原始指令压根没写说明（`chatluna.stop` 就是），
   *   在别名表里补一句比在别人的插件里补 i18n 现实得多。
   * ★ 不显示原始指令名：用户明确要求「只显示别名」。
   *   要看原名映射：单条详情 /help <别名>，或者 /help -all 翻全量目录。
   */
  function shortcutPage(page, mine) {
    const entries = aliasEntries()
    if (!entries.length) return null

    const all = catalogue()
    const byName = new Map(all.map((c) => [c.name, c]))
    const items = entries.map((e) => {
      const c = byName.get(e.target)
      return {
        alias: e.alias,
        target: e.target,
        note: e.note || c?.description || '（这条还没有写说明）',
        level: c?.level ?? DEFAULT_LEVEL,
      }
    })

    const pageSize = Math.max(Number(cfg.pageSize) || 18, 4)
    const pages = Math.max(Math.ceil(items.length / pageSize), 1)
    const p = Math.min(Math.max(Number(page) || 1, 1), pages)
    const slice = items.slice((p - 1) * pageSize, p * pageSize)
    const usable = items.filter((i) => i.level <= mine).length

    const rows = slice.map((i) => {
      const off = i.level > mine ? ' lv-off' : ''
      return `| <span class="${off.trim() || 'x'}">\`/${esc(i.alias)}\`</span> | ${cell(i.note)} | ${levelBadge(i.level, mine)} |`
    })

    const foot = [
      p < pages ? `下一页：<code>/help ${p + 1}</code>` : null,
      p > 1 ? `上一页：<code>/help ${p - 1}</code>` : null,
      `单条详情：<code>/help &lt;别名&gt;</code>`,
      `全部 **${all.length}** 条原始指令：<code>/help -all</code>`,
    ]
      .filter(Boolean)
      .join('　·　')

    return [
      `# 大肥鱼 · 常用指令`,
      ``,
      `共 **${items.length}** 个别名 · 第 **${p}/${pages}** 页 · 你能用 **${usable}** 个 · 你的等级：${levelBadge(mine, mine)}`,
      ``,
      // ★ 2026-10-03 用户要求：「把那个『别名就是简写…』的这一段删掉，不需要在这个界面说明这些」
      //   —— 首页只为"有哪些能敲"服务，不讲机制。机制说明留在 docs/24 与 /help <别名> 的详情页。
      `| 别名 | 用途 | 等级 |`,
      `| --- | --- | --- |`,
      ...rows,
      ``,
      `<div class="pg-foot">${foot}</div>`,
    ].join('\n')
  }

  function overviewPage(mine) {
    const all = catalogue()
    if (!all.length) return '# 指令总览\n\n拿不到指令表（Commander 还没就绪）。稍后再试。'

    // 按规则顺序排类目，保证「其他」永远在最后
    const order = [...rules(), { id: 'other', name: '其他' }]
    const groups = new Map()
    for (const c of all) {
      const k = c.category.id
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k).push(c)
    }

    const rows = []
    for (const cat of order) {
      const list = groups.get(cat.id)
      if (!list || !list.length) continue
      const usable = list.filter((c) => c.level <= mine).length
      const minLevel = list.reduce((m, c) => Math.min(m, c.level), 4)
      rows.push(
        `| **${esc(cat.name)}** | \`/help ${esc(cat.id)}\` | ${list.length} | ${usable} | ${levelBadge(minLevel, mine)} |`
      )
    }

    const total = all.length
    const usable = all.filter((c) => c.level <= mine).length

    return [
      `# 大肥鱼 · 全部指令`,
      ``,
      `共 **${total}** 条原始指令，分 **${rows.length}** 类。你的等级：${levelBadge(mine, mine)}`,
      ``,
      // ★ 「怎么看」这一列必须写出**完整的命令**，不能只写代号。
      //   2026-10-03 实测：用户看到表里写着 `ext`，就顺手发了 `/ext` ——
      //   那不是指令，于是被 ChatLuna 当成聊天接了（回了句"这命令不是给我的吧"）。
      //   写全 `/help ext` 就没有这个歧义了。
      `| 类目 | 怎么看 | 条数 | 你能用 | 最低等级 |`,
      `| --- | --- | --- | --- | --- |`,
      ...rows,
      ``,
      `<div class="pg-foot">发 <b>/help &lt;代号&gt;</b> 看某一类的全部指令（例：<code>/help chat</code>）<br>` +
        `发 <b>/help &lt;指令名或别名&gt;</b> 看单条详情（例：<code>/help model</code>）<br>` +
        `只看常用的那几个：<code>/help</code>　·　不想看图：<code>/page.text on</code></div>`,
    ].join('\n')
  }

  function categoryPage(catId, page, mine) {
    const all = catalogue()
    const cat = [...rules(), { id: 'other', name: '其他' }].find((c) => c.id === catId)
    const list = all.filter((c) => c.category.id === catId)
    if (!cat || !list.length) return null
    const aliasOf = new Map(aliasEntries().map((e) => [e.target, e.alias]))

    const pageSize = Math.max(Number(cfg.pageSize) || 18, 4)
    const pages = Math.max(Math.ceil(list.length / pageSize), 1)
    const p = Math.min(Math.max(Number(page) || 1, 1), pages)
    const slice = list.slice((p - 1) * pageSize, p * pageSize)
    const usable = list.filter((c) => c.level <= mine).length

    const rows = slice.map((c) => {
      const off = c.level > mine ? ' lv-off' : ''
      // ★ 有别名就把别名摆在前面：这是用户日常真正会敲的那个名字。
      //   原始名不删，缩小一档跟在后面 —— 老习惯发全名照样能用，两边的对应关系也一眼可见。
      const al = aliasOf.get(c.name)
      const label = al
        ? `\`/${esc(al)}\` <span class="pg-sub">${esc(c.display)}</span>`
        : `\`${esc(c.display)}\``
      return `| <span class="${off.trim() || 'x'}">${label}</span> | ${cell(c.description) || '（无说明）'} | ${levelBadge(c.level, mine)} |`
    })

    const foot = [
      p < pages ? `下一页：<code>/help ${esc(catId)} ${p + 1}</code>` : null,
      p > 1 ? `上一页：<code>/help ${esc(catId)} ${p - 1}</code>` : null,
      `回总览：<code>/help -all</code>；单条详情：<code>/help &lt;指令名&gt;</code>`,
    ]
      .filter(Boolean)
      .join('　·　')

    return [
      `# ${esc(cat.name)}`,
      ``,
      `共 **${list.length}** 条 · 第 **${p}/${pages}** 页 · 你能用 **${usable}** 条 · 你的等级：${levelBadge(mine, mine)}`,
      ``,
      `| 指令 | 说明 | 等级 |`,
      `| --- | --- | --- |`,
      ...rows,
      ``,
      `<div class="pg-foot">${foot}</div>`,
    ].join('\n')
  }

  function detailPage(entry, mine, askedAs) {
    const c = entry
    const lines = [
      `# ${esc(c.display)}`,
      ``,
      c.description ? esc(c.description) : '（这条指令没有写说明）',
      ``,
      `| 项 | 值 |`,
      `| --- | --- |`,
      `| 等级 | ${levelBadge(c.level, mine)}${c.level > mine ? ' —— 你暂时用不了' : ''} |`,
      `| 用法 | \`${esc(c.usage)}\` |`,
      `| 类目 | ${esc(c.category.name)} |`,
      `| 别名 | ${c.aliases.length ? c.aliases.map((a) => `\`${esc(a)}\``).join(' ') : '（无）'} |`,
    ]

    // ★ 用户是用别名（或不带前缀的写法）查过来的 → 明确写出"你敲的那个名字 = 这个名字"。
    //   用户要的就是"抽象层与原指令的映射"，映射关系必须在这里看得见，
    //   否则他没法确认 /model 到底改的是哪条指令。
    if (askedAs && askedAs !== c.name) {
      lines.splice(7, 0, `| 原名 | \`${esc(c.name)}\`（\`/${esc(askedAs)}\` 与它完全等价） |`)
    }

    if (c.args.length) {
      lines.push(``, `**参数**`, ``, `| 参数 | 类型 | 必填 | 说明 |`, `| --- | --- | --- | --- |`)
      for (const a of c.args) {
        lines.push(
          `| \`${esc(a.name)}\` | ${esc(a.type)} | ${a.required ? '是' : '否'} | ${cell(a.description) || '—'} |`
        )
      }
    }

    if (c.options.length) {
      lines.push(``, `**选项**`, ``, `| 选项 | 类型 | 说明 |`, `| --- | --- | --- |`)
      for (const o of c.options) {
        lines.push(`| \`-${esc(o.name)}\` | ${esc(o.type)} | ${cell(o.description) || '—'} |`)
      }
    }

    lines.push(
      ``,
      `<div class="pg-foot">直接发 <code>${esc(c.usage)}</code> 就能用。<br>` +
        `同一类别的其它指令：<code>/help ${esc(c.category.id)}</code>　·　回总览：<code>/help</code></div>`
    )
    return lines.join('\n')
  }

  // ------------------------------------------------------------------ 查找

  /** 目标可能是：类目代号 / 类目中文名 / 指令名 / 指令别名（大小写不敏感） */
  function resolveTarget(raw) {
    const t = String(raw ?? '').trim()
    if (!t) return { kind: 'overview' }
    const low = t.toLowerCase()

    const cat = [...rules(), { id: 'other', name: '其他' }].find(
      (c) => c.id.toLowerCase() === low || String(c.name).toLowerCase() === low
    )
    if (cat) return { kind: 'category', catId: cat.id }

    const all = catalogue()
    const byName = all.find((c) => c.name.toLowerCase() === low)
    if (byName) return { kind: 'command', entry: byName, via: null }

    const byDisplay = all.find((c) => String(c.display).toLowerCase() === low)
    if (byDisplay) return { kind: 'command', entry: byDisplay, via: low }

    // ★ 别名（`/help model`）也要查得到 —— 这是首页列出来的名字，
    //   用户照着首页敲进来却"找不到"是最不能接受的失败。
    const byAlias = all.find((c) => c.aliases.some((a) => a.toLowerCase() === low))
    if (byAlias) return { kind: 'command', entry: byAlias, via: low }

    // 没命中：给几个像的，别让用户对着「找不到」发呆
    const near = all
      .filter((c) => c.name.toLowerCase().includes(low) || low.includes(c.name.toLowerCase()))
      .slice(0, 6)
      .map((c) => c.display)
    return { kind: 'miss', target: t, near }
  }

  // ------------------------------------------------------------------ 指令

  ctx
    .command('help [target:string] [page:number]', '常用指令 / 分类 / 单条详情（出图）', { authority: 1 })
    // ★ 三种写法都要能用：`-a`（短）、`--all`（长）、`-all`（用户原话里的写法）。
    //   `-all` 在 Koishi 里走的是**组合短选项**分支（core:400-409，`-all` 被拆成 a/l/l），
    //   只定义 `-a` 其实也能出 all=true，但会顺手给 `options.l` 塞一个空值 ——
    //   那要看 `parseValue(undefined)` 的脸色。用 symbols 精确匹配整个 `-all` 就没这条尾巴。
    .option('all', '-a 列出全部原始指令（默认只看常用的别名）', { symbols: ['-all'] })
    .action(async (argv, target, pageNo) => {
      const session = argv?.session
      const showAll = !!argv?.options?.all
      const mine = session?.user?.authority ?? 1

      // ★★ `[target:string]` 是**贪婪**位置参数，第二个位置参数根本拿不到值
      //   （`@koishijs/core:1332` 把 `string` 域定义成 `{greedy:true}`，解析时
      //   `Argv.stringify(argv)` 会把**剩下所有 token** 一次性塞给第一个参数，
      //   见 core:385-388）。也就是说 `/help chat 2` 里 target 拿到的是整串 `"chat 2"`、
      //   `page` 永远是 undefined —— 而页脚一直写着「下一页：`/help chat 2`」，
      //   实际会回一句「找不到「chat 2」」。2026-10-03 复核分页时才发现（第一轮就带着）。
      //   修法：自己把结尾的数字切出来当页码。指令名/类目代号里不可能有空格，切了不会误伤。
      let rawTarget = String(target ?? '').trim()
      const tail = /^(.+?)\s+(\d+)$/.exec(rawTarget)
      if (tail) {
        rawTarget = tail[1].trim()
        pageNo = Number(tail[2])
      }

      // ★ `/help 2` = 常用页第 2 页。目标位只认纯数字时当页码，
      //   否则翻页就得写成 `/help 1 2` 这种没人猜得到的写法。
      const asPage = /^\d+$/.test(rawTarget) ? Number(rawTarget) : null

      let md
      const r = asPage === null ? resolveTarget(rawTarget) : { kind: 'overview' }
      if (r.kind === 'overview') {
        // 首页 = 别名层；`-all` = 全部原始指令；没有别名表时首页退回全量总览
        md = showAll ? overviewPage(mine) : shortcutPage(asPage ?? pageNo, mine)
        if (!md) md = overviewPage(mine)
      } else if (r.kind === 'category') {
        md = categoryPage(r.catId, pageNo, mine)
        if (!md) md = `类目 \`${esc(r.catId)}\` 里一条指令都没有。发 \`/help\` 看常用指令。`
      } else if (r.kind === 'command') {
        md = detailPage(r.entry, mine, r.via)
      } else {
        md = [
          `# 找不到「${esc(r.target)}」`,
          ``,
          `它既不是类目代号，也不是指令名或别名。`,
          r.near.length ? `\n你是不是想找：${r.near.map((n) => `\`${esc(n)}\``).join('、')}` : '',
          ``,
          `发 \`/help\` 看常用指令，发 \`/help -all\` 看全部类目。`,
        ]
          .filter((x) => x !== '')
          .join('\n')
      }

      const pg = ctx.get('chatlunaPage')
      // ★ 文字模式必须走 plainify，不能把 md 原样 return：
      //   `session.send(string)` 会经过 `h.parse`，而 OneBot 编码器不认识 `<br>`，
      //   会把 br **连同它的子节点**一起丢掉 —— `<br>` 之后的内容整段消失。
      //   rig 47 实测（2026-10-03）：首页的别名表格、页脚的第二三行全没了，
      //   但出图路径完全正常，只有文字模式会撞上。
      if (pg?.available?.() && !pg.isTextMode?.(session)) return pg.output(session, md)

      // 降级：没有 page 服务 / 出图不可用 / 用户切了文字 → 至少别什么都不回
      if (!cfg.textFallback) return md
      return pg?.plainify ? pg.plainify(md) : md.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '')
    })

  // ------------------------------------------------------------------ 未知指令兜底
  //
  // ★ 为什么必须有
  //   2026-10-03 实测（生产日志 01:58:46）：用户在群里发 `/ext`。
  //   `ext` 是总览表里的**类目代号**，不是指令名，于是：
  //     ① Koishi 的指令中间件解析不到 → next()；
  //     ② Koishi 自带的"你是不是想输入 X"（core:1294-1316）也匹配不上
  //        （它只在**指令名**里找近似，类目代号当然找不到）；
  //     ③ 于是这条消息**整条漏给 ChatLuna**，模型把它当聊天接了，
  //        回了句「这命令不是给我的吧，群里就我们俩 / 你想干嘛直接说」。
  //   用户那边的体感就是"命令没有效果，或者是我没正确使用？"——两者都是。
  //
  // ★ 为什么要 prepend（`ctx.middleware(fn, true)`）
  //   ChatLuna 是在它自己加载时用普通 `ctx.middleware` 挂上去的，**排在前面**。
  //   如果我们也用普通注册，等轮到我们的时候 ChatLuna 已经把这句当聊天回完了。
  //   prepend 是 unshift（guard 的注释里记过这条），能在插件加载期插到最前面。
  //
  // ★ prepend 的代价：我们比 `chatluna-guard` 还早，屏蔽判定得自己问
  //   被屏蔽的群不该因为敲错指令就冒出一句话。guard 用 `ctx.provide('qqbotGuard')`
  //   暴露了 `isBlocked(session)`，这里直接问它；问不到就当没屏蔽（宁可多回一句，
  //   也不要因为拿不到服务就整条兜底失效）。
  //
  // ★ 什么时候**不**兜底（把决定权还回去）
  //   - 指令真的存在（含别名 / 子指令）→ next()，走正常执行；
  //   - 有指令名以这个 token 开头 → next()，交给 Koishi 自己的 suggest 去问
  //     "你是不是想输入 xxx"（那套逻辑比这里细，别抢它的活）；
  //   - 不像指令名（中文、含空格、含奇怪符号）→ next()，那是自然语言，不是敲错了。

  /** 类目代号（或显示名）→ 类目规则项 */
  function categoryFor(token) {
    const t = String(token || '').toLowerCase()
    if (!t) return null
    const list = [...rules(), { id: 'other', name: '其他' }]
    return (
      list.find((c) => String(c.id).toLowerCase() === t) ||
      list.find((c) => String(c.name) === token) ||
      null
    )
  }

  /**
   * 所有指令名 + 别名（小写）。
   *
   * ★ 这里**故意不用 `$commander.resolve(name, session)`**：prepend 中间件比 `attach` 还早，
   *   那时候 `session.user` 还没挂上，权限判定拿不到东西，`resolve` 有可能把一条**真实存在**
   *   的指令判成不存在 —— 那样我们就会把用户正常发的指令抢掉。
   *   只按名字（和别名）查表不依赖任何 session 状态，是安全的做法：
   *   名字对得上就放行，让 Koishi 自己去判权限（它会给"权限不足"，而不是"没有这个指令"）。
   */
  function commandNames() {
    const cmdr = commander()
    const set = new Set()
    if (!cmdr) return set
    for (const c of cmdr._commandList) {
      const n = String(c.name || '').toLowerCase()
      if (n) set.add(n)
      for (const a of Object.keys(c._aliases || {})) {
        const k = String(a || '').toLowerCase()
        if (k) set.add(k)
      }
    }
    return set
  }

  /** 这个名字是不是（或可能是）一条指令 */
  function looksLikeCommand(token, names) {
    if (names.has(token)) return true
    // 有指令名以它开头 → 可能是子指令写了一半，交给 Koishi 自己的 suggest
    for (const n of names) if (n.startsWith(token + '.') || n.startsWith(token)) return true
    return false
  }

  /** 类目代号里和这个 token 沾边的（给"你是不是想看"用） */
  function nearCategories(token) {
    const t = String(token || '').toLowerCase()
    if (t.length < 2) return []
    return [...rules(), { id: 'other', name: '其他' }]
      .map((c) => String(c.id))
      .filter((id) => {
        const s = id.toLowerCase()
        return s.startsWith(t) || t.startsWith(s)
      })
      .slice(0, 4)
  }

  /** 返回要发的话；返回 null 表示"别拦，让后面的人处理" */
  function unknownHintFor(token, names) {
    if (looksLikeCommand(token, names)) return null

    const cat = categoryFor(token)
    if (cat) {
      return (
        `没有 \`/${token}\` 这个指令 —— \`${cat.id}\` 是**类目代号**，不是指令名。\n` +
        `想看「${cat.name}」这一类：发 \`/help ${cat.id}\`\n` +
        `看全部类目：发 \`/help\``
      )
    }

    const near = nearCategories(token)
    return [
      `没有 \`/${token}\` 这个指令。`,
      near.length ? `你是不是想看这些类目：${near.map((id) => `/help ${id}`).join('、')}` : '',
      `常用指令：发 /help　·　全部原始指令：发 /help -all`,
    ]
      .filter(Boolean)
      .join('\n')
  }

  /** 当前生效的指令前缀（配置里可能是 ['/', '.']） */
  function prefixList(session) {
    try {
      const cmdr = commander()
      if (cmdr?._resolvePrefixes) {
        const list = [...cmdr._resolvePrefixes(session)].filter((p) => typeof p === 'string' && p)
        if (list.length) return list.sort((a, b) => b.length - a.length)
      }
      const raw = cmdr?.config?.prefix
      if (Array.isArray(raw)) return raw.filter((p) => typeof p === 'string' && p).sort((a, b) => b.length - a.length)
    } catch {}
    return ['/']
  }

  ctx.middleware(async (session, next) => {
    try {
      if (!cfg.enabled || !cfg.unknownHint) return next()
      if (!session?.stripped) return next()
      if (session.isDirect ? false : !cfg.unknownHintInGroup) return next()

      // 指令已经解析出来了 —— 正常执行，别插手
      if (session.argv?.command) return next()

      // 被屏蔽的群保持静默。拿不到 guard 服务时不因为这一条把兜底整个关掉
      const guard = ctx.get('qqbotGuard')
      if (guard?.isBlocked?.(session)) return next()

      // ★ 前缀要**自己切**：prepend 中间件比 `attach` 还早，而 `stripped.prefix` 是
      //   `ctx.before('attach')` 里才写上去的（@koishijs/core:1275-1284）。
      //   第一次跑这个剧本时就是漏了这一步：token 拿到的是 `/ext`（带着斜杠），
      //   正则 `^[a-z]...` 直接不匹配 → 一次都没兜底，日志里连一行都没有。
      let content = String(session.stripped.content || '').trim()
      if (!content) return next()
      let hadPrefix = false
      for (const p of prefixList(session)) {
        if (content.startsWith(p)) {
          content = content.slice(p.length).trim()
          hadPrefix = true
          break
        }
      }

      const appel = session.stripped.appel
      if (!session.isDirect && !hadPrefix && !appel) return next()

      const token = content.split(/\s/, 1)[0]
      if (!token) return next()
      // 只认"看起来就是个指令名"的：字母开头，只含 [a-z0-9._-]
      if (!/^[a-z][a-z0-9._-]*$/i.test(token)) return next()

      const hint = unknownHintFor(token.toLowerCase(), commandNames())
      if (hint === null) return next()

      log('未知指令兜底：%s → 回提示', token)
      await session.send(hint)
      // 短路：不调 next()，ChatLuna 不会再把这句话当聊天接一遍
      return
    } catch (e) {
      logger.warn('未知指令兜底出错（放行给后续处理）：%s', e.message)
      return next()
    }
  }, true)

  // ------------------------------------------------------------------ 启动自检

  ctx.on('ready', () => {
    setTimeout(() => {
      const all = catalogue()
      const cmdr = commander()
      if (!cmdr) {
        logger.warn('拿不到 Commander 指令表，/help 会是空的')
        return
      }
      // ★ 自检 1：help 这个名字到底解析到谁？框架 help 插件没关干净的话会解析到它
      const helpCmd = cmdr.get?.('help')
      if (!helpCmd) logger.warn('自检失败：`help` 解析不到，指令系统可能没起来')
      else if (helpCmd.name !== 'help') {
        logger.warn('自检失败：`help` 解析到了 %s —— 多半是 @koishijs/plugin-help 没关掉', helpCmd.name)
      } else {
        // ★ 这条必须走 logger.info，不能走 debug 门控的 log()：
        //   生产环境 debug=false，用 log() 的话「自检通过」永远不打印，
        //   于是「没打印」既可能是没通过、也可能是没开 debug —— 自检就失去意义了（踩过）。
        logger.info('自检通过：`help` 指向本插件')
      }

      // ★ 自检 2：有多少条指令落在「其他」里 —— 说明类目规则该补了
      const other = all.filter((c) => c.category.id === 'other')
      logger.info(
        '指令目录就绪：共 %d 条，分 %d 类；未归类 %d 条%s',
        all.length,
        new Set(all.map((c) => c.category.id)).size,
        other.length,
        other.length ? `（${other.slice(0, 8).map((c) => c.name).join(' / ')}${other.length > 8 ? ' …' : ''}）` : ''
      )

      // ★ 自检 3：首页到底画哪一张。别名层没接上时必须说清楚，
      //   否则用户看到"首页突然又变回 147 条"会以为是回归。
      const aliases = aliasEntries()
      const missingTargets = aliases.filter((e) => !all.some((c) => c.name === e.target))
      if (!aliases.length) {
        logger.warn('常用别名表为空（chatluna-alias 没装/没启用？）→ /help 首页退回全量总览')
      } else {
        logger.info(
          '常用别名层就绪：%d 个别名（/help 首页只列这些）；%d 条原始指令在 /help -all%s',
          aliases.length,
          all.length,
          missingTargets.length ? `；⚠ ${missingTargets.length} 个别名的目标不在指令表里` : ''
        )
        if (missingTargets.length) {
          logger.warn('别名指向了不存在的指令：%s', missingTargets.map((e) => `${e.alias}→${e.target}`).join(' / '))
        }
      }
      if (cfg.debug) {
        for (const c of all) log('  %s [%s] a=%d — %s', c.name, c.category.id, c.level, c.description)
      }
    }, 9000)
  })

  logger.info('指令帮助体系已挂载（每页 %d 条；显示越权指令 %s）', cfg.pageSize, cfg.showUnavailable ? '是' : '否')
}

module.exports = { name, inject, Config, apply }
