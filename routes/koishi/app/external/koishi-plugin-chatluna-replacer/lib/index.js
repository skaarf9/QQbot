/**
 * koishi-plugin-chatluna-replacer —— 出站文本替换层
 *
 * 需求（用户原话）：
 *   「给对话模型的输出之上添加一个逻辑层，原因是模型总是使用 😏 这个 emoji，
 *     感觉很拽的样子，但它自己感觉不出来，又不想改提示词，所以添加一个逻辑替换层，
 *     将输出文字中的特定字符替换成特定内容，由"管理员"级别以上的人维护，
 *     提供群聊中可用的 CRUD 命令」
 *
 * 一句话：**改发送口，不改提示词，也不改模型**。
 *
 * ---------------------------------------------------------------------------
 * ★ 为什么挂在 `before-send`（而不是改 ChatLuna 或写中间件）
 *
 *   所有出站消息都要过 `@satorijs/core` 的 MessageEncoder：
 *     `encoder.send()` → `app.serial(session, 'before-send', ...)`（core:752），
 *   **返回非空即取消发送**。挂这里等于"一个点覆盖全部出站路径"：
 *   模型回复 / R9 主动插话 / chatluna-followup 的跟进 / 指令回执 …… 全走它。
 *
 *   本项目已有几个先例：`chatluna-replyshaper`（去空行 + 不回复哨兵）、
 *   `chatluna-reply-style`（加引用/@）、`chatluna-page`（长文本出图）。
 *   本插件与它们同一套路，都只改 `session.elements`，互不冲突。
 *
 *   ★★ 但**必须先于 chatluna-render / chatluna-page 执行**，而且这件事由本插件
 *      **自己声明**（`ctx.on('before-send', fn, true)` = prepend 到队首），
 *      **不能**指望 koishi.yml 里的先后顺序 —— 实测过，那样会静默失效：
 *
 *        · page 会把长回复（默认 ≥180 字或 ≥6 行）转成**图片**；
 *        · 一旦先出了图，这里看到的就只剩一个 image 元素，😏 已经烤进图里了，改不动；
 *        · 症状**只出现在长回复上**（短回复照常替换），不报错、日志也看不出异常，
 *          是最难查的一类。
 *
 *      为什么"写在配置前面"不算数：`inject: ['database']` 会**推迟 apply**，
 *      而 render / page / reply-style 没有这层等待、监听器先注册；`app.serial`
 *      按注册顺序遍历，于是本插件反而排在最后。详见 before-send 那段注释。
 *      （rig 63 第二轮就是踩这个：page 渲染的正文是 295 字符 = **未替换**的长度。）
 *
 *      实测（rig 63）执行顺序是：**replacer（队首）→ render → page（出图）
 *      → reply-style（引用 / @）→ … → episode（记记忆，最后）**
 *      —— `chatluna-episode` 同样带 `inject`、同样被推迟到很后面，
 *      所以它记到的**纯文本**回复是**替换之后**的文本；长回复那头它看到的
 *      已经是 page 出好的图片了（那是 episode 与 page 之间既有的行为，与本插件无关）。
 *
 * ---------------------------------------------------------------------------
 * ★★ 三条语义（这是本插件的全部行为，别看代码猜）
 *
 *   1. **单趟最长匹配（maximal munch）**：从左到右扫一遍，每个位置在所有
 *      「当前作用域适用且已启用」的规则里挑**命中最长**的那条。
 *      这样 `😏` 和 `😏😏` 两条规则同时存在时，`😏😏` 会命中后者，符合直觉。
 *      同长时：**更具体的作用域优先**（群规则压过全局规则），再按 id 小的优先。
 *
 *   2. **替换出来的文本不再扫第二遍**（no re-scan）。
 *      否则 `A→B`、`B→A` 两条规则就是死循环，或者 `😏→嘿嘿😏` 会无限套娃。
 *      代价是 `😏 → 😏呀` 不会继续被替换 —— 这正是我们要的可预测行为。
 *
 *   3. **只动纯文本元素**（`type === 'text'`）。
 *      图片 / @ / 引用 / 表情包一律不碰 —— 尤其不能碰 reply-style 刚加上的
 *      `quote`、`at`，也不该把表情包里的字改掉。
 *
 * ---------------------------------------------------------------------------
 * ★ 为什么默认**不改指令回执**（`skipCommands` 默认开）
 *
 *   替换是给"模型说的话"用的。指令回执是功能性文本，改了有害无益。
 *   最要命的是**本插件自己的指令**：`/replacer.list` 要显示规则原文 `😏`，
 *   要是也被替换掉，管理员就永远看不到自己配的是什么了（列表里全是替换结果）。
 *   所以：**本插件自己的指令无条件跳过**（不受 `skipCommands` 影响），
 *   其余指令按 `skipCommands` 决定。
 *
 * ---------------------------------------------------------------------------
 * ★ 坑位备忘（都踩过，改之前先看）
 *
 *   - **指令名一律英文**（2026-10-02 起全局约定）。中文别名会被
 *     `chatluna-cmdname` 在运行期摘掉（它扫 `_aliases`，删非 ASCII 键），
 *     所以中文只出现在描述/帮助文案里，不注册成别名。
 *   - **子指令必须写点号全名**（`replacer.add`）。`ctx.command('replacer/add')`
 *     注册出来的子指令 name 只有 `add`（`ctx.command('a.b')` 才是整名），
 *     而 Commander 是拿整名去 flat 的 `_commandList` 里查的 —— 写成斜杠就**完全没反应**。
 *   - **父指令必须自己挂 action**（`ctx.command('replacer')` 返回的是叶子对象）。
 *     不挂的话单独发 `/replacer` 会"解析成功但返回空串"，现象和没反应一样。
 *   - **别名不要传 args 声明**：`alias(name, options)` 的 options 会被
 *     `inferCommand` 整体赋给 `argv.args`，handler 第一个参数就变成声明对象了。
 *     所以别名一律 `{ args: [] }`。
 *   - **这里绝对不能抛异常**：`before-send` 抛错会被当成"取消发送"，消息直接没了。
 *     整个 handler 包在 try/catch 里（同 reply-style）。
 *   - **`inject` 里别写 `commands`**：那会让插件被 cordis 静默跳过（见 docs/07）。
 *     `required: ['database']` 是安全的（chatluna-emotion 就是这么用的）。
 *   - **表必须先 `ctx.model.extend`**，否则 `ctx.database.get(表名)` 直接抛
 *     `cannot resolve table`，写入全静默失败（guard 踩过）。
 *   - **`session.elements` 有 setter**，整体替换最省事；逐个改也行。
 *   - **出站 session 拿得到 `channelId` / `guildId`**（reply-style 实证），
 *     但 `messageId` / `userId` 是 undefined（原型 getter 不可枚举，编码时没被拷）。
 *     所以我们只用 channel/guild 判定作用域，不碰 userId。
 *   - **`session.argv.command` 在出站 session 里是有的**（reply-style 的
 *     `skipCommands` 就是靠它生效的），这是"这条是不是指令回执"的判据。
 */

