/**
 * koishi-plugin-chatluna-alias —— 指令别名层（把 147 条原始指令收成一张常用表）
 *
 * 需求（用户原话，2026-10-03）：
 *   「现在的命令列表的命令有前缀，有的甚至使用的发 "xingyuan" 这个过时的名称前缀，
 *     可能是插件本身的命令也全都搜集过来了。给当前的命令抽象一层：
 *      ① 只有那些可能经常用到的命令才列出来；
 *      ② 只显示别名（别名为英文，一个单词，不重复），命令也是使用斜杠加别名的方式调用，
 *         也就是建立一个抽象层命令与原本的命令的映射；
 *      ③ 同时保留一个查看原有命令的参数，比如 -all 什么的。」
 *
 * ------------------------------------------------------------------ 为什么用原生别名
 *
 * `Command#alias()`（`@koishijs/core:963`）就是框架自带的抽象层：别名和主名挂在
 * **同一条指令对象**上，于是参数解析、选项、usage、i18n 文案、authority 门槛全部自动继承，
 * 一行都不用抄。实测 `/model gpt-4o` 与 `/chatluna.use.model gpt-4o` 走的是同一条路径。
 *
 * 两条**走不通**的路（记下来免得以后又绕回去）：
 *
 *  ① 转发指令（自己注册一个 `model`，action 里再 `session.execute('chatluna.use.model …')`）
 *     —— 参数和选项得自己再写一遍，写漏了就静默丢参数；而且 `argv.command` 指向的是
 *     我们这条假指令，权限判定、`-h` 用法、`/help model` 的详情页全会错位。
 *
 *  ② 改写 `session.stripped.content`（prepend 中间件里把 `/model` 换成
 *     `/chatluna.use.model`）—— **群里会直接失效**。`ctx.before('attach')` 是先从
 *     content 上切前缀再解析（core:1275-1289），而 `inferCommand` 里有一句
 *     `if (argv.root && stripped.prefix === null && isStrict) return`（core:1447），
 *     群聊恒为 strict。也就是说：内容里没有前缀 = 这条消息根本没有指令可解析。
 *     要把前缀再拼回去，就得自己实现一遍 `_resolvePrefixes`，纯属重复造轮子。
 *
 * ------------------------------------------------------------------ 为什么在 ready 时注册
 *
 * `_registerAlias` 在名字**已被别的指令占用**时会直接抛异常（core:934-940
 * `duplicate command names`），而各插件的指令是在自己的 apply 里建的。只有在 `ready`
 * 之后，`_commandList` 才是完整的，这时判定「这个别名有没有被占用」才有意义。
 * 被占用 / 找不到目标都只 warn 跳过 —— 绝不让一条配错的别名把整个插件带崩。
 *
 * ------------------------------------------------------------------ 和 /help 的关系
 *
 * 别名表只在这里维护（一处配置）；`chatluna-help` 通过 `ctx.get('chatlunaAlias')`
 * 读它来渲染「常用指令」首页，读不到就退回原来的全量总览 —— 两个插件互不依赖也能各自工作。
 */

const { Schema, Logger } = require('koishi')

const name = 'chatluna-alias'
const inject = { required: [], optional: [] }
const logger = new Logger('alias')

/**
 * 默认别名表。
 *
 * 收录标准（这是"抽象层"的全部意义，别随手往里加）：
 *   **一个人一周之内真会在 QQ 里敲的命令**。诊断/运维类的一次性指令
 *   （`vision.stat`、`page.prune`、`render.test`、`sticker.retry`…）一律不收 ——
 *   它们在 `/help -all` 里都还在，需要时查得到就行。
 *
 * 命名规则：英文、单个单词、小写、全局唯一。复数形式专门用来区分"列表"和"操作"：
 *   `model` 切模型 / `models` 列模型，`room` 看当前会话 / `rooms` 列会话。
 */
