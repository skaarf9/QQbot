/**
 * 伪 OpenAI 兼容上游 —— 用来确定性地验证「模型兜底队列」。
 *
 * 用途：真上游什么时候 403 由别人说了算，没法拿来当测试。这个假上游可以**按模型名**
 * 决定返回什么，于是"首选挂了会不会自动切下一个"变成可复现的实验。
 *
 * 用法：
 *   node tools\fake-openai.mjs [--port 3005] [--fail-first 1] [--log 文件]
 *
 * 支持的"模型"（名字故意叫得一眼能认出来）：
 *   fake-broken    恒 403（模拟额度/权限被拒）
 *   fake-broken500 恒 500（模拟上游炸了：说明不只是 403 才切）
 *   fake-flaky     前 --fail-first 次 403，之后 200（模拟"限额恢复"→ 验证冷却结束会回切）
 *   fake-ok       恒 200，正文 FAKE_OK_A
 *   fake-ok2      恒 200，正文 FAKE_OK_B
 *   fake-emoji    恒 200，正文 FAKE_EMOJI_TEXT（带 😏 的固定串，验出站替换层用）
 *   其它名字       404（模拟模型不存在）
 *
 * 记什么：每个请求打一行 `[upstream] #序号 model=xxx -> 403/200`，
 * 这就是"有没有真的去请求首选"的直接证据 —— 冷却生效时第二轮不该再出现 fake-broken。
 *
 * 注意：它只实现 ChatLuna 真正会用到的两个端点：
 *   GET  /v1/models            （拉模型列表；本方案里配 pullModels:false，通常不会调）
 *   POST /v1/chat/completions  （stream:true 走 SSE，false 走整包 JSON）
 */

import { createServer } from 'node:http'
import { createWriteStream } from 'node:fs'

const argv = process.argv.slice(2)
const getArg = (name, dflt) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] != null ? argv[i + 1] : dflt
}
const PORT = +getArg('port', 3005)
const FAIL_FIRST = +getArg('fail-first', 1)
const LOG_FILE = getArg('log', null)

let logStream = null
if (LOG_FILE) logStream = createWriteStream(LOG_FILE, { flags: 'w' })

const t0 = Date.now()
function say(...a) {
  const line = `[${String(Date.now() - t0).padStart(6)}ms] ${a.join(' ')}`
  console.log(line)
  logStream?.write(line + '\n')
}

let seq = 0
const hits = new Map() // model -> 次数
function countHit(model) {
  const n = (hits.get(model) ?? 0) + 1
  hits.set(model, n)
  return n
}

/**
 * ★ `fake-emoji` 的固定正文。给「出站替换层」（chatluna-replacer）做**确定性**验证用：
 *   真模型什么时候吐 😏 由它自己决定，没法当断言依据；这个假上游想吐就吐。
 *
 *   为什么要 mojibake 之外的讲究 —— 这段串是精心挑的：
 *     · 含单个 😏（规则 😏→嘿嘿 要命中）
 *     · 含连着两个 😏😏（验"最长匹配"：😏😏→哈哈 要压过 😏→嘿嘿）
 *     · **整行、很短**（< 180 字 / < 6 行），否则会被 chatluna-page 转成图片，
 *       就看不到文本了，断言也就无从谈起
 *     · 代码单元长度使得 8 字符分片**不会切开代理对**（😏 占 2 个单元，
 *       按 .{1,8} 切刚好落在边界内），别随手改串长
 */
const FAKE_EMOJI_TEXT = '心情不错😏 好耶😏😏'

/**
 * ★ `fake-emoji` 的**长**正文（≥180 字 / ≥6 行）。
 *
 * 专门用来验「出站替换层必须排在 chatluna-page 前面」这一条：
 *   · page 会把长回复（≥180 字符或 ≥6 行、仅群聊）转成**图片**；
 *   · 如果替换层排在 page 之后，它看到的就只剩一个 image 元素，改不动 😏；
 *   · 所以判据是「**既要**有替换层的出站替换日志，**又要**落成 [image]」——
 *     两者同时成立，才证明顺序是「先换字、后出图」。
 *
 * 触发方式：请求里带上 `ZZLONG`（见 decide 里的判定）。
 * 用 ASCII 记号而不是中文关键词，是因为提示词里本来就满是中文词
 * （"长期记忆""长回复""行长"…），拿中文当开关会误触发。
 */
const FAKE_EMOJI_LONG = [
  '这是一段故意写长的回复，用来验证「出站替换层」排在 chatluna-page 前面。',
  '因为 page 会把长回复（≥180 字或 ≥6 行）转成图片，一旦先出了图，替换层就改不动了。',
  '第一处记号在这里😏，第二处😏😏，第三处还是😏。',
  '把这三处换成「嘿嘿」「哈哈」「嘿嘿」之后，这段文字的字符数会略少一点。',
  '如果替换层排在 page 后面，日志里就不会出现这条长文本的「出站替换」记录。',
  '所以判据是：本条既要出现「出站替换」，又要在 fake-onebot 那边落成 [image]。',
  '两件事同时成立，才能证明「先换字、后出图」这个顺序是对的。',
  '（最后一行凑数，保证行数 ≥6、字符数 ≥180。）',
].join('\n')

