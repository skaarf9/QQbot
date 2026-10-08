#!/usr/bin/env node
'use strict'
/**
 * mock-napcat-webui.cjs —— 假的 NapCat WebUI（只在 127.0.0.1:6099）
 *
 * 为什么需要：面板最值钱的两块功能（二维码面板 / 登录状态 / 刷新二维码）只在**真 NapCat 登录期间**
 * 才活着，而真 NapCat 要 UAC 提权 + 真 QQ 客户端 + 手机扫码。这个 mock 把这些行为复刻到一个
 * 几十行的 HTTP 服务里，于是改面板时不用碰真账号就能回归：
 *   · /api/auth/login               —— 校验面板算的 hash 是不是 sha256(token + ".napcat")
 *   · /api/QQLogin/CheckLoginStatus —— 返回 isLogin / loginPhase（可用 FAKE_PHASE 指定）
 *   · /api/QQLogin/RefreshQRcode    —— 覆盖写 `<NapCat>/cache/qrcode.png`（换一张看得出的图）
 *   · /api/QQLogin/RestartNapCat    —— 把 phase 复位成 waiting_qrcode
 *
 * 用法（另开一个窗口，先起 mock 再起面板）：
 *   node tools\panel\tests\mock-napcat-webui.cjs                       # phase=waiting_qrcode
 *   set FAKE_PHASE=ready && node tools\panel\tests\mock-napcat-webui.cjs  # 已登录
 *   set FAKE_PHASE=qrcode_scanned && ...                                # 已扫码待确认
 *
 * ★ 它会**覆盖** cache/qrcode.png，所以启动时先把原文件备份到 .runtime/panel/，
 *   退出（含 Ctrl+C）时还原。备份文件在，硬杀之后重启一次也会还原。
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const ROOT = path.resolve(__dirname, '..', '..', '..')
const HOME = process.env.NAPCAT_HOME || path.join(ROOT, 'NapCat.Shell')
const QR = path.join(HOME, 'cache', 'qrcode.png')
const RUNTIME = path.join(ROOT, '.runtime', 'panel')
const BACKUP = path.join(RUNTIME, 'qrcode.backup.png')
const SWAP = path.join(HOME, 'static', 'assets')
const PORT = Number(process.env.FAKE_PORT || 6099)

const webuiFile = path.join(HOME, 'config', 'webui.json')
const webui = JSON.parse(fs.readFileSync(webuiFile, 'utf8'))
const TOKEN = String(webui.token || '')
const EXPECTED_HASH = crypto.createHash('sha256').update(TOKEN + '.napcat').digest('hex')

let phase = process.env.FAKE_PHASE || 'waiting_qrcode'
const requests = []
let restored = false

function backupOnce() {
  if (fs.existsSync(BACKUP)) return
  if (!fs.existsSync(QR)) return
  fs.mkdirSync(RUNTIME, { recursive: true })
  fs.copyFileSync(QR, BACKUP)
  console.log('[mock] 已备份原 qrcode.png ->', BACKUP)
}
function restore() {
  if (restored) return
  restored = true
  if (fs.existsSync(BACKUP)) {
    try {
      fs.copyFileSync(BACKUP, QR)
      console.log('[mock] 已还原原 qrcode.png')
    } catch {
      /* ignore */
    }
  }
}

/** RefreshQRcode 时换成这张"明显不是二维码"的图，方便肉眼确认面板换图了 */
function swapImage() {
  let src = null
  try {
    src = fs.readdirSync(SWAP).find((n) => /^logo-.*\.png$/.test(n))
  } catch {
    /* ignore */
  }
  if (src) fs.copyFileSync(path.join(SWAP, src), QR)
  else fs.writeFileSync(QR, Buffer.from('89504e470d0a1a0a', 'hex')) // 至少让 mtime 变
}

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => (body += d))
  req.on('end', () => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
    const cred = url.searchParams.get('webui_token')
    requests.push(`${req.method} ${url.pathname}${cred ? ' (webui_token)' : ''}`)
    const json = (o) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(o))
    }
    const ok = (data) => json({ code: 0, data, message: 'success' })
    const bad = (m) => json({ code: 1, message: m })

    if (url.pathname === '/api/auth/login') {
      const b = JSON.parse(body || '{}')
      if (b.hash !== EXPECTED_HASH) {
        console.log('[mock] 登录被拒：hash 不匹配（面板算的 ' + b.hash + '）')
        return bad('token is invalid')
      }
      return ok({ Credential: 'MOCK-CREDENTIAL' })
    }
    if (cred !== 'MOCK-CREDENTIAL') return bad('Unauthorized')

    if (url.pathname === '/api/QQLogin/CheckLoginStatus') {
      return ok({
        isLogin: phase === 'ready',
        isOffline: false,
        loginPhase: phase,
        qrLoginAccepted: phase === 'qrcode_scanned',
        coreReady: phase === 'ready',
        qrcodeurl: 'https://txz.qq.com/p?k=MOCK',
        loginError: '',
      })
    }
    if (url.pathname === '/api/QQLogin/GetQQLoginInfo') return ok({ uin: '10000', nick: 'mock', online: true })
    if (url.pathname === '/api/QQLogin/RefreshQRcode') {
      restore() // 备份还在就先别覆盖，免得丢掉原图
      restored = false
      backupOnce()
      swapImage()
      console.log('[mock] RefreshQRcode -> cache/qrcode.png 已换图（mtime 变了）')
      return ok(true)
    }
    if (url.pathname === '/api/QQLogin/RestartNapCat') {
      phase = 'waiting_qrcode'
      console.log('[mock] RestartNapCat -> phase=waiting_qrcode')
      return ok(true)
    }
    return bad('unknown path ' + url.pathname)
  })
})

backupOnce()
process.on('exit', restore)
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0))

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock] 假 NapCat WebUI 已在 127.0.0.1:${PORT}，token=${TOKEN || '(webui.json 里没有 token)'}，phase=${phase}`)
  console.log('[mock] 面板应该显示：NapCat 运行中 + 登录状态取自这个 mock')
})

setInterval(() => {
  if (!requests.length) return
  console.log('[mock] 收到：' + requests.splice(0).join(' / '))
}, 5000)
