/**
 * koishi-plugin-chatluna-local-embeddings
 *
 * 给 ChatLuna 提供**本地**嵌入模型（embeddings）：
 *   - 用 transformers.js（ONNX Runtime，纯 CPU）在本机跑嵌入模型
 *   - 默认 Xenova/bge-small-zh-v1.5（中文优化，512 维，q8 量化约 23MB）
 *   - 不需要 API Key，模型下载一次之后**离线可用**
 *
 * 为什么自己写：ChatLuna 1.4 自带的 `koishi-plugin-chatluna-embeddings-service`
 * 只支持 HuggingFace **推理 API**（要 token + 外网），OpenAI/通义/智谱那几个都要 Key。
 * 自建路线下最省事、最不怕断供的是在本地跑一个小模型。
 *
 * ★ 关键 API（照抄 chatluna-deepseek-adapter@1.4.1 的实证用法）：
 *   const plugin = new ChatLunaPlugin(ctx, config, PLATFORM)      // platformName
 *   plugin.parseConfig(cb)                                        // 填 ClientConfigPool
 *   plugin.registerClient(() => new XxxClient(...))               // 注册平台客户端
 *   await plugin.initClient()                                     // 触发 createClient
 *   然后 chatluna 会 emit `chatluna/embeddings-added`，
 *   `Schema.dynamic('embeddings')` 就能列出 `local/bge-small-zh-v1.5`。
 *
 * ★ 模型名的解析规则（`utils/count_tokens.cjs` 的 parseRawModelName）：
 *   按**第一个** `/` 切成 `[platform, model]`。所以平台名后面接的模型名里
 *   可以再带斜杠（`local/Xenova/bge-small-zh-v1.5` 也能解析），但我们还是把
 *   HF 仓库 id 藏在配置里，对外只暴露 `local/bge-small-zh-v1.5` 这样干净的名字。
 *
 * ★ 目录约定：模型缓存默认放 `<仓库根>/models/hf-cache`（生产实例和测试实例共用），
 *   而不是 `ctx.baseDir/data`，避免两边各下一份 23MB。
 *
 * ★★ 依赖必须从**宿主应用**的 node_modules 里解析（见 appRequire）：
 *   自研插件是用 junction 挂在 `<app>/node_modules/` 下的，Node 默认按 realpath 解析，
 *   所以 `require('koishi-plugin-chatluna/...')` 会走到**源码所在的那个实例**
 *   （koishi-app/node_modules），而不是当前正在跑的那个实例（比如 koishi-test）。
 *   两份 chatluna = 两个 ChatLunaBaseEmbeddings 类，chatluna 内部那句
 *   `model instanceof ChatLunaBaseEmbeddings` 就会 false。
 *   症状（rig 32 实测）：
 *     chatluna-long-memory The model bge-small-zh-v1.5 is not embeddings, return empty embeddings
 *     chatluna Error: Embedding dimension is 0, Try to change the embeddings model.
 */

const path = require('node:path')
const fs = require('node:fs')
const Module = require('node:module')

const { Schema } = require('koishi')

/**
 * 从宿主应用根目录解析依赖，保证拿到的是"正在运行的那一份"。
 * `ctx.baseDir` 在 koishi-app 里就是 koishi-app，在 koishi-test 里就是 koishi-test。
 */
function appRequire(ctx, spec) {
  const req = Module.createRequire(path.join(ctx.baseDir, 'index.js'))
  return req(spec)
}

const name = 'chatluna-local-embeddings'
const inject = ['chatluna']

/** 平台名，最终 defaultEmbeddings 写作 `local/<模型名>` */
const PLATFORM = 'local'

/** BGE 中文模型官方推荐的检索指令前缀（只加在 query 上，不加在文档上） */
const BGE_ZH_QUERY_PREFIX = '为这个句子生成表示以用于检索相关文章：'

const DEFAULT_MODELS = [
  {
    name: 'bge-small-zh-v1.5',
    repo: 'Xenova/bge-small-zh-v1.5',
    dtype: 'q8',
    pooling: 'cls',
    queryPrefix: BGE_ZH_QUERY_PREFIX,
  },
]

/**
 * ★ 这个 require 是**故意**走本文件自己的解析路径的：它只用来拼 Config 的 schema。
 *   schema 是纯数据，不存在"类 identity"问题；而运行时用的类必须走 appRequire
 *   （见文件头说明）。要是这里也改成 appRequire，就没法在模块加载期拿到它了。
 */
const { ChatLunaPlugin: ChatLunaPluginSchema } = require('koishi-plugin-chatluna/services/chat')

