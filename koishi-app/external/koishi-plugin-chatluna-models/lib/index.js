/**
 * koishi-plugin-chatluna-models —— 模型总览 / 队列状态 / 阶段切换（三件事）
 *
 *   /models [页码] [-l 每页]      列出可用的模型，**页码直接当参数**，页脚写清怎么翻
 *   /stages                      各处理阶段「实际在用哪个模型」+ 队列冷却/停用状态
 *   /stages.set [阶段] [序号|模型] 换某个阶段用的模型（候选分页，带视觉闸门）
 *   /stages.reset <阶段>          回到本进程启动时 koishi.yml 里的值
 *
 * ------------------------------------------------------------------ 为什么要接管 /models
 *
 * 上游 `chatluna.model.list` 本身**是支持翻页的**（`-p <page>` / `-l <limit>`，
 * 见 `koishi-plugin-chatluna/lib/index.cjs:632`），但它的页脚文案是（locale 实测）：
 *
 *     header: 以下是目前可用的模型列表：
 *     footer: 你可以通过 chatluna.new -p [preset] 或 chatluna.switch 为会话设置默认模型。
 *     pages : 当前为第 [page] / [total] 页
 *
 * —— `pages` 只说"你在第几页"，**一个字都没提怎么去下一页**；`footer` 讲的还是
 * 预设/会话切换，跟翻页无关。用户原话：「/models 命令没法翻页，提示中没有翻页的命令」。
 * 这不是 bug 而是文案缺口，但改上游要动 node_modules，所以自己接管：
 * 我们的页脚直接把命令写出来（`/models 2`），并且把页码做成**位置参数**，
 * 这样 `/models 2` 和 `/models -p 2` 都能用。
 *
 * ------------------------------------------------------------------ /stages 的数据从哪来
 *
 * ⑧ 各阶段的**配置值**：从运行期的 loader 配置读（`ctx.loader.config.plugins`），不是抄文档。
 *    各阶段的模型散在七八个插件的配置里（vision/visionModel、proactive/judgeModel、
 *    episode/summaryModel、long-memory/longMemoryExtractModel、sticker/judgeModel…），
 *    只有 loader 手里的那份是「此刻真的生效的值」——控制台改完、重启后立刻反映出来。
 *
 * ⑨ **实际在用哪个模型**：从 `chatluna-multi-adapter` 的 `RotationRegistry` 读。
 *    配置里写的常常是**模型组**（`cc/q.dialogue` 不是一个真模型，是一串候选），
 *    所以"配了谁"≠"谁在答"。注册表手里才有：组内候选顺序、每个候选失败了几次、
 *    冷却到什么时候。我们**不自己重推**这个顺序，而是直接问它 `plan(组名)` ——
 *    那是 requester 每次真正要走的那条路（`requester.js` 里就是 `plan()` 后按序试）。
 *
 *    ★ 为什么能读到私有字段：koishi-plugin-chatluna 的 `platform.getClient()` 返回
 *      运行期的平台客户端实例，multi-adapter 的客户端把注册表挂在 `_registry` 上。
 *      这是**只读**用法，字段名在 `docs/22` 里逐行核对过（版本 0.0.3 钉死）。
 *      拿不到就退化成"只看配置值"，绝不抛错。
 *
 * ⑩ **本次登录不再尝试**（上游没有这个能力）：上游的冷却梯度是
 *    `基数 × [1,2,10,30,60]`（默认基数 30 秒 → 30 秒 / 1 分 / 5 分 / 15 分 / 30 分封顶），
 *    也就是**一直会再试**，只是间隔越来越长。用户要求"三次之后就本次登录别再试了"。
 *    做法：起一个定时扫描（默认 5 秒），发现某「组+接口+模型」累计失败到阈值
 *    （默认 3）就把它的 `cooldownUntil` 抬到 `Infinity` —— 注册表的 `isCooling()`
 *    在 `pickLeastCooling()` 里也生效，从而**只要还有别的候选可用就永远不会选中它**。
 *    状态只存在内存里，所以天然是"本次登录"：重启即复原。
 *    ⚠️ 全组都被停用时仍会兜底挑冷却最浅的那个（fail-open，免得整个阶段不可用）。
 *
 * ------------------------------------------------------------------ 阶段切换为什么敢热改
 *
 * 各级阶段的模型都是**别的插件的配置字段**，所以切换 = 改 koishi.yml + 让那个插件
 * 用新配置重启一次。Koishi 的 loader 本来就支持这件事（控制台"保存并重启该插件"
 * 走的就是 `loader.reload()` + `writeConfig()`，见 `@koishijs/plugin-config`），
 * 我们照抄同一条路径：
 *
 *     plugins[key][字段] = 新值  →  loader.reload(父作用域, key, 新配置)  →  loader.writeConfig()
 *
 * 好处：①不用动 node_modules；②写回 koishi.yml，重启后仍在；③只重启那一个插件。
 * 代价：会短暂重启目标插件（对 vision/sticker/proactive 这些是毫秒级；对主 chatluna
 * 插件是重连上游，几秒）。所以回复里会把"已热重载 X"写清楚。
 *
 * ★ **视觉闸门**：看图/表情包这些阶段必须吃图，而模型组的能力 = 候选能力的**交集**
 *   （multi-adapter `_buildGroupModels`），一旦混进不吃图的模型，整组就不声明
 *   `image_input`，ChatLuna 会把图片降级成 `[image:xxx]` 占位符（`lib/index.cjs:3954`）。
 *   所以 `/stages.set` 对"要视觉的阶段"直接**拒绝**没有 `image_input` 的候选。
 */

const { Schema, Logger } = require('koishi')
const fs = require('node:fs')

const name = 'chatluna-models'
const inject = { required: ['chatluna'], optional: [] }

const logger = new Logger('chatluna-models')

/** loader 的插件记录表用的 Symbol（`@koishijs/loader` 里 `Symbol.for('koishi.loader.record')`） */
const kRecord = Symbol.for('koishi.loader.record')

/** multi-adapter 注册表里失败表的键分隔符（`rotation.js` 里用的 `\u0000`） */
const FAILURE_KEY_SEP = '\u0000'

/** 上游冷却倍数表（`chatluna-multi-adapter/lib/constants.js` FAILURE_COOLDOWN_MULTIPLIERS） */
const COOLDOWN_MULTIPLIERS = [1, 2, 10, 30, 60]
/** 上游冷却上限（30 分钟） */
const MAX_FAILURE_COOLDOWN = 30 * 60e3
/** 上游默认冷却基数（30 秒） */
const DEFAULT_FAILURE_COOLDOWN = 30e3

const Config = Schema.intersect([
  Schema.object({
    enabled: Schema.boolean().default(true).description('总开关'),
    pageSize: Schema.natural().min(3).max(50).default(10).description('/models 每页条数（可用 -l 临时覆盖）'),
    pickPageSize: Schema.natural().min(3).max(50).default(15).description('/stages.set 候选列表每页条数（可用 -l 临时覆盖）'),
    showGroupChain: Schema.boolean().default(true).description('在模型组下面一行列出组内兜底顺序（拆自 chatluna-multi-adapter 配置）'),
    stagesCommand: Schema.boolean().default(true).description('注册 /stages 与 /stages.set（阶段总览 / 阶段切换）'),
    switching: Schema.boolean().default(true).description('允许 /stages.set 改阶段模型（关掉则只读）'),
  }),
  Schema.object({
    sessionFailureLimit: Schema.natural().min(0).max(20).default(3)
      .description('同一「模型+接口」在本次运行内累计失败到几次就"本次登录不再尝试"（0 = 关闭；重启即复原）'),
    queueSweepSeconds: Schema.natural().min(1).max(120).default(5)
      .description('扫描队列失败表的间隔（秒）'),
  }),
  Schema.object({
    debug: Schema.boolean().default(false).description('打印解析到的阶段、模型与队列状态'),
  }),
])

// ================================================================ 纯函数区
// 下面这些都不碰 ctx，方便单测（.scratch/check-models-state.cjs）。

