/**
 * koishi-plugin-chatluna-persona —— 人设卡片（self card）
 *
 * ============================================================================
 * 这个插件解决什么问题
 * ============================================================================
 * 「我是谁」过去只写在**对话预设**里（data/chathub/presets/default-persona.yml）。
 * 可同一个角色不止一个模型在演：
 *   · 视觉模型：要判断"这张表情包里画的是不是我自己"——它从来不知道角色长什么样，
 *     于是把 bot 的形象描述成"蓝色小女孩"，对话模型看到这句就认不出是自己；
 *   · 记忆总结模型：摘要里写着「你（大肥鱼）」，可对**它**来说"你"毫无所指，
 *     到底哪句是 bot 说的、哪些是群友说的，全靠猜；
 *   · 表情包判定/打标模型：完全不知道角色的存在。
 *
 * 现在身份事实只有一份（data/persona/self.yml），本插件把它按**消费方**渲染：
 *   对话模型          → 第二人称「你」（它就是角色本人）
 *   视觉/记忆/表情模型 → 第三人称「大肥鱼」（它们是工具，不是角色）
 * 这条「谁用第几人称」的规矩是刻意的，理由见 block() 里的注释（也是"你/我哪个更准"的答案）。
 *
 * ============================================================================
 * 对外接口
 * ============================================================================
 *   ctx.chatluna_persona.name / aliases / card / path
 *   ctx.chatluna_persona.block('dialogue' | 'vision' | 'summary' | 'memory' | 'sticker' | 'proactive')
 *   ctx.chatluna_persona.brief()          // 一行式「大肥鱼（DeepSeek 二创的蓝色鲸鱼娘）」
 *   ctx.chatluna_persona.imagePath()      // 本地参考形象图（可能为 null）
 *   {persona()}                           // 给预设用的变量（等价于 block('dialogue')）
 *
 *   /persona.show [阶段]   看卡片与各阶段实际收到的那段话（authority 3）
 *   /persona.reload        改完 self.yml 立刻生效（authority 4）
 *   /persona.image         把参考形象图发出来看一眼（authority 3）
 */

const { Schema, Logger, h } = require('koishi')
const fs = require('node:fs')
const path = require('node:path')
const yaml = require('js-yaml')

const name = 'chatluna-persona'
const inject = { required: ['database'], optional: ['http', 'chatluna'] }
const logger = new Logger('chatluna-persona')

/** 阶段名 → 中文名（/persona.show 用） */
const STAGES = {
  dialogue: '主对话',
  vision: '看图（视觉模型）',
  summary: '短期情景总结',
  memory: '长期记忆抽取',
  sticker: '表情包判定/打标',
  proactive: '主动插话把关',
}

/** self.yml 缺字段时的兜底（不要让它因为少写一行就整段空掉） */
const FALLBACK = {
  name: '大肥鱼',
  aliases: ['大肥鱼'],
  oneLine: 'DeepSeek 二创的蓝色鲸鱼娘',
  species: '二次元鲸鱼娘',
  appearance: '蓝色长发的二次元鲸鱼娘少女，鲸鱼鳍形状的耳朵，常见女仆装',
  lookAlike: '',
  notSelf: '',
  selfAddress: ['我'],
  signatureLines: [],
  selfImage: '',
}

const Config = Schema.intersect([
  Schema.object({
    selfCardPath: Schema.string()
      .default('data/persona/self.yml')
      .description('人设卡片文件（相对 Koishi 根目录）。这是「我是谁」的唯一事实来源'),
    reloadSeconds: Schema.natural()
      .min(0)
      .default(5)
      .description('检查文件是否被改动的间隔（秒）。0 = 只在启动和 /persona.reload 时读'),
    avatarSelfId: Schema.string()
      .default('')
      .description('self.yml 里 selfImage: auto 时取哪个 QQ 号的头像。留空 = 自动用当前 bot 的号'),
    avatarRefreshDays: Schema.natural()
      .min(1)
      .default(7)
      .description('头像缓存多少天后重新下载一次（头像不常换，别每次启动都去拉）'),
    debug: Schema.boolean().default(false).description('打印每次渲染/重载的细节'),
  }),
])