const { Schema, Logger, h } = require('koishi')

const name = 'chatluna-replacer'
/** ★ 别写 `commands`，见文件头坑位备忘 */
const inject = { required: ['database'] }
const logger = new Logger('chatluna-replacer')

const TABLE = 'chatluna_replacer_rule'
/** 作用域里的"全局"哨兵值。用 '*' 而不是空串：空串在 sqlite 里和"没写"分不清 */
const GLOBAL_SCOPE = '*'
/** 本插件自己的指令前缀（这些指令的回执永远不走替换） */
const CMD_PREFIX = 'replacer'

const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('总开关'),
  skipCommands: Schema.boolean()
    .default(true)
    .description(
      '指令回执不走替换（默认开）。替换是给"模型说的话"用的，指令输出是功能性文本。' +
        '<b>本插件自己的指令（/replacer.*）无论这里怎么设都会跳过</b>，' +
        '否则规则清单里的 😏 会被换成替换结果，管理员就看不到原文了。'
    ),
  skipGuardControl: Schema.boolean()
    .default(true)
    .description('chatluna-guard 的「闭嘴/开口」开关回执也跳过（它们是功能性回执，不是模型说的话）'),
  dropWhenEmpty: Schema.boolean()
    .default(true)
    .description(
      '替换后整条消息变空就不发（避免 QQ 上出现一条空消息）。' +
        '典型场景：规则把 😏 换成空串，而模型这一条只发了 😏。'
    ),
  maxRules: Schema.natural().default(200).description('规则条数上限（防手滑灌库；够用就别调大）'),
  hitFlushSeconds: Schema.natural()
    .default(20)
    .description('命中次数的落盘间隔（秒）。命中统计只用来判断"哪条规则是死规则"，不需要实时'),
  debug: Schema.boolean().default(false).description('打印每次替换与skipped原因'),
})

// ---------------------------------------------------------------- 行的归一化

function normalize(row) {
  return {
    id: String(row?.id ?? ''),
    scope: String(row?.scope ?? GLOBAL_SCOPE),
    pattern: String(row?.pattern ?? ''),
    replacement: row?.replacement == null ? '' : String(row.replacement),
    enabled: row?.enabled !== false,
    hits: Number(row?.hits) || 0,
    createdBy: row?.createdBy == null ? null : String(row.createdBy),
  }
}

const byId = (a, b) => (Number(a.id) || 0) - (Number(b.id) || 0)

/** 把内部 scope 值说成人话 */
function describeScope(scope, currentKey) {
  if (scope === GLOBAL_SCOPE) return '全局'
  if (scope === currentKey) return '本群'
  return `其它(${scope})`
}

