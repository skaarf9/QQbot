#!/usr/bin/env node
/**
 * websearch-server.cjs — 联网搜索 + 网页浏览 MCP 服务器（stdio JSON-RPC 2.0）
 *
 * 给 ChatLuna 的 koishi-plugin-chatluna-mcp-client 使用。
 * 依赖：@modelcontextprotocol/sdk（已存在于 koishi-app/node_modules，v1.29.0）
 *      zod（同上，是 mcp-client 的依赖）
 * 不新增任何 npm 依赖。
 *
 * 设计要点：
 *   - 搜索默认 Bing 的 RSS 形式（结构化、体积小、无需解析脏 HTML），Google/DDG 为可选备选。
 *   - 抓网页一律"先简化再喂模型"：剥标签 → 抽正文块 → 解实体 → 折空白 → 截断。
 *   - 所有网络调用都有超时；任何失败都返回可读文本（isError:true），不抛栈给模型。
 *
 * 日志一律走 stderr —— stdout 只允许出现协议帧。
 */

'use strict'

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const { z } = require('zod')

// ---------------------------------------------------------------------------
// 常量 / 配置
// ---------------------------------------------------------------------------

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const ENGINE_LABELS = { bing: 'Bing', google: 'Google', duckduckgo: 'DuckDuckGo' }

const SEARCH_TIMEOUT_MS = 10000
const FETCH_TIMEOUT_MS = 12000
const MAX_HTML_BYTES = 3 * 1024 * 1024

const DEFAULT_TOP = 5
const MAX_TOP = 10
const DEFAULT_SNIPPET = 240
const DEFAULT_MAX_CHARS = 4000
const MAX_CHARS_LIMIT = 20000

/**
 * 代理策略：
 *   默认（不传 proxy）→ 沿用进程环境里的 HTTP_PROXY / HTTPS_PROXY / ALL_PROXY，
 *                        Node 内置 fetch（undici）的 EnvHttpProxyAgent 会自动读取。
 *   传 "off"          → 临时清空这几个变量，强制直连。
 *   传 "http://..."   → 临时把这几个变量改成该地址。
 *
 * 重要坑：MCP SDK 的 stdio 客户端在 Windows 上只继承白名单环境变量
 * （APPDATA/HOMEDRIVE/HOMEPATH/LOCALAPPDATA/PATH/PROCESSOR_ARCHITECTURE/
 *   SYSTEMDRIVE/SYSTEMROOT/TEMP/USERNAME/USERPROFILE/PROGRAMFILES），
 * **不含** HTTP_PROXY/HTTPS_PROXY/ALL_PROXY。所以必须在 mcp-client 的 servers JSON
 * 里用 env 显式传代理，否则子进程里根本没有代理变量。
 */
function systemProxy() {
  try {
    const cfg = require('koishi').Context?.current?.config
    if (!cfg || cfg.proxyMode !== 'system') return ''
    const addr = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY
    return typeof addr === 'string' && /^https?:\/\//i.test(addr) ? addr.replace(/\/+$/, '') : ''
  } catch {
    return ''
  }
}

/** 当前环境里生效的代理地址（仅用于日志/自检展示）。 */
function activeProxy() {
  const env =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy
  if (typeof env === 'string' && env.trim()) return env.trim().replace(/\/+$/, '')
  return systemProxy()
}

/**
 * 把工具参数 proxy 翻译成给 httpGet 用的代理模式。
 *
 *   ''/'inherit'/undefined      → 'inherit'：沿用环境里的 HTTP(S)_PROXY
 *   'off'/'none'/'direct'/'false' → 'off'：临时清空代理变量，强制直连
 *   'http://host:port'          → 就是它本身：临时把代理变量改成这个地址
 */