const DEFAULT_ALIASES = [
  // ---- 基础 ----
  { alias: 'help', target: 'help', note: '指令总览（就是这一页）' },
  { alias: 'think', target: 'think', note: '看模型上一次的思考过程' },

  // ---- 对话与模型 ----
  { alias: 'model', target: 'chatluna.use.model' },
  // ★ 2026-10-04（第八轮）：`/models` 不再转发上游的 `chatluna.model.list` ——
  //   上游虽然支持 `-p <page>`，但页脚只写「当前为第 1 / 3 页」，**一个字都没提怎么翻页**
  //   （用户原话：「/models 命令没法翻页，提示中没有翻页的命令」），而且它的 footer 讲的是
  //   预设/会话切换，跟模型无关。自研的 chatluna-models 接管了这条命令：页码可以当位置参数
  //   （`/models 2`），页脚直接写出下一步敲什么。
  { alias: 'models', target: 'models', note: '列出可用模型（`/models 2` 翻页）；`/stages` 看各阶段在用的模型' },
  { alias: 'stages', target: 'stages', note: '看各阶段（聊天 / 看图 / 记忆 / 把关…）分别在用哪个模型' },
  { alias: 'preset', target: 'chatluna.use.preset' },
  { alias: 'presets', target: 'chatluna.preset.list' },
  { alias: 'mode', target: 'chatluna.use.mode' },
  { alias: 'new', target: 'chatluna.new' },
  { alias: 'room', target: 'chatluna.current' },
  { alias: 'rooms', target: 'chatluna.list' },
  { alias: 'switch', target: 'chatluna.switch' },
  // `chatluna.stop` 自己没有写说明，全靠这里的 note
  { alias: 'stop', target: 'chatluna.stop', note: '打断正在生成的这一轮回复' },

  // ---- 长期记忆 ----
  { alias: 'remember', target: 'chatluna.memory.add' },
  { alias: 'recall', target: 'chatluna.memory.search' },
  { alias: 'forget', target: 'chatluna.memory.delete' },

  // ---- 好感度 ----
  // ★ 指令根 = chatluna-affinity 配置里的 scopeId。2026-10-04 之前它叫 `xingyuan`
  //   （小号的旧名"星源"）—— 用户要求「全部替换成功能性描述、不带名字」，改成了 `affinity`。
  //   改 scopeId 会连带换掉这 10 条指令的全名，所以配置、指令表、帮助页、预设变量四处必须一起改。
  //
  // ★★ 别名**不能叫 `affinity`**：Koishi 的 Commander 会为 `affinity.rank` 这类带点全名
  //   **自动建出父指令 `affinity`**（`_resolve` 逐段 resolve 时建的），所以 `affinity`
  //   这个名字已经被占了 —— rig 58 第一次跑就报「affinity（已被 affinity 占用）」，
  //   别名被跳过（`/affinity` 敲下去只会落到那个没有 action 的父指令上）。
  //   换个同义单词 `favor`，语义一样、不撞车。
  { alias: 'favor', target: 'affinity.inspect', note: '看某人的好感度；不带人 = 看自己' },
  { alias: 'rank', target: 'affinity.rank' },
  { alias: 'adjust', target: 'affinity.adjust' },
  { alias: 'block', target: 'affinity.block' },
  { alias: 'unblock', target: 'affinity.unblock' },

  // ---- 情绪 ----
  { alias: 'mood', target: 'emotion' },
  { alias: 'moods', target: 'emotion.list' },
  { alias: 'feel', target: 'emotion.set' },

  // ---- 图片与表情包 ----
  { alias: 'pics', target: 'vision.list' },
  { alias: 'probe', target: 'vision.probe', note: '测一张图会不会被压缩（不调模型）' },
  // ★ 第九轮（2026-10-04）：`/vision.this` = 「引用一张图，看视觉把它认成了什么」。
  //   只读缓存、不调模型，专门用来验"表情包是不是被认成 bot 自己 / 对话模型有没有改对描述"。
  //   别名不叫 `vision`：`vision.this` 会让 Commander 自动建出父指令 `vision`（同 affinity 那个坑）。
  { alias: 'look', target: 'vision.this', note: '引用一张图 + /look：看它被认成了什么（只读，不调模型）' },
  { alias: 'stickers', target: 'sticker.list' },

  // ---- 群管理与限流 ----
  { alias: 'mute', target: 'guard.mute' },
  { alias: 'unmute', target: 'guard.allow' },
  { alias: 'muted', target: 'guard.status' },
  { alias: 'quota', target: 'guard.limit', note: '这个群还剩几个出站令牌' },

  // ---- 互动 ----
  { alias: 'scene', target: 'scene', note: '看当前互动（游戏 / 任务）的状态' },
  // ★ 第五轮：短期情景记忆 / 专注模式。别名**刻意不叫 recall** ——
  //   `chatluna.memory.search` 已经占了那个名字（长期记忆检索），重名会让 `_registerAlias` 抛
  //   duplicate command names（别名层里最忌讳的事）。所以把"翻旧账"这条留给它：mem。
  { alias: 'mem', target: 'episode.preview', note: '看模型眼里的「最近发生的事」（排查记性差）' },
  { alias: 'focus', target: 'focus', note: '开专注模式：这一局每句话都记住（长局游戏用）' },
  { alias: 'followup', target: 'followup' },
  { alias: 'proactive', target: 'proactive' },
  { alias: 'speak', target: 'proactive.speak' },
  // ★ 第九轮：作息表（chatluna-routine）。`/routine.status` 看作息与当前时段；
  //   `routine` 这个名字本身没被占用（父指令是 routine，但我们别名指向子指令，
  //   名字 `routine` 会和自动建出的父指令撞车 —— 所以用 `day`）。
  { alias: 'day', target: 'routine.status', note: '看作息表：现在处于睡觉 / 吃饭 / 醒着哪个时段' },
  { alias: 'self', target: 'persona.show', note: '看人设卡片（各阶段的模型分别会收到什么）' },

  // ---- 扩展与运维 ----
  { alias: 'market', target: 'selfext.search' },
  { alias: 'apply', target: 'selfext.request' },
  { alias: 'install', target: 'selfext.install' },
  { alias: 'text', target: 'page.text', note: '页面化输出切回文字' },
  // ★ `more` 是「长内容分页」的翻页入口（2026-10-03 第四轮加）：
  //   长回复 / 长输出出图时会带上「第 1/3 页 · 发 /more 2」的页脚，这条别名就是那个 /more。
  //   不带数字 = 看下一页，带数字 = 跳到第 n 页。
  { alias: 'more', target: 'page.more', note: '翻到长回复 / 长输出的下一页' },
  { alias: 'reply', target: 'replystyle' },
  { alias: 'me', target: 'qqbot.auth.me' },
  { alias: 'levels', target: 'qqbot.auth.list' },
  { alias: 'grant', target: 'qqbot.auth.set' },
  // ★ 这里**故意没有** `echo`：生产环境装了官方的 `@koishijs/plugin-echo`，`echo` 这个名字
  //   已经被它占了（干的是同一件事：把话原样说回来）。第一次上线时表里写了 `echo → qqbot.echo`，
  //   启动日志如实报了「名字冲突 1：echo（已被 echo 占用）」并跳过 —— 校验器按设计工作。
  //   与其抢名字，不如承认 `/echo` 本来就是可用的。
]