// ---------------------------------------------------------------- 参数解析
//
// ★ 为什么 `replacer.add` 不用 Koishi 的 `<a:string> <b:string>` 声明式参数：
//   要替换的东西是**任意文本**——emoji、空格、引号、`>` `<` `&` 都可能有。
//   而 Satori 的 `Element.escape()` 会把 `>` 变成 `&gt;`（@satorijs/element:113），
//   声明式参数拿到的是**转义后**的串（实测：`Argv.parse('/x a => b')` 的 token 内容
//   是 `=&gt;`）。与其到处补反转义，不如直接读原始正文自己切词：
//   拿到的就是用户敲的原字符，`>` 还是 `>`。
//
//   原始正文用 `session.stripped.content`（去掉前缀与 @ 之后的消息正文）——
//   `qqbot.echo` 就是这么取"参数后面那一整段"的，实测可用。
//   切词规则：空白分隔，`"..."` / `'...'` 内视为一个整体（内部空格不算分隔）。

/** 取「指令名之后」的原始正文 */
function rawRest(session) {
  const raw = String(session?.stripped?.content ?? session?.content ?? '')
  const cut = raw.search(/\s/)
  return cut >= 0 ? raw.slice(cut + 1) : ''
}

/**
 * 切词。返回 [{ value, quoted }]。
 * 引号未闭合时容忍（当作到行尾为止），不报错——群里敲指令不该因为少个引号就哑掉。
 */
function tokenize(rest) {
  const out = []
  const s = String(rest ?? '')
  let i = 0
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++
    if (i >= s.length) break
    const q = s[i]
    if (q === '"' || q === "'") {
      i++
      let v = ''
      while (i < s.length && s[i] !== q) v += s[i++]
      if (i < s.length) i++ // 吃掉收尾引号
      out.push({ value: v, quoted: true })
      continue
    }
    let v = ''
    while (i < s.length && !/\s/.test(s[i])) v += s[i++]
    out.push({ value: v, quoted: false })
  }
  return out
}

/**
 * 切词并摘掉 `-g` / `--global`。
 *
 * ★ 为什么自己也摘一遍：`-g` 虽然在 `.option()` 里声明了（Koishi 会填
 *   `argv.options.global` 并从解析结果里拿走），但我们读的是**原始正文**，
 *   那里 `-g` 还在。两处都处理，不管 Koishi 版本怎么变都不会把 `-g`
 *   当成"要替换的原文"。
 */
function parseArgs(rest) {
  const args = []
  let wantGlobal = false
  for (const t of tokenize(rest)) {
    if (!t.quoted && (t.value === '-g' || t.value === '--global')) {
      wantGlobal = true
      continue
    }
    args.push(t.value)
  }
  return { args, wantGlobal }
}

// ---------------------------------------------------------------- 替换核心

/**
 * 单趟最长匹配替换。**纯函数**（不碰 DB、不碰 session），便于 `replacer.test` 复用。
 *
 * @param {string} text  原始文本
 * @param {Array}  rules 已经过作用域过滤 + enabled 过滤的规则（未排序也行）
 * @returns {{text: string, hits: Array}} 替换后的文本 + 命中的规则（按命中先后）
 */
function transform(text, rules) {
  const s = String(text ?? '')
  if (!s || !rules.length) return { text: s, hits: [] }

  // 排序即优先级：pattern 长的优先（最长匹配）、同长时具体作用域优先、再按 id。
  // 排好之后"从前往后找第一个命中的"就等于"挑最优的那条"。
  const ordered = [...rules]
    .filter((r) => r.pattern)
    .sort((a, b) => {
      const d = b.pattern.length - a.pattern.length
      if (d !== 0) return d
      const sa = a.scope === GLOBAL_SCOPE ? 0 : 1
      const sb = b.scope === GLOBAL_SCOPE ? 0 : 1
      if (sa !== sb) return sb - sa
      return (Number(a.id) || 0) - (Number(b.id) || 0)
    })

  let out = ''
  const hits = []
  let i = 0
  while (i < s.length) {
    let matched = null
    for (const r of ordered) {
      if (s.startsWith(r.pattern, i)) {
        matched = r
        break
      }
    }
    if (!matched) {
      out += s[i]
      i += 1
      continue
    }
    // ★ 单趟：替换结果直接落进 out，**不再回头扫**（见文件头语义 2）
    out += matched.replacement
    hits.push(matched)
    i += matched.pattern.length
  }
  return { text: out, hits }
}

// ---------------------------------------------------------------- 应用