/** 多行压成一行（提示词里塞换行容易被当成新条目） */
function oneLine(s) {
  return String(s ?? '')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

/** 按魔数认图片类型：qlogo 返回的是 JPEG，但扩展名不一定对得上 */
function sniffExt(buf) {
  if (!buf || buf.length < 12) return 'jpg'
  const b = buf
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg'
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif'
  if (b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP') {
    return 'webp'
  }
  return 'jpg'
}

function apply(ctx, config) {
  const log = (...a) => config.debug && logger.info(...a)

  const cardFile = () => path.resolve(ctx.baseDir, config.selfCardPath)
  const cacheDir = () => path.resolve(ctx.baseDir, 'data/persona/cache')

  /** 解析后的卡片（带 mtime 缓存） */
  let state = { at: 0, mtimeMs: 0, card: null, error: null }

  function parseCard() {
    const file = cardFile()
    let raw = {}
    try {
      raw = yaml.load(fs.readFileSync(file, 'utf8')) || {}
    } catch (e) {
      state.error = `读不到 ${file}：${e.message}`
      logger.warn('人设卡片读取失败：%s（先用内置兜底）', e.message)
      raw = {}
    }
    const card = { ...FALLBACK, ...raw }
    for (const k of ['aliases', 'selfAddress', 'signatureLines']) {
      if (!Array.isArray(card[k])) card[k] = card[k] ? [card[k]] : FALLBACK[k]
    }
    if (!card.name) card.name = FALLBACK.name
    card.appearanceOne = oneLine(card.appearance)
    card.lookAlikeOne = oneLine(card.lookAlike)
    card.notSelfOne = oneLine(card.notSelf)
    return card
  }

  function load(force = false) {
    const file = cardFile()
    let mtimeMs = 0
    try {
      mtimeMs = fs.statSync(file).mtimeMs
    } catch {
      /* 文件不存在 → 走兜底 */
    }
    const fresh = state.card && !force && Date.now() - state.at < config.reloadSeconds * 1000
    if (fresh && mtimeMs === state.mtimeMs) return state.card
    if (state.card && !force && mtimeMs === state.mtimeMs) {
      state.at = Date.now()
      return state.card
    }
    const card = parseCard()
    state = { at: Date.now(), mtimeMs, card, error: state.error && !mtimeMs ? state.error : null }
    log('人设卡片已加载：%s（%s）', card.name, file)
    return card
  }

  const card = () => load(false)

  /**
   * 各阶段拿到的那段话。
   *
   * ★ 人称规则（= "提示词里指代自己用你/我哪个更准"的答案）：
   *   - **对话模型**：用第二人称「你」。它就是这个角色，跟它说"你是大肥鱼"才是它自己的身份；
   *     说"我是大肥鱼"也可以，但系统提示词的说话者是主人/平台，第二人称才是自然语域，
   *     而且现有预设整篇都是「你」，混用会让它在自述时精神分裂（实测过：会冒"我是大肥鱼，
   *     你是一个 AI"这种串味输出）。
   *   - **工具模型**（视觉/记忆/表情/把关）：用**第三人称角色名**，绝不用「你/我」。
   *     理由：对这些模型来说"我"是模型自己、"你"是调用它的人，两个都不是大肥鱼；
   *     写成"你是大肥鱼"会让它把自己的身份和角色搅在一起（视觉模型会开始自称鲸鱼娘），
   *     写成"我是大肥鱼"更糟。**描述一个不在场的第三方**才是它们该干的事。
   *   - 因此：卡片文件里的事实一律**中性第三人称**写，由这里翻译成各阶段的口吻。
   */
  function block(kind) {
    const c = card()
    const aliases = c.aliases.filter((a) => a !== c.name).slice(0, 6)
    const aliasText = aliases.length ? `别人也会叫她：${aliases.join(' / ')}。` : ''
    switch (kind) {
      case 'vision':
        return [
          `【图里可能出现的角色：${c.name}】`,
          `${c.name}是${c.species}，${oneLine(c.oneLine)}。`,
          `长这样：${c.appearanceOne}`,
          c.lookAlikeOne ? `判断标准：${c.lookAlikeOne}` : null,
          c.notSelfOne ? `不算她的：${c.notSelfOne}` : null,
          `★ 输出规则：如果这张画的就是她，描述**开头加上** [自己] 这个标记（例：[自己] ${c.name}趴在桌上睡觉，旁边写着"好困"）；`,
          `  很像但拿不准是不是她，开头加 [可能自己]；不是她，就什么标记都别加，照常描述。`,
        ]
          .filter(Boolean)
          .join('\n')
      case 'summary':
      case 'memory':
        return [
          `【这个群里的机器人】`,
          `这个群里的机器人叫「${c.name}」（${oneLine(c.oneLine)}）。`,
          `记录里标注为「${c.name}（机器人）」的话是**它**说的，其余都是群友说的。`,
          `总结时用「${c.name}」指代它：不要写成"你"，也不要把它的发言算到群友头上。`,
        ].join('\n')
      case 'sticker':
        return [
          `【表情包里的角色：${c.name}】`,
          `${c.name}是${c.species}，长这样：${c.appearanceOne}`,
          c.notSelfOne ? `不算她的：${c.notSelfOne}` : null,
          `★ 如果这张图画的就是她，描述里要写清「${c.name}（自己的形象）」，并加标签「自己」；画的不是她，照常打标。`,
        ]
          .filter(Boolean)
          .join('\n')
      case 'proactive':
        return [
          `【开口的是谁】`,
          `要判断的这个机器人叫「${c.name}」，${oneLine(c.oneLine)}。`,
          `按她的性格衡量"这话该不该由她来说"。`,
        ].join('\n')
      case 'dialogue':
      default:
        return [
          `【你是谁】`,
          `你是「${c.name}」——${oneLine(c.oneLine)}。`,
          `你的样子：${c.appearanceOne}`,
          `${aliasText}自称可以用${c.selfAddress.map((s) => `「${s}」`).join('、')}。`,
          `★ 群里出现的那个${c.species}形象就是你自己；图片描述开头带 [自己] 的，画的就是你。`,
          c.signatureLines.length
            ? `你的口头禅（随手用，别硬凑）：${c.signatureLines.slice(0, 5).join('　')}`
            : null,
        ]
          .filter(Boolean)
          .join('\n')
    }
  }

  /** 一行式自述，给别的插件做第三人称叙述用（episode 的「谁: 说了什么」等） */
  function brief() {
    const c = card()
    return `${c.name}（${oneLine(c.oneLine)}）`
  }

  // ------------------------------------------------------------ 参考形象图

  const imageCache = { at: 0, path: null, tried: 0 }

  function cacheFileFor(key, ext) {
    return path.join(cacheDir(), `${key}.${ext}`)
  }

  function findCached(key) {
    for (const ext of ['jpg', 'png', 'webp', 'gif']) {
      const p = cacheFileFor(key, ext)
      if (fs.existsSync(p)) return p
    }
    return null
  }

  async function fetchToCache(url, key, useCache) {
    const dir = cacheDir()
    const existing = findCached(key)
    if (existing && useCache) {
      const ageDays = (Date.now() - fs.statSync(existing).mtimeMs) / 86400000
      if (ageDays < config.avatarRefreshDays) return existing
    }
    const http = ctx.http
    if (!http) {
      if (existing) return existing
      logger.warn('没有 http 服务，取不到参考形象图')
      return null
    }
    try {
      // ★ 用 `ctx.http.file()` 而不是 `ctx.http.get(..., {responseType:'arraybuffer'})`：
      //   实测后者在这个环境里拿回来的是**0 字节**（Koishi 的 http 服务对 arraybuffer 的处理
      //   与裸 axios 不同），表现是"参考形象图下载失败（下到 0 字节）"——
      //   而 vision 插件下载 QQ 图片用的就是 file()，跟着它写才不会踩第二次（坑 66）。
      let buf = null
      if (typeof http.file === 'function') {
        const res = await http.file(url, { timeout: 20000 })
        const data = res?.data
        if (data) buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
      }
      if (!buf || buf.length === 0) {
        const res = await http.get(url, { responseType: 'arraybuffer', timeout: 20000 })
        const data = res?.data
        buf = Buffer.isBuffer(data) ? data : Buffer.from(data || [])
      }
      if (!buf.length) throw new Error('下到 0 字节')
      fs.mkdirSync(dir, { recursive: true })
      const p = cacheFileFor(key, sniffExt(buf))
      fs.writeFileSync(p, buf)
      logger.info('参考形象图已更新：%s（%d 字节）', p, buf.length)
      return p
    } catch (e) {
      logger.warn('参考形象图下载失败（%s）：%s', url, e.message)
      return existing
    }
  }

  /** 参考形象图的本地路径。没有就返回 null（调用方要能接受 null） */
  async function imagePath(force = false) {
    const c = card()
    const spec = String(c.selfImage || '').trim()
    if (!spec) return null
    if (spec !== 'auto') {
      if (/^https?:/i.test(spec)) return fetchToCache(spec, 'custom', !force)
      const p = path.resolve(ctx.baseDir, spec)
      if (fs.existsSync(p)) return p
      logger.warn('selfImage 指向的文件不存在：%s', p)
      return null
    }
    if (imageCache.path && !force && Date.now() - imageCache.at < 60000) return imageCache.path
    const id =
      String(config.avatarSelfId || '').trim() ||
      String(
        (ctx.bots || []).find((b) => String(b.platform) === 'onebot')?.selfId ||
          (ctx.bots || [])[0]?.selfId ||
          ''
      )
    if (!id) {
      logger.warn('拿不到 bot 自己的 QQ 号，参考形象图不可用（可配 avatarSelfId）')
      return null
    }
    const p = await fetchToCache(`https://q1.qlogo.cn/g?b=qq&nk=${id}&s=640`, `avatar-${id}`, !force)
    imageCache.at = Date.now()
    imageCache.path = p
    return p
  }

  // ------------------------------------------------------------ 服务

  const api = {
    get name() {
      return card().name
    },
    get aliases() {
      return card().aliases
    },
    get card() {
      return card()
    },
    get path() {
      return cardFile()
    },
    get error() {
      load(false)
      return state.error
    },
    /** 角色展示名（第三人称场景用，例如情景记忆里的「谁: 说了什么」） */
    displayName: () => card().name,
    brief,
    block,
    imagePath,
    reload: (why = '手动') => {
      const c = load(true)
      logger.info('人设卡片已重载（%s）：%s', why, c.name)
      return c
    },
  }
  ctx.set('chatluna_persona', api)

  // ------------------------------------------------------------ {persona()} 变量
  ctx.inject(['chatluna'], (ctx2) => {
    const renderer = ctx2.chatluna?.promptRenderer
    if (!renderer || typeof renderer.registerFunctionProvider !== 'function') {
      logger.warn('promptRenderer 不可用，{persona()} 未注册')
      return
    }
    renderer.registerFunctionProvider('persona', async (args) => {
      const kind = String(args?.[0] || 'dialogue').replace(/["'\s]/g, '')
      const text = block(STAGES[kind] ? kind : 'dialogue')
      log('{persona(%s)} 渲染 %d 字', kind, text.length)
      return text
    })
    logger.info('已注册人设变量：{persona()}（{persona("vision")} 等可指定阶段口吻）')
  })

  // ------------------------------------------------------------ 指令

  ctx.command('persona.show [stage:string]', '看人设卡片与各阶段实际收到的那段话', {
    authority: 3,
  })
    .usage('stage 可填 dialogue / vision / summary / memory / sticker / proactive，留空=全看')
    .example('/persona.show vision')
    .action(async ({ session }, stage) => {
      const c = card()
      const want = String(stage || '').trim()
      const keys = STAGES[want] ? [want] : Object.keys(STAGES)
      const out = [
        `【人设卡片】${api.path}`,
        `名字：${c.name}｜别名：${c.aliases.join(' / ')}`,
        `一句话：${oneLine(c.oneLine)}`,
        `形象：${c.appearanceOne}`,
        c.lookAlikeOne ? `算她的：${c.lookAlikeOne}` : null,
        c.notSelfOne ? `不算她的：${c.notSelfOne}` : null,
        `口头禅 ${c.signatureLines.length} 条｜参考形象图：${await imagePath() || '无'}`,
        state.error ? `⚠️ ${state.error}` : null,
        '',
      ].filter((l) => l !== null)
      for (const k of keys) {
        out.push(`──── ${STAGES[k]}（${k}）会收到 ────`)
        out.push(block(k))
        out.push('')
      }
      return out.join('\n')
    })

  ctx.command('persona.reload', '改完 self.yml 立刻生效', { authority: 4 }).action(async () => {
    const c = api.reload('指令')
    return `已重载人设：${c.name}（${c.aliases.length} 个称呼）`
  })

  ctx.command('persona.image', '把参考形象图发出来', { authority: 3 }).action(async ({ session }) => {
    const p = await imagePath(true)
    if (!p) return '没有可用的参考形象图（self.yml 的 selfImage 为空或下载失败）。'
    await session.send(h => h('image', { url: `file://${p.replace(/\\/g, '/')}` }))
    return `参考形象图：${p}`
  })

  // 启动时先读一次：读不到也照样跑（有内置兜底），但要让人看见
  load(true)
  ctx.setTimeout(() => {
    imagePath().catch(() => {})
  }, 5000)
  logger.info('人设卡片已就绪：%s（%s）', card().name, cardFile())
}

module.exports = { name, inject, Config, apply }
