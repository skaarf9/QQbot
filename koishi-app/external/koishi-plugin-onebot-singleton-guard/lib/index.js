/**
 * koishi-plugin-onebot-singleton-guard —— 启动自检：拒绝当"第二个实例"
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ★ 治的是什么病（真事故，不是理论）：
 *   用户看到「群里每条命令都收到两条回复」。
 *   真身是**有两个 Koishi 实例连着同一个 NapCat**：NapCat 的 OneBot WS 服务端把
 *   每条事件**广播**给所有客户端，于是两个实例都处理同一条消息、各回一次。
 *   见 [docs/04 坑 57](../../../../docs/04-踩坑记录.md) 与 [坑 70](../../../../docs/04-踩坑记录.md)。
 *
 * ★ 为什么这件事反复发生（三次了）：
 *   防重复的检查原来只写在 `tools/run-prod.cjs` 里。可是**真正会被敲下回车的那条命令
 *   不是它** —— 文档里的排障启动、`npm start`、以及 agent 用后台 job 起的
 *   `node node_modules\koishi\bin.js start`，全都**绕过**了启动器，直连 Koishi CLI。
 *   更隐蔽的是：新实例抢不到控制台端口时只报一句 `No open ports available`（坑 6），
 *   **适配器却照常连上 NapCat** —— 于是它"半死"着，却照样把每条消息都回一遍。
 *   还有 agent 后台 job 那条路：`job_kill` 只收得掉 pwsh 那一层，node 那棵树会活成
 *   **孤儿**（丢了端口、还连着 NapCat，端口检查对它天然失明）。
 *
 * ★ 所以守卫必须**放进 Koishi 自己的配置里**：插件的 apply() 在所有插件装配时、
 *   在适配器建立连接**之前**跑（`ready` 之前），因此**无论从哪条命令启动**都躲不过它。
 *   判定口径沿用项目里那条已经验证过的："**有没有实例在跑 = 谁连着 NapCat**"
 *   （不是"谁占着控制台端口"），再加一条控制台端口占用作为补充信号。
 *   同一套 netstat 解析在 `tools/run-prod.cjs` 里也有一份 —— 改这里时记得一起看。
 *
 * ★ 但要**分得清"第二个实例"和"无辜的观察者"**：
 *   `tools/napcat-probe.cjs` 会正大光明地连上同一个端点（它只观察、不回消息），
 *   而 [docs/23](../../../../docs/23-OneBot断线与静默重连死锁.md) 里教的排障第一步就是"先跑探针"，
 *   紧接着才去重启 Koishi —— 如果只按"有几个客户端"判，**这条正经流程会被自己拦住**，
 *   连上后的复查还会把刚起来的健康实例当成"后起的那个"给退掉。
 *   所以：只有**看起来像 Koishi 的进程**（`koishi/lib/worker`、`koishi/bin.js`）才算冲突；
 *   命令行明显是别的程序（探针 / 一次性脚本）→ 只告警放行，并把它的命令行打出来给人看。
 *   ★ 认不出身份时**在启动前从保守**（拒绝，并说明认不出），
 *     但在**连上后的复查里从宽**（只告警）—— 后者宁可留着机器人服务，也不能误杀。
 *
 * ★ 退出码 52：Koishi 的 CLI 会 fork worker，worker 非 0 退出时**默认会自动重生**
 *   （`koishi/lib/cli/index.js` 的 `shouldExit()`：51 = 重启，52 = 真退出）。
 *   所以"拒绝启动"必须用 `process.exit(52)`，否则会变成重启死循环。
 *
 * ★ 两种时机：
 *   ① 启动前自检（apply 时，连上之前）—— 覆盖现实中 100% 的场景：人/agent 在已有实例
 *      还在服务时又起了一个。
 *   ② 连上后复查（默认 20s 后）—— 补"两个实例几乎同时启动"这个窄缝。不能让两边都退：
 *      约定**PID 大的（后起的那个）让位**，于是恰好活下来一个。
 *
 * ★ 扫不到就放行（fail-open）：netstat / 命令行查询偶尔失败不该让机器人起不来。
 *   真正的兜底还有 `tools/run-prod.cjs`。
 */

const { Schema } = require('koishi')
const { execFileSync } = require('node:child_process')

const name = 'onebot-singleton-guard'
const inject = { required: [], optional: [] }