function apply(ctx, config) {
  const cfg = {
    enabled: true,
    skipCommands: true,
    skipGuardControl: true,
    dropWhenEmpty: true,
    maxRules: 200,
    hitFlushSeconds: 20,
    debug: false,
    ...(config ?? {}),
  }

  const log = (...a) => cfg.debug && logger.info(...a)

  // ★ 必须先注册表模型，否则读写直接抛 `cannot resolve table`（guard 踩过）
  ctx.model.extend(
    TABLE,
    {
      id: { type: 'string', length: 32 },
      scope: { type: 'string', length: 128, initial: GLOBAL_SCOPE },
      pattern: { type: 'text' },
      replacement: { type: 'text', nullable: true },
      enabled: { type: 'boolean', initial: true },
      // 命中次数：只用于判断"哪条规则其实从来没生效过"
      hits: { type: 'integer', initial: 0 },
      createdBy: { type: 'string', length: 128, nullable: true },
      createdAt: { type: 'timestamp', nullable: true },
      updatedAt: { type: 'timestamp', nullable: true },
    },
    { primary: ['id'] }
  )

  // ---------------------------------------------------------------- 内存快照
  //
  // 发送口是**每条消息都要过**的热路径，绝不能在里面 await 查库。
  // 所以维护一份同步快照：ready 时载入、每次改动后重载、另给 /replacer.reload。
  // 同一进程里所有写入口都在本插件内，缓存失效完全可控。
  /** 全量规则（归一化 + 按 id 排序） */
  let snapshot = []
  let loaded = false
  let loading = null
  /** id -> 累计命中次数（含从库里读出来的基数）。落盘时直接写绝对值 */
  const hitCounts = new Map()
  /** id -> 自上次落盘以来新增的命中数 */
  const pendingHits = new Map()

  async function reload(reason) {
    if (loading) return loading
    loading = (async () => {
      try {
        const rows = await ctx.database.get(TABLE, {})
        snapshot = rows.map(normalize).sort(byId)
        loaded = true
        for (const r of snapshot) if (!hitCounts.has(r.id)) hitCounts.set(r.id, r.hits)
        log('已载入替换规则 %d 条（%s）', snapshot.length, reason)
      } catch (e) {
        // 表还没建好/库没起来时不要刷屏，下次发消息会再试
        logger.warn('载入替换规则失败（%s）：%s', reason, e.message)
      } finally {
        loading = null
      }
      return snapshot
    })()
    return loading
  }

  /** 落盘命中次数（攒批，不每条消息写一次库） */
  async function flushHits() {
    if (!pendingHits.size) return
    const batch = [...pendingHits.entries()]
    pendingHits.clear()
    for (const [id, n] of batch) {
      try {
        await ctx.database.set(TABLE, { id }, { hits: hitCounts.get(id) ?? n })
      } catch (e) {
        // 写失败就把增量退回去，下次再试
        pendingHits.set(id, (pendingHits.get(id) ?? 0) + n)
        logger.warn('命中次数落盘失败（%s）：%s', id, e.message)
        return
      }
    }
  }

  function countHit(rule) {
    hitCounts.set(rule.id, (hitCounts.get(rule.id) ?? 0) + 1)
    pendingHits.set(rule.id, (pendingHits.get(rule.id) ?? 0) + 1)
    rule.hits = hitCounts.get(rule.id)
  }

  if (Number(cfg.hitFlushSeconds) > 0) {
    // ctx.setInterval：插件卸载/重载时会被 cordis 自动清掉，别用裸 setInterval
    ctx.setInterval(() => void flushHits(), Number(cfg.hitFlushSeconds) * 1000)
  }

  // ---------------------------------------------------------------- 作用域

  /** 这条消息属于哪个作用域。群用 guildId，私聊退到 channelId */
  function scopeOf(session) {
    const id = session?.guildId ?? session?.channelId
    return id == null || id === '' ? GLOBAL_SCOPE : String(id)
  }

  /** 当前作用域能用哪些规则（已启用） */
  function rulesFor(scopeKey) {
    return snapshot.filter(
      (r) => r.enabled && r.pattern && (r.scope === GLOBAL_SCOPE || r.scope === scopeKey)
    )
  }

  // ---------------------------------------------------------------- 指令标记
  //
  // ★★ 为什么**不能**在 before-send 里读 `session.argv`（本插件第一版就栽在这）
  //
  //   出站时 @satorijs/core 的编码器会 new 一个 session，只把原 session 上**可枚举**的键
  //   复制过去（core:739-742 那个 `for (const key in ...)`）；而 `argv` 是 Koishi 用
  //   `defineProperty` 挂上去的 —— **不可枚举**，于是被这个循环漏掉。
  //   结论：`session.argv?.command` 在 before-send 里**永远是 undefined**。
  //
  //   rig 63 第一轮的实测现象正是这么来的：本插件自己的指令回执被自己替换掉了 ——
  //   `/replacer` 清单印出来是「#1 开 [本群]「嘿嘿」→「嘿嘿」」，`/replacer.test` 的
  //   **输入行**都变成了替换后的文本。管理员于是永远看不到自己配的原文，
  //   而"跳过自己的指令"这条防线根本没生效（`skipCommands` 也一起失效）。
  //
  //   照抄本项目已被生产验证过的做法（`chatluna-page:591`、`chatluna-guard:960`）：
  //   在 `command/execute` 往 session 上打一个**普通赋值**的标记。普通赋值 = 可枚举，
  //   出站时会被编码器自动拷过去，于是 before-send 里读得到。
  ctx.before('command/execute', (argv) => {
    const s = argv?.session
    // 存整个 command 对象（page 也这么做）：出站侧要拿 name 与 _aliases 两种写法
    if (s && argv?.command) s.__replacerCommand = argv.command
  })

  // ---------------------------------------------------------------- 出站改写
  //
  // ★★ 为什么必须用 `prepend`（第三个参数 = true），而不是靠 koishi.yml 里的先后
  //
  //   rig 63 第二轮实测：即使把本插件在 koishi.yml 里排到 chatluna-page **前面**，
  //   它照样**最后**才跑 —— 日志顺序是 `page → replystyle → replacer`。
  //
  //   根因是 **`inject` 会推迟 apply**：本插件声明了 `required: ['database']`，
  //   于是它的 `apply` 要等 database 就绪才跑；而 chatluna-render / chatluna-page /
  //   chatluna-reply-style 没有这层等待，`apply` 立刻完成、`before-send` 监听器先注册。
  //   `app.serial` 是按**注册顺序**遍历的（@cordisjs/core:523 dispatch + :534 `unshift/push`），
  //   所以"写在配置文件前面"根本不等于"先跑"。
  //
  //   这个坑的症状**只出现在长回复上**：page 把 ≥180 字 / ≥6 行的回复转成图片，
  //   排在它后面的话，替换层看到的就只剩一个 image 元素 —— 短回复照常替换，
  //   长回复里的 😏 原样留在图里，静默、无报错（第二轮实测：page 渲染的正文是
  //   295 字符 = **未替换**的长度）。
  //
  //   所以位置这件事**必须由本插件自己声明**：`ctx.on(事件, 回调, true)` 走
  //   `register(..., {prepend:true})` → `hooks.unshift(...)`（@cordisjs/core:534），
  //   把自己固定插在队首，从此与插件加载顺序**无关**。
  //
  //   ★ 副作用（实测，不是推断）：`chatluna-episode` 也带 `inject`，会被推迟到很后面 ——
  //     实测整条链是 `replacer → render → page → reply-style → … → episode`，
  //     它反而排在**最后**。于是 episode 记到的**纯文本**回复是**替换之后**的文本
  //     （"我实际发出去的是 嘿嘿"），比记原文更贴合"对话记录 == 群友看到的"。
  //     长回复那头它看到的已经是 page 出好的图片（记的是 `<img>`）—— 那是 episode 与
  //     page 之间既有的行为，与本插件无关。
  ctx.on('before-send', (session) => {
    // ★ 整个 handler 绝不能抛：抛了会被当成"取消发送"，消息就没了
    try {
      if (!cfg.enabled || !session) return

      const els = session.elements
      if (!Array.isArray(els) || els.length === 0) return

      // ---- 是不是该跳过这条出站 ----
      // 首选 `__replacerCommand`（可枚举标记，见上）；`session.argv` 只是兜底，
      // 正常路径下它是 undefined（留着重在"万一哪天 Koishi 改成可枚举"）。
      const cmd = session.__replacerCommand ?? session.argv?.command
      if (cmd) {
        const names = [cmd.name, ...Object.keys(cmd._aliases ?? {})].filter(Boolean)
        // 本插件自己的指令：无条件跳过（否则规则清单里的原文会被自己替换掉）
        if (names.some((n) => n === CMD_PREFIX || String(n).startsWith(CMD_PREFIX + '.'))) {
          log('本插件指令回执，跳过替换（%s）', cmd.name)
          return
        }
        if (cfg.skipCommands) {
          log('指令回执，跳过替换（%s）', cmd.name)
          return
        }
      }
      // guard 的开关回执：功能性的，不是模型说的话
      if (cfg.skipGuardControl && session.__guardControl) {
        log('guard 开关回执，跳过替换')
        return
      }

      // 快照还没载入：这一次放行原样，同时补一次载入（自愈，不阻塞发送）
      if (!loaded) {
        void reload('按需')
        return
      }

      const scopeKey = scopeOf(session)
      const rules = rulesFor(scopeKey)
      if (!rules.length) return

      // ---- 逐元素改写（只动 text）----
      const next = []
      let changed = false
      /** 本轮的替换**次数**（同一条规则命中多次要算多次） */
      let totalHits = 0
      /** @type {Map<string, object>} 本轮命中的规则（按 id 去重，只用于打明细） */
      const hitRules = new Map()

      for (const el of els) {
        if (el?.type !== 'text') {
          next.push(el)
          continue
        }
        const raw = String(el?.attrs?.content ?? '')
        if (!raw) {
          next.push(el)
          continue
        }
        const { text, hits } = transform(raw, rules)
        if (hits.length) {
          totalHits += hits.length
          for (const r of hits) {
            hitRules.set(r.id, r)
            countHit(r)
          }
        }
        if (text === raw) {
          next.push(el)
          continue
        }
        changed = true
        if (text.length === 0) {
          // 这一整段被替换没了 → 丢掉这个元素（同 replyshaper 的做法）
          log('文本元素被替换为空，丢弃（原文「%s」）', raw.slice(0, 24))
          continue
        }
        next.push(h('text', { content: text }))
      }

      if (!changed) return

      if (next.length === 0) {
        if (cfg.dropWhenEmpty) {
          log('替换后整条消息为空，取消发送')
          return true // 非空返回值 = 取消发送
        }
        // 不取消的话得留个占位，否则发出去是条空消息
        next.push(h('text', { content: '' }))
      }

      session.elements = next

      const detail = [...hitRules.values()]
        .map((r) => `#${r.id}「${r.pattern}」→「${r.replacement}」`)
        .join('，')
      // ★ 「%d 处」= 替换**次数**，「%d 条规则」= 命中的不同规则数。
      //   第一版把后者当"处"打了（长正文里 😏 命中 2 次 + 😏😏 1 次，只有 2 条规则，
      //   日志写"2 处"），排查加载顺序时差点被这行日志带偏 —— 两个数都打出来。
      logger.info(
        '出站替换：%d 处 / %d 条规则（%s）｜%s',
        totalHits,
        hitRules.size,
        scopeKey === GLOBAL_SCOPE ? '私聊/全局' : `群 ${scopeKey}`,
        detail
      )
    } catch (e) {
      // 见上：这里吞掉异常是**故意的**，抛出去这条消息就发不出去了
      logger.warn('出站替换出错（原样发送）：%s', e.message)
    }
    // ★ 第三个参数 true = prepend：插到 before-send 队首，与插件加载顺序无关。
    //   为什么必须这么写，见本节开头那段长注释（rig 63 第二轮实测）。
  }, true)

  // ---------------------------------------------------------------- 指令
  //
  // 命名约定：**一律英文**（2026-10-02 起）。中文只写在描述里。
  // 写操作（增删改）门槛 = 3 管理员；只读（看清单 / 试跑）门槛 = 1 普通。
  const READ = { authority: 1 }
  const WRITE = { authority: 3 }

  const USAGE = [
    '替换层用法（写操作要 3 级管理员以上）：',
    '  /replacer                     看当前群生效的规则',
    '  /replacer.add 原文 [替换为]    新增（省略"替换为"= 删掉原文；加 -g 全群生效，需 4 级）',
    '  /replacer.set 编号 替换为      改某条规则的替换文本',
    '  /replacer.del 编号            删除',
    '  /replacer.on|off 编号         启用 / 停用',
    '  /replacer.test 一段文字        预览会被替换成什么（不改任何东西）',
    '  /replacer.reload              从库里重新载入规则',
    '',
    '原文里含空格时用引号：/replacer.add "你 好" 嗨',
    '例：/replacer.add 😏 嘿嘿',
  ].join('\n')

  /** 编号 → 规则。找不到时返回 null，并把原因写进 err */
  function findRule(idRaw) {
    const id = String(idRaw ?? '').trim()
    if (!/^\d+$/.test(id)) return null
    return snapshot.find((r) => r.id === id) ?? null
  }

  function nextId() {
    const max = snapshot.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0)
    return String(max + 1)
  }

  /** 组装规则清单文案 */
  function listText(session) {
    const scopeKey = scopeOf(session)
    const mine = snapshot.filter(
      (r) => r.scope === GLOBAL_SCOPE || r.scope === scopeKey
    )
    const others = snapshot.length - mine.length
    const lines = [
      `替换规则：本群生效 ${mine.filter((r) => r.scope !== GLOBAL_SCOPE).length} 条 / 全局 ${mine.filter((r) => r.scope === GLOBAL_SCOPE).length} 条（共 ${snapshot.length} 条）`,
    ]
    if (!mine.length) {
      lines.push('  （还没有规则）')
    } else {
      for (const r of mine) {
        // 命中数优先取内存里的实时值（落盘是攒批的，库里的会滞后一点）
        const hits = hitCounts.get(r.id) ?? r.hits
        lines.push(
          `  #${r.id} ${r.enabled ? '开' : '关'} [${describeScope(r.scope, scopeKey)}] 「${r.pattern}」→「${r.replacement}」 命中 ${hits}`
        )
      }
    }
    if (others > 0) lines.push(`（另有 ${others} 条只在别的群生效，这里看不到）`)
    lines.push('', USAGE)
    return lines.join('\n')
  }

  // 总入口：/replacer
  // ★ 父指令必须自己挂 action，否则单独发 /replacer 会"解析成功但返回空串"
  ctx.command(CMD_PREFIX, '查看出站文本替换规则', READ).action(({ session }) => listText(session))

  ctx.command(`${CMD_PREFIX}.list`, '查看出站文本替换规则', READ).action(({ session }) => listText(session))

  ctx
    .command(`${CMD_PREFIX}.add`, '新增一条替换规则', WRITE)
    // ★ Koishi 的签名是 `option(name, def, config)`：**第一个参数是裸名字**，
    //   旗标与描述写在第二个字符串里（core:294 `_createOption` 用正则从 def 里抠旗标）。
    //   写成 `option('global', '-g, --global', '描述')` 会把描述当成 config 展开 —— 静默出错。
    .option('global', '-g, --global  作用到所有群与私聊（需要 4 级主人）')
    .usage('例：/replacer.add 😏 嘿嘿   ／  /replacer.add "你 好" 嗨   ／  /replacer.add 😏（= 删掉）')
    .action(async ({ session }, ..._rest) => {
      // ★ 参数从**原始正文**里取（见文件头：声明式参数会被 Satori 转义）
      const { args, wantGlobal } = parseArgs(rawRest(session))
      if (args.length === 0) return '要替换什么？\n' + USAGE
      if (args.length > 2) {
        return `最多两个参数（原文 + 替换为），收到了 ${args.length} 个。\n原文里含空格请用引号：/replacer.add "你 好" 嗨`
      }

      const pattern = args[0]
      const replacement = args.length >= 2 ? args[1] : ''
      if (!pattern) return '「原文」不能是空的。'

      const level = session?.user?.authority ?? 1
      if (wantGlobal && level < 4) {
        return `-g（全局）需要 4 级主人权限，你当前是 ${level} 级。不加 -g 的话只在本群生效。`
      }

      if (snapshot.length >= Number(cfg.maxRules)) {
        return `规则已达上限 ${cfg.maxRules} 条，先删掉用不上的再加。`
      }

      const scope = wantGlobal ? GLOBAL_SCOPE : scopeOf(session)
      const sameScope = snapshot.find((r) => r.scope === scope && r.pattern === pattern)
      if (sameScope) {
        return `这条原文在${describeScope(scope, scopeOf(session))}已经有了（#${sameScope.id} → 「${sameScope.replacement}」）。要改替换文本用 /replacer.set ${sameScope.id} 新的替换文本`
      }

      const id = nextId()
      const now = new Date()
      try {
        await ctx.database.upsert(TABLE, [
          {
            id,
            scope,
            pattern,
            replacement,
            enabled: true,
            hits: 0,
            createdBy: session?.userId == null ? null : String(session.userId),
            createdAt: now,
            updatedAt: now,
          },
        ])
      } catch (e) {
        logger.warn('新增替换规则失败：%s', e.message)
        return `写库失败：${e.message}`
      }
      await reload('新增')

      logger.info(
        '%s 新增替换规则 #%s（%s）：「%s」→「%s」',
        session?.userId,
        id,
        describeScope(scope, scopeOf(session)),
        pattern,
        replacement
      )
      return [
        `已添加规则 #${id}： 「${pattern}」→「${replacement || '（删除）'}」`,
        `生效范围：${wantGlobal ? '全局（所有群与私聊）' : `仅本群 ${scope}`}${wantGlobal ? '' : '（要全局加 -g，需 4 级）'}`,
        '发 /replacer 可以随时看清单。',
      ].join('\n')
    })

  ctx
    .command(`${CMD_PREFIX}.set <id:string>`, '改某条规则的替换文本', WRITE)
    .usage('例：/replacer.set 1 嘿嘿   ／  /replacer.set 1 ""（= 改成删除）')
    .action(async ({ session }, idRaw) => {
      const rule = findRule(idRaw)
      if (!rule) return `没有 #${idRaw} 这条规则。发 /replacer 看清单。`
      if (!canTouch(rule, session)) return `#${rule.id} 是全局规则，改它需要 4 级主人权限。`

      const { args } = parseArgs(rawRest(session))
      // 第一个 token 是编号，其余（0 或 1 个）才是替换文本
      const rest = args.slice(1)
      if (rest.length > 1) return '替换文本最多一个参数，含空格请用引号。'
      const replacement = rest.length === 1 ? rest[0] : ''

      try {
        await ctx.database.set(TABLE, { id: rule.id }, { replacement, updatedAt: new Date() })
      } catch (e) {
        logger.warn('改替换规则失败：%s', e.message)
        return `写库失败：${e.message}`
      }
      await reload('修改')
      logger.info('%s 把规则 #%s 的替换文本改成「%s」', session?.userId, rule.id, replacement)
      return `已把 #${rule.id}「${rule.pattern}」的替换文本改为「${replacement || '（删除）'}」`
    })

  ctx
    .command(`${CMD_PREFIX}.del <id:string>`, '删除一条替换规则', WRITE)
    // ★ 别名的 options 不传 args 声明（会被整体赋给 argv.args，见文件头坑位备忘）
    .alias(`${CMD_PREFIX}.remove`, { args: [] })
    .action(async ({ session }, idRaw) => {
      const rule = findRule(idRaw)
      if (!rule) return `没有 #${idRaw} 这条规则。发 /replacer 看清单。`
      if (!canTouch(rule, session)) return `#${rule.id} 是全局规则，删它需要 4 级主人权限。`
      try {
        await ctx.database.remove(TABLE, { id: rule.id })
      } catch (e) {
        logger.warn('删除替换规则失败：%s', e.message)
        return `写库失败：${e.message}`
      }
      hitCounts.delete(rule.id)
      pendingHits.delete(rule.id)
      await reload('删除')
      logger.info('%s 删除了替换规则 #%s（「%s」）', session?.userId, rule.id, rule.pattern)
      return `已删除规则 #${rule.id}（「${rule.pattern}」→「${rule.replacement}」）`
    })

  async function setEnabled(session, idRaw, on) {
    const rule = findRule(idRaw)
    if (!rule) return `没有 #${idRaw} 这条规则。发 /replacer 看清单。`
    if (!canTouch(rule, session)) return `#${rule.id} 是全局规则，改它需要 4 级主人权限。`
    if (rule.enabled === on) return `#${rule.id} 本来就是${on ? '开' : '关'}着的。`
    try {
      await ctx.database.set(TABLE, { id: rule.id }, { enabled: on, updatedAt: new Date() })
    } catch (e) {
      logger.warn('切换替换规则失败：%s', e.message)
      return `写库失败：${e.message}`
    }
    await reload(on ? '启用' : '停用')
    logger.info('%s 把替换规则 #%s 设为%s', session?.userId, rule.id, on ? '启用' : '停用')
    return `已把 #${rule.id}（「${rule.pattern}」）设为${on ? '启用' : '停用'}。`
  }

  ctx
    .command(`${CMD_PREFIX}.on <id:string>`, '启用一条替换规则', WRITE)
    .action(({ session }, idRaw) => setEnabled(session, idRaw, true))

  ctx
    .command(`${CMD_PREFIX}.off <id:string>`, '停用一条替换规则（不删，随时能开回来）', WRITE)
    .action(({ session }, idRaw) => setEnabled(session, idRaw, false))

  ctx
    .command(`${CMD_PREFIX}.test`, '预览一段文字会被替换成什么（不改任何东西）', READ)
    .usage('例：/replacer.test 今天真开心😏')
    .action(({ session }) => {
      // dry-run：整段原始正文当作待替换文本，不切词（含空格也照原样）
      const input = String(rawRest(session) ?? '')
      if (!input) return '给我一段文字，例如 /replacer.test 今天真开心😏'
      // 试跑也遵守"本插件自身指令跳过"的口径没意义（这是纯预览），
      // 所以直接按当前作用域的规则算，让管理员看到真实效果。
      const scopeKey = scopeOf(session)
      const rules = rulesFor(scopeKey)
      const { text, hits } = transform(input, rules)
      const byRule = new Map()
      for (const r of hits) byRule.set(r.id, (byRule.get(r.id) ?? 0) + 1)
      const lines = [
        `输入：${input}`,
        `输出：${text === '' ? '（空 → 整条消息会被取消发送）' : text}`,
        `当前作用域：${scopeKey === GLOBAL_SCOPE ? '全局' : scopeKey}｜适用规则 ${rules.length} 条`,
      ]
      if (byRule.size) {
        lines.push('命中：')
        for (const [id, n] of byRule) {
          const r = snapshot.find((x) => x.id === id)
          lines.push(`  #${id}「${r?.pattern}」→「${r?.replacement}」× ${n}`)
        }
      } else {
        lines.push('命中：无（这段话里没有任何规则的原文；也可能规则都关着）')
      }
      return lines.join('\n')
    })

  ctx.command(`${CMD_PREFIX}.reload`, '从库里重新载入替换规则', WRITE).action(async () => {
    await reload('手动')
    await flushHits()
    return `已重新载入：共 ${snapshot.length} 条规则（其中启用 ${snapshot.filter((r) => r.enabled).length} 条）。`
  })

  /**
   * 能不能动这条规则。
   * 群规则：3 级管理员就能改（本群范围内）。
   * 全局规则：只有 4 级主人能改 —— 免得某个群的管理员改了所有群。
   */
  function canTouch(rule, session) {
    if (rule.scope !== GLOBAL_SCOPE) return true
    return (session?.user?.authority ?? 1) >= 4
  }

  // ---------------------------------------------------------------- 启动

  ctx.on('ready', () => {
    void reload('启动')

    // 自检：指令名解析是这块最容易翻车的地方（斜杠写法、父指令不挂 action 都踩过），
    // 启动后主动验一遍，出问题在日志里一眼能看到。延迟是为了等别的插件也注册完。
    ctx.setTimeout(() => {
      const names = [
        CMD_PREFIX,
        `${CMD_PREFIX}.list`,
        `${CMD_PREFIX}.add`,
        `${CMD_PREFIX}.set`,
        `${CMD_PREFIX}.del`,
        `${CMD_PREFIX}.remove`,
        `${CMD_PREFIX}.on`,
        `${CMD_PREFIX}.off`,
        `${CMD_PREFIX}.test`,
        `${CMD_PREFIX}.reload`,
      ]
      const bad = names.filter((n) => !ctx.$commander?.get?.(n))
      if (bad.length) logger.warn('触发名自检：这些名字解析不到 → %s', bad.join(' / '))
      else logger.info('触发名自检通过：%d 个触发名全部可用', names.length)
    }, 8000)
  })

  logger.info(
    '出站替换层已挂载（开关 %s；指令回执%s；规则改动需 3 级管理员，全局规则需 4 级）',
    cfg.enabled ? '开' : '关',
    cfg.skipCommands ? '跳过' : '也替换'
  )
}

module.exports = {
  name,
  inject,
  Config,
  apply,
  /**
   * 纯函数部分，**只为离线单测暴露**（`tools/probe-replacer-core.cjs`）。
   * Koishi 加载插件时只读 name / inject / Config / apply，多挂一个键无副作用。
   * 暴露的理由：替换语义（单趟最长匹配 / 不回头扫 / 作用域优先级）是这东西最容易
   * 静默写错的地方，而跑一次测试台要一分半 —— 这几条值得用毫秒级的单测钉住。
   */
  _internals: { transform, tokenize, parseArgs, normalize },
}