function proxyMode(arg) {
  if (typeof arg === 'string') {
    const s = arg.trim()
    if (/^(off|none|direct|false)$/i.test(s)) return 'off'
    if (/^https?:\/\//i.test(s)) return s.replace(/\/+$/, '')
    if (/^(inherit|default|env|system)$/i.test(s)) return 'inherit'
  }
  return 'inherit'
}

function log(...args) {
  try {
    process.stderr.write(`[websearch] ${args.map(String).join(' ')}\n`)
  } catch {
    /* ignore */
  }
}

function clampInt(v, min, max, dflt) {
  const n = typeof v === 'number' ? v : Number.parseInt(v, 10)
  if (!Number.isFinite(n)) return dflt
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

// ---------------------------------------------------------------------------
// HTTP 抓取
// ---------------------------------------------------------------------------

function fmtBytes(n) {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / 1024 / 1024).toFixed(2)}MB`
}

/**
 * Node 内置 fetch（undici）**已经自动解压** Content-Encoding，所以这里只在"字节流
 * 真的是 gzip"（魔数 1f 8b）时才兜底解一次；解不开就原样返回，绝不因为解压失败丢掉
 * 正文。按响应头判断是错的：正文早已被 undici 解压过，再解一次会报
 * "incorrect header check"。
 */
function decompressBuffer(buf) {
  if (!buf || buf.length < 2) return buf
  if (buf[0] !== 0x1f || buf[1] !== 0x8b) return buf // 不是 gzip 魔数 → 视为已解压
  try {
    const zlib = require('zlib')
    return zlib.gunzipSync(buf)
  } catch {
    return buf // 魔数像 gzip 但解不开（缓存/代理污染）：保留原始字节
  }
}

const PROXY_ENV_KEYS = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']

/** 临时改写/清空代理环境变量执行 fn，结束后一定恢复原样。 */
async function withProxyEnv(proxy, fn) {
  if (proxy === 'inherit') return await fn()
  const saved = new Map()
  for (const k of PROXY_ENV_KEYS) {
    saved.set(k, process.env[k])
    delete process.env[k]
  }
  if (proxy !== 'off') {
    process.env.HTTP_PROXY = proxy
    process.env.HTTPS_PROXY = proxy
    process.env.ALL_PROXY = proxy
  }
  try {
    return await fn()
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

/** 根据 Content-Type / <meta charset> 猜字符集，返回 TextDecoder。 */
function pickCharset(contentType, peek) {
  let cs = ''
  const m1 = /charset\s*=\s*["']?\s*([\w-]+)/i.exec(contentType || '')
  if (m1) cs = m1[1]
  if (!cs && peek) {
    const m2 = /<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i.exec(peek)
    if (m2) cs = m2[1]
  }
  cs = (cs || 'utf-8').toLowerCase()
  if (cs === 'gb2312' || cs === 'gbk' || cs === 'gb18030') cs = 'gbk'
  try {
    return new TextDecoder(cs, { fatal: false })
  } catch {
    return new TextDecoder('utf-8', { fatal: false })
  }
}

/**
 * 抓一个 URL，返回 { ok, url, finalUrl, status, contentType, text, bytes, timedOut, error, notes }
 * 绝不抛异常；任何失败都通过 error 字段表达。
 */
async function httpGet(url, opts = {}) {
  const {
    timeoutMs = FETCH_TIMEOUT_MS,
    accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    maxBytes = MAX_HTML_BYTES,
    proxy = 'inherit'
  } = opts

  const out = {
    ok: false,
    url,
    finalUrl: url,
    status: 0,
    contentType: '',
    text: '',
    bytes: 0,
    timedOut: false,
    error: '',
    notes: []
  }

  let target
  try {
    target = new URL(url)
  } catch {
    out.error = `URL 不合法：${url}`
    return out
  }
  if (!/^https?:$/.test(target.protocol)) {
    out.error = `只支持 http/https：${target.protocol}`
    return out
  }

  const signal = AbortSignal.timeout(timeoutMs)
  const headers = {
    'User-Agent': UA,
    Accept: accept,
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate'
  }

  // 代理交给 undici 内置的 EnvHttpProxyAgent（它读 HTTP(S)_PROXY / ALL_PROXY）。
  // Node 22 没有对外导出 undici.ProxyAgent，所以这里只做环境变量的临时覆盖/清除。
  let res
  try {
    res = await withProxyEnv(proxy, () => fetch(target, { method: 'GET', headers, redirect: 'follow', signal }))
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      out.timedOut = true
      out.error = `请求超时（>${Math.round(timeoutMs / 1000)}s）`
      return out
    }
    out.error = `请求失败：${String((err && err.message) || err).slice(0, 200)}`
    return out
  }

  out.status = res.status
  out.finalUrl = res.url || url
  out.contentType = res.headers.get('content-type') || ''

  let buf
  try {
    buf = Buffer.from(await res.arrayBuffer())
  } catch (err) {
    out.error = `读取响应体失败：${String((err && err.message) || err).slice(0, 160)}`
    return out
  }

  if (buf.length > maxBytes) {
    out.notes.push(`响应体 ${fmtBytes(buf.length)} 超过上限 ${fmtBytes(maxBytes)}，已截取前 ${fmtBytes(maxBytes)}`)
    buf = buf.subarray(0, maxBytes)
  }
  out.bytes = buf.length

  const bytes = decompressBuffer(buf)
  const decoder = pickCharset(out.contentType, bytes.subarray(0, 4096).toString('latin1'))
  try {
    out.text = decoder.decode(bytes)
  } catch {
    out.text = bytes.toString('utf8')
  }

  out.ok = res.status >= 200 && res.status < 400
  if (!out.ok) out.error = `HTTP ${res.status}`
  return out
}

// ---------------------------------------------------------------------------
// HTML → 纯文本
// ---------------------------------------------------------------------------

const SKIP_TAGS = new Set([
  'script', 'style', 'noscript', 'svg', 'iframe', 'nav', 'header', 'footer',
  'aside', 'form', 'template', 'canvas', 'video', 'audio', 'object', 'select', 'button'
])
const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'main', 'ul', 'ol', 'dl', 'dd', 'dt', 'table',
  'thead', 'tbody', 'tr', 'td', 'th', 'blockquote', 'pre', 'figure', 'figcaption',
  'details', 'summary', 'address', 'hr', 'br'
])
const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'title'])

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', middot: '·', bull: '•', copy: '©', reg: '®', trade: '™',
  laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', lsaquo: '‹', rsaquo: '›',
  deg: '°', plusmn: '±', times: '×', divide: '÷', frac12: '½', sup2: '²', sup3: '³',
  euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶', dagger: '†', permil: '‰',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', infin: '∞', ne: '≠', le: '≤', ge: '≥',
  micro: 'µ', alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', pi: 'π', omega: 'ω',
  lambda: 'λ', mu: 'μ', sigma: 'σ', tau: 'τ', phi: 'φ',
  zwnj: '', zwj: '', shy: '', sbquo: '‚', bdquo: '„', oelig: 'œ', aelig: 'æ', szlig: 'ß'
}

/** HTML 实体解码（数字 + 常用命名实体）。 */
function decodeEntities(input) {
  if (!input || input.indexOf('&') === -1) return input || ''
  return input.replace(/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, body) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X'
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10)
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole
      if (code === 0 || (code >= 0xd800 && code <= 0xdfff)) return ''
      try {
        return String.fromCodePoint(code)
      } catch {
        return whole
      }
    }
    const key = body.toLowerCase()
    if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key)) return NAMED_ENTITIES[key]
    return whole
  })
}

function normalizeText(input) {
  return String(input || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 抽取 <title> 文本（实体已解码）。 */
function extractTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html || '')
  if (!m) return ''
  return normalizeText(decodeEntities(m[1].replace(/<[^>]*>/g, ' ')))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

/** 去掉页面里的样板容器（导航、页脚、评论、cookie 提示……）。 */
function stripBoilerplate(html) {
  let out = String(html || '')
  const containerTags = [
    'nav', 'header', 'footer', 'aside', 'form', 'noscript', 'iframe', 'svg',
    'script', 'style', 'template', 'select', 'button', 'canvas', 'video', 'audio', 'object'
  ]
  for (const tag of containerTags) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), ' ')
  }
  // role / class / id 明显是样板区的容器
  let prev = ''
  for (let pass = 0; pass < 3 && prev !== out; pass++) {
    prev = out
    out = out.replace(/<(div|section|ul|ol|table|span|p)\b([^>]*)>[\s\S]*?<\/\1\s*>/gi, (whole, tag, attrs) => {
      const a = String(attrs || '')
      if (/role\s*=\s*["']?(navigation|banner|contentinfo|complementary|search|form)/i.test(a)) return ' '
      if (
        /(class|id)\s*=\s*["'][^"']*(?:^|[\s_-])(nav|navbar|navigation|menu|breadcrumb|footer|header|sidebar|aside|comment|cookie|gdpr|consent|advert|ads?|promo|banner|social|share|related|recommend|subscribe|paywall|popup|modal|toolbar|licence|license|disclaimer|skip-link)(?:[\s_-]|["'])/i.test(
          a
        )
      ) {
        return ' '
      }
      return whole
    })
  }
  out = out.replace(/<!--[\s\S]*?-->/g, ' ')
  return out
}

/**
 * 从 HTML 中抽取正文块（自研分词器，不依赖 DOM 解析器，零额外依赖）。
 *
 * 算法：先用一个标签正则把 HTML 切成 [文本片段 | 标签] 的 token 序列，然后单趟遍历：
 *   - 遇到 script/style/nav/header/footer/form… 等容器标签，把它整段"跳过"
 *     （用 skipStack 记住嵌套深度，直到对应结束标签）；
 *   - 遇到块级标签（p/div/li/h1..h6/pre/…）就"收束"当前缓冲区，得到一个块；
 *   - 内联标签（b/i/a/span/em/strong…）既不切块也不影响缓冲区，
 *     所以 <p>a <b>b</b> c</p> 会得到 "a b c"，而不是被切碎成三段。
 *
 * 返回 [{ tag, text }]，tag ∈ 'heading' | 'title' | 'li' | 'pre' | 'flow'。
 */
function extractBlocks(html) {
  const s = String(html || '')
  const tokens = []
  // 注意：这里不能用 \b（`<p>` 里 p 后面是 > 属于非单词字符，\b 不成立会导致漏匹配）。
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g
  let m
  let pos = 0
  while ((m = tagRe.exec(s)) !== null) {
    if (m.index > pos) tokens.push({ type: 'text', value: s.slice(pos, m.index) })
    tokens.push({ type: 'tag', closing: m[1] === '/', name: m[2].toLowerCase(), raw: m[0] })
    pos = tagRe.lastIndex
  }
  if (pos < s.length) tokens.push({ type: 'text', value: s.slice(pos) })

  const blocks = []
  const skipStack = []
  let buf = ''
  let kind = 'flow'
  let inPre = false

  const reset = (k) => {
    buf = ''
    kind = k
  }

  /** 收束当前缓冲区为一个正文块。 */
  const emit = () => {
    const text = buf
    buf = ''
    if (!text || text.indexOf('<') !== -1) return
    const flat = inPre
      ? decodeEntities(text).replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim()
      : decodeEntities(text).replace(/\s+/g, ' ').trim()
    if (!flat) return
    // 过滤纯标点/空白的边角碎片
    if (!/[\p{L}\p{N}]/u.test(flat) && flat.length < 24) return
    blocks.push({ tag: kind, text: flat })
  }

  reset('flow')
  for (const t of tokens) {
    if (t.type === 'text') {
      if (skipStack.length === 0) buf += t.value
      continue
    }

    if (t.closing) {
      const at = skipStack.lastIndexOf(t.name)
      if (at !== -1) {
        skipStack.length = at // 丢弃该跳过容器（含未闭合的内层）
        continue
      }
      if (t.name === 'pre') inPre = false
      if (BLOCK_TAGS.has(t.name) || t.name === 'li' || t.name === 'p' || HEADING_TAGS.has(t.name)) emit()
      continue
    }

    if (skipStack.length > 0) {
      // 跳过区内部：只跟踪嵌套，不产出任何文本
      if (!/\/\s*>$/.test(t.raw) && t.name !== 'br' && t.name !== 'hr') skipStack.push(t.name)
      continue
    }

    if (SKIP_TAGS.has(t.name)) {
      emit()
      if (!/\/\s*>$/.test(t.raw)) skipStack.push(t.name)
      continue
    }

    if (HEADING_TAGS.has(t.name)) {
      emit()
      reset(t.name === 'title' ? 'title' : 'heading')
    } else if (t.name === 'li') {
      emit()
      reset('li')
    } else if (t.name === 'pre') {
      emit()
      inPre = true
      reset('pre')
    } else if (BLOCK_TAGS.has(t.name) || t.name === 'p') {
      emit()
      reset('flow')
    }
    // 内联标签：什么都不做（文本继续进缓冲区）
  }
  emit()
  return blocks
}

/** 去掉重复的标题块（很多页面 h1 与 title 完全相同）。 */
function dedupe(blocks) {
  const out = []
  const seenHeadings = new Set()
  for (const b of blocks) {
    if (!b.text) continue
    if (b.tag === 'heading' || b.tag === 'title') {
      const key = b.text.replace(/\s+/g, '').slice(0, 40)
      if (!key) continue
      if (seenHeadings.has(key)) continue
      seenHeadings.add(key)
    }
    out.push(b)
  }
  return out
}

/** 把正文块渲染成纯文本：段落之间空行、列表项加 - 前缀、标题后用空行隔开。 */
function renderBlocks(blocks, maxChars) {
  const lines = []
  let total = 0
  let truncated = false
  const push = (line) => {
    lines.push(line)
    total += line.length + 1
  }

  for (const b of blocks) {
    if (!b.text) continue
    if (b.tag === 'pre') {
      // <pre> 保留换行
      for (const sub of b.text.split('\n')) {
        if (total + sub.length + 1 > maxChars) {
          truncated = true
          break
        }
        push(sub)
      }
      if (truncated) break
      push('')
      continue
    }
    const line = b.tag === 'li' ? `- ${b.text}` : b.text
    if (total + line.length + 1 > maxChars) {
      const remain = maxChars - total
      if (remain > 80) push(line.slice(0, remain))
      truncated = true
      break
    }
    push(line)
    if (b.tag === 'heading' || b.tag === 'title') push('')
  }

  let text = lines
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (truncated) text += '\n…（已截断）'
  return { text, truncated }
}

/** HTML → 精简正文纯文本。返回 { title, text, chars, truncated, rawChars }。 */
function htmlToPlainText(html, maxChars = DEFAULT_MAX_CHARS) {
  const raw = String(html || '')
  const title = extractTitle(raw)
  let body = stripBoilerplate(raw)
  // 只保留 body 内容（若没有 body 就不动）
  const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(body)
  if (bodyMatch) body = bodyMatch[1]
  const blocks = dedupe(extractBlocks(body))
  const { text, truncated } = renderBlocks(blocks, maxChars)
  return { title, text, chars: text.length, truncated, rawChars: raw.length }
}

// ---------------------------------------------------------------------------
// 搜索引擎
// ---------------------------------------------------------------------------

/** 去掉结果摘要里的 HTML 标签并压成一行。 */
function cleanSnippet(input, maxLen = DEFAULT_SNIPPET) {
  let s = String(input || '')
  s = s.replace(/<[^>]*>/g, ' ')
  s = normalizeText(decodeEntities(s)).replace(/\s+/g, ' ').trim()
  if (s.length > maxLen) s = `${s.slice(0, maxLen - 1)}…`
  return s
}

function unwrapDdgUrl(href) {
  try {
    const u = new URL(href, 'https://duckduckgo.com')
    const target = u.searchParams.get('uddg')
    if (target) return decodeURIComponent(target)
    return u.toString()
  } catch {
    return href
  }
}

/**
 * Bing 的 RSS 形式：首选，结构化、体积小、无脏 HTML。
 *
 * 注意必须用 **cn.bing.com**：实测 www.bing.com 的 format=rss 对中文查询会返回
 * 完全不相干的结果（例如「今天上海天气」→ 小游戏下载、「koishi 机器人框架」→ 漫画站），
 * 且每次不同；cn.bing.com 同样请求返回的是正确结果，中文/英文查询都准，而且更快。
 */
async function searchBingRSS(query, top, proxy, timeoutMs, host = 'cn.bing.com') {
  const url = `https://${host}/search?q=${encodeURIComponent(query)}&format=rss&count=${top}`
  const res = await httpGet(url, {
    proxy,
    timeoutMs,
    accept: 'application/rss+xml,application/xml;q=0.9,text/xml;q=0.8,*/*;q=0.5'
  })
  if (!res.ok) return { ok: false, error: res.error || `HTTP ${res.status}`, engineUsed: `bing-rss(${host})`, rawBytes: res.bytes }
  const items = []
  const re = /<item\b[^>]*>([\s\S]*?)<\/item\s*>/gi
  let m
  while ((m = re.exec(res.text)) !== null && items.length < top) {
    const chunk = m[1]
    const pick = (tag) => {
      const mm = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, 'i').exec(chunk)
      if (!mm) return ''
      return normalizeText(
        decodeEntities(mm[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]*>/g, ' '))
      )
    }
    const title = pick('title').replace(/\s+/g, ' ').trim()
    const link = pick('link').replace(/\s+/g, ' ').trim()
    const desc = pick('description')
    if (!title || !link) continue
    items.push({ title, url: link, snippet: cleanSnippet(desc) })
  }
  if (!items.length) {
    return { ok: false, error: 'RSS 解析后无结果（Bing 可能限流或该查询无命中）', engineUsed: `bing-rss(${host})`, rawBytes: res.bytes }
  }
  return { ok: true, items, engineUsed: `bing-rss(${host})`, rawBytes: res.bytes }
}