/** 这个模型这次该返回什么。`data` 是请求体（只有 fake-emoji 用得上） */
function decide(model, data) {
  const n = countHit(model)
  switch (model) {
    case 'fake-broken':
      return { status: 403, body: { error: { message: 'fake upstream: 403 额度/权限被拒', type: 'permission_denied', code: 'insufficient_quota' } } }
    case 'fake-broken500':
      return { status: 500, body: { error: { message: 'fake upstream: 500 上游炸了', type: 'server_error' } } }
    case 'fake-flaky':
      return n <= FAIL_FIRST
        ? { status: 403, body: { error: { message: `fake upstream: 第 ${n} 次仍 403（阈值 ${FAIL_FIRST}）`, type: 'permission_denied' } } }
        : { status: 200, text: `FAKE_OK_FLAKY_${n}` }
    case 'fake-ok':
      return { status: 200, text: `FAKE_OK_A_${n}` }
    case 'fake-ok2':
      return { status: 200, text: `FAKE_OK_B_${n}` }
    case 'fake-emoji': {
      // 请求里带 ZZLONG 就吐长正文（验"替换层排在 page 前面"），否则吐短正文。
      //
      // ★ 只看**本轮这一条**（messages 的最后一条），不看整段历史 —— 因为对话历史是
      //   **落库的**：上一轮跑完 ZZLONG 就留在 chatluna_message / chatluna_episode 里了，
      //   扫整个 messages 的话，从那一轮之后的**每一次**回复都变成"长正文"，
      //   短回复那几条判据全部失效（rig 63 第三轮就是这么假失败的）。
      //   只看最后一条 = 与本进程之外的任何历史状态**无关**，剧本可重复跑。
      const msgs = Array.isArray(data?.messages) ? data.messages : []
      const last = msgs.length ? JSON.stringify(msgs[msgs.length - 1]) : ''
      return { status: 200, text: last.includes('ZZLONG') ? FAKE_EMOJI_LONG : FAKE_EMOJI_TEXT }
    }
    default:
      return { status: 404, body: { error: { message: `fake upstream: 没有这个模型 ${model}`, type: 'invalid_request_error', code: 'model_not_found' } } }
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = ''
    req.on('data', (d) => (buf += d.toString()))
    req.on('end', () => resolve(buf))
  })
}

function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

/** 按 OpenAI 的格式吐一段流 */
async function streamReply(res, model, text) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  const id = 'chatcmpl-fake-' + seq
  const created = Math.floor(Date.now() / 1000)
  const chunk = (delta, finish = null) =>
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`

  res.write(chunk({ role: 'assistant', content: '' }))
  // 分成几片吐，顺带验证流式拼接（兜底切换后分片也要正常）
  // ★ `u` 旗标不能省：`.{1,8}` 按**码元**切，会把 😏 这类代理对从中间劈开。
  //   虽然拼回来通常无损，但吐出去的是半个代理对（非法 UTF-16），
  //   下游任何一次序列化/日志都可能把它变成乱码，测出来的是假故障。
  const pieces = text.match(/.{1,8}/gu) ?? [text]
  for (const p of pieces) {
    await new Promise((r) => setTimeout(r, 20))
    res.write(chunk({ content: p }))
  }
  res.write(chunk({}, 'stop'))
  res.write(
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    })}\n\n`
  )
  res.write('data: [DONE]\n\n')
  res.end()
}

const server = createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0]

  if (req.method === 'GET' && url.endsWith('/models')) {
    say(`[upstream] GET ${url} → 模型清单`)
    return json(res, 200, {
      object: 'list',
      data: ['fake-broken', 'fake-broken500', 'fake-flaky', 'fake-ok', 'fake-ok2', 'fake-emoji'].map((id) => ({
        id,
        object: 'model',
        owned_by: 'fake',
      })),
    })
  }

  if (req.method === 'POST' && url.endsWith('/chat/completions')) {
    const raw = await readBody(req)
    let data = {}
    try {
      data = JSON.parse(raw)
    } catch {}
    const model = String(data.model ?? '')
    const stream = data.stream !== false
    const n = ++seq
    const verdict = decide(model, data)

    if (verdict.status !== 200) {
      say(`[upstream] #${n} model=${model} stream=${stream} → ${verdict.status} ← ${verdict.body.error.message}`)
      return json(res, verdict.status, verdict.body)
    }

    say(`[upstream] #${n} model=${model} stream=${stream} → 200 "${verdict.text}"`)
    if (!stream) {
      return json(res, 200, {
        id: 'chatcmpl-fake-' + n,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: verdict.text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      })
    }
    return streamReply(res, model, verdict.text)
  }

  say(`[upstream] ${req.method} ${url} → 404（这个假上游只认 /v1/models 和 /v1/chat/completions）`)
  json(res, 404, { error: { message: 'not found' } })
})

server.listen(PORT, '127.0.0.1', () => {
  say(`伪 OpenAI 上游监听 http://127.0.0.1:${PORT}/v1  （fake-flaky 阈值 ${FAIL_FIRST}）`)
  say('把 ChatLuna 的某个平台 apiEndpoint 指到 http://127.0.0.1:' + PORT + '/v1 即可')
})

process.on('SIGINT', () => {
  say('收到中断，退出')
  process.exit(0)
})