const Config = Schema.intersect([
  ChatLunaPluginSchema.Config,
  Schema.object({
    enabled: Schema.boolean().default(true).description(
      '启用本地嵌入模型服务。关掉后平台不会注册，`defaultEmbeddings` 会退回「无」。'
    ),
    cacheDir: Schema.string().default('').description(
      '模型缓存目录。留空 = `<仓库根>/models/hf-cache`（生产与测试实例共用一份）。'
    ),
    allowRemote: Schema.boolean().default(true).description(
      '缓存里没有模型时允许联网下载。初次安装要开着；下好之后可以关掉，彻底离线。'
    ),
    device: Schema.union([
      Schema.const('cpu').description('只用 CPU（稳，推荐）'),
      Schema.const('auto').description('让 onnxruntime 自己挑（可能用 GPU）'),
    ]).default('cpu').description('推理设备'),
    maxBatch: Schema.natural().default(16).description(
      '一次送去模型的最大条数。条数太多会吃内存。'
    ),
    warmup: Schema.boolean().default(true).description(
      '启动后在后台预热模型，避免第一条记忆处理时卡住。'
    ),
    timeout: Schema.natural().default(120).description(
      '单次嵌入调用的超时（秒）。CPU 上第一次跑会慢，别设太小。'
    ),
    debug: Schema.boolean().default(false).description('打印每次嵌入的调试日志'),
  }),
  Schema.object({
    models: Schema.array(
      Schema.object({
        name: Schema.string().required().description(
          '对外暴露的模型名，`defaultEmbeddings` 里写 `local/<这个名字>`'
        ),
        repo: Schema.string().required().description(
          'HuggingFace 仓库 id（如 Xenova/bge-small-zh-v1.5）'
        ),
        dtype: Schema.union([
          Schema.const('fp32').description('全精度，最准最慢（约 95MB）'),
          Schema.const('fp16').description('半精度'),
          Schema.const('q8').description('8bit 量化（约 23MB，推荐）'),
          Schema.const('int8').description('8bit 量化（另一套权重）'),
          Schema.const('uint8').description('无符号 8bit'),
          Schema.const('q4').description('4bit，最小最快但精度掉得多'),
        ]).default('q8').description('量化精度'),
        pooling: Schema.union([
          Schema.const('cls').description('取 [CLS] 向量（BGE 系列推荐）'),
          Schema.const('mean').description('平均池化'),
        ]).default('cls').description('池化方式'),
        queryPrefix: Schema.string().default('').description(
          '只加在「检索 query」前面的指令前缀，文档不加。BGE 中文系列建议保留默认值。'
        ),
      })
    ).default(DEFAULT_MODELS).description('可用的本地嵌入模型列表'),
  }),
]).i18n({
  'zh-CN': {
    $inner: [
      {},
      {
        $desc: '本地嵌入模型',
        enabled: '是否启用',
        cacheDir: '模型缓存目录',
        allowRemote: '允许联网下载模型',
        device: '推理设备',
        maxBatch: '批大小',
        warmup: '启动预热',
        timeout: '超时（秒）',
        debug: '调试日志',
      },
      {
        $desc: '模型列表',
        models: {
          $desc: '可用的本地嵌入模型',
          name: '模型名',
          repo: 'HuggingFace 仓库',
          dtype: '量化精度',
          pooling: '池化方式',
          queryPrefix: 'query 指令前缀',
        },
      },
    ],
  },
})

// ------------------------------------------------------------------ 工具

function resolveCacheDir(ctx, config) {
  const raw = (config.cacheDir || '').trim()
  if (raw.length > 0) {
    return path.isAbsolute(raw) ? raw : path.resolve(ctx.baseDir, raw)
  }
  // 默认 <仓库根>/models/hf-cache：koishi-app 和 koishi-test 共用同一份
  return path.resolve(ctx.baseDir, '..', 'models', 'hf-cache')
}