/** Bing 的 HTML 结果页兜底（RSS 被限流时用）。 */
async function searchBingHTML(query, top, proxy, timeoutMs, host = 'cn.bing.com') {
  const url = `https://${host}/search?q=${encodeURIComponent(query)}&count=${top}`
  const res = await httpGet(url, { proxy, timeoutMs })
  if (!res.ok) return { ok: false, error: res.error || `HTTP ${res.status}`, engineUsed: `bing-html(${host})`, rawBytes: res.bytes }
  const items = []
  const re =
    /<li class="b_algo"[\s\S]*?<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<p[^>]*>([\s\S]*?)<\/p>)?/gi
  let m
  while ((m = re.exec(res.text)) !== null && items.length < top) {
    const link = decodeEntities(m[1])
    const title = cleanSnippet(m[2], 200)
    const snippet = cleanSnippet(m[3] || '')
    if (!title || !/^https?:/i.test(link)) continue
    items.push({ title, url: link, snippet })
  }
  if (!items.length) {
    return {
      ok: false,
      error: 'HTML 结果页未解析出条目（页面结构变化或被反爬拦截）',
      engineUsed: `bing-html(${host})`,
      rawBytes: res.bytes
    }
  }
  return { ok: true, items, engineUsed: `bing-html(${host})`, rawBytes: res.bytes }
}

