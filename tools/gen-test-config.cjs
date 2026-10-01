// 生成测试实例的 koishi.yml（从生产配置里抄 API Key，避免手抄）
const fs = require('node:fs')
const path = require('node:path')

const APP = 'D:/deepseek/QQbot/koishi-app'
const TEST = 'D:/deepseek/QQbot/koishi-test'

const prod = fs.readFileSync(path.join(APP, 'koishi.yml'), 'utf8')

// 抓 chatluna-deepseek-adapter 的 apiKeys 整段（缩进对齐的那种）
const m = prod.match(/ {2}chatluna-deepseek-adapter:[^\n]*\n([\s\S]*?)(?=\n {2}\S)/)
if (!m) throw new Error('没能从生产配置里抓到 deepseek adapter 段')
const adapterBlock = m[1].replace(/\s+$/, '')
console.log('抓到 adapter 配置：')
console.log(adapterBlock)

// R9 主动发言：**不再从生产配置抄**（自写插件的提示词是 schema 默认值，配置里只有数字），
// 测试台要把阈值调低、冷却归零、空闲压到 1 分钟，好在一两分钟内复现"没人叫它，它自己开口"。
// ★ 提示词想验证生产版本的话，把 koishi-app\koishi.yml 里 chatluna-proactive 的
//   activityPrompt / idlePrompt 抄过来即可（默认值就在插件源码里，两边一字不差）。
const proactiveBlock = [
  '    enabled: true',
  '    debug: true',
  '    pollSeconds: 3',
  '    cooldownSeconds: 0',
  '    failureCooldownSeconds: 30',
  '    historyLimit: 20',
  '    maxImages: 3',
  '    groups:',
  "      - guildId: '454444539'",
  '        enableActivity: true',
  '        activityThreshold: 0.05',
  '        thresholdCeiling: 0.05',
  '        activityMessageInterval: 5',
  '        enableIdle: true',
  '        idleMinutes: 1',
  '        idleJitter: false',
].join('\n')

const yml = `# 测试实例：只连伪 OneBot（tools/fake-onebot.mjs），不碰真 QQ。
# 生产实例在 koishi-app/，端口 5140；这个跑 5141。
prefix:
  - /
  - .
prefixMode: strict
nickname:
  - 大肥鱼
  - 星源
plugins:
  http:aa0001: {}
  server:aa0002:
    host: 127.0.0.1
    port: 5141
  database-sqlite:aa0003:
    path: data/test.db
  commands:aa0004: {}
  chatluna:aa0005:
    botNames:
      - 大肥鱼
      - 星源
    defaultPreset: 星源
    defaultModel: deepseek/deepseek/deepseek-v4-flash-vision-exp
    autoUpdateConversationModel: true
    messageQueue: true
    messageQueueDelay: 3
    allowQuoteReply: true
    autoArchive: true
    autoArchiveTimeout: 3600
    defaultEmbeddings: local/bge-small-zh-v1.5
    defaultVectorStore: luna-vdb
  chatluna-vector-store-service:aa0020:
    vectorStore:
      - luna-vdb
  chatluna-local-embeddings:aa0021:
    enabled: true
    device: cpu
    warmup: true
    debug: true
  chatluna-storage-service:aa0006:
    storageBackend: local
    serverPath: http://127.0.0.1:5141
    storagePath: ./data/chatluna-storage
    backendPath: /chatluna-storage
  chatluna-deepseek-adapter:aa0007:
${adapterBlock}
  chatluna-emotion:aa0008:
    halfLife: 60
    expireMinutes: 0.1
    sweepSeconds: 2
    debug: true
  chatluna-vision:aa0009:
    debug: true
  chatluna-followup:aa0010:
    debug: true
    windowSeconds: 120
    maxSeconds: 600
    maxConsecutive: 20
    groupMaxPerWindow: 1
    groupWindowSeconds: 600
    groups:
      - guildId: '454444539'
        enabled: true
        windowSeconds: 45
        maxSeconds: 90
        maxConsecutive: 1
      - guildId: '999000111'
        enabled: false
  chatluna-proactive:aa0016:
${proactiveBlock}
  chatluna-long-memory:aa0013:
    enabledLayers:
      - Guild
      - User
    layerEngines:
      - layer: Guild
        engine: HippoRAG
      - layer: User
        engine: HippoRAG
    longMemoryExtractModel: deepseek/deepseek/deepseek-v4.1-flash-fast
    longMemoryExtractInterval: 3
    longMemoryQueryRewrite: false
    hippoExtractModel: deepseek/deepseek/deepseek-v4.1-flash-fast
    hippoKGPersist: true
    hippoSimilarityThreshold: 0.35
  chatluna-sticker:aa0014:
    storageDir: data/sticker-library
    judgeThreshold: 1
    judgeModel: deepseek/deepseek/deepseek-v4-flash-vision-exp
    phashThreshold: 5
    maxSendableImages: 2000
    occurrenceTtlDays: 10
    judgeTimeoutMinutes: 10
  chatluna-scene:aa0017:
    enabled: true
    variableName: scene
    scopeMode: channel
    endMode: clear
    abortIdleMinutes: 1
    maxMinutes: 60
    notifyOnAbort: false
    enableTool: true
    debug: true
  chatluna-selfext:aa0018:
    enabled: true
    cacheMinutes: 30
    maxResults: 8
    ownerIds:
      - '2791932480'
    allowInstall: true
    persistConfig: true
    npmProxy: http://127.0.0.1:7890
    debug: true
  chatluna-guard:aa0019:
    enabled: true
    defaultPolicy: silent
    allowGroups: []
    muteGroups: []
    applyToPrivate: false
    controlAuthority: 3
    bareKeywords: true
    confirmSeconds: 0
    refreshSeconds: 5
    debug: true
  chatluna-affinity:aa0015:
    scopeId: xingyuan
    botSelfIds:
      - '2178517838'
    variableSettings:
      affinityVariableName: affinity
    nativeToolSettings:
      enabledNativeTools:
        - affinity
        - userAlias
    xmlToolSettings:
      enableAffinityXmlToolCall: false
      enableBlacklistXmlToolCall: false
      enableRelationshipXmlToolCall: false
      enableUserAliasXmlToolCall: false
    debugLogging: true
  qqbot-auth:aa0012:
    ownerIds:
      - '2791932480'
    adminIds:
      - '10002'
    blockedIds:
      - '10004'
    debug: true
    affinityScopeId: xingyuan
    affinityPromoteAt: 51
    affinityDemoteAt: 40
  adapter-onebot:aa0011:
    protocol: ws
    endpoint: ws://127.0.0.1:3002
    token: ''
    selfId: '2178517838'
`