const Config = Schema.intersect([
  Schema.object({
    enabled: Schema.boolean().default(true).description('总开关。关掉后别名全部失效，只留原始指令名'),
    aliases: Schema.array(
      Schema.object({
        alias: Schema.string().required().description('别名：英文、单个单词、小写。调用方式 `/别名`'),
        target: Schema.string().required().description('它指向的原始指令名（完整点号名，如 `chatluna.use.model`）'),
        note: Schema.string().description('用途说明。留空 = 用指令自己的说明'),
      })
    )
      .role('table')
      .default(DEFAULT_ALIASES)
      .description(
        '★ 别名表。只有写在这里的指令才会出现在 `/help` 首页 —— 这就是用户要的那层抽象。' +
          '改完重启生效；被占用的名字会打 warn 跳过，不会影响别的指令'
      ),
  }),
  Schema.object({
    debug: Schema.boolean().default(true).description('打印每条别名的注册结果'),
  }),
])

/** 与 `Command.normalize` 保持一致（core:931）：小写 + 下划线转横线 */
const normalize = (s) => String(s ?? '').trim().toLowerCase().replace(/_/g, '-')

function apply(ctx, config) {
  const cfg = {
    enabled: true,
    aliases: DEFAULT_ALIASES,
    debug: true,
    ...(config ?? {}),
  }
  const log = (...a) => cfg.debug && logger.info(...a)

  /** 注册结果。`entries()` 是给 chatluna-help 用的只读快照 */
  const state = {
    entries: [], // [{ alias, target, note, ok, level? }]
    missing: [], // 目标指令不存在（插件没装 / 名字写错）
    conflict: [], // 名字被别的指令占了
    dup: [], // 表里重复的别名
  }

  function table() {
    const list = Array.isArray(cfg.aliases) && cfg.aliases.length ? cfg.aliases : DEFAULT_ALIASES
    return list
      .map((it) => ({
        alias: normalize(it?.alias),
        target: normalize(it?.target),
        note: String(it?.note ?? '').trim(),
      }))
      .filter((it) => it.alias && it.target)
  }

  function commander() {
    const c = ctx.$commander || ctx.root?.$commander
    return c && Array.isArray(c._commandList) ? c : null
  }

  /**
   * 把别名挂到目标指令上。
   *
   * 可以重复调用（`_registerAlias` 对"已经是同一条指令的别名"是空操作），
   * 所以 ready 后补一次、以后再补一次都不会出问题。
   */
  function install() {
    const cmdr = commander()
    if (!cmdr) {
      logger.warn('拿不到 Commander 指令表，别名层未生效')
      return
    }

    const entries = []
    const missing = []
    const conflict = []
    const dup = []
    const seen = new Set()

    for (const { alias, target, note } of table()) {
      if (seen.has(alias)) {
        dup.push(alias)
        continue
      }
      seen.add(alias)

      const cmd = cmdr.get(target)
      if (!cmd) {
        missing.push(`${alias} → ${target}`)
        continue
      }

      // 目标名本身可能还是个别名（写表时写成了别人的别名）—— 记真实主名，便于展示
      const realName = cmd.name

      const owner = cmdr.get(alias)
      if (owner && owner !== cmd) {
        conflict.push(`${alias}（已被 ${owner.name} 占用）`)
        continue
      }

      if (!owner && alias !== realName) {
        try {
          cmd.alias(alias)
        } catch (e) {
          conflict.push(`${alias}（${e.message}）`)
          continue
        }
      }

      entries.push({ alias, target: realName, note, ok: true })
      log('别名 /%s → %s%s', alias, realName, note ? `（${note}）` : '')
    }

    state.entries = entries
    state.missing = missing
    state.conflict = conflict
    state.dup = dup
  }

  // ---------------------------------------------------------------- 对外服务

  /**
   * `chatluna-help` 用它渲染「常用指令」首页。
   *
   * ★ 返回的是**拷贝**：调用方（帮助页）只读，不给自己留后门改别名表。
   * ★ 只返回注册成功的条目 —— 帮助页里出现一条敲不出来的别名比不出现更糟。
   */
  ctx.provide('chatlunaAlias', {
    entries: () => state.entries.map((e) => ({ ...e })),
    problems: () => ({
      missing: [...state.missing],
      conflict: [...state.conflict],
      dup: [...state.dup],
    }),
    /** 别名 → 原始指令名（不认识就返回 null） */
    resolve: (alias) => state.entries.find((e) => e.alias === normalize(alias))?.target ?? null,
    has: (alias) => state.entries.some((e) => e.alias === normalize(alias)),
  })

  // ---------------------------------------------------------------- 启动

  ctx.on('ready', () => {
    if (!cfg.enabled) {
      logger.info('指令别名层已关闭（配置 enabled=false），/help 会退回全量总览')
      return
    }
    install()

    // 补一次：个别插件是 `ctx.inject` 延迟注册的，ready 那一刻可能还没建指令
    setTimeout(() => {
      if (state.missing.length) install()
      report()
    }, 3000)
  })

  function report() {
    logger.info(
      '指令别名层已挂载：%d 个别名可用；目标缺失 %d，名字冲突 %d，表内重复 %d',
      state.entries.length,
      state.missing.length,
      state.conflict.length,
      state.dup.length
    )
    if (state.missing.length) logger.warn('别名目标不存在：%s', state.missing.join(' / '))
    if (state.conflict.length) logger.warn('别名不可用（名字已被占用或非法）：%s', state.conflict.join(' / '))
    if (state.dup.length) logger.warn('别名表里有重复项（只保留第一条）：%s', state.dup.join(' / '))
  }
}

module.exports = { name, inject, Config, apply }