/**
 * 相关性别名检查：判断"关键词在标题/摘要里到底命中了几个"。
 *
 * 实测 Bing 偶尔会返回与查询完全无关的结果（尤其 www.bing.com 的 RSS），
 * 用户看到驴唇不对马嘴的搜索结果比看到"搜索失败"更糟，所以这里加一道兜底：
 * 一条结果都没命中任何关键词时，换 host / 退回 HTML 结果页。
 */
function relevanceScore(items, query) {
  const tokens = []
  for (const t of String(query).toLowerCase().split(/[\s,，、+]+/)) {
    if (t.length >= 2) tokens.push(t)
  }
  // 中文没有空格分词：再补一层大字/词（长度≥2 的相邻 2-gram 过于宽松，这里用整串）
  const compact = String(query).toLowerCase().replace(/\s+/g, '')
  if (compact.length >= 2) tokens.push(compact)
  // query 里带 site: 之类的语法时忽略该 token
  const usable = tokens.filter((t) => !t.includes(':'))
  if (!usable.length) return items.length // 没有可判定 token 就不拦
  let hit = 0
  for (const it of items) {
    const hay = `${it.title || ''} ${it.snippet || ''} ${it.url || ''}`.toLowerCase()
    if (usable.some((t) => hay.includes(t))) hit++
  }
  return hit
}

