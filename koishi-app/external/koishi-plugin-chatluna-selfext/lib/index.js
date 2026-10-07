/**
 * koishi-plugin-chatluna-selfext
 *
 * R12「自我扩展」——自写。
 *
 * 需求原文：「发现缺能力（如查天气）→ 搜插件 → 下载安装 → 运行」。
 *
 * ★★ 这条需求里唯一不能含糊的是**安全**。硬约束（第八节第 2 条）写得很清楚：
 *   NapCat / Koishi 的插件加载器**零沙箱**——插件就是往 Koishi 进程里 `import()` 一个 npm 包，
 *   它能读整个文件系统、能拿到 OneBot token、能发任意消息。而「群里 @bot 说话」是不可信输入
 *   直达模型上下文的通道。所以：
 *
 *     **模型只能"搜"和"申请"，绝不能自己装。安装只有主人（authority 4）能触发。**
 *
 *   这不是我保守：官方 registry 里真的躺着 `koishi-plugin-boom2`，它的描述原文就是
 *   「只要安装就会永久损坏你的Koishi,千万别装」。所以搜索结果是**带危险标记**的，
 *   命中危险词的包在安装时会直接拒绝，除非主人显式加 `-f`。
 *
 * 三段实现细节（都实测过，别凭印象改）：
 *   1. **搜**：拉官方 registry 的 index.json（4.9k 条，5MB），结构是
 *      `{ total, objects: [ { package: { name, version, description, ... },
 *                             manifest: { description: { zh, en }, service },
 *                             verified, downloads, installSize } ] }`。
 *      内存里缓存，默认 30 分钟。
 *   2. **装**：优先用 market 插件挂出来的 `ctx.installer.install({ '包名': '版本' })`
 *      （它自己探测 npm/yarn/pnpm，见 @koishijs/plugin-market 的 src/node/installer.ts:189）；
 *      没有 market（比如测试实例）就自己 `npm install`。**包名先过白名单正则**，防命令注入。
 *   3. **跑**：`ctx.loader.reload(ctx.loader.entry, '包名:id', {})` 立刻挂载（不必重启），
 *      再 `loader.config.plugins[key] = {}` + `loader.writeConfig()` 落盘——注意
 *      **只调 reload 不写 config 的话，重启就没了**（控制台的 ConfigWriter 是两个动作都做）。
 *      写盘前会先备份 koishi.yml。
 */

const { Schema, Logger } = require('koishi')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { StructuredTool } = require('@langchain/core/tools')
const z = require('zod')

const name = 'koishi-plugin-chatluna-selfext'

const inject = { required: ['http'], optional: ['chatluna'] }

const logger = new Logger('chatluna-selfext')

/** 合法 npm 包名（含 scope）。★ 装之前必须过这一关：包名会进命令行 */
const PKG_RE = /^(@[a-z0-9-_.]+\/)?[a-z0-9-_.]+$/i

/** 危险描述关键词：命中就在搜索结果里标红，安装时要求 -f */
const DEFAULT_DANGER_WORDS = [
  '损坏',
  '别装',
  '千万别装',
  '病毒',
  '木马',
  '后门',
  '恶意',
  '删库',
  '盗号',
  '炸群',
]

const DEFAULT_ENDPOINTS = [
  'https://koishi-registry.yumetsuki.moe/index.json',
  'https://registry.koishi.chat/index.json',
]