/** 把注册表失败表的键拆开：`组\0接口序号\0模型` */
function parseFailureKey(key) {
  const parts = String(key).split(FAILURE_KEY_SEP)
  if (parts.length < 3) return null
  return { group: parts[0], endpointIndex: Number(parts[1]), model: parts.slice(2).join(FAILURE_KEY_SEP) }
}

/** 毫秒 → 人话（`4 分 12 秒`） */
function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000))
  if (total < 60) return `${total} 秒`
  const m = Math.floor(total / 60)
  const s = total % 60
  if (m < 60) return s ? `${m} 分 ${s} 秒` : `${m} 分`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return rm ? `${h} 小时 ${rm} 分` : `${h} 小时`
}

/**
 * 一个候选此刻的状态。
 *
 * ★ 判定"本次登录停用"用 `!Number.isFinite(until)`：我们把 `cooldownUntil` 抬到了
 *   `Infinity`，而 `Number.isFinite(Infinity) === false`。另外加一条 `> 1e14` 的兜底，
 *   防止以后有人用大整数表示"永久"。
 */
function candidateState(state, now) {
  const failures = Number((state && state.failures) || 0)
  const until = Number((state && state.cooldownUntil) || 0)
  if (!Number.isFinite(until) || until > 1e14) return { kind: 'disabled', failures, remain: 0, until }
  const remain = Math.max(0, until - now)
  if (remain > 0) return { kind: 'cooling', failures, remain, until }
  return { kind: 'ready', failures, remain: 0, until: 0 }
}

/** 冷却梯度（人话），用于把上游的 [1,2,10,30,60] 讲清楚 */
function cooldownLadder(base) {
  const b = Number(base) > 0 ? Number(base) : DEFAULT_FAILURE_COOLDOWN
  return COOLDOWN_MULTIPLIERS.map((k) => formatDuration(Math.min(b * k, MAX_FAILURE_COOLDOWN)))
}

/**
 * 模型能力 → 是否吃图。
 * 返回 true / false / null（未知）。null 必须当成"不知道"，
 * 要视觉的阶段遇到 null 要拒绝（宁可不切，也不能把图片丢给看不见它的模型）。
 */
function canSeeImage(capabilities) {
  if (!capabilities) return null
  const list = Array.isArray(capabilities) ? capabilities : String(capabilities).split(/[,，\s]+/)
  const cleaned = list.map((x) => String(x).trim().toLowerCase()).filter(Boolean)
  if (!cleaned.length) return null
  return cleaned.includes('image_input')
}

/** 模型能力 → 短标注（`✅视觉` / `✖视觉` / `?视觉`） */
function markImage(capabilities) {
  const can = canSeeImage(capabilities)
  return can === true ? '✅视觉' : can === false ? '✖无视觉' : '?视觉未知'
}

/** 去掉 `平台/` 前缀（ChatLuna 的模型名是 `平台/模型`） */
function stripPlatform(value) {
  const s = String(value || '')
  const i = s.indexOf('/')
  return i > 0 ? s.slice(i + 1) : s
}

/** 上下文尺寸 → `1M` / `262K` */
function formatContext(n) {
  const num = Number(n)
  if (!Number.isFinite(num) || num <= 0) return '—'
  if (num >= 1e6) return `${Math.round((num / 1e6) * 10) / 10}M`
  return `${Math.round(num / 1024)}K`
}

/** 阶段 key / 中文名 / 别名 → 阶段定义 */
function resolveStage(stages, input) {
  const raw = String(input || '').trim()
  if (!raw) return null
  const norm = (s) => String(s).toLowerCase().replace(/[\s_-]/g, '')
  const target = norm(raw)
  for (const stage of stages) {
    // ★ 中文名（label）也要认：`/stages.set` 的清单里列的就是 label，
    //   用户照着敲却匹配不上就太蠢了（别名表不必重复列 label）。
    for (const name of [stage.key, stage.label, ...(stage.aliases || [])]) {
      if (name && norm(name) === target) return stage
    }
  }
  return null
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** YAML 标量该不该加引号（`:free` 这种**不加空格**的冒号在 YAML 里是合法的普通标量） */
function formatYamlScalar(value) {
  const s = String(value)
  if (s && /^[A-Za-z0-9_./@:+-]+$/.test(s)) return s
  return `'${s.replace(/'/g, "''")}'`
}

/**
 * 把某个插件的某个字段写回 koishi.yml —— **只动那一行**。
 *
 * ★ 为什么不直接 `loader.writeConfig()`：那内部是 `yaml.dump(this.config)`，
 *   会**整份重写**（注释全丢、缩进/空行/键序全变）。这在本项目是硬伤 ——
 *   `koishi-app/koishi.yml` 是靠注释讲清楚"为什么这么配"的，一条 `/stages.set`
 *   把它洗成机器格式，等于把文档擦掉。（实测确实发生过：测试实例那份的注释
 *   在一次切换后全没了。）
 *   `loader.reload()` 自己**不会**触发写盘 —— 它给 fork 打 `kUpdate` 标记，
 *   于是 `internal/before-update` 直接返回（`@koishijs/loader/lib/shared.js:383`），
 *   所以"运行时生效"和"落盘"可以分开：reload 交给 loader，落盘我们自己按行改。
 *
 * 返回改好后的整份文本；`pluginKey` 不在顶层时返回 null（调用方退化成 writeConfig）。
 * `value === undefined` = 删掉这个字段（回到"未显式配置 → 插件 schema 默认"）。
 */
function patchYamlField(text, pluginKey, field, value) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const keyRe = new RegExp('^(\\s*)' + escapeRe(pluginKey) + ':\\s*$')
  let keyIndex = -1
  let keyIndent = 0
  for (let i = 0; i < lines.length; i++) {
    const m = keyRe.exec(lines[i])
    if (m) {
      keyIndex = i
      keyIndent = m[1].length
      break
    }
  }
  if (keyIndex < 0) return null

  const fieldRe = new RegExp('^(\\s*)' + escapeRe(field) + ':(?:\\s|$)')
  for (let i = keyIndex + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    const indent = line.length - line.trimStart().length
    if (indent <= keyIndent) break // 已经出了这个插件的块
    const m = fieldRe.exec(line)
    if (!m) continue
    if (value === undefined) {
      lines.splice(i, 1)
      return lines.join(eol)
    }
    if (lines[i] === m[1] + field + ': ' + formatYamlScalar(value)) return text // 本来就是这值
    lines[i] = m[1] + field + ': ' + formatYamlScalar(value)
    return lines.join(eol)
  }

  if (value === undefined) return text // 本来就没这一行
  lines.splice(keyIndex + 1, 0, ' '.repeat(keyIndent + 2) + field + ': ' + formatYamlScalar(value))
  return lines.join(eol)
}

// ================================================================ 配置读取

/** 从 loader 的配置树里按插件名取配置（键形如 `chatluna-proactive:pr0001`） */
function pluginConfig(plugins, pluginName) {
  const entries = pluginEntries(plugins, pluginName)
  return entries.length ? entries[0].value : null
}

/** 同名插件的**全部**实例的配置值 */
function pluginConfigs(plugins, pluginName) {
  return pluginEntries(plugins, pluginName).map((e) => e.value)
}

/**
 * 同名插件的**全部**实例，带 `{ key, value, container }`。
 *
 * ★ 会加载多份是有真实场景的：测试台就同时挂着两个 chatluna-multi-adapter
 *   （aa0030 / aa0031）。模型组要合并所有实例才准 —— 只看第一个，
 *   遇到"第一个是空壳、第二个才配了组"就会显示成没有兜底顺序。
 * ★ `container` 是它在 loader 配置树里的**父对象**，切换阶段模型时要写回这里。
 */