async function searchGoogle(query, top, proxy, timeoutMs) {
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=${top}&hl=zh-CN`
  const res = await httpGet(url, { proxy, timeoutMs })
  if (!res.ok) return { ok: false, error: res.error || `HTTP ${res.status}`, engineUsed: 'google', rawBytes: res.bytes }
  if (/consent\.google\.com|Before you continue to Google/i.test(res.text) && !/href="\/url\?q=/.test(res.text)) {
    return { ok: false, error: 'Google 返回了同意页/反爬页，未拿到结果', engineUsed: 'google', rawBytes: res.bytes }
  }
  const items = []
  const re = /<a href="\/url\?q=([^&"]+)[^"]*"[^>]*>[\s\S]{0,600}?<h3[^>]*>([\s\S]*?)<\/h3>/gi
  let m
  while ((m = re.exec(res.text)) !== null && items.length < top) {
    const link = decodeURIComponent(m[1])
    const title = cleanSnippet(m[2], 200)
    if (!title || !/^https?:/i.test(link)) continue
    if (/google\.com\//i.test(link)) continue
    const tail = res.text.slice(m.index + m[0].length, m.index + m[0].length + 3000)
    const sm = /<div[^>]*class="[^"]*VwiC3b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(tail)
    items.push({ title, url: link, snippet: cleanSnippet(sm ? sm[1] : '') })
  }
  if (!items.length) {
    return { ok: false, error: 'Google 结果页未解析出条目（DOM 结构变化或被反爬拦截）', engineUsed: 'google', rawBytes: res.bytes }
  }
  return { ok: true, items, engineUsed: 'google', rawBytes: res.bytes }
}

async function searchDuckDuckGo(query, top, proxy, timeoutMs) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const res = await httpGet(url, { proxy, timeoutMs })
  if (!res.ok) return { ok: false, error: res.error || `HTTP ${res.status}`, engineUsed: 'duckduckgo', rawBytes: res.bytes }
  const items = []
  const re =
    /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]{0,1200}?(?:<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>)?/gi
  let m
  while ((m = re.exec(res.text)) !== null && items.length < top) {
    const link = unwrapDdgUrl(decodeEntities(m[1]))
    const title = cleanSnippet(m[2], 200)
    if (!title || !/^https?:/i.test(link)) continue
    items.push({ title, url: link, snippet: cleanSnippet(m[3] || '') })
  }
  if (!items.length) {
    return { ok: false, error: 'DDG 结果页未解析出条目（可能被限流）', engineUsed: 'duckduckgo', rawBytes: res.bytes }
  }
  return { ok: true, items, engineUsed: 'duckduckgo', rawBytes: res.bytes }
}

const ENGINES = {
  // Bing 四级尝试：cn.bing.com RSS → www.bing.com RSS → cn HTML → www HTML。
  // 每一级都做相关性检查：返回了结果但一条都没命中关键词，同样视为失败往下走。
  bing: async (q, top, proxy, timeoutMs) => {
    const attempts = [
      ['cn.bing.com', searchBingRSS, 'RSS'],
      ['www.bing.com', searchBingRSS, 'RSS'],
      ['cn.bing.com', searchBingHTML, 'HTML 结果页'],
      ['www.bing.com', searchBingHTML, 'HTML 结果页']
    ]
    const tried = []
    for (const [host, fn, label] of attempts) {
      let r
      try {
        r = await fn(q, top, proxy, timeoutMs, host)
      } catch (err) {
        r = { ok: false, error: `异常：${String((err && err.message) || err).slice(0, 120)}` }
      }
      if (!r.ok) {
        tried.push(`${host} ${label}: ${r.error}`)
        continue
      }
      const hit = relevanceScore(r.items, q)
      if (hit === 0) {
        tried.push(`${host} ${label}: 返回 ${r.items.length} 条但无一命中关键词（判定为串味结果）`)
        continue
      }
      return {
        ...r,
        note: tried.length ? `前 ${tried.length} 次尝试失败/不相关，已改用 ${host} ${label}` : '',
        tried
      }
    }
    return { ok: false, error: tried.join('；') || 'Bing 全部尝试失败', engineUsed: 'bing', tried }
  },
  google: searchGoogle,
  duckduckgo: searchDuckDuckGo
}

async function runSearch(query, engine, top, proxy, timeoutMs) {
  const order = engine === 'auto' ? ['bing', 'duckduckgo', 'google'] : [engine]
  const tried = []
  for (const name of order) {
    const fn = ENGINES[name]
    if (!fn) {
      tried.push(`${name}: 未知引擎`)
      continue
    }
    let r
    try {
      r = await fn(query, top, proxy, timeoutMs)
    } catch (err) {
      r = { ok: false, error: `引擎内部异常：${String((err && err.message) || err).slice(0, 160)}`, engineUsed: name }
    }
    if (r.ok) {
      const inner = Array.isArray(r.tried) ? r.tried : []
      return { ...r, engineRequested: engine, tried: [...tried, ...inner] }
    }
    tried.push(`${ENGINE_LABELS[name] || name}: ${r.error}`)
  }
  return { ok: false, engineRequested: engine, tried, error: tried.join('；') || '没有可用引擎' }
}

function formatResults(query, search, top) {
  const lines = [`搜索「${query}」（引擎 ${search.engineUsed}，共 ${search.items.length} 条）：`]
  search.items.slice(0, top).forEach((it, i) => {
    lines.push(`${i + 1}. ${it.title}`)
    lines.push(`   ${it.url}`)
    if (it.snippet) lines.push(`   ${it.snippet}`)
  })
  if (search.note) lines.push(`（${search.note}）`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// 结果封装：始终返回 content 数组，避免 SDK 版本差异
// ---------------------------------------------------------------------------

function okText(text) {
  return { content: [{ type: 'text', text: String(text) }] }
}
function errText(text) {
  return { content: [{ type: 'text', text: String(text) }], isError: true }
}
/** 兜底：任何未捕获异常都转成可读文本，绝不把栈丢给模型。 */
function safe(handler, name) {
  return async (args) => {
    try {
      return await handler(args)
    } catch (err) {
      log(`tool ${name} threw:`, (err && err.stack) || String(err))
      return errText(
        `工具 ${name} 执行出错：${String((err && err.message) || err).slice(0, 300)}\n（这是可恢复错误，可换关键词或换链接重试。）`
      )
    }
  }
}

// ---------------------------------------------------------------------------
// 工具实现
// ---------------------------------------------------------------------------

async function doSearch(args) {
  const query = String((args && args.query) || '').trim()
  if (!query) return errText('web_search 缺少 query 参数。')
  const engine = ['bing', 'google', 'duckduckgo', 'auto'].includes(args.engine) ? args.engine : 'bing'
  const top = clampInt(args.top, 1, MAX_TOP, DEFAULT_TOP)
  const proxy = proxyMode(args.proxy)
  const timeoutMs = clampInt(args.timeout_ms, 3000, 30000, SEARCH_TIMEOUT_MS)

  const search = await runSearch(query, engine, top, proxy, timeoutMs)
  if (!search.ok) {
    const lines = [`搜索「${query}」失败。`, `原因：${search.error}`]
    if (search.tried && search.tried.length) lines.push(`尝试过：${search.tried.join(' / ')}`)
    lines.push('建议：稍后重试、换 query 关键词，或改用 engine="duckduckgo"。')
    return errText(lines.join('\n'))
  }
  log(`web_search q=${JSON.stringify(query)} engine=${search.engineUsed} hits=${search.items.length} bytes=${search.rawBytes || '?'}`)
  return okText(formatResults(query, search, top))
}

async function doBrowse(args) {
  const raw = String((args && args.url) || '').trim()
  if (!raw) return errText('web_browse 缺少 url 参数。')
  let target = raw
  if (!/^https?:\/\//i.test(target)) target = `https://${target}`
  let parsed
  try {
    parsed = new URL(target)
  } catch {
    return errText(`URL 不合法：${raw}`)
  }
  if (!/^https?:$/.test(parsed.protocol)) return errText(`只支持 http/https，收到：${parsed.protocol}`)

  const maxChars = clampInt(args.max_chars, 400, MAX_CHARS_LIMIT, DEFAULT_MAX_CHARS)
  const proxy = proxyMode(args.proxy)
  const timeoutMs = clampInt(args.timeout_ms, 3000, 30000, FETCH_TIMEOUT_MS)

  const res = await httpGet(parsed.toString(), { proxy, timeoutMs })
  const head = [`URL: ${parsed.toString()}`]
  if (res.finalUrl && res.finalUrl !== parsed.toString()) head.push(`最终地址: ${res.finalUrl}`)
  head.push(
    `状态: ${res.timedOut ? `超时(>${Math.round(timeoutMs / 1000)}s)` : `HTTP ${res.status}`}｜类型: ${
      res.contentType || '未知'
    }｜大小: ${fmtBytes(res.bytes)}`
  )
  for (const n of res.notes) head.push(`提示: ${n}`)

  if (!res.ok) {
    head.push(`抓取失败：${res.error || '未知错误'}`)
    head.push('建议：换一个搜索结果里的链接，或稍后重试；该站点可能有反爬限制。')
    return errText(head.join('\n'))
  }

  const isHtml = /html|xml/i.test(res.contentType) || /^\s*<(!doctype|html)/i.test(res.text.slice(0, 200))
  if (!isHtml) {
    const flat = normalizeText(res.text).slice(0, maxChars)
    head.push(`（非 HTML 内容，按纯文本返回${res.text.length > maxChars ? '，已截断' : ''}）`)
    head.push('')
    head.push(flat + (res.text.length > maxChars ? '\n…（已截断）' : ''))
    log(`web_browse url=${parsed.toString()} nonhtml chars=${flat.length}`)
    return okText(head.join('\n'))
  }

  const plain = htmlToPlainText(res.text, maxChars)
  head.push(`标题: ${plain.title || '(无)'}`)
  head.push(`正文: ${plain.chars} 字符${plain.truncated ? '（已截断）' : ''}｜原始 HTML ${fmtBytes(plain.rawChars)}`)
  head.push('')
  head.push(plain.text || '(正文为空：可能是 JS 渲染页面、需要登录，或被反爬拦截)')
  log(
    `web_browse url=${parsed.toString()} title=${JSON.stringify(plain.title).slice(0, 80)} plainChars=${plain.chars} rawHTML=${plain.rawChars}`
  )
  return okText(head.join('\n'))
}

