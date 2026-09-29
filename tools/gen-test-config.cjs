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
  chatluna-storage-service:aa0006:
    storageBackend: local
    serverPath: http://127.0.0.1:5141
    storagePath: ./data/chatluna-storage
    backendPath: /chatluna-storage
  chatluna-deepseek-adapter:aa0007:
${adapterBlock}
  chatluna-emotion:aa0008: {}
  chatluna-vision:aa0009:
    debug: true
  chatluna-followup:aa0010:
    debug: true
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
fs.writeFileSync(
  path.join(TEST, 'package.json'),
  JSON.stringify(pkg, null, 2) + '\n',
  'utf8'
)
console.log('已写出 package.json')
