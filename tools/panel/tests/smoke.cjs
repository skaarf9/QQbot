#!/usr/bin/env node
'use strict'
/**
 * smoke.cjs —— 面板的接口冒烟测试（只读 + 一次清屏，不动 Koishi / NapCat 进程）
 *
 * 用法：先起面板 `node tools\panel\server.cjs`，另开一个窗口：
 *   node tools\panel\tests\smoke.cjs            # 默认打 127.0.0.1:5151
 *   node tools\panel\tests\smoke.cjs --port 5152
 *
 * 检什么（每条打印 ✓/✗，最后给退出码）：
 *   1  页面能拿到、且把面板 token 注进去了
 *   2  /api/ping 免鉴权可访问（重复启动时靠它认出"这就是本面板"）
 *   3  /api/state 不带 token 必须 403
 *   4  /api/state 带 token 且结构完整（services / login / app）
 *   5  日志源列表与快照能读（Koishi 至少有一个源）
 *   6  二维码接口：有图 → 200 image/png；没图 → 404
 *   7  Host 头不是本机面板时必须 403（防 DNS rebinding）
 *   8  /api/open-folder 的非白名单目录必须被拒
 */
const http = require('node:http')

const argv = process.argv.slice(2)
const argOf = (n, d) => {
  const i = argv.indexOf('--' + n)
  return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d
}
const PORT = Number(argOf('port', '5151'))

const call = (path, { method = 'GET', token, headers = {}, body } = {}) =>
  new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path,
        method,
        headers: Object.assign(
          { Host: `127.0.0.1:${PORT}` },
          token ? { 'X-Panel-Token': token } : {},
          data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
          headers,
        ),
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) }))
      },
    )
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })

let pass = 0
let fail = 0
const check = (name, ok, extra = '') => {
  if (ok) {
    pass++
    console.log('  ✓ ' + name + (extra ? '  ' + extra : ''))
  } else {
    fail++
    console.log('  ✗ ' + name + (extra ? '  ' + extra : ''))
  }
}

;(async () => {
  console.log(`面板冒烟测试 → http://127.0.0.1:${PORT}/`)

  const home = await call('/')
  const token = /name="panel-token" content="([0-9a-f]+)"/.exec(home.buf.toString('utf8'))?.[1] || ''
  check('页面可访问且注入了面板 token', home.status === 200 && token.length === 32)

  const ping = await call('/api/ping')
  const pingJson = JSON.parse(ping.buf.toString('utf8') || '{}')
  check('/api/ping 免鉴权', ping.status === 200 && pingJson.app === 'qqbot-panel', JSON.stringify(pingJson))

  const noAuth = await call('/api/state')
  check('/api/state 不带 token → 403', noAuth.status === 403)

  const st = await call('/api/state', { token })
  const state = JSON.parse(st.buf.toString('utf8') || '{}')
  check(
    '/api/state 结构完整',
    st.status === 200 && state.services?.koishi && state.services?.napcat && state.login && state.app?.port === PORT,
  )
  console.log(
    `      Koishi: running=${state.services?.koishi?.running} 源=${state.services?.koishi?.sources?.length} | ` +
      `NapCat: running=${state.services?.napcat?.running} 源=${state.services?.napcat?.sources?.length} | ` +
      `登录: ${state.login?.checked?.loginPhase ?? state.login?.error ?? '—'}`,
  )
  check('NapCat WebUI 链接自带 token', !!state.services?.napcat?.webui?.url?.includes('/webui/'))

  // 2026-10-08：非管理员面板里那条隐藏的 UAC 请求弹不出提示，所以多了「控制台启动」这条备用路。
  // 这里只验"按钮在页面上、接口要鉴权"，真的去 POST 会弹一个控制台窗口，冒烟测试不干那种事。
  check(
    '页面有「控制台启动」按钮',
    home.buf.toString('utf8').includes('data-act="napcat-start-console"'),
  )
  const consoleNoAuth = await call('/api/napcat/start-console', { method: 'POST', body: {} })
  check('/api/napcat/start-console 不带 token → 403', consoleNoAuth.status === 403)
  check(
    '/api/state 带提权超时上限（前端提示要用）',
    typeof state.app?.elevateTimeoutMs === 'number' && state.app.elevateTimeoutMs > 0,
    `${state.app?.elevateTimeoutMs} ms | 面板提权=${state.app?.elevated}`,
  )

  const src = state.services?.koishi?.sources?.[0]?.id || state.services?.koishi?.defaultSource
  const snap = await call('/api/logs/snapshot?service=koishi&source=' + encodeURIComponent(src || '') + '&limit=10&token=' + token)
  const snapJson = JSON.parse(snap.buf.toString('utf8') || '{}')
  check('日志快照可读', snap.status === 200 && Array.isArray(snapJson.lines), `源=${snapJson.source} 行=${snapJson.lines?.length}`)
  if (snapJson.lines?.length) {
    const levels = [...new Set(snapJson.lines.map((l) => l.lvl))]
    check('日志行带级别字段', levels.every((l) => typeof l === 'string' && l.length > 0), '级别=' + levels.join('/'))
  }

  const qr = await call('/api/napcat/qr.png?token=' + token)
  check(
    '二维码接口行为正确',
    qr.status === 200 ? qr.headers['content-type'] === 'image/png' : qr.status === 404,
    `HTTP ${qr.status}${qr.status === 200 ? ' ' + qr.headers['content-type'] : ''}`,
  )

  const badHost = await call('/api/state', { token, headers: { Host: 'evil.example.com' } })
  check('Host 不是本机面板 → 403', badHost.status === 403)

  const badFolder = await call('/api/open-folder', { method: 'POST', token, body: { which: 'C:/Windows' } })
  check('/api/open-folder 白名单外的目录被拒', badFolder.status === 400)

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail ? 1 : 0)
})().catch((e) => {
  console.error('\n跑不动：' + e.message + '\n（面板起了吗？端口对吗？）')
  process.exit(1)
})