async function doSearchRead(args) {
  const query = String((args && args.query) || '').trim()
  if (!query) return errText('web_search_read 缺少 query 参数。')
  const engine = ['bing', 'google', 'duckduckgo', 'auto'].includes(args.engine) ? args.engine : 'bing'
  const top = clampInt(args.top, 1, MAX_TOP, DEFAULT_TOP)
  const readTop = clampInt(args.read_top, 1, Math.min(top, MAX_TOP), Math.min(2, top))
  const perPage = clampInt(args.max_chars_per_page, 400, MAX_CHARS_LIMIT, Math.min(DEFAULT_MAX_CHARS, 3000))
  const proxy = proxyMode(args.proxy)
  const timeoutMs = clampInt(args.timeout_ms, 3000, 30000, FETCH_TIMEOUT_MS)

  const search = await runSearch(query, engine, top, proxy, Math.min(timeoutMs, SEARCH_TIMEOUT_MS))
  const parts = []
  if (!search.ok) {
    parts.push(`搜索「${query}」失败。`, `原因：${search.error}`, '建议：稍后重试或换关键词。')
    return errText(parts.join('\n'))
  }
  parts.push(formatResults(query, search, top))

  const picks = search.items.slice(0, readTop)
  parts.push('', `── 以下为前 ${picks.length} 条的正文摘要 ──`)

  // 并发抓取，单条失败不影响其他条目
  const results = await Promise.all(
    picks.map(async (it) => {
      try {
        const res = await httpGet(it.url, { proxy, timeoutMs })
        if (!res.ok) return { url: it.url, ok: false, note: res.error || `HTTP ${res.status}` }
        const isHtml = /html|xml/i.test(res.contentType) || /^\s*<(!doctype|html)/i.test(res.text.slice(0, 200))
        if (!isHtml) {
          const flat = normalizeText(res.text).slice(0, perPage)
          return { url: it.url, ok: true, title: it.title, text: flat, truncated: res.text.length > perPage, chars: flat.length }
        }
        const plain = htmlToPlainText(res.text, perPage)
        return { url: it.url, ok: true, title: plain.title || it.title, text: plain.text, truncated: plain.truncated, chars: plain.chars }
      } catch (err) {
        return { url: it.url, ok: false, note: `抓取异常：${String((err && err.message) || err).slice(0, 120)}` }
      }
    })
  )

  results.forEach((r, i) => {
    parts.push('')
    parts.push(`【${i + 1}】${r.title || picks[i].title}`)
    parts.push(r.url)
    if (!r.ok) {
      parts.push(`(抓取失败：${r.note})`)
      return
    }
    if (!r.text) {
      parts.push('(正文为空：可能是 JS 渲染页面或需要登录)')
      return
    }
    parts.push(r.text)
    if (r.truncated) parts.push('…（已截断）')
  })

  const okCount = results.filter((r) => r.ok).length
  log(`web_search_read q=${JSON.stringify(query)} hits=${search.items.length} read=${okCount}/${picks.length}`)
  const text = parts.join('\n')
  return okCount === 0 ? errText(text) : okText(text)
}

