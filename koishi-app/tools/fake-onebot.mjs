/**
 * 伪 OneBot v11 服务端 —— 自动化测试台的核心。
 *
 * 用途：让一个 Koishi 实例（正向 WS 模式）连上来，然后按剧本喂事件、收集它的回复。
 * 这样就不需要真人拿手机发消息，而且时序可以精确控制（"@bot 之后 1.5 秒发图"这种）。
 *
 * 用法：
 *   cd D:\deepseek\QQbot\koishi-app
 *   node tools\fake-onebot.mjs [剧本.json] [--port 3002] [--settle 4000]
 *
 * 剧本格式（见 tools\scenarios\*.json）：
 *   {
 *     "selfId": "2178517838",
 *     "nickname": "大肥鱼",
 *     "steps": [
 *       { "wait": 2000, "group": "454444539", "user": "2791932480", "name": "测试员",
 *         "elements": [["at","2178517838"],["text"," "]] },
 *       { "wait": 1500, "group": "454444539", "user": "2791932480",
 *         "elements": [["text","吃了吗"]] },
 *       { "wait": 1000, "group": "454444539", "user": "2791932480",
 *         "elements": [["image","http://127.0.0.1:5141/chatluna-storage/temp/x.jpg"]] },
 *       { "wait": 5000, "group": "454444539", "user": "2791932480",
 *         "elements": [["reply","$bot"]] }        // $bot = 回复 bot 发的最后一条
 *     ]
 *   }
 *
 * elements 支持：[type, value] 或 [type, value, extra]
 *   at / text / image / reply / face / forward
 *
 * 注意：这个脚本只负责"喂"和"看"。它不判断对错，判断交给你（或我）读日志。
 */

import { readFileSync, existsSync, createReadStream, createWriteStream, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'

// ------------------------------------------------------------------ 参数

const argv = process.argv.slice(2)
const scenarioPath = argv.find((a) => !a.startsWith('--'))
const getArg = (name, dflt) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] != null ? argv[i + 1] : dflt
}
const PORT = +getArg('port', 3002)
// 图片服务器：ChatLuna 的静态路由只服务登记进它自己库里的文件，
// 所以测试用的图我们自己发，别去蹭它的 /chatluna-storage/
const IMG_PORT = +getArg('imgPort', 3003)
const IMG_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'test-images')
// 客户端连上后先等一会再开演，给 Koishi 把插件加载完的时间
const SETTLE = +getArg('settle', 5000)

const scenario = scenarioPath
  ? JSON.parse(readFileSync(scenarioPath, 'utf8'))
  : {
      selfId: '2178517838',
      nickname: '大肥鱼',
      steps: [
        {
          wait: 0,
          group: '454444539',
          user: '2791932480',
          name: '测试员',
          elements: [['at', '2178517838'], ['text', ' ']],
        },
        {
          wait: 1500,
          group: '454444539',
          user: '2791932480',
          name: '测试员',
          elements: [['text', '吃了吗']],
        },
      ],
    }

const SELF_ID = String(scenario.selfId ?? '2178517838')
const NICKNAME = scenario.nickname ?? '大肥鱼'

// ------------------------------------------------------------------ 输出

const t0 = Date.now()
const el = () => String(Date.now() - t0).padStart(6) + 'ms'

// --log <文件>：把整个剧本回放写成文件，方便回看（终端里多行正文容易看漏）
const LOG_FILE = getArg('log', null)
let logStream = null
if (LOG_FILE) {
  logStream = createWriteStream(LOG_FILE, { flags: 'w' })
}

function say(...a) {
  const line = `[${el()}] ${a.join(' ')}`
  console.log(line)
  logStream?.write(line + '\n')
}

// ------------------------------------------------------------------ 状态

let ws = null
let messageSeq = 100000
/** message_id -> { group_id, user_id, name, segments } —— 供 get_msg（引用）用 */
const inbound = new Map()
let lastBotMessageId = null

function nextId() {
  return ++messageSeq
}

/** 剧本里的 elements → OneBot 的 message 段数组 + raw_message */
function buildMessage(elements) {
  const segs = []
  const raw = []
  for (const [type, value, extra] of elements) {
    if (type === 'at') {
      segs.push({ type: 'at', data: { qq: String(value) } })
      raw.push(`[CQ:at,qq=${value}]`)
    } else if (type === 'text') {
      segs.push({ type: 'text', data: { text: String(value) } })
      raw.push(String(value))
    } else if (type === 'image') {
      const file = String(value).split('/').pop() || 'image.jpg'
      segs.push({
        type: 'image',
        data: { summary: '[图片]', file, sub_type: 0, url: String(value), file_size: '0' },
      })
      raw.push(`[CQ:image,file=${file},url=${value}]`)
    } else if (type === 'reply') {
      const id = value === '$bot' ? lastBotMessageId : value
      segs.push({ type: 'reply', data: { id: String(id) } })
      raw.push(`[CQ:reply,id=${id}]`)
    } else if (type === 'face') {
      segs.push({ type: 'face', data: { id: String(value), name: extra ?? '' } })
      raw.push(`[CQ:face,id=${value}]`)
    } else {
      throw new Error('不认识的元素类型：' + type)
    }
  }
  return { segs, raw: raw.join('') }
}