/** Koishi CLI 约定的"真退出、别重生"退出码（51 = 重启，52 = 退出） */
const EXIT_REFUSE = 52

/** `netstat -ano -p TCP` 的行格式（与 tools/run-prod.cjs 一致；zh-CN 上状态仍是英文） */
const RE_ESTABLISHED = /^\s*TCP\s+\S+:(\d+)\s+\S+:(\d+)\s+ESTABLISHED\s+(\d+)\s*$/
const RE_LISTENING = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/

/** 认得出是"另一个 Koishi 在跑"的命令行特征（worker 持有 socket，CLI 兜底） */
const RE_KOISHI_PROC = /koishi[\\/]lib[\\/]worker|koishi[\\/]bin\.js|koishi[\\/]lib[\\/]cli/i

const Config = Schema.object({
  enabled: Schema.boolean().default(true)
    .description('总开关。关掉后本插件不做任何事（测试台里跑第二个实例时才需要关）。'),
  enforce: Schema.boolean().default(true)
    .description('发现重复实例时：true = 直接拒绝启动（退出码 52）；false = 只大声报警但放行（排查用，会真的出现两条回复）。'),
  endpoint: Schema.string().default('ws://127.0.0.1:3001')
    .description('要守的 OneBot 端点，必须和 adapter-onebot 的 `endpoint` 一致（测试实例是 ws://127.0.0.1:3002）。'),
  consolePort: Schema.natural().default(5140)
    .description('本实例的控制台 HTTP 端口（生产 5140 / 测试 5141）。被**别的 Koishi** 占着就说明已有一个实例。填 0 关闭这项检查。'),
  recheckDelay: Schema.natural().role('ms').default(20000)
    .description('连上之后隔多久复查一次客户端数（补"几乎同时启动"的窄缝）。填 0 关闭复查。'),
  ignorePids: Schema.array(Schema.natural()).default([])
    .description('这些 PID 不算冲突（例如你自己挂着的抓包/探针进程）。平时留空 —— 非 Koishi 的观察者会被自动识别放行。'),
})

/** ws://127.0.0.1:3001/ → { host, port }；解析不出来返回 null */
function parseEndpoint(endpoint) {
  const text = String(endpoint ?? '').trim()
  const m = /^wss?:\/\/([^/:\s]+)(?::(\d+))?/i.exec(text)
  if (!m) return null
  if (m[2]) return { host: m[1], port: Number(m[2]) }
  return { host: m[1], port: /^wss:/i.test(text) ? 443 : 80 }
}

/**
 * 一次 netstat 拿到两样东西：
 *   clients      —— 连着 OneBot 端口的进程号（ESTABLISHED 才算；对端服务器那条不算，因为它的
 *                   远端端口是随机端口）
 *   consoleOwner —— 占着控制台端口的进程号（LISTENING）
 */
function scanNetstat(onebotPort, consolePort) {
  const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  })
  const clients = new Set()
  let consoleOwner = null
  for (const line of out.split(/\r?\n/)) {
    const est = RE_ESTABLISHED.exec(line)
    if (est) {
      if (Number(est[2]) === onebotPort) clients.add(Number(est[3]))
      continue
    }
    const lis = RE_LISTENING.exec(line)
    if (lis && consolePort && Number(lis[1]) === consolePort) consoleOwner = Number(lis[2])
  }
  return { clients: [...clients].filter((pid) => pid > 0), consoleOwner }
}

/**
 * 查这些 PID 的命令行（只用来**辨认身份**，所以只在"发现有外来客户端"时才跑，
 * 正常启动路径上一次都不会调）。
 * @returns {{ ok: boolean, map: Map<number, string> }} ok=false 表示查询本身失败（身份＝未知）
 */
function commandLines(pids) {
  const ids = [...new Set(pids)].filter((pid) => pid > 0)
  if (!ids.length) return { ok: true, map: new Map() }
  const filter = ids.map((pid) => `ProcessId=${pid}`).join(' OR ')
  const script =
    "$ErrorActionPreference='SilentlyContinue'; " +
    `Get-CimInstance Win32_Process -Filter "${filter}" | ` +
    "ForEach-Object { '' + $_.ProcessId + \"`t\" + $_.CommandLine }"
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', timeout: 8000, windowsHide: true },
    )
    const map = new Map()
    for (const line of out.split(/\r?\n/)) {
      const tab = line.indexOf('\t')
      if (tab < 0) continue
      const pid = Number(line.slice(0, tab).trim())
      if (pid) map.set(pid, line.slice(tab + 1).trim())
    }
    return { ok: true, map }
  } catch {
    return { ok: false, map: new Map() }
  }
}