async function doEngines(args) {
  const proxy = proxyMode(args && args.proxy)
  const probes = [
    ['Bing RSS (cn.bing.com)', `https://cn.bing.com/search?q=${encodeURIComponent('test')}&format=rss`, 'bing'],
    ['Bing RSS (www.bing.com)', `https://www.bing.com/search?q=${encodeURIComponent('test')}&format=rss`, 'bing'],
    ['DuckDuckGo HTML', 'https://html.duckduckgo.com/html/?q=test', 'duckduckgo'],
    ['Google', 'https://www.google.com/search?q=test', 'google']
  ]
  const lines = ['联网搜索引擎可用性自检：', `代理模式：${proxy === 'inherit' ? `inherit（${activeProxy() || '环境未设置代理'}）` : proxy}`, '']
  const results = await Promise.all(
    probes.map(async ([label, url, key]) => {
      const t0 = Date.now()
      try {
        const res = await httpGet(url, { proxy, timeoutMs: SEARCH_TIMEOUT_MS })
        return { label, key, ms: Date.now() - t0, status: res.status, bytes: res.bytes, ok: res.ok, error: res.error }
      } catch (err) {
        return { label, key, ms: Date.now() - t0, ok: false, error: String((err && err.message) || err).slice(0, 120) }
      }
    })
  )
  for (const r of results) {
    lines.push(
      `${r.ok ? '✅' : '❌'} ${r.label}（engine="${r.key}"）：${
        r.ok ? `HTTP ${r.status}，${fmtBytes(r.bytes)}，${r.ms}ms` : `${r.error}（${r.ms}ms）`
      }`
    )
  }
  lines.push('')
  lines.push('说明：默认 engine="bing"（走 RSS，最省 token）；engine="auto" 会依次尝试 Bing → DuckDuckGo → Google。')
  return okText(lines.join('\n'))
}

