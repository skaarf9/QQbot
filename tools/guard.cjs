#!/usr/bin/env node
/**
 * guard.cjs —— 屏蔽开关的控制脚本（R15）
 *
 * 走的是运行中的 Koishi 实例暴露的控制口（<baseDir>/data/guard-control.json 里有
 * 端口 / 路径 / 令牌，脚本自己读，不需要你抄）。写入口有三条，任选：
 *
 *   1. 群里发（人在群里时最方便）：/闭嘴、/开口、/屏蔽状态
 *   2. 本脚本（我不在群里、或者群里发不出去时用）
 *   3. 插件配置里的 muteGroups / allowGroups（进群之前就先写好）
 *
 * 用法：
 *   node tools/guard.cjs status                       # 看所有显式设置
 *   node tools/guard.cjs mute 454444539 [原因…]        # 静默这个群
 *   node tools/guard.cjs allow 454444539 [原因…]       # 放行这个群
 *   node tools/guard.cjs reset 454444539              # 删掉设置，回到默认策略
 *   node tools/guard.cjs check 454444539              # 只看这个群现在回不回
 *
 * 可选：--app koishi-app|koishi-test（默认 koishi-app）
 *       --file <guard-control.json 路径>
 *       --port <端口> --token <令牌>   # 直接指定，不走控制文件
 */
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')

const ROOT = path.join(__dirname, '..')
const args = process.argv.slice(2)

function flag(name, def) {
  const i = args.indexOf(`--${name}`)
  if (i < 0) return def
  const v = args[i + 1]
  args.splice(i, 2)
  return v ?? true
}

const appName = flag('app', 'koishi-app')
const fileArg = flag('file', '')
const portArg = flag('port', '')
const tokenArg = flag('token', '')

const cmd = (args.shift() || 'status').toLowerCase()
const groupId = args.shift() || ''
const reason = args.join(' ') || undefined

const controlFile = fileArg || path.join(ROOT, appName, 'data', 'guard-control.json')

function loadInfo() {
  let info = {}
  if (fs.existsSync(controlFile)) {
    try {
      info = JSON.parse(fs.readFileSync(controlFile, 'utf8'))
    } catch (e) {
      console.error(`读 ${controlFile} 失败：${e.message}`)
    }
  } else if (!portArg) {
    console.error(
      `找不到控制文件 ${controlFile}\n` +
        `（Koishi 得先跑起来，它启动时会写这个文件；或者用 --port/--token 直接指定）`
    )
    process.exit(2)
  }
  return {
    port: Number(portArg || info.port || 5140),
    host: info.host || '127.0.0.1',
    route: info.path || '/qqbot/guard',
    token: String(tokenArg || info.token || ''),
  }
}

const info = loadInfo()

function call(query) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams({ ...query, token: info.token }).toString()
    const req = http.request(
      {
        host: info.host === '::' ? '127.0.0.1' : info.host,
        port: info.port,
        path: `${info.route}?${qs}`,
        method: 'GET',
        timeout: 8000,
      },
      (res) => {
        let raw = ''
        res.on('data', (c) => (raw += c))
        res.on('end', () => {
          let data
          try {
            data = JSON.parse(raw)
          } catch {
            return reject(new Error(`返回不是 JSON（HTTP ${res.statusCode}）：${raw.slice(0, 200)}`))
          }
          resolve({ status: res.statusCode, data })
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('请求超时（Koishi 在跑吗？）')))
    req.on('error', reject)
    req.end()
  })
}

const mark = (state) => (state === 'mute' ? '🔇 静默' : state === 'allow' ? '🔊 放行' : state)

function printStatus(d) {
  console.log(
    `默认策略：${d.defaultPolicy === 'silent' ? '白名单外一律静默（新群绝对安全）' : '默认放行'}｜` +
      `预置白名单：[${(d.allowGroups || []).join(', ') || '空'}]｜预置黑名单：[${(d.muteGroups || []).join(', ') || '空'}]`
  )
  if (!d.groups?.length) {
    console.log('没有被显式设置过的群')
    return
  }
  console.log('显式设置过的群：')
  for (const g of d.groups) {
    console.log(
      `  ${mark(g.state)}  群 ${g.groupId}｜${g.via || '?'}｜${g.operatorId || '?'}｜${g.updatedAt || '-'}${g.reason ? `｜${g.reason}` : ''}`
    )
  }
}

async function main() {
  const map = { mute: 'mute', allow: 'allow', reset: 'reset', status: 'status', list: 'status' }
  if (cmd === 'check') {
    if (!groupId) throw new Error('check 要带群号')
    const { data } = await call({ action: 'status' })
    const hit = (data.groups || []).find((g) => String(g.groupId) === String(groupId))
    const blocked = hit ? hit.state === 'mute' : data.defaultPolicy === 'silent' && !(data.allowGroups || []).includes(String(groupId))
    console.log(
      `群 ${groupId}：${blocked ? '🔇 现在不会回复' : '🔊 会正常回复'}` +
        (hit ? `（显式 ${hit.state}）` : `（走默认策略 ${data.defaultPolicy}）`)
    )
    return
  }
  const action = map[cmd]
  if (!action) throw new Error(`不认识的命令：${cmd}（可用：status/mute/allow/reset/check）`)
  if ((action === 'mute' || action === 'allow' || action === 'reset') && !groupId) {
    throw new Error(`${cmd} 要带群号，例如：node tools/guard.cjs ${cmd} 454444539`)
  }
  const { data, status } = await call({ action, groupId, reason, by: 'script' })
  if (status !== 200 || !data.ok) {
    console.error(`失败（HTTP ${status}）：${data.error || JSON.stringify(data)}`)
    process.exit(1)
  }
  if (action === 'status') {
    printStatus(data)
    return
  }
  const g = (data.groups || []).find((x) => String(x.groupId) === String(groupId))
  console.log(
    action === 'reset'
      ? `群 ${groupId}：设置已删除，回到默认策略（${data.defaultPolicy}）`
      : `群 ${groupId}：${mark(data.state)}${g?.reason ? `（${g.reason}）` : ''}`
  )
  console.log('—— 当前全量 ——')
  printStatus({ ...data })
}

main().catch((e) => {
  console.error(`出错：${e.message}`)
  process.exit(1)
})