const Config = Schema.intersect([
  Schema.object({
    enabled: Schema.boolean().default(true).description('总开关'),
    endpoints: Schema.array(Schema.string())
      .role('table')
      .default(DEFAULT_ENDPOINTS)
      .description('Koishi registry 镜像地址，按顺序试'),
    cacheMinutes: Schema.natural().default(30).description('registry 索引的内存缓存时间（分钟）'),
    maxResults: Schema.natural().default(8).description('搜索结果最多返回几条'),
    ownerIds: Schema.array(Schema.string())
      .role('table')
      .default([])
      .description('申请安装时私聊通知谁（填主人的 QQ；留空则只在群里说一声）'),
    notifyOwnerOnRequest: Schema.boolean()
      .default(true)
      .description(
        '有人 /selfext.request 申请装插件时，私聊通知 ownerIds。默认开。' +
          '★ 关掉它的场合：用户 2026-10-03 定的原则是「除了命令产生的回复以及 ai 做的回复，' +
          '不要逻辑代码额外产生的回复，宁愿不说话」。这条**是命令驱动的**（有人敲了 /apply），' +
          '而且是私聊发给主人、不进群，所以默认留着；' +
          '实在不想要就关掉，改用 /selfext.requests 主动查看。'
      ),
    allowInstall: Schema.boolean()
      .default(true)
      .description('是否允许安装（关掉后 /selfext.install 直接拒绝，只保留搜索与申请）'),
    persistConfig: Schema.boolean()
      .default(true)
      .description('热挂载后是否把插件条目写进 koishi.yml（写前自动备份）。关掉则重启后失效'),
    npmProxy: Schema.string()
      .default('')
      .description('自己跑 npm install 时用的代理（留空则沿用进程环境变量 HTTP_PROXY/HTTPS_PROXY）'),
    dangerWords: Schema.array(Schema.string())
      .role('table')
      .default(DEFAULT_DANGER_WORDS)
      .description('这些词出现在插件描述里就判定为危险包'),
    debug: Schema.boolean().default(false).description('打印搜索/安装细节'),
  }),
])

// ------------------------------------------------------------------ registry

function createRegistry(ctx, config) {
  let cache = null
  let cacheAt = 0
  let loading = null

  const log = (...a) => config.debug && logger.info(...a)

  async function fetchIndex() {
    const endpoints = (config.endpoints || []).filter(Boolean)
    let lastError = null
    for (const url of endpoints) {
      try {
        const started = Date.now()
        const data = await ctx.http.get(url, { timeout: 30000 })
        const parsed = typeof data === 'string' ? JSON.parse(data) : data
        const objects = parsed?.objects
        if (!Array.isArray(objects) || objects.length === 0) {
          throw new Error('索引结构不对（没有 objects 数组）')
        }
        logger.info(
          'registry 索引已加载：%d 条，用时 %d ms（%s）',
          objects.length,
          Date.now() - started,
          url
        )
        return objects
      } catch (e) {
        lastError = e
        log('拉取 %s 失败：%s', url, e.message)
      }
    }
    throw new Error(`所有 registry 镜像都拉不动：${lastError?.message || '未知错误'}`)
  }

  async function all() {
    const ttl = Math.max(1, config.cacheMinutes) * 60000
    if (cache && Date.now() - cacheAt < ttl) return cache
    if (loading) return loading
    loading = fetchIndex()
      .then((objects) => {
        cache = objects
        cacheAt = Date.now()
        return objects
      })
      .finally(() => {
        loading = null
      })
    return loading
  }

  /** registry 里的描述有几个来源，中文优先 */
  function describe(item) {
    const zh = item?.manifest?.description?.zh
    if (zh) return String(zh)
    const en = item?.manifest?.description?.en
    if (en) return String(en)
    return String(item?.package?.description || '')
  }

  function isDangerous(item) {
    const text = describe(item) + ' ' + String(item?.package?.description || '')
    const words = config.dangerWords || []
    return words.filter((w) => w && text.includes(w))
  }

  /** 关键词搜索：包名 / 描述 / keywords 三处都看 */
  function search(query, limit) {
    const q = String(query || '').trim().toLowerCase()
    if (!q) return []
    const terms = q.split(/\s+/).filter(Boolean)
    return all().then((objects) => {
      const scored = []
      for (const item of objects) {
        const pkg = item?.package || {}
        const name = String(pkg.name || '')
        const desc = describe(item)
        const keywords = (pkg.keywords || []).join(' ').toLowerCase()
        const haystack = (name + ' ' + desc + ' ' + keywords).toLowerCase()
        if (!terms.every((t) => haystack.includes(t))) continue
        let score = 0
        if (name.toLowerCase().includes(q)) score += 5
        if (desc.toLowerCase().includes(q)) score += 3
        if (keywords.includes(q)) score += 2
        score += Math.min(2, Math.log10(1 + (item.downloads?.lastMonth || 0)))
        if (item.verified) score += 1
        scored.push({ item, score })
      }
      scored.sort((a, b) => b.score - a.score)
      return scored.slice(0, limit).map((s) => s.item)
    })
  }

  function format(item, index) {
    const pkg = item?.package || {}
    const danger = isDangerous(item)
    const flags = [
      item.verified ? '官方认证' : null,
      `月下载 ${item.downloads?.lastMonth ?? '?'}`,
      danger.length ? `⚠️危险：描述里有「${danger.join('、')}」` : null,
    ].filter(Boolean)
    const line =
      `${index + 1}. ${pkg.name}@${pkg.version}` +
      `\n   ${describe(item).replace(/\s+/g, ' ').slice(0, 100) || '（没有描述）'}` +
      `\n   ${flags.join('｜')}`
    return line
  }

  function latestVersion(objects, pkgName) {
    const hit = objects.find((o) => o?.package?.name === pkgName)
    return hit?.package?.version || null
  }

  function findByName(objects, pkgName) {
    return objects.find((o) => o?.package?.name === pkgName) || null
  }

  return { all, search, format, isDangerous, latestVersion, findByName, describe }
}