/**
 * 这个 PID 是谁：
 *   koishi  —— 另一个 Koishi 实例（真冲突）
 *   other   —— 认得出是别的程序（探针 / 一次性脚本；不算冲突）
 *   gone    —— netstat 之后它就没了（不算冲突）
 *   unknown —— 查不到命令行（保守处理）
 */
function classify(pid, lookup) {
  if (!lookup.ok) return 'unknown'
  const cmd = lookup.map.get(pid)
  if (cmd == null) return 'gone'
  return RE_KOISHI_PROC.test(cmd) ? 'koishi' : 'other'
}

const short = (text, n = 150) => {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

function apply(ctx, config) {
  const logger = ctx.logger(name)
  if (!config.enabled) {
    logger.info('已按配置关闭（enabled: false）—— 本实例不查重复实例')
    return
  }

  const target = parseEndpoint(config.endpoint)
  if (!target) {
    logger.warn(`endpoint 解析不了（${config.endpoint}）—— 本次不做重复实例自检`)
    return
  }

  // 自己人：本进程 + 直接父进程（koishi CLI）。自检时它们本来就不该连 NapCat，
  // 但插件被热重载时会带着"自己那条老连接"重跑 apply()，那时候不能把自己当敌人。
  const selfPids = new Set([process.pid, process.ppid].filter(Boolean))
  const ignored = new Set(config.ignorePids ?? [])
  const foreign = (pid) => pid > 0 && !selfPids.has(pid) && !ignored.has(pid)

  /** 把一次快照变成"冲突 / 观察者"两张单子（命令行只在有人可疑时才查） */
  function survey(snapshot) {
    const clients = snapshot.clients.filter(foreign)
    const consoleOwner = foreign(snapshot.consoleOwner) ? snapshot.consoleOwner : null
    const suspects = [...new Set([...clients, consoleOwner].filter(Boolean))]
    const lookup = suspects.length ? commandLines(suspects) : { ok: true, map: new Map() }
    const cmdOf = (pid) => lookup.map.get(pid) ?? ''

    const conflicts = []
    const observers = []
    const push = (list, pid, where, kind) => list.push({ pid, where, kind, cmd: short(cmdOf(pid)) })

    if (consoleOwner) {
      const kind = classify(consoleOwner, lookup)
      // 控制台端口被占：是 Koishi 就说明"另一个实例正在服务"；认不出也从保守（端口被占本身就够糟）；
      // 明确是别的程序则只告警（我们的控制台会起不来，但机器人本身能跑，也不会多出一个客户端）。
      if (kind === 'koishi' || kind === 'unknown') push(conflicts, consoleOwner, `控制台端口 ${config.consolePort}`, kind)
      else if (kind === 'other') push(observers, consoleOwner, `控制台端口 ${config.consolePort}`, kind)
    }
    for (const pid of clients) {
      const kind = classify(pid, lookup)
      // 端点上有客户端：Koishi → 冲突；别的程序（napcat-probe 之类）→ 只告警放行；认不出 → 从保守。
      if (kind === 'koishi' || kind === 'unknown') push(conflicts, pid, `OneBot 端点 ${config.endpoint}`, kind)
      else if (kind === 'other') push(observers, pid, `OneBot 端点 ${config.endpoint}`, kind)
    }
    return { conflicts, observers, lookupOk: lookup.ok }
  }

  function renderConflicts(conflicts, lookupOk) {
    const lines = []
    lines.push('拒绝启动：同一个 OneBot 端点已经有实例在服务 —— 再起一个会让每条命令被回答两次')
    for (const c of conflicts) {
      lines.push(
        `  ${c.where}：PID ${c.pid} 占着/连着` +
          (c.cmd ? `\n      ${c.cmd}` : lookupOk ? '' : '（命令行查不到，按保守处理）'),
      )
    }
    lines.push('  为什么：NapCat 的 WS 服务端把每条事件【广播】给所有客户端，两个实例都会处理同一条消息、各回一次（坑 57 / 坑 70）。')
    lines.push('  怎么收尾：')
    lines.push('    node tools\\run-prod.cjs --check                        # 先看现状（端口谁占着 / NapCat 上有几个客户端）')
    lines.push('    node tools\\run-prod.cjs --takeover --log-level 3       # 重启：连正在服务的旧实例一起收掉再起')
    for (const pid of new Set(conflicts.map((c) => c.pid))) {
      lines.push(`    taskkill /PID ${pid} /T /F                             # 或精确收掉这一棵进程树`)
    }
    lines.push('  确实要故意再起一个（真知道自己在做什么）：把本插件的 enabled 设为 false，或 enforce: false 只告警。')
    return lines
  }

  function renderObservers(observers) {
    const lines = []
    lines.push('提醒：端点上还有非 Koishi 的客户端 —— 它只观察事件、不会回消息，所以不算"第二个实例"，本实例照常启动')
    for (const o of observers) {
      lines.push(`  ${o.where}：PID ${o.pid}${o.cmd ? `（${o.cmd}）` : ''}`)
    }
    lines.push('  （典型是 tools/napcat-probe.cjs。如果那其实是个认不出来的 Koishi，连上后 20s 的复查会兜住。）')
    return lines
  }

  // ── ① 启动前自检 ───────────────────────────────────────────────────────
  let snapshot = null
  try {
    snapshot = scanNetstat(target.port, config.consolePort)
  } catch (error) {
    logger.warn(`netstat 失败（${error?.message ?? error}）—— 跳过重复实例自检（放行）`)
  }

  if (snapshot) {
    const { conflicts, observers, lookupOk } = survey(snapshot)

    if (conflicts.length) {
      for (const line of renderConflicts(conflicts, lookupOk)) logger.error(line)
      if (config.enforce) process.exit(EXIT_REFUSE)
      logger.warn('enforce: false —— 已放行，但每条命令很可能被回答两次')
    } else {
      if (observers.length) for (const line of renderObservers(observers)) logger.warn(line)
      logger.info(
        `启动自检通过：${config.endpoint} 上没有别的 Koishi 客户端` +
          (config.consolePort ? `，控制台端口 ${config.consolePort} 也没被别的 Koishi 占着` : ''),
      )
    }
  }

  // ── ② 连上后复查（补"几乎同时启动"的窄缝）──────────────────────────────
  if (config.recheckDelay > 0) {
    ctx.setTimeout(() => {
      let now
      try {
        now = scanNetstat(target.port, config.consolePort)
      } catch {
        return
      }
      // ★ 这里只认**像 Koishi 的**外来客户端：查不到身份时从宽（宁可留着机器人服务，
      //   也不能因为一个认不出的邻居就把自己退掉）。启动前那道自检已经做过保守判断了。
      const others = now.clients.filter(foreign)
      if (!others.length) return
      const lookup = commandLines(others)
      if (!lookup.ok) {
        logger.warn(`复查时查不到外来客户端的身份（PID ${others.join(', ')}）—— 不动作`)
        return
      }
      const koishiLike = others.filter((pid) => classify(pid, lookup) === 'koishi')
      if (!koishiLike.length) {
        logger.info(`复查：端点上还有 ${others.length} 个非 Koishi 客户端（PID ${others.join(', ')}）—— 不是第二个实例，继续服务`)
        return
      }
      const earliest = Math.min(...koishiLike)
      if (process.pid > earliest) {
        // 后起的那个让位：PID 大小两边看到的是同一组数，判定一致，于是恰好活下来一个。
        logger.error(
          `拒绝继续：${config.endpoint} 上出现了另一个 Koishi 客户端（PID ${koishiLike.join(', ')}），` +
            `本实例 PID ${process.pid} 是后起的那个 —— 主动退出，避免每条命令被回答两次`,
        )
        if (config.enforce) process.exit(EXIT_REFUSE)
      } else {
        logger.warn(
          `复查发现另一个 Koishi 客户端（PID ${koishiLike.join(', ')}）比本实例（PID ${process.pid}）更早就连着了 —— ` +
            '本实例继续服务；如果群里出现两条回复，请去查那个进程（node tools\\run-prod.cjs --check）',
        )
      }
    }, config.recheckDelay)
  }
}

module.exports = { name, inject, Config, apply }