function pluginEntries(plugins, pluginName, bag) {
  bag = bag || []
  if (!plugins) return bag
  for (const key of Object.keys(plugins)) {
    const short = key.split(':')[0]
    const value = plugins[key]
    if (short === pluginName) {
      bag.push({ key, value: value && typeof value === 'object' ? value : {}, container: plugins })
    }
    if (short === 'group' || short === '~group') pluginEntries(value, pluginName, bag)
  }
  return bag
}

/**
 * 取深层字段。写 `pick(cfg, 'a.b.c')`。
 * 返回 undefined = 这个阶段没配（展示成「—」），不是空串。
 */
function pick(obj, path) {
  let cur = obj
  for (const seg of String(path).split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = cur[seg]
  }
  return cur == null || cur === '' ? undefined : cur
}

/** 模型组名 → 组内模型顺序。键是 `<platform>/<组名>`（multi-adapter 的 platform 是 `cc`） */
function buildGroupMap(plugins) {
  const map = new Map()
  for (const cfg of pluginConfigs(plugins, 'chatluna-multi-adapter')) {
    const platform = String(cfg.platform || '').trim()
    const groups = Array.isArray(cfg.modelGroups) ? cfg.modelGroups : []
    for (const group of groups) {
      if (!group || group.enabled === false) continue
      const groupName = String(group.name || '').trim()
      if (!groupName) continue
      const models = (Array.isArray(group.models) ? group.models : [])
        .map((m) => String((m && m.model) || '').trim())
        .filter(Boolean)
      const key = platform ? `${platform}/${groupName}` : groupName
      if (!models.length && map.has(key)) continue
      map.set(key, {
        name: groupName,
        platform,
        strategy: String(group.strategy || '').trim(),
        models,
        capabilities: (Array.isArray(group.models) ? group.models : []).map((m) => ({
          model: String((m && m.model) || '').trim(),
          capabilities: m && m.modelCapabilities,
          contextSize: m && m.contextSize,
        })),
      })
    }
  }
  return map
}

/** 配了 multi-adapter 的平台名（`['cc']`） */
function multiPlatforms(plugins) {
  const out = []
  for (const cfg of pluginConfigs(plugins, 'chatluna-multi-adapter')) {
    const p = String(cfg.platform || '').trim()
    if (p && !out.includes(p)) out.push(p)
  }
  return out
}

// ================================================================ 可用模型

/**
 * 运行期平台真的列出来的 LLM 模型（含 `{ name, capabilities, contextSize }`）。
 *
 * 抄的是 ChatLuna 自己的 `list_all_model` 中间件（lib/index.cjs:4951）：
 * `platform.listAllModels(ModelType.llm).value.map(m => m.toModelName())`。
 * 防御性写法：拿不到 service / 返回值形状变了都不要抛，退化成空数组。
 */
function listLlmModelInfos(ctx) {
  try {
    // eslint-disable-next-line global-require
    const types = require('koishi-plugin-chatluna/llm-core/platform/types')
    const service = ctx.chatluna && ctx.chatluna.platform
    if (!service || typeof service.listAllModels !== 'function') return []
    const result = service.listAllModels(types.ModelType.llm)
    const list = (result && result.value) || []
    return list
      .map((m) => {
        if (!m) return null
        const name = typeof m.toModelName === 'function' ? m.toModelName() : String(m.name || m)
        if (!name) return null
        return {
          name,
          capabilities: m.capabilities,
          contextSize: m.maxTokens || m.contextSize,
          platform: m.platform,
        }
      })
      .filter(Boolean)
  } catch (e) {
    logger.warn('取模型列表失败：%s', e.message)
    return []
  }
}