// ------------------------------------------------------------------ 安装

function sanitizeSpec(input) {
  const raw = String(input || '').trim()
  // 允许 "包名@版本" 这种写法，但两段都要合法
  const at = raw.lastIndexOf('@')
  if (at > 0) {
    const pkg = raw.slice(0, at)
    const ver = raw.slice(at + 1)
    if (PKG_RE.test(pkg) && /^[a-z0-9-_.^~*+]+$/i.test(ver)) return { pkg, spec: raw }
  }
  if (!PKG_RE.test(raw)) return null
  return { pkg: raw, spec: raw }
}

function randomId() {
  return Math.random().toString(36).slice(2, 8)
}

function apply(ctx, config) {
  const registry = createRegistry(ctx, config)
  const log = (...a) => config.debug && logger.info(...a)

  /** 模型/群友提过、等主人确认的安装申请 */
  const requests = []

  async function runNpm(spec) {
    const env = { ...process.env }
    if (config.npmProxy) {
      env.HTTP_PROXY = config.npmProxy
      env.HTTPS_PROXY = config.npmProxy
    }
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    logger.info('开始安装：%s（自己跑 %s）', spec, npm)
    return await new Promise((resolve) => {
      // shell: true 在 Windows 上是必须的（Node 对 .cmd 的直连限制），
      // 所以更要命的是**包名必须已经过 PKG_RE**，否则就是命令注入。
      const child = spawn(`${npm} install ${spec} --no-fund --no-audit`, {
        cwd: ctx.baseDir || process.cwd(),
        env,
        shell: true,
        stdio: 'inherit',
      })
      child.on('error', (e) => {
        logger.warn('npm 启动失败：%s', e.message)
        resolve(-1)
      })
      child.on('exit', (code) => resolve(code ?? -1))
    })
  }

  /** 装包：market 的 installer 优先（它知道该用哪个包管理器），否则自己上 */
  async function installPackage(pkg, version) {
    const installer = ctx.installer
    const spec = version ? `${pkg}@${version}` : pkg
    if (installer && typeof installer.install === 'function') {
      logger.info('开始安装：%s（走 market 的 ctx.installer）', spec)
      const code = await installer.install({ [pkg]: version || 'latest' })
      return { via: 'installer', code }
    }
    const code = await runNpm(spec)
    return { via: 'npm', code }
  }

  /**
   * 让插件跑起来。两条路：
   *
   *   A. **热挂载**：`loader.reload(loader.entry, '包名:id', {})`，不重启、立刻生效。
   *      前提是这个包**现在能被解析到**。解析器是 `ns-require`（`@koishijs/loader` 里
   *      `nsRequire({ namespace:'koishi', prefix:'plugin', dirname: baseDir })`），
   *      它的 `resolve()` 就是 `require.resolve('koishi-plugin-xxx')`。
   *
   *   B. **重启**：`loader.fullReload()` → `process.exit(51)` → koishi CLI 的 daemon
   *      重新 fork worker → 重新读 koishi.yml → 新包装上。
   *      ★ 这条路是**市场插件自己的做法**：`plugin-market` 装完新依赖只调 fullReload，
   *        根本不热挂载（它只对"版本变化且已在 require.cache 里"的包做重启）。
   *        实测也证明必须留着它：装完立刻 reload 会得到
   *          [I] loader apply plugin koishi-plugin-weather:bil2fv
   *          [E] app cannot resolve plugin "koishi-plugin-weather"
   *        —— 包确实已经躺在 node_modules 里了（npm 退出码 0、koishi.yml 也写了），
   *        但同一进程里就是解析不到，于是"装好了但没跑起来"。
   *
   *   所以顺序是：先试着解析，解析得到就热挂载；解析不到就写配置 + 触发重启。
   */
  async function mount(pkg) {
    const loader = ctx.loader
    if (!loader || typeof loader.reload !== 'function' || !loader.entry) {
      return { mounted: false, note: '这个环境没有可用的 loader，重启之后才会生效' }
    }

    let resolvable = false
    try {
      resolvable = !!(await loader.resolve(pkg))
    } catch (e) {
      log('解析 %s 失败：%s', pkg, e.message)
    }

    const persist = async () => {
      if (!config.persistConfig) return '（没写进配置，重启后失效）'
      let note = ''
      try {
        const file = loader.filename
        if (file && fs.existsSync(file)) {
          const backup = `${file}.bak-${Date.now()}`
          fs.copyFileSync(file, backup)
          note = `（配置已备份到 ${path.basename(backup)}）`
        }
        const key = `${pkg}:${randomId()}`
        const target = loader.config?.plugins
        if (target) target[key] = {}
        await loader.writeConfig()
        note += '，并已写进 koishi.yml'
        return note
      } catch (e) {
        return `，但写配置失败：${e.message}`
      }
    }

    if (resolvable) {
      const key = `${pkg}:${randomId()}`
      try {
        await loader.reload(loader.entry, key, {})
        logger.info('插件已热挂载：%s（key=%s）', pkg, key)
        return { mounted: true, key, note: `已热挂载，马上就能用${await persist()}` }
      } catch (e) {
        logger.warn('热挂载 %s 失败：%s', pkg, e.message)
      }
    }

    // 走重启路线
    const note = await persist()
    if (typeof loader.fullReload === 'function') {
      logger.info('解析不到 %s，触发整进程重启来加载它', pkg)
      setTimeout(() => {
        try {
          loader.fullReload()
        } catch (e) {
          logger.warn('触发重启失败：%s', e.message)
        }
      }, 500)
      return {
        mounted: false,
        restarting: true,
        note: `这个包要重启一次才能被加载，我已经触发重启了${note}。大概十秒后我就回来，到时候直接用它就行。`,
      }
    }
    return { mounted: false, note: `没能挂载，需要手动重启 Koishi${note}` }
  }

  async function searchText(query) {
    try {
      const hits = await registry.search(query, config.maxResults)
      if (hits.length === 0) {
        return `没搜到跟「${query}」相关的插件。换个关键词（比如用英文名或功能词）再试。`
      }
      return (
        `搜到 ${hits.length} 个相关插件：\n` +
        hits.map((item, i) => registry.format(item, i)).join('\n')
      )
    } catch (e) {
      return `搜索失败：${e.message}`
    }
  }

  async function fileRequest(pkgName, reason, session) {
    const spec = sanitizeSpec(pkgName)
    if (!spec) return `「${pkgName}」不像一个合法的 npm 包名，没法申请。`
    let item = null
    let danger = []
    let version = null
    try {
      const objects = await registry.all()
      item = registry.findByName(objects, spec.pkg)
      version = registry.latestVersion(objects, spec.pkg)
      if (item) danger = registry.isDangerous(item)
    } catch (e) {
      log('申请时查 registry 失败（不影响申请）：%s', e.message)
    }
    const request = {
      pkg: spec.pkg,
      version,
      reason: String(reason || '').slice(0, 200),
      description: item ? registry.describe(item) : '',
      danger,
      userId: session?.userId,
      at: new Date(),
    }
    requests.push(request)
    logger.info(
      '收到安装申请：%s@%s（申请人 %s，理由：%s）%s',
      request.pkg,
      version || '?',
      session?.userId,
      request.reason || '（没写）',
      danger.length ? `⚠️ 危险词命中：${danger.join('、')}` : ''
    )

    const where = session?.guildId ? `群 ${session.guildId}` : '私聊'
    const ownerText =
      `【插件安装申请】\n` +
      `包名：${request.pkg}${version ? `@${version}` : ''}\n` +
      `申请：${session?.userId || '?'}（${where}）\n` +
      `理由：${request.reason || '（没写）'}\n` +
      (request.description ? `描述：${request.description.replace(/\s+/g, ' ').slice(0, 120)}\n` : '') +
      (danger.length ? `⚠️ 危险：描述里有「${danger.join('、')}」\n` : '') +
      `\n确认安装：/selfext.install ${request.pkg}` +
      (danger.length ? ' -f（危险包必须加 -f）' : '')
    const notifyOwners = config.notifyOwnerOnRequest === false ? [] : config.ownerIds || []
    for (const owner of notifyOwners) {
      try {
        const bot = ctx.bots[0]
        if (bot) await bot.sendPrivateMessage(owner, ownerText)
      } catch (e) {
        logger.warn('给主人 %s 发私聊失败：%s', owner, e.message)
      }
    }
    return (
      `我没这个本事，但找到了现成的插件「${request.pkg}」` +
      `${request.description ? `（${request.description.replace(/\s+/g, ' ').slice(0, 60)}）` : ''}。` +
      `已经跟主人申请了，他同意我就学会了。`
    )
  }

  async function doInstall(specInput, options = {}) {
    if (!config.allowInstall) return '安装功能被配置关掉了（allowInstall=false）。'
    const spec = sanitizeSpec(specInput)
    if (!spec) return `「${specInput}」不是合法的 npm 包名，拒绝执行。`

    let item = null
    let version = null
    try {
      const objects = await registry.all()
      item = registry.findByName(objects, spec.pkg)
      version = registry.latestVersion(objects, spec.pkg)
    } catch (e) {
      log('查 registry 失败（仍然继续装，让 npm 自己解析版本）：%s', e.message)
    }

    if (item) {
      const danger = registry.isDangerous(item)
      if (danger.length && !options.force) {
        return (
          `⚠️ 「${spec.pkg}」的描述里有「${danger.join('、')}」，看着不是好东西，我拒绝安装。\n` +
          `描述原文：${registry.describe(item).slice(0, 120)}\n` +
          `你确定要装就加 -f：/selfext.install ${spec.pkg} -f`
        )
      }
    } else {
      logger.warn('registry 里没有 %s 这个包，仍然尝试安装（npm 上可能有）', spec.pkg)
    }

    const result = await installPackage(spec.pkg, options.version || version)
    if (result.code !== 0) {
      return `安装失败（${result.via} 退出码 ${result.code}）。看看日志，可能是网络或包名的问题。`
    }
    const mounted = await mount(spec.pkg)
    return (
      `「${spec.pkg}${version ? `@${version}` : ''}」安装完成（${result.via}）。\n` +
      `${mounted.note}` +
      (mounted.mounted
        ? '\n如果这个插件有自己的配置项，还得去控制台或者 koishi.yml 里补一下才能真正干活。'
        : '')
    )  }

  // ---------------------------------------------------------------- 指令

  // ★ 指令名一律英文点号（父名 = 插件短名 selfext，与 guard.*/scene.* 一致）。
  //   不能用 plugin.*：官方 market 插件已经占了 plugin.install / plugin.uninstall / plugin.upgrade。
  //   连字符旧名（plugin-search 等）保留为别名；**不留中文别名**（会出现在指令列表里）。
  ctx
    .command('selfext.search <keywords:text>', '在 Koishi 插件市场里搜插件', { authority: 1 })
    .alias('plugin-search', { args: [] })
    .action(async (_argv, keywords) => searchText(keywords))

  ctx
    .command('selfext.request <name:string> [reason:text]', '申请安装一个插件（等主人确认）', { authority: 1 })
    .alias('plugin-request', { args: [] })
    .usage('例：/selfext.request koishi-plugin-weather 想让它会查天气')
    .action(async ({ session }, pkgName, reason) => {
      if (!pkgName) return '要给我一个 npm 包名。先用 /selfext.search <关键词> 找找。'
      return await fileRequest(pkgName, reason, session)
    })

  ctx
    .command('selfext.install <name:string>', '安装并立刻挂载一个插件（仅主人）', { authority: 4 })
    .alias('plugin-install', { args: [] })
    .option('force', '-f  危险包也照装（描述里命中危险词时用）')
    .option('version', '-v <version:string>  指定版本')
    .usage('例：/selfext.install koishi-plugin-weather')
    .action(async ({ options, session }, pkgName) => {
      if (!pkgName) return '要给我一个 npm 包名。'
      logger.info('主人 %s 请求安装 %s', session?.userId, pkgName)
      return await doInstall(pkgName, { force: options.force === true, version: options.version })
    })

  ctx
    .command('selfext.requests', '看有哪些还没处理的安装申请', { authority: 2 })
    .alias('plugin-requests', { args: [] })
    .action(() => {
      if (requests.length === 0) return '目前没有待处理的安装申请。'
      return requests
        .slice(-10)
        .map(
          (r, i) =>
            `${i + 1}. ${r.pkg}${r.version ? `@${r.version}` : ''}（${r.userId || '?'}）` +
            `${r.reason ? `：${r.reason}` : ''}`
        )
        .join('\n')
    })

  // ---------------------------------------------------------------- 给模型的两个工具

  ctx.inject(['chatluna'], (ctx2) => {
    const platform = ctx2.chatluna?.platform
    if (!platform || typeof platform.registerTool !== 'function') {
      logger.warn('platform.registerTool 不可用，plugin_search / plugin_request 工具未注册')
      return
    }

    const searchDesc =
      '当你发现自己没有能力做某件事（查天气、查快递、搜图、玩游戏……）时，用它搜索 Koishi 插件市场，' +
      '看看有没有现成的插件能补上这个能力。搜到之后不要自己动手，用 plugin_request 向主人申请。' +
      '绝对不要假装自己能做到。'
    platform.registerTool('plugin_search', {
      selector: () => true,
      authorization: () => true,
      description: searchDesc,
      createTool: () =>
        new (class extends StructuredTool {
          name = 'plugin_search'
          description = searchDesc
          schema = z.object({
            query: z.string().describe('搜索关键词，中文或英文都行，比如「天气」'),
          })
          async _call(input) {
            return await searchText(input.query)
          }
        })(),
    })

    const requestDesc =
      '向主人申请安装一个插件来获得新能力。只有在 plugin_search 找到合适的包、' +
      '而且当前确实做不到用户要求的事时才调用。调用后告诉用户"已经申请了"，不要承诺马上就能用。'
    platform.registerTool('plugin_request', {
      selector: () => true,
      authorization: () => true,
      description: requestDesc,
      createTool: () =>
        new (class extends StructuredTool {
          name = 'plugin_request'
          description = requestDesc
          schema = z.object({
            name: z.string().describe('要安装的 npm 包名，必须来自 plugin_search 的结果'),
            reason: z.string().describe('为什么要装它，一句话'),
          })
          async _call(input, _manager, runnable) {
            const session = runnable?.configurable?.session
            return await fileRequest(input.name, input.reason, session)
          }
        })(),
    })

    logger.info('自我扩展工具已注册：plugin_search / plugin_request（安装仍需主人指令）')
  })

  logger.info(
    '自我扩展已挂载（搜索=开；安装=%s；申请通知 %d 个主人；registry 缓存 %d 分钟）',
    config.allowInstall ? '仅主人可触发' : '关',
    (config.ownerIds || []).length,
    config.cacheMinutes
  )
}

module.exports = { name, inject, Config, apply }