/** 余弦相似度，只给 /localemb.test 用 */
function cosine(a, b) {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

// ------------------------------------------------------------------ 运行时

class LocalRuntime {
  constructor(ctx, config, logger) {
    this.ctx = ctx
    this.config = config
    this.logger = logger
    this._tf = null
    this._pipelines = new Map()
    this._modelMap = new Map()
    for (const m of config.models || []) {
      this._modelMap.set(m.name, m)
    }
    this.cacheDir = resolveCacheDir(ctx, config)
  }

  get modelNames() {
    return [...this._modelMap.keys()]
  }

  modelFor(modelName) {
    const m = this._modelMap.get(modelName)
    if (m) return m
    // 兼容直接写 HF 仓库 id 的情况（defaultEmbeddings 里手滑写成 local/Xenova/xxx）
    for (const cand of this._modelMap.values()) {
      if (cand.repo === modelName) return cand
    }
    const first = [...this._modelMap.values()][0]
    if (!first) throw new Error('没有配置任何本地嵌入模型')
    this.logger.warn('模型 %s 不在配置里，退回 %s', modelName, first.name)
    return first
  }

  async transformers() {
    if (!this._tf) {
      this._tf = (async () => {
        // ★ transformers.js 是 ESM，CJS 里只能动态 import
        const mod = await import('@huggingface/transformers')
        const env = mod.env
        env.cacheDir = this.cacheDir
        env.allowLocalModels = true
        env.allowRemoteModels = this.config.allowRemote !== false
        if (!fs.existsSync(this.cacheDir)) {
          fs.mkdirSync(this.cacheDir, { recursive: true })
        }
        this.logger.info(
          'transformers.js %s 就绪（缓存目录 %s，联网下载=%s）',
          env.version || '?',
          this.cacheDir,
          env.allowRemoteModels ? '开' : '关'
        )
        return mod
      })().catch((e) => {
        this._tf = null
        throw e
      })
    }
    return this._tf
  }

  pipelineFor(m) {
    const dtype = m.dtype || 'q8'
    const key = `${m.repo}::${dtype}`
    if (!this._pipelines.has(key)) {
      const p = (async () => {
        const tf = await this.transformers()
        const t0 = Date.now()
        const pipe = await tf.pipeline('feature-extraction', m.repo, {
          dtype,
          device: this.config.device || 'cpu',
        })
        this.logger.info(
          '已加载本地嵌入模型 %s（%s，耗时 %s ms）',
          m.repo,
          dtype,
          Date.now() - t0
        )
        return pipe
      })().catch((e) => {
        this._pipelines.delete(key)
        throw e
      })
      this._pipelines.set(key, p)
    }
    return this._pipelines.get(key)
  }

  /** 预热：把配置里第一个模型先 load 起来 */
  async warmup() {
    const first = [...this._modelMap.values()][0]
    if (!first) return
    await this.pipelineFor(first)
  }

  /**
   * 真正的嵌入。texts 永远是数组，返回 number[][]。
   * isQuery 为 true 时给每条文本加 queryPrefix（BGE 系列的检索指令）。
   */
  async embed(modelName, texts, isQuery) {
    if (!Array.isArray(texts) || texts.length === 0) return []
    const m = this.modelFor(modelName)
    const pipe = await this.pipelineFor(m)
    const prefix = isQuery ? m.queryPrefix || '' : ''
    const input = prefix ? texts.map((t) => prefix + t) : texts
    const t0 = Date.now()
    const out = await pipe(input, {
      pooling: m.pooling || 'cls',
      normalize: true,
    })
    const list = out.tolist()
    if (this.config.debug) {
      this.logger.debug(
        '嵌入 %d 条（%s，%s）耗时 %s ms，维度 %s',
        texts.length,
        m.name,
        isQuery ? 'query' : 'doc',
        Date.now() - t0,
        list[0] ? list[0].length : 0
      )
    }
    return list
  }
}

// ------------------------------------------------------------------ ChatLuna 客户端

class LocalEmbeddingsRequester {
  constructor(runtime) {
    this.runtime = runtime
  }

  /**
   * ChatLuna 的 `ChatLunaEmbeddings._embeddingWithRetry` 就是调这里。
   * params = { model, input, timeout }
   *   - input 是 string  → 来自 embedQuery（检索用的 query）
   *   - input 是 string[] → 来自 embedDocuments（要入库的文档）
   * 返回 number[] 或 number[][]。
   */
  async embeddings(params) {
    const isQuery = typeof params.input === 'string'
    const texts = isQuery ? [params.input] : params.input
    const vectors = await this.runtime.embed(params.model, texts, isQuery)
    return isQuery ? vectors[0] : vectors
  }
}

/**
 * 用**宿主应用那一份** chatluna 的类现场拼出客户端类。
 * 不能在模块顶层 `class X extends PlatformEmbeddingsClient` —— 那样基类会是
 * 源码目录那一份，instanceof 判定全废（见文件头的说明）。
 */
function buildClientClass(ctx) {
  const {
    PlatformEmbeddingsClient,
  } = appRequire(ctx, 'koishi-plugin-chatluna/llm-core/platform/client')
  const {
    ChatLunaEmbeddings,
  } = appRequire(ctx, 'koishi-plugin-chatluna/llm-core/platform/model')
  const { ModelType } = appRequire(
    ctx,
    'koishi-plugin-chatluna/llm-core/platform/types'
  )

  return class LocalEmbeddingsClient extends PlatformEmbeddingsClient {
    constructor(config, plugin, runtime) {
      super(ctx, plugin.platformConfigPool)
      // ★ 字段名必须带下划线：基类 `BasePlatformClient` 上有个 `get config()`
      //   （返回 configPool 里那条平台配置），直接 `this.config = ...` 会报
      //   "Cannot set property config of #<BasePlatformClient> which has only a getter"。
      //   实测踩到：第一次跑机台就在 createClient 里炸了。
      this._config = config
      this._plugin = plugin
      this._runtime = runtime
    }

    platform = PLATFORM

    async getModels() {
      return this.refreshModels()
    }

    async refreshModels() {
      return (this._config.models || []).map((m) => ({
        name: m.name,
        type: ModelType.embeddings,
        // 本地模型没有硬上下文限制，给个宽松值
        maxTokens: 8192,
        capabilities: [],
      }))
    }

    _createModel(model, report) {
      return new ChatLunaEmbeddings({
        usageReporter: report,
        maxConcurrency: 1,
        maxRetries: this._config.maxRetries ?? 0,
        timeout: (this._config.timeout ?? 120) * 1000,
        batchSize: this._config.maxBatch ?? 16,
        model,
        client: new LocalEmbeddingsRequester(this._runtime),
      })
    }
  }
}

// ------------------------------------------------------------------ 入口

function apply(ctx, config) {
  const { createLogger } = appRequire(ctx, 'koishi-plugin-chatluna/utils/logger')
  const logger = createLogger(ctx, 'chatluna-local-embeddings')
  const runtime = new LocalRuntime(ctx, config, logger)

  // ---- 状态 / 自检指令（不依赖 chatluna 是否就绪）
  ctx
    .command('localemb', '查看本地嵌入模型状态')
    .action(async () => {
      const loaded = [...runtime._pipelines.keys()]
      const ready = fs.existsSync(runtime.cacheDir)
      const repos = [...runtime._modelMap.values()].map(
        (m) => `${m.name} ← ${m.repo}（${m.dtype || 'q8'} / ${m.pooling || 'cls'}）`
      )
      return [
        '本地嵌入模型：',
        ...repos.map((r) => `  ${r}`),
        `平台名前缀：${PLATFORM}/`,
        `缓存目录：${runtime.cacheDir}${ready ? '' : '（还不存在）'}`,
        `已加载：${loaded.length > 0 ? loaded.join('、') : '无（第一次用到时才加载）'}`,
      ].join('\n')
    })

  ctx
    .command('localemb.test <text:text>', '本地嵌入模型自检：跑一条文本看看维度与耗时')
    .action(async (_argv, text) => {
      if (!text) return '给点文本，例：/localemb.test 今天天气不错'
      try {
        const t0 = Date.now()
        const v = await runtime.embed(runtime.modelNames[0], [text], true)
        const ms = Date.now() - t0
        const head = v[0].slice(0, 4).map((x) => x.toFixed(4)).join(', ')
        return `维度 ${v[0].length}，耗时 ${ms} ms，前 4 维 [${head}]`
      } catch (e) {
        return `嵌入失败：${e.message}`
      }
    })

  // ---- 注册到 ChatLuna
  if (!config.enabled) {
    logger.info('enabled=false，本地嵌入平台未注册')
    return
  }

  ctx.on('ready', async () => {
    try {
      const { ChatLunaPlugin } = appRequire(
        ctx,
        'koishi-plugin-chatluna/services/chat'
      )
      const LocalEmbeddingsClient = buildClientClass(ctx)
      const plugin = new ChatLunaPlugin(ctx, config, PLATFORM)
      plugin.parseConfig(() => [
        {
          platform: PLATFORM,
          apiKey: 'local',
          chatLimit: config.chatTimeLimit,
          timeout: config.timeout,
          maxRetries: config.maxRetries,
          concurrentMaxSize: config.chatConcurrentMaxSize,
        },
      ])
      plugin.registerClient(
        () => new LocalEmbeddingsClient(config, plugin, runtime)
      )
      await plugin.initClient()
      logger.info(
        '本地嵌入平台已注册：%s（%d 个模型）',
        PLATFORM,
        runtime.modelNames.length
      )
      if (config.warmup) {
        runtime
          .warmup()
          .then(() => logger.info('模型预热完成'))
          .catch((e) => logger.warn('模型预热失败：%s', e.message))
      }
    } catch (e) {
      logger.error('注册本地嵌入平台失败：%s', e && e.stack ? e.stack : e)
    }
  })

  // 顺手把相似度计算暴露出去，给自检脚本用
  ctx.on('dispose', () => {
    runtime._pipelines.clear()
  })

  return { runtime, cosine }
}

module.exports = { name, inject, Config, apply, PLATFORM }