// ------------------------------------------------------------------ API

const apiLog = []

function reply(echo, data) {
  ws?.send(JSON.stringify({ status: 'ok', retcode: 0, data: data ?? {}, echo }))
}

function handleApi(msg) {
  const { action, params = {}, echo } = msg
  apiLog.push({ action, params })

  switch (action) {
    case 'get_login_info':
      return reply(echo, { user_id: +SELF_ID, nickname: NICKNAME })

    case 'get_version_info':
      return reply(echo, {
        app_name: 'fake-onebot',
        app_version: '0.1.0',
        protocol_version: 'v11',
      })

    case 'get_msg': {
      const id = String(params.message_id)
      const m = inbound.get(id)
      if (!m) {
        ws?.send(
          JSON.stringify({
            status: 'failed',
            retcode: 100,
            data: null,
            wording: '消息不存在',
            echo,
          })
        )
        return
      }
      return reply(echo, {
        message_id: +id,
        real_id: +id,
        message_type: m.group_id ? 'group' : 'private',
        group_id: m.group_id ? +m.group_id : undefined,
        user_id: +m.user,
        time: Math.floor(Date.now() / 1000),
        sender: { user_id: +m.user, nickname: m.name, card: '' },
        message: m.segs,
        raw_message: m.raw,
      })
    }

    case 'send_group_msg':
    case 'send_private_msg': {
      const id = nextId()
      lastBotMessageId = id
      const text = (params.message || [])
        .map((s) => (s.type === 'text' ? s.data.text : `[${s.type}]`))
        .join('')
      const where = action === 'send_group_msg' ? `群${params.group_id}` : `私聊${params.user_id}`
      say(`📤 BOT → ${where}  #${id}`)
      for (const line of String(text).split('\n')) say(`        ${line}`)
      return reply(echo, { message_id: id })
    }

    default:
      return reply(echo, {})
  }
}

// ------------------------------------------------------------------ 开演

async function runScenario() {
  say(`剧本开始（${scenario.steps.length} 步）`)
  for (const [i, step] of scenario.steps.entries()) {
    if (step.wait) await new Promise((r) => setTimeout(r, step.wait))
    if (!ws) {
      say('连接断了，剧本中止')
      return
    }

    const { segs, raw } = buildMessage(step.elements)
    const id = nextId()
    const isGroup = step.group != null
    inbound.set(String(id), {
      group_id: step.group,
      user: String(step.user),
      name: step.name ?? '测试员',
      segs,
      raw,
    })

    const event = {
      post_type: 'message',
      message_type: isGroup ? 'group' : 'private',
      sub_type: isGroup ? 'normal' : 'friend',
      message_id: id,
      real_id: id,
      self_id: +SELF_ID,
      time: Math.floor(Date.now() / 1000),
      user_id: +step.user,
      sender: { user_id: +step.user, nickname: step.name ?? '测试员', card: '', role: 'member' },
      message: segs,
      raw_message: raw,
      font: 14,
      message_format: 'array',
    }
    if (isGroup) {
      event.group_id = +step.group
      event.group_name = step.groupName ?? 'My Test'
    } else {
      event.target_id = +step.user
    }

    say(`📥 第${i + 1}步 → ${isGroup ? `群${step.group}` : `私聊${step.user}`}  #${id}`)
    say(`        ${raw}`)
    ws.send(JSON.stringify(event))
  }
  say('剧本投递完毕，等 bot 反应…')
}

// ------------------------------------------------------------------ 图片服务器

const MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

function startImageServer() {
  if (!existsSync(IMG_DIR)) return
  const server = createServer((req, res) => {
    const name = normalize(decodeURIComponent((req.url || '/').split('?')[0])).replace(
      /^[\\/]+/,
      ''
    )
    const file = join(IMG_DIR, name)
    if (!file.startsWith(IMG_DIR) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404)
      res.end('not found')
      say(`🖼  404 ${name}`)
      return
    }
    const size = statSync(file).size
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': size,
    })
    createReadStream(file).pipe(res)
    say(`🖼  送出 ${name}（${size} 字节）`)
  })
  server.listen(IMG_PORT, '127.0.0.1', () => {
    say(`图片服务器 http://127.0.0.1:${IMG_PORT}/  ← ${IMG_DIR}`)
  })
  return server
}

// ------------------------------------------------------------------ 服务

startImageServer()

const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT })

wss.on('connection', (socket, req) => {
  ws = socket
  say(`Koishi 已连上（${req.socket.remoteAddress}）`)

  socket.on('message', (buf) => {
    let msg
    try {
      msg = JSON.parse(buf.toString())
    } catch {
      return
    }
    if (msg.action) handleApi(msg)
  })

  socket.on('close', () => {
    say('连接断开')
    if (ws === socket) ws = null
  })

  setTimeout(() => {
    if (ws === socket) runScenario().catch((e) => say('剧本出错：' + e.message))
  }, SETTLE)
})

wss.on('listening', () => {
  say(`伪 OneBot 服务端监听 ws://127.0.0.1:${PORT}`)
  say('等 Koishi 连上来（记得把测试实例的 adapter endpoint 指过来）')
})

process.on('SIGINT', () => {
  say('收到中断，退出')
  process.exit(0)
})

export { existsSync }
