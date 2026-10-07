// 验证新机制：回复整形（去空行 + 不回复哨兵）与出站令牌桶
const path = require('node:path')

function makeCtx() {
  const handlers = {}
  const commands = []
  const ctx = {
    handlers,
    commands,
    on(ev, fn) { (handlers[ev] ||= []).push(fn) },
    command(name) { const c = { action(fn) { commands.push({ name, fn }); return c }, alias() { return c } }; return c },
    model: { extend() {} },
    provide() {},
    inject(_deps, cb) { /* 不回调：跳过 chatluna 链部分 */ },
    setTimeout() {}, setInterval() {},
    get() { return undefined },
    middleware() {},
    $commander: { get() { return null } },
    server: { get() {}, post() {} },
    http: {},
    database: { get: async () => [], upsert: async () => {}, remove: async () => {} },
  }
  return ctx
}

function fire(ctx, ev, ...args) {
  const out = []
  for (const fn of ctx.handlers[ev] || []) out.push(fn(...args))
  return out
}

;(async () => {
  console.log('=== 1) 回复整形 ===')
  const rs = require(path.resolve(__dirname, '../koishi-app/external/koishi-plugin-chatluna-replyshaper/lib/index.js'))
  const c1 = makeCtx()
  rs.apply(c1, { enabled: true, cleanBlankLines: true, stripTrailingSpaces: true, skipTokens: ['[SKIP]', '【不回复】'], skipWhenEmpty: true, debug: true })

  const mk = (content) => ({ elements: [{ type: 'text', attrs: { content } }] })

  let s = mk('第一行\n\n第二行\n\n')
  let r = fire(c1, 'before-send', s)
  console.log('  去空行:', JSON.stringify(s.elements.map((e) => e.attrs.content)), '| 取消?', r)

  s = mk('  \n\n  ')
  r = fire(c1, 'before-send', s)
  console.log('  全空 → 取消:', r)

  s = mk('[SKIP]')
  r = fire(c1, 'before-send', s)
  console.log('  哨兵 [SKIP] → 取消:', r)

  s = mk('（不回复）')
  r = fire(c1, 'before-send', s)
  console.log('  哨兵 带标点 → 取消:', r)

  s = mk('正常回复')
  r = fire(c1, 'before-send', s)
  console.log('  正常 → 放行:', JSON.stringify(r), '内容', s.elements[0].attrs.content)

  s = { elements: [{ type: 'img', attrs: { url: 'x' } }, { type: 'text', attrs: { content: '图\n\n好' } }] }
  fire(c1, 'before-send', s)
  console.log('  带图混合:', JSON.stringify(s.elements.map((e) => e.type + ':' + (e.attrs.content ?? ''))))

  console.log('\n=== 2) 出站令牌桶 ===')
  const gd = require(path.resolve(__dirname, '../koishi-app/external/koishi-plugin-chatluna-guard/lib/index.js'))
  const c2 = makeCtx()
  gd.apply(c2, {
    enabled: true, defaultPolicy: 'silent', allowGroups: ['454444539'],
    outboundEnabled: true, outboundBurst: 2, outboundPerMinute: 1, outboundApplyToPrivate: false,
    groups: [], refreshSeconds: 0, debug: false,
  })

  const sess = () => ({ platform: 'onebot', channelId: '454444539', guildId: '454444539', isDirect: false })
  const results = []
  for (let i = 1; i <= 5; i++) {
    const out = fire(c2, 'before-send', sess())
    results.push(out.some((v) => v === true) ? 'DROP' : 'send')
  }
  console.log('  桶容量2/每分钟1，连发 5 条:', results.join(' '))

  const priv = { platform: 'onebot', channelId: 'p1', isDirect: true }
  const privOut = fire(c2, 'before-send', priv)
  console.log('  私聊（未开启限速）→ 放行:', !privOut.some((v) => v === true))
})().catch((e) => { console.error('测试异常:', e); process.exit(1) })