// ---------------------------------------------------------------------------
// 注册
// ---------------------------------------------------------------------------

const server = new McpServer({ name: 'websearch', version: '1.0.0' })

const commonProxy = z
  .string()
  .optional()
  .describe('可选：代理地址（http://host:port）。传 "off" 强制直连；不传则沿用进程环境变量里的代理。')
const commonTimeout = z.number().int().min(3000).max(30000).optional().describe('可选：网络超时毫秒数，默认 10000~12000。')

server.registerTool(
  'web_search',
  {
    title: '联网搜索',
    description:
      '联网搜索网页，返回精简结果列表（序号 + 标题 + URL + 摘要），默认 5 条、最多 10 条。' +
      '默认使用 Bing（RSS 形式，快且干净），可选 google / duckduckgo / auto。' +
      '适合查最新消息、事实核查、找资料链接。拿到 URL 后如需正文请再用 web_browse。' +
      '注意：不支持百度。',
    inputSchema: {
      query: z.string().min(1).describe('搜索关键词，可用 site:、"" 等搜索引擎语法'),
      top: z.number().int().min(1).max(10).optional().describe('返回条数，默认 5，最多 10'),
      engine: z.enum(['bing', 'google', 'duckduckgo', 'auto']).optional().describe('搜索引擎，默认 bing'),
      proxy: commonProxy,
      timeout_ms: commonTimeout
    },
    annotations: { readOnlyHint: true, openWorldHint: true }
  },
  safe(doSearch, 'web_search')
)

server.registerTool(
  'web_browse',
  {
    title: '浏览网页',
    description:
      '抓取一个网页并返回"简化后的正文纯文本"（已剥离 script/style/nav/footer 等噪声、解码 HTML 实体、折叠空白）。' +
      '默认截断到约 4000 字符并标记「…（已截断）」。用于读取 web_search 返回的 URL 的正文。' +
      '对 JS 动态渲染的页面可能拿不到正文。',
    inputSchema: {
      url: z.string().min(1).describe('要抓取的 http/https URL'),
      max_chars: z.number().int().min(400).max(20000).optional().describe('正文最大字符数，默认 4000'),
      proxy: commonProxy,
      timeout_ms: commonTimeout
    },
    annotations: { readOnlyHint: true, openWorldHint: true }
  },
  safe(doBrowse, 'web_browse')
)

server.registerTool(
  'web_search_read',
  {
    title: '搜索并阅读',
    description:
      '一步到位：先联网搜索，再自动抓取前 N 条（默认 2 条）的正文并返回简化后的纯文本。' +
      '当问题需要"先找再读"时优先用它，可以省掉一轮 web_browse 调用。单条抓取失败不影响其他条目。',
    inputSchema: {
      query: z.string().min(1).describe('搜索关键词'),
      top: z.number().int().min(1).max(10).optional().describe('搜索结果条数，默认 5'),
      read_top: z.number().int().min(1).max(10).optional().describe('实际抓取并阅读的条数，默认 2'),
      max_chars_per_page: z.number().int().min(400).max(20000).optional().describe('每个页面正文最大字符数，默认约 3000'),
      engine: z.enum(['bing', 'google', 'duckduckgo', 'auto']).optional().describe('搜索引擎，默认 bing'),
      proxy: commonProxy,
      timeout_ms: commonTimeout
    },
    annotations: { readOnlyHint: true, openWorldHint: true }
  },
  safe(doSearchRead, 'web_search_read')
)

server.registerTool(
  'web_engines',
  {
    title: '搜索引擎自检',
    description:
      '自检当前网络/代理下各搜索引擎是否可达（Bing RSS / DuckDuckGo / Google），返回 HTTP 状态与耗时。排查"搜索失败"时先用它。',
    inputSchema: { proxy: commonProxy },
    annotations: { readOnlyHint: true, openWorldHint: true }
  },
  safe(doEngines, 'web_engines')
)

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  log(`started pid=${process.pid} node=${process.version} proxy=${activeProxy() || '(direct)'}`)
}

process.on('uncaughtException', (err) => {
  log('uncaughtException:', (err && err.stack) || String(err))
})
process.on('unhandledRejection', (err) => {
  log('unhandledRejection:', (err && err.stack) || String(err))
})

// 只有被当作可执行脚本直接运行时才启动 stdio 服务器；
// 被 require（例如离线单测文本简化逻辑）时不抢 stdin/stdout。
const RUN_AS_MAIN = (() => {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    const path = require('path')
    return path.resolve(entry) === path.resolve(__filename)
  } catch {
    return false
  }
})()

if (RUN_AS_MAIN) {
  main().catch((err) => {
    log('fatal:', (err && err.stack) || String(err))
    process.exit(1)
  })
}

// 供探测脚本 / 离线单测 require 时复用
module.exports = {
  htmlToPlainText,
  decodeEntities,
  cleanSnippet,
  httpGet,
  runSearch,
  proxyMode,
  activeProxy,
  normalizeText,
  extractBlocks,
  stripBoilerplate,
  renderBlocks,
  dedupe,
  decompressBuffer
}