fs.writeFileSync(path.join(TEST, 'koishi.yml'), yml, 'utf8')
console.log('\n已写出 ' + path.join(TEST, 'koishi.yml'))

const pkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'))
pkg.name = 'qqbot-koishi-test'
pkg.description = '测试实例（伪 OneBot）'

// ★ 自研插件的依赖路径必须从 koishi-test 出发指回 koishi-app，
//   因为生产配置里写的是 `file:external/...`，那是相对 koishi-app 的。
//   照抄会得到 koishi-test\external\... 这个不存在的路径 → junction 是坏的。
//   指向真实源码还有个好处：改插件代码两边同时生效（测试实例是 junction，不是拷贝）。
const LOCAL_PLUGINS = [
  'koishi-plugin-chatluna-emotion',
  'koishi-plugin-chatluna-followup',
  'koishi-plugin-chatluna-guard',
  'koishi-plugin-chatluna-local-embeddings',
  'koishi-plugin-chatluna-proactive',
  'koishi-plugin-chatluna-scene',
  'koishi-plugin-chatluna-selfext',
  'koishi-plugin-chatluna-vision',
  'koishi-plugin-qqbot-auth',
]
for (const name of LOCAL_PLUGINS) {
  pkg.dependencies[name] = `file:../koishi-app/external/${name}`
}
fs.writeFileSync(
  path.join(TEST, 'package.json'),
  JSON.stringify(pkg, null, 2) + '\n',
  'utf8'
)
console.log('已写出 package.json')

// ★ 预设也要同步：测试实例读的是自己的 koishi-test/data/chathub/presets/，
//   不同步的话改了生产的预设（比如加 {long_memory()}）测试实例根本不知道。
const presetSrc = path.join(APP, 'data', 'chathub', 'presets')
const presetDst = path.join(TEST, 'data', 'chathub', 'presets')
fs.mkdirSync(presetDst, { recursive: true })
const synced = []
for (const name of fs.readdirSync(presetSrc)) {
  if (!name.endsWith('.yml')) continue
  fs.copyFileSync(path.join(presetSrc, name), path.join(presetDst, name))
  synced.push(name)
}
console.log('已同步预设：' + synced.join(', '))