function listLlmModels(ctx) {
  return listLlmModelInfos(ctx)
    .map((m) => m.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
}

/**
 * `/stages.set` 的候选池：运行期模型（含模型组，能力是适配器算出的交集）
 * ∪ multi-adapter 手写的候选（能力取自配置，因为 `pullModels: false` 时平台列表里没有它们）
 * ∪ 其它适配器的 `additionalModels`。
 *
 * 每条带 `capabilities`（可能是 null = 未知），供"视觉闸门"判定。
 */
function candidatePool(ctx, plugins) {
  const pool = new Map()
  const add = (rawName, capabilities, source, contextSize) => {
    const model = String(rawName || '').trim()
    if (!model) return
    const prev = pool.get(model)
    if (prev) {
      if (prev.capabilities == null && capabilities != null) prev.capabilities = capabilities
      if (!prev.contextSize && contextSize) prev.contextSize = contextSize
      if (source && !prev.sources.includes(source)) prev.sources.push(source)
      return
    }
    pool.set(model, { name: model, capabilities: capabilities || null, contextSize: contextSize || 0, sources: source ? [source] : [] })
  }

  // ① 运行期真列出来的（模型组就在这一类里）
  for (const info of listLlmModelInfos(ctx)) add(info.name, info.capabilities, '运行时', info.contextSize)

  // ② multi-adapter 手写的候选 + 组名
  for (const cfg of pluginConfigs(plugins, 'chatluna-multi-adapter')) {
    const platform = String(cfg.platform || '').trim()
    for (const group of Array.isArray(cfg.modelGroups) ? cfg.modelGroups : []) {
      if (!group || group.enabled === false) continue
      const groupName = String(group.name || '').trim()
      if (groupName) add(platform ? `${platform}/${groupName}` : groupName, null, '模型组')
      for (const row of Array.isArray(group.models) ? group.models : []) {
        add(row && row.model, row && row.modelCapabilities, `组 ${groupName}`, row && row.contextSize)
      }
    }
  }

  // ③ 额外模型列表（openai-like 适配器）。★ 名字要带平台前缀才是 ChatLuna 里的全名：
  //    配置写 `ling-3.1-flash:free`，ChatLuna 里叫 `ccfree/ling-3.1-flash:free`
  //    （`listAllModels` 的 `toModelName()` 就是 `platform + '/' + name`）。
  for (const cfg of pluginConfigs(plugins, 'chatluna-openai-like-adapter')) {
    const platform = String(cfg.platform || '').trim()
    for (const row of Array.isArray(cfg.additionalModels) ? cfg.additionalModels : []) {
      const model = String((row && row.model) || '').trim()
      if (!model) continue
      add(platform ? `${platform}/${model}` : model, row && row.modelCapabilities, '额外模型', row && row.contextSize)
    }
  }

  return [...pool.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
}

/**
 * 我们挑过的模型的一句话备注（价格/额度来自 commandcode.ai 套餐页，**2026-10-06 快照**）。
 * 只为了选的时候有依据；站点改价不会自动同步，所以要标日期。
 */
const MODEL_NOTES = {
  'deepseek/deepseek-v4.1-flash': '$0.15/$0.60 · GOAT 专项 $60/月（≈15.4 万请求/月）· 视觉实测 1.6s',
  'deepseek/deepseek-v4.1-flash-fast': '$0.16/$0.58 · GOAT $60/月（≈5.75 万请求）· 最快视觉档 1.8s',
  'deepseek/deepseek-v4-flash-vision-exp': '$0.15/$0.60 · GOAT $20/月（≈5.1 万请求）· 老视觉实验版',
  'Qwen/Qwen3.8-Omni-Flash': '$0.15/$0.47 · GOAT $20/月 · 视觉+工具实测通过，中文口语好',
  'Qwen/Qwen3.8-Flash': '$0.16/$0.47 · GOAT $20/月 · 视觉+工具实测 2.3s',
  'Qwen/Qwen3.7-Flash': '$0.03/$0.13 · 全表最便宜的视觉档，但聊天实测 7.9s（慢）',
  'z-ai/glm-5.3-flash': '$0.15/$0.50 · GOAT $60/月 · 视觉通过但偏慢（5~6s）',
  'xiaomi/mimo-v2.6-flash': '$0.14/$0.28 · 视觉通过但聊天 18s，太慢，不建议进队列',
  'xiaomi/mimo-v2.5': '$0.14/$0.28（-98% 优惠）· 视觉实测答不出颜色，别用',
  'inclusionai/ling-3.1-flash:free': '免费 · **不支持视觉**（图片请求直接 400）· 只配纯文本阶段',
  'inclusionai/ling-3.0-flash-sante:free': '免费 · 不支持视觉',
  'poolside/laguna-s-2.1-free': '免费 · 不支持视觉 · 代码向，不适合中文闲聊',
}

// ================================================================ 队列状态

/**
 * 拿 multi-adapter 的 `RotationRegistry`。
 *
 * `platform.getClient(p)` 返回的是 koishi 的 computed 引用，取 `.value` 才是客户端实例；
 * 注册表挂在它的 `_registry` 上。任何一步不对就返回 null（只读用法，不许影响主流程）。
 */
async function registryOf(ctx, platform) {
  try {
    const service = ctx.chatluna && ctx.chatluna.platform
    if (!service || typeof service.getClient !== 'function') return null
    const ref = await service.getClient(platform)
    const client = ref && ref.value
    const registry = client && client._registry
    if (!registry || typeof registry.plan !== 'function' || typeof registry.listGroups !== 'function') return null
    return registry
  } catch (e) {
    logger.debug('取队列注册表失败（%s）：%s', platform, e.message)
    return null
  }
}

/** 失败表（`Map<键, {failures, cooldownUntil}>`），形状不对就返回 null */
function failureTable(registry) {
  const table = registry && registry._failures
  if (!table || typeof table.get !== 'function' || typeof table.forEach !== 'function') return null
  return table
}

/** 把这些注册表按平台收起来，供阶段值按前缀挑 */
async function collectRegistries(ctx, plugins) {
  const out = []
  for (const platform of multiPlatforms(plugins)) {
    const registry = await registryOf(ctx, platform)
    if (registry) out.push({ platform, registry })
  }
  return out
}

/**
 * 阶段值（可能是 `cc/q.vision`，也可能直接是模型名）→ 它属于哪个注册表、组名叫什么。
 *
 * ★ 注册表里的组名**不带平台前缀**（`plan()` 收的是 ChatLuna 的 `params.model`，
 *   而那是 `q.dialogue` 这种裸组名 —— 见 `requester.js` 的 `route ok: q.dialogue -> …`）。
 *   而配置里写的**带前缀**（`cc/q.vision`）。所以两种写法都得试，否则"配了谁"能显示、
 *   "实际在用谁"永远是空的（第一版就是这个 bug，rig 66 第一轮抓到的）。
 */
function resolveGroup(registries, value) {
  const raw = String(value || '')
  if (!raw) return null
  const bare = stripPlatform(raw)
  for (const item of registries) {
    const has = typeof item.registry.hasGroup === 'function' ? (name) => item.registry.hasGroup(name) : () => false
    for (const candidate of [raw, bare, `${item.platform}/${bare}`]) {
      if (!candidate) continue
      if (has(candidate)) return { ...item, group: candidate }
    }
  }
  return null
}

/**
 * 这个组现在实际会走哪个模型。
 *
 * ★ 直接问注册表 `plan()` —— 那是 requester 真正执行的顺序（`requester.js:170`），
 *   而不是照配置顺序猜的。
 * ★ 只对 `failover` 策略问：`roundRobin` / `random` 的 `plan()` 会**推进游标**
 *   （`_planGroup` 里 `group.cursor++`），单纯为了显示去调用会改变运行行为。
 */
function groupInUse(registry, groupName, strategy) {
  if (String(strategy || '').toLowerCase() !== 'failover') return null
  try {
    const attempts = registry.plan(groupName)
    return (attempts && attempts[0] && attempts[0].model) || null
  } catch (e) {
    logger.debug('plan(%s) 失败：%s', groupName, e.message)
    return null
  }
}

/** 组内候选 + 各自状态 */
function groupCandidates(registry, groupName, now) {
  const table = failureTable(registry)
  let group
  try {
    group = typeof registry.getGroup === 'function' ? registry.getGroup(groupName) : null
  } catch { group = null }
  const attempts = (group && group.attempts) || []
  return attempts.map((attempt) => {
    const state = candidateState(table ? table.get(attempt.key) : null, now)
    return { model: attempt.model, endpointIndex: attempt.endpointIndex, key: attempt.key, ...state }
  })
}

// ================================================================ 阶段定义

/**
 * 「处理阶段」清单。
 *
 * 收录标准：**真的会独立跑一次模型调用的地方**。没有模型的阶段（出图、限流）不列。
 * `plugin` / `field` 是**切换时要改的 loader 配置位置**，`vision` 表示这个阶段必须吃图。
 */
const STAGES = [
  {
    key: 'dialogue',
    label: '主对话',
    plugin: 'chatluna',
    field: 'defaultModel',
    vision: true,
    aliases: ['对话', '聊天', 'chat'],
    note: '全局默认；每个会话还可以用 /model 单独覆盖（改这里不会自动改已有会话，除非它是自动模式）',
  },
  {
    key: 'vision',
    label: '看图识别',
    plugin: 'chatluna-vision',
    field: 'visionModel',
    vision: true,
    aliases: ['视觉', '识图', '看图'],
    note: '收到图片时先用它描述图片',
  },
  {
    key: 'vision-fallback',
    label: '看图兜底',
    plugin: 'chatluna-vision',
    field: 'fallbackModel',
    vision: true,
    // ★ 这一路**不吃 ChatLuna 的能力闸门**：`chatluna-vision` 的 describeWith() 自己拼
    //   `image_url` 消息再调模型（lib/index.js:637-646），不像主链路那样由 ChatLuna 按
    //   `image_input` 决定要不要附图。所以"ChatLuna 说它不支持视觉"在这里**不代表图会丢**，
    //   展示时要换一句话说，否则会给出一个误导人的 ⚠。
    gateBypass: true,
    aliases: ['视觉兜底', '识图兜底'],
    note: '主视觉模型失败/超时时才用；图片由本插件直接喂给模型，不走 ChatLuna 的能力闸门',
  },
  {
    key: 'sticker',
    label: '表情包判定',
    plugin: 'chatluna-sticker',
    field: 'judgeModel',
    vision: true,
    aliases: ['表情判定', '表情包'],
    note: '判断收到的表情包值不值得收进库',
  },
  {
    key: 'sticker-learn',
    label: '表情包打标',
    plugin: 'chatluna-sticker-admin',
    field: 'learnModel',
    vision: true,
    aliases: ['表情打标', '收藏打标'],
    note: 'sticker_learn 主动收藏时打标签',
  },
  {
    key: 'proactive',
    label: '主动插话把关',
    plugin: 'chatluna-proactive',
    field: 'judgeModel',
    vision: false,
    aliases: ['插话', '把关', '主动'],
    note: '没人叫它时，决定这波话题能不能接',
  },
  {
    key: 'episode',
    label: '短期情景总结',
    plugin: 'chatluna-episode',
    field: 'summaryModel',
    vision: false,
    aliases: ['情景', '总结', 'episode'],
    note: '{episode()} 的滚动概括',
  },
  {
    key: 'memory',
    label: '长期记忆抽取',
    plugin: 'chatluna-long-memory',
    field: 'longMemoryExtractModel',
    vision: false,
    aliases: ['记忆', '记忆抽取'],
  },
  {
    key: 'memory-graph',
    label: '长期记忆图谱',
    plugin: 'chatluna-long-memory',
    field: 'hippoExtractModel',
    vision: false,
    aliases: ['图谱', '记忆图谱'],
    note: 'HippoRAG 的实体/关系抽取',
  },
  {
    key: 'embeddings',
    label: '嵌入（记忆检索）',
    plugin: 'chatluna',
    field: 'defaultEmbeddings',
    vision: false,
    readonly: true,
    aliases: ['嵌入', '向量模型'],
    note: '不是 LLM，是向量模型',
  },
  {
    key: 'vector-store',
    label: '向量库',
    plugin: 'chatluna',
    field: 'defaultVectorStore',
    vision: false,
    readonly: true,
    aliases: ['向量库', 'vector'],
    note: '不是模型，是存向量的后端',
  },
]

// ================================================================ 应用

function apply(ctx, config) {
  const cfg = {
    enabled: true,
    pageSize: 10,
    pickPageSize: 15,
    showGroupChain: true,
    stagesCommand: true,
    switching: true,
    sessionFailureLimit: 3,
    queueSweepSeconds: 5,
    debug: false,
    ...(config || {}),
  }
  if (!cfg.enabled) {
    logger.info('已关闭（enabled=false），/models 与 /stages 都不注册')
    return
  }

  /** loader 的实时配置树。拿不到就退化成 null（命令仍可用，只是阶段显示「没配」） */
  function pluginsConfig() {
    const loader = ctx.loader
    const root = loader && loader.config
    return (root && root.plugins) || null
  }

  // ============================================================ 队列自愈
  /**
   * 本次运行内被我们"停用"的候选。
   * 键是注册表里的失败表键（`组\0接口\0模型`），值是展示用的记录。
   * 真状态在注册表的失败表里（`cooldownUntil = Infinity`），这里只是给人看的那一份。
   */
  const sessionDisabled = new Map()

  /** 本进程启动时各阶段的值（`/stages.reset` 的恢复点）。必须在注册指令前就有，动作里要读 */
  const originalValues = new Map()

  /**
   * 扫一遍失败表：累计失败到阈值就把 `cooldownUntil` 抬到 `Infinity`。
   *
   * ★ 只写这**一个**字段：注册表自己的 `isCooling()` 用它，`_planGroup()` 过滤候选时
   *   就自然不会选中它；同时 `reportFailure()` 之后仍会把它改回有限值（说明又试了一次），
   *   那种情况我们下次扫描会再抬上去 —— 行为稳定，不需要改上游代码。
   */
  async function sweepQueue() {
    if (!cfg.sessionFailureLimit) return
    const plugins = pluginsConfig()
    if (!plugins) return
    const registries = await collectRegistries(ctx, plugins)
    if (!registries.length) return
    const now = Date.now()
    for (const { platform, registry } of registries) {
      const table = failureTable(registry)
      if (!table) continue
      const hits = []
      try {
        table.forEach((state, key) => {
          if (!state || Number(state.failures || 0) < cfg.sessionFailureLimit) return
          if (isDisabled(state)) return // 已经停用过
          hits.push({ key, failures: Number(state.failures || 0) })
        })
      } catch (e) {
        logger.debug('扫失败表失败：%s', e.message)
        continue
      }
      for (const hit of hits) {
        const parsed = parseFailureKey(hit.key)
        if (!parsed) continue
        const state = table.get(hit.key)
        if (!state) continue
        state.cooldownUntil = Number.POSITIVE_INFINITY // ← 本次登录不再尝试
        sessionDisabled.set(hit.key, {
          at: now,
          failures: hit.failures,
          group: parsed.group,
          model: parsed.model,
          platform,
        })
        logger.info(
          '队列自愈：%s 的 %s 累计失败 %d 次 → 本次登录不再尝试（重启即复原）',
          parsed.group || '(单模型)',
          parsed.model,
          hit.failures
        )
      }
    }
  }

  /** 失败表里的一条记录是否已被我们"永久"停用 */
  function isDisabled(state) {
    const until = Number((state && state.cooldownUntil) || 0)
    return !Number.isFinite(until) || until > 1e14
  }

  if (cfg.sessionFailureLimit) {
    // ★ 不立刻扫：启动瞬间适配器还没把模型组注册进注册表
    ctx.setInterval(() => {
      sweepQueue().catch((e) => logger.debug('队列自愈异常：%s', e.message))
    }, cfg.queueSweepSeconds * 1000)
  }

  // ============================================================ /models
  ctx
    .command('models [page:number]', '列出可用的模型（可翻页）')
    .option('limit', '-l <limit:number>', { fallback: 0 })
    .option('page', '-p <page:number>', { fallback: 0 })
    .usage(
      '例：`/models` 第 1 页；`/models 2` 第 2 页；`/models -l 20` 每页 20 个。' +
        '想看「各阶段实际在用哪个模型」用 `/stages`。'
    )
    .action(async ({ session, options }, pageArg) => {
      const models = listLlmModels(ctx)
      if (!models.length) {
        return '没有拿到任何模型。检查适配器（chatluna-multi-adapter / *-adapter）是否加载成功。'
      }

      const limit = Math.max(1, Math.min(50, Number(options.limit) || cfg.pageSize))
      // 页码：位置参数优先，其次 `-p`，最后第 1 页
      const page = Math.max(1, Math.floor(Number(pageArg) || Number(options.page) || 1))
      const totalPages = Math.max(1, Math.ceil(models.length / limit))

      if (page > totalPages) {
        return `只有 ${totalPages} 页（共 ${models.length} 个模型）。用 \`/models ${totalPages}\` 看最后一页。`
      }

      const groupMap = buildGroupMap(pluginsConfig())
      const current = await currentConversation(ctx, session)
      const currentModel = current && current.model
      const slice = models.slice((page - 1) * limit, page * limit)

      const lines = [
        `可用模型（共 ${models.length} 个 · 第 ${page}/${totalPages} 页 · 每页 ${limit} 个）`,
        '',
        ...slice.map((m, i) => {
          const no = (page - 1) * limit + i + 1
          const marks = []
          if (m === currentModel) marks.push('★当前会话')
          const group = groupMap.get(m)
          if (group && group.models.length) marks.push(`模型组 ${group.models.length} 个`)
          return `${no}. ${m}${marks.length ? `　${marks.join(' · ')}` : ''}`
        }),
        '',
      ]

      // ★ 页脚：把翻页命令**写出来**。这是这个插件存在的首要理由（上游只写"第几页"）。
      //   ★ 临时改过 -l 就把 -l 一起写进提示 —— 页码和每页条数不联动，
      //     提示 `/models 2` 而实际每页 3 条，用户按提示敲只会跳到另一个"第 2 页"。
      const lArg = limit === cfg.pageSize ? '' : ` -l ${limit}`
      const hints = []
      if (page < totalPages) hints.push(`\`/models ${page + 1}${lArg}\` 看下一页`)
      if (page > 1) hints.push(`\`/models ${page - 1}${lArg}\` 看上一页`)
      if (!lArg) hints.push('`/models -l 20` 每页 20 个')
      hints.push('`/stages` 看各阶段实际在用的模型')
      lines.push('→ ' + hints.join('；'))

      if (cfg.debug) {
        logger.info('/models 第 %d/%d 页，共 %d 个模型', page, totalPages, models.length)
      }
      return lines.join('\n')
    })

  // ============================================================ /stages
  /** 队列的一段（实际在用 + 候选状态），拿不到注册表就返回 null */
  async function queueBlock(value, plugins, registries, now) {
    if (!value) return null
    const hit = resolveGroup(registries, value)
    if (!hit) return null
    const { registry, group, platform } = hit
    const strategy = (() => {
      try {
        const runtime = typeof registry.getGroup === 'function' ? registry.getGroup(group) : null
        return (runtime && runtime.strategy) || 'failover'
      } catch { return 'failover' }
    })()
    const candidates = groupCandidates(registry, group, now)
    const inUse = groupInUse(registry, group, strategy)
    return { platform, group, strategy, candidates, inUse }
  }

  function renderCandidate(candidate, inUse) {
    const isInUse = inUse && candidate.model === inUse
    if (candidate.kind === 'disabled') {
      const rec = sessionDisabled.get(candidate.key)
      return `⛔ ${candidate.model}　本次登录停用（${candidate.failures} 次失败${rec ? ` · ${fmtClock(rec.at)} 起` : ''}）`
    }
    if (candidate.kind === 'cooling') {
      return `${isInUse ? '✅' : '⏳'} ${candidate.model}　${
        isInUse ? '实际在用（' : '冷却中 '
      }${candidate.failures} 次失败，冷却剩 ${formatDuration(candidate.remain)}${isInUse ? '）' : ''}`
    }
    return `${isInUse ? '✅ 实际在用' : '○ 后备'} ${candidate.model}${
      candidate.failures ? `（失败过 ${candidate.failures} 次，已恢复）` : ''
    }`
  }

  function fmtClock(ts) {
    const d = new Date(ts)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }

  async function stagesText(session, options) {
    const plugins = pluginsConfig()
    if (!plugins) {
      return '拿不到 loader 配置（ctx.loader.config），无法列出各阶段模型。'
    }
    const groupMap = buildGroupMap(plugins)
    const registries = await collectRegistries(ctx, plugins)
    const now = Date.now()
    const current = await currentConversation(ctx, session)
    const pool = candidatePool(ctx, plugins)
    const capsByName = new Map(pool.map((m) => [m.name, m.capabilities]))

    const out = []
    const verbose = !!(options && options.verbose)

    out.push('【各阶段模型 · 实际在用】')
    if (current) {
      const where = session.guildId ? `群 ${session.guildId}` : session.channelId || session.userId || '—'
      out.push(`当前会话：${current.title || '（无标题）'} ｜ ${where}`)
      const globalDefault = pick(pluginConfig(plugins, 'chatluna'), 'defaultModel')
      const sameAsDefault = globalDefault && current.model === globalDefault
      out.push(
        `会话模型：${current.model || '—'}` +
          (sameAsDefault ? '（＝全局默认 defaultModel）' : `（全局默认是 ${globalDefault || '—'}）`)
      )
      out.push(`预设：${current.preset || '—'} ｜ 聊天模式：${current.chatMode || '—'}`)
    } else {
      out.push('当前会话：拿不到（可能还没建会话；聊一句再试）')
    }
    out.push('')

    if (!registries.length) {
      out.push('⚠ 拿不到队列注册表（chatluna-multi-adapter 的运行期状态），下面只有配置值。')
    }

    for (const stage of STAGES) {
      const entries = pluginEntries(plugins, stage.plugin)
      const stageCfg = entries.length ? entries[0].value : null
      const value = pick(stageCfg, stage.field)
      const live = await queueBlock(value, plugins, registries, now)

      if (!value) {
        // ★ 没读到 ≠ 插件没用模型：很多插件的 schema 有默认值，那种情况下 koishi.yml 里
        //   本来就不会有这一行。所以如实说"没显式配"，别写成"没配"让人以为没生效。
        out.push(`${stage.label}：未显式配置（用插件默认）`)
        continue
      }

      const can = canSeeImage(capsByName.get(String(value)))
      // ★ 不带 `image_input` 的两种情况分开说：
      //   · 真闸门（主链路）：ChatLuna 会按能力表把图降级成占位符 → 必须报警；
      //   · 旁路（看图兜底）：插件自己拼 image_url 喂模型，能力表不参与 → 说清楚就行，
      //     报成"瞎了"会误导人（那个值其实是能用的）。
      const visionWarn =
        stage.vision && can === false
          ? stage.gateBypass
            ? '　（ChatLuna 的能力表没给这个模型标视觉，但这一路是插件直接喂图、不走闸门）'
            : '　⚠ 这个阶段要吃图，但当前模型不支持视觉！'
          : ''
      if (!live) {
        out.push(`${stage.label}：${value}${visionWarn}`)
        const group = groupMap.get(value)
        if (cfg.showGroupChain && group && group.models.length > 1) {
          out.push(`  └ 组内顺序：${group.models.join(' → ')}${group.strategy ? `（策略：${group.strategy}）` : ''}`)
        }
        if (verbose && stage.note) out.push(`  （${stage.note}）`)
        continue
      }

      out.push(`${stage.label}：${value}　→　实际在用 ${live.inUse || '（见下）'}`)
      for (const candidate of live.candidates) out.push(`  ${renderCandidate(candidate, live.inUse)}`)
      if (live.strategy !== 'failover') {
        out.push(`  └ 策略是「${live.strategy}」，没有固定"在用"，按策略轮换`)
      }
      if (visionWarn) out.push(`  ⚠ 这个阶段要吃图，但配置值 ${value} 现在不带 image_input`)
      if (verbose && stage.note) out.push(`  （${stage.note}）`)
    }

    // 尾部：本次登录被停用的清单（最有用的一条信息，别埋在阶段里）
    out.push('')
    if (sessionDisabled.size) {
      out.push('本次登录已停用（重启即复原）')
      for (const rec of sessionDisabled.values()) {
        out.push(`  ${rec.group || '(单模型)'} · ${rec.model}：${rec.failures} 次失败（${fmtClock(rec.at)} 起）`)
      }
    } else {
      out.push('本次登录已停用：无')
    }

    const base = pick(pluginConfig(plugins, 'chatluna-multi-adapter'), 'endpointFailureCooldown') || DEFAULT_FAILURE_COOLDOWN
    out.push('')
    out.push(`队列规则：冷却梯度 ${cooldownLadder(base).join(' → ')}（上限 ${formatDuration(MAX_FAILURE_COOLDOWN)}）`)
    out.push(
      cfg.sessionFailureLimit
        ? `同一「模型+接口」累计失败 ${cfg.sessionFailureLimit} 次 → 本次登录不再尝试（只看内存状态，重启复原）`
        : '「本次登录不再尝试」已关闭（sessionFailureLimit=0），失败只会按冷却梯度重试'
    )
    out.push('切换：`/stages.set` 看阶段清单 ｜ `/stages.set 看图识别` 选模型（可翻页）')
    out.push('（实际在用 = 队列此刻会走的第一个候选，直接读 chatluna-multi-adapter 的 plan()）')
    return out.join('\n')
  }

  if (cfg.stagesCommand) {
    ctx
      .command('stages', '看各阶段（聊天 / 看图 / 记忆 / 把关…）实际在用哪个模型')
      .option('verbose', '-v, --verbose', { fallback: false })
      .usage('配置值从 loader 实时读，"实际在用"从 multi-adapter 的队列注册表实时读；加 -v 看每个阶段的说明。')
      .action(async ({ session, options }) => {
        try {
          return await stagesText(session, options)
        } catch (e) {
          logger.warn('生成阶段总览失败：%s', e.message)
          return `生成失败：${e.message}`
        }
      })
  }

  // ============================================================ /stages.set
  /** 阶段清单（`/stages.set` 不带参数时给） */
  async function stagesHelp() {
    const plugins = pluginsConfig()
    const out = ['【按阶段换模型】用法：`/stages.set <阶段> [序号|模型名]`', '']
    for (const stage of STAGES) {
      const value = plugins ? pick(pluginConfig(plugins, stage.plugin), stage.field) : undefined
      const flag = stage.readonly ? '（只读）' : stage.vision ? '（要视觉）' : ''
      out.push(`  ${stage.key}　${stage.label}${flag}：${value || '（未显式配置）'}`)
    }
    out.push('')
    out.push('→ 先 `/stages.set 看图识别` 列出候选（带分页），再用 `/stages.set 看图识别 3` 选定。')
    out.push('→ 也可以直接写模型名：`/stages.set 看图识别 cc/q.vision`。')
    out.push('→ 中英文/别名都认（视觉、识图、看图 = vision）。改动会写回 koishi.yml 并热重载那个插件。')
    return out.join('\n')
  }

  /** 候选列表（分页 + 绝对编号） */
  async function pickList(stage, options, pageArg, ctxObj) {
    const plugins = pluginsConfig()
    const pool = candidatePool(ctxObj, plugins || {})
    // ★ 要视觉的阶段，把不能吃图的排到后面并标出来（不是直接删：用户可能就是要看全）
    const rows = pool.slice()
    if (stage.vision) {
      rows.sort((a, b) => {
        const rank = (x) => (canSeeImage(x.capabilities) === true ? 0 : canSeeImage(x.capabilities) === false ? 2 : 1)
        return rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
      })
    }
    const limit = Math.max(1, Math.min(50, Number(options.limit) || cfg.pickPageSize))
    const page = Math.max(1, Math.floor(Number(pageArg) || Number(options.page) || 1))
    const totalPages = Math.max(1, Math.ceil(rows.length / limit))
    if (page > totalPages) return `只有 ${totalPages} 页（共 ${rows.length} 个候选）。`

    const current = pick(pluginConfig(plugins || {}, stage.plugin), stage.field)
    const slice = rows.slice((page - 1) * limit, page * limit)
    const out = [
      `${stage.label}（${stage.key}）的候选模型`,
      `共 ${rows.length} 个 · 第 ${page}/${totalPages} 页 · 每页 ${limit} 个` +
        (stage.vision ? ' · 支持视觉的排在前面' : ''),
      `当前：${current || '（未显式配置）'}`,
      '',
    ]
    slice.forEach((row, i) => {
      const no = (page - 1) * limit + i + 1
      const marks = [markImage(row.capabilities)]
      if (row.contextSize) marks.push(`上下文 ${formatContext(row.contextSize)}`)
      const note = MODEL_NOTES[row.name]
      out.push(`${no}. ${row.name}　${marks.join(' · ')}`)
      if (note) out.push(`     ${note}`)
    })
    out.push('')
    const lArg = limit === cfg.pickPageSize ? '' : ` -l ${limit}`
    const hints = []
    if (page < totalPages) hints.push(`\`/stages.set ${stage.key} -p ${page + 1}${lArg}\` 下一页`)
    if (page > 1) hints.push(`\`/stages.set ${stage.key} -p ${page - 1}${lArg}\` 上一页`)
    hints.push(`\`/stages.set ${stage.key} <序号>\` 选定`)
    out.push('→ ' + hints.join('；'))
    if (stage.vision) out.push('（这个阶段要吃图：序号对应 ✖无视觉 的会被拒绝）')
    return out.join('\n')
  }

  /**
   * 把新值落到运行期 + 落盘。
   * ★ `modelName === undefined` = 删掉这个字段（回到"未显式配置 → 用插件 schema 默认"）。
   * ★ 两个动作分开：**reload 让它在本次运行生效**（loader 的官方路径，且不会自己写盘），
   *   **按行改文件**负责持久化（保住注释，见 `patchYamlField`）。
   * 返回 `{ reloaded, persisted, file }`：`persisted` 是 `line`（按行改）/ `loader`（退化整份重写）/ `none`。
   */
  async function applyStageValue(stage, modelName) {
    const loader = ctx.loader
    if (!loader || !loader.config || !loader.config.plugins) throw new Error('拿不到 loader 配置（ctx.loader.config）')
    const entries = pluginEntries(loader.config.plugins, stage.plugin)
    if (!entries.length) throw new Error(`koishi.yml 里没有 ${stage.plugin} 这个插件`)
    const target = entries[0]
    const next = { ...(target.value || {}) }
    if (modelName === undefined || modelName === null) delete next[stage.field]
    else next[stage.field] = String(modelName)
    target.container[target.key] = next

    // ① 运行期生效：只重启这一个插件
    const parent = resolveReloadParent(loader, target.key)
    let reloaded = false
    if (parent) {
      await loader.reload(parent, target.key, next)
      reloaded = true
    }

    // ② 落盘：优先**按行改**（保住注释与排版），拿不到文件路径或找不到插件块才退化成整份重写
    let persisted = 'none'
    let file = null
    const filename = loader.filename
    if (typeof filename === 'string' && filename) {
      file = filename
      let patched = null
      try {
        const raw = fs.readFileSync(filename, 'utf8')
        patched = patchYamlField(raw, target.key, stage.field, modelName === undefined || modelName === null ? undefined : String(modelName))
        if (patched != null) {
          if (patched !== raw) {
            fs.writeFileSync(filename + '.tmp', patched, 'utf8')
            fs.renameSync(filename + '.tmp', filename)
          }
          persisted = 'line'
        }
      } catch (e) {
        logger.warn('按行写 koishi.yml 失败（%s），退化成整份重写', e.message)
        patched = null
      }
      if (patched == null) {
        if (typeof loader.writeConfig === 'function') await loader.writeConfig()
        persisted = 'loader'
      }
    } else if (typeof loader.writeConfig === 'function') {
      await loader.writeConfig()
      persisted = 'loader'
    }
    return { reloaded, persisted, file }
  }

  /** 找到 loader 记录表里持有这个 key 的父作用域（找不到就只能写盘、重启生效） */
  function resolveReloadParent(loader, key) {
    const entry = loader.entry
    const candidates = []
    if (entry && entry.scope && entry.scope.ctx) candidates.push(entry.scope.ctx)
    if (entry) candidates.push(entry)
    if (entry && entry.scope) candidates.push(entry.scope)
    for (const candidate of candidates) {
      try {
        const record = candidate && candidate.scope && candidate.scope[kRecord]
        if (record && record[key]) return candidate
      } catch { /* 忽略，试下一个 */ }
    }
    return null
  }

  /**
   * 真正落地一次切换：过视觉闸门 → 写 loader 配置 + 热重载 → 回报。
   * ★ 抽成独立函数是因为 action 里有两个入口（写序号、写模型名），报错文案要完全一致。
   */
  async function commitStage(stage, row) {
    const modelName = String(row.name || '').trim()
    if (!modelName) return '没给出模型名。'
    const current = pick(pluginConfig(pluginsConfig() || {}, stage.plugin), stage.field)
    if (current === modelName) return `${stage.label} 现在就是 ${modelName}，没改。`
    const known = visionOfRow(row)
    if (stage.vision) {
      if (known === false) {
        return (
          `❌ 拒绝：${modelName} 不支持视觉（${markImage(row.capabilities)}）。\n` +
          `${stage.label} 这个阶段收到的是图片，换成它会让图片被降级成占位符，等于瞎了。\n` +
          (stage.gateBypass
            ? '（这个阶段虽然由插件直接把图喂给模型、不经过 ChatLuna 的能力闸门，' +
              '但上游会对图片直接报 400，所以照样不建议换。）\n'
            : '') +
          `用 \`/stages.set ${stage.key}\` 看带 ✅视觉 的候选。`
        )
      }
      if (known === null) {
        return (
          `❌ 拒绝：${modelName} 的视觉能力未知（既不在适配器列出的模型里，也没在模型组里声明能力）。\n` +
          `要换的话先把它加进 chatluna-multi-adapter 的模型组（在那里声明 modelCapabilities），` +
          `或者直接选一个已经在组里的模型（那些的能力是确定的）。`
        )
      }
    }
    let result
    try {
      result = await applyStageValue(stage, modelName)
    } catch (e) {
      logger.warn('切换 %s 失败：%s', stage.key, e.message)
      return `切换失败：${e.message}`
    }
    const { reloaded, persisted } = result
    logger.info(
      '阶段 %s：%s → %s（%s / 落盘 %s）',
      stage.key,
      current || '—',
      modelName,
      reloaded ? '已热重载' : '未热重载',
      persisted
    )
    const capLine = stage.vision ? `　（${markImage(row.capabilities)}）` : ''
    const howSave =
      persisted === 'line'
        ? '落盘：只改了 koishi.yml 里的那一行（注释与排版都保留）'
        : persisted === 'loader'
          ? '落盘：⚠ 走的是 loader 整份重写，那份文件的注释会被压掉'
          : '⚠ 没能落盘（本次运行生效，重启后会回到原样）'
    return (
      `✅ ${stage.label}：${current || '—'} → ${modelName}${capLine}\n` +
      (reloaded ? `已写回 koishi.yml 并热重载 ${stage.plugin}。${howSave}` : `${howSave}；没找到运行期记录，**重启后生效**。`) +
      (stage.key === 'dialogue' ? '\n（主对话的"全局默认"改了：已有会话要 /model -a 或等自动模式下才会跟着变）' : '')
    )
  }

  if (cfg.stagesCommand) {
    ctx
      .command('stages.set [stage:string] [value:string]', '按阶段换模型（不带参数看清单，带阶段看候选，带序号/模型名即选定）')
      .option('page', '-p <page:number>', { fallback: 0 })
      .option('limit', '-l <limit:number>', { fallback: 0 })
      .usage(
        '例：`/stages.set` 看全部阶段；`/stages.set 看图识别` 列候选；`/stages.set 看图识别 3` 选第 3 个；' +
          '`/stages.set 看图识别 -p 2` 翻页；`/stages.set memory cc/q.memory` 直接写模型名。'
      )
      .action(async ({ session, options }, stageArg, valueArg) => {
        try {
          if (!stageArg) return await stagesHelp()
          const stage = resolveStage(STAGES, stageArg)
          if (!stage) {
            return `没有这个阶段：${stageArg}\n用 \`/stages.set\` 看阶段清单（key 或中文名都行）。`
          }
          if (stage.readonly) return `${stage.label} 是只读项（${stage.note || '不是可切换的模型'}），不能在这里改。`
          if (!valueArg) return await pickList(stage, options, 0, ctx)
          if (!cfg.switching) return '阶段切换被关掉了（switching=false）。'

          const plugins = pluginsConfig() || {}
          const rows = pickListOrder(candidatePool(ctx, plugins), stage)
          const raw = String(valueArg).trim()
          if (/^\d+$/.test(raw)) {
            const picked = rows[Number(raw) - 1]
            if (!picked) {
              return `序号 ${raw} 超出候选范围（共 ${rows.length} 个）。用 \`/stages.set ${stage.key}\` 看列表。`
            }
            return await commitStage(stage, picked)
          }
          // 直接写模型名：能力尽量从候选池里查（查不到 = 未知，要视觉的阶段会拒）
          const known = rows.find((x) => x.name === raw)
          return await commitStage(stage, known || { name: raw, capabilities: null })
        } catch (e) {
          logger.warn('阶段切换失败：%s', e.message)
          return `切换失败：${e.message}`
        }
      })

    ctx
      .command('stages.reset <stage:string>', '把某个阶段的模型改回本进程启动时 koishi.yml 里的值')
      .action(async ({ session }, stageArg) => {
        try {
          const stage = resolveStage(STAGES, stageArg)
          if (!stage) return `没有这个阶段：${stageArg}`
          if (stage.readonly) return `${stage.label} 是只读项，不能改。`
          if (!cfg.switching) return '阶段切换被关掉了（switching=false）。'
          const snapshot = originalValues.get(stage.key)
          if (!snapshot) return `没有记到 ${stage.label} 的启动快照（这个阶段这次启动时就不在配置里）。`
          const current = pick(pluginConfig(pluginsConfig() || {}, stage.plugin), stage.field)
          const target = snapshot.configured ? snapshot.value : undefined
          if (current === target || (current === undefined && target === undefined)) {
            return `${stage.label} 现在就是启动时的状态（${target || '未显式配置'}），没改。`
          }
          let result
          try {
            result = await applyStageValue(stage, target)
          } catch (e) {
            return `恢复失败：${e.message}`
          }
          logger.info(
            '阶段 %s 恢复为启动值 %s（%s / 落盘 %s）',
            stage.key,
            target || '(删除该行)',
            result.reloaded ? '已热重载' : '未热重载',
            result.persisted
          )
          return (
            `✅ ${stage.label} 已恢复到本进程启动时的状态：` +
            `${target || '未显式配置（已删掉 koishi.yml 里的那一行，回到插件默认）'}` +
            `${result.reloaded ? '，已热重载' : '，重启后生效'}。`
          )
        } catch (e) {
          return `恢复失败：${e.message}`
        }
      })
  }

  /** `/stages.set <阶段> <序号>` 的编号体系必须与列表一致（要视觉的阶段会重排） */
  function pickListOrder(pool, stage) {
    const rows = pool.slice()
    if (stage.vision) {
      rows.sort((a, b) => {
        const rank = (x) => (canSeeImage(x.capabilities) === true ? 0 : canSeeImage(x.capabilities) === false ? 2 : 1)
        return rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
      })
    }
    return rows
  }

  /** 视觉能力查表：候选行自带的优先，其次回头查全局候选池 */
  function visionOfRow(row) {
    if (row && row.capabilities) return canSeeImage(row.capabilities)
    const plugins = pluginsConfig() || {}
    const found = candidatePool(ctx, plugins).find((x) => x.name === row.name)
    return found ? canSeeImage(found.capabilities) : null
  }

  ctx.on('ready', () => {
    try {
      const plugins = pluginsConfig() || {}
      for (const stage of STAGES) {
        const value = pick(pluginConfig(plugins, stage.plugin), stage.field)
        // ★ 记的是"启动时的**状态**"，不只是值：没显式配置也要记下来，
        //   这样 `/stages.reset` 才知道该把这一行删掉（而不是恢复成某个具体模型名）。
        originalValues.set(stage.key, { value, configured: value !== undefined })
      }
    } catch (e) {
      logger.debug('记录阶段启动快照失败：%s', e.message)
    }
    // 启动时把队列现在的顺序打一遍（运维用；也方便和 docs/22 的表格对照）
    setTimeout(() => {
      sweepQueue().catch(() => {})
      if (!cfg.debug) return
      collectRegistries(ctx, pluginsConfig() || {})
        .then((registries) => {
          for (const { platform, registry } of registries) {
            for (const group of registry.listGroups()) {
              logger.debug(
                'group %s [%s] -> %s',
                group.name,
                group.strategy,
                group.attempts.map((a) => a.model).join(' -> ')
              )
            }
            if (platform) logger.debug('平台 %s 的队列注册表已接上', platform)
          }
        })
        .catch(() => {})
    }, 3000)

    logger.info('模型总览已就绪：/models（每页 %d）%s', cfg.pageSize, cfg.stagesCommand ? ' + /stages + /stages.set' : '')
    if (cfg.sessionFailureLimit) {
      logger.info(
        '队列自愈已开启：同一模型累计失败 %d 次 → 本次登录不再尝试（每 %d 秒扫一次）',
        cfg.sessionFailureLimit,
        cfg.queueSweepSeconds
      )
    }
  })
}

/**
 * 读当前会话的模型/预设/模式。
 *
 * ★ `getConversation` 收的是**会话 id**，不是 session（`services/conversation.d.ts:17`），
 *   所以先 `resolveConversation(session)` 把"这个 session 现在绑的是哪个会话"解出来。
 *   一开始想当然地传 session，读到的是 null —— 会静默显示成"还没建会话"。
 *
 * ★ 这里**不判断"自动还是手动"**：ChatLuna 的 `conversation.model` 里存的就是
 *   「路由最后选出来的那个模型名」，没有单独的 auto 标记位
 *   （`/model -a` 走 `applyAutoModelUpdate`，把结果**写回同一个字段**）。
 *   所以 /stages 只显示"现在用的是谁"，并把全局默认一并列出来让人自己对照。
 */
async function currentConversation(ctx, session) {
  try {
    const service = ctx.chatluna && ctx.chatluna.conversation
    if (!service || typeof service.resolveConversation !== 'function') return null
    const resolved = await service.resolveConversation(session)
    const id = resolved && resolved.conversationId
    if (!id) return null
    const conversation = await service.getConversation(id)
    if (!conversation) return null
    return {
      id: conversation.id,
      title: conversation.title,
      model: conversation.model,
      preset: conversation.preset,
      chatMode: conversation.chatMode,
    }
  } catch (e) {
    logger.debug('读当前会话失败：%s', e.message)
    return null
  }
}

module.exports = {
  name,
  inject,
  Config,
  apply,
  /** 给单测用（不依赖 ctx） */
  _pure: {
    parseFailureKey,
    formatDuration,
    candidateState,
    cooldownLadder,
    canSeeImage,
    markImage,
    stripPlatform,
    formatContext,
    resolveStage,
    patchYamlField,
    formatYamlScalar,
    STAGES,
    COOLDOWN_MULTIPLIERS,
    MAX_FAILURE_COOLDOWN,
    DEFAULT_FAILURE_COOLDOWN,
  },
}
