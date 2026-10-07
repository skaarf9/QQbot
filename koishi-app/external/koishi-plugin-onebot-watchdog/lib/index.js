/**
 * koishi-plugin-onebot-watchdog —— OneBot 断线自动重连
 *
 * 需求（用户原话）：
 *   「这件事还会再发生 —— 要不要我彻底修掉？」→ 选 B：看门狗 + 心跳探活。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ★ 为什么必须自写（按 [硬约束 第 0 条](../../../../docs/05-硬约束.md)「先本地 → 再市场 → 最后自写」）：
 *   - **本地已装**：无。
 *   - **市场**：没有能治这个病的插件 —— 因为这不是"缺功能"，是 upstream 的**逻辑 bug**。
 *   - **自写**：所以这里只写**最薄的一层兜底**，不碰上游代码、不改适配器，
 *     只在外面看着它、掉线了就把它拉起来。
 *
 * ★ 它治的是什么病（完整分析见 [docs/23](../../../../docs/23-OneBot断线与静默重连死锁.md)）：
 *   `koishi-plugin-adapter-onebot`（`lib/index.js:683`）在 socket `close` 时调 `bot.offline()`，
 *   把 status 置成 OFFLINE；而 `@satorijs/core` 的重连守卫恰好是
 *   `if (!this.getActive()) return`（`adapter.ts:57` 和 **`:72`**）。
 *   两个 `close` 监听器**按注册顺序**触发：core 的先跑（此刻还 active，于是算出"5 秒后重试"
 *   并打印了**唯一**那条 `will retry in 5s`），适配器的后跑（`bot.offline()`）。
 *   于是**重试被排进队列、又被自己的下一个监听器作废**，5 秒后静默 return。
 *   结果：**恰好一条警告，此后永不重连、零报错。**
 *
 * ★ 本插件做两件事，对应两种断线：
 *   ① **状态事件重连**（治"正常 close"）—— 监听 `bot-status-updated`，
 *      一旦某个 bot 变成非 active，延迟几秒调 `bot.start()`。
 *      `bot.start()` 开头是 `if (this.isActive) return`，而此刻恰好是 OFFLINE，
 *      所以能真正走完整的重连流程（`adapter.connect()` → `WsClient.start()`
 *      → `connectionId++` → 全新连接），正好绕开那个死掉的守卫。
 *   ② **心跳探活**（治"半开连接"）—— TCP 没断但对端已死时**根本不会触发 close**，
 *      状态会一直停在 ONLINE，① 永远等不到。所以再定期主动发一个带超时的
 *      `getLogin()`：连续失败 N 次就判定连接已死，**先 `stop()` 把状态打回 OFFLINE
 *      再 `start()`**（少了 stop 这一步，`start()` 会被 `if (isActive) return` 直接吃掉）。
 *
 * ★ 限流：连续失败时 core 自己 6 次重试（约 30s）后会 `setStatus(OFFLINE)`，
 *   本插件会再触发一次 —— 这是**有意为之**（等于持续重试，NapCat 一回来就能接上），
 *   但 `minRecoverInterval` 保证两次重连之间不会打转。
 *
 * ★ 只在 `status === ONLINE(1)` 时探活：CONNECT(2) 是"正在连"，这时探活必然失败，
 *   会误判。ONLINE 才代表 `accept()` 跑完、`bot.initialize()` 成功。
 */

const { Schema } = require('koishi')

const name = 'onebot-watchdog'
const inject = { required: [], optional: [] }

// @satorijs/protocol 的 Status 是个 const enum（运行时被擦除），这里自带一份，避免依赖传递包。
const STATUS_NAMES = { 0: 'OFFLINE', 1: 'ONLINE', 2: 'CONNECT', 3: 'DISCONNECT', 4: 'RECONNECT' }
const STATUS_ONLINE = 1
const statusName = (s) => STATUS_NAMES[s] ?? `#${s}`

const Config = Schema.intersect([
  Schema.object({
    enabled: Schema.boolean().default(true).description('总开关。关掉后本插件不做任何事。'),
    platforms: Schema.array(Schema.string()).default(['onebot'])
      .description('只照看这些平台的 bot。'),
    excludeSids: Schema.array(Schema.string()).default([])
      .description('不照看这些 bot，格式 `platform:selfId`。例如 `chatluna-sandbox` 会注册一个模拟 bot `onebot:20001`（全内存、0ms 应答），它不是真连接，不该被重连。'),
  }).description('开关'),

  Schema.object({
    recoverDelay: Schema.natural().role('ms').default(8000)
      .description('发现掉线后等多久再重连（给 NapCat 一点重启/重登的时间）。'),
    minRecoverInterval: Schema.natural().role('ms').default(30000)
      .description('同一个 bot 两次重连之间的最小间隔（限流，防打转）。'),
  }).description('重连'),

  Schema.object({
    probeEnabled: Schema.boolean().default(true)
      .description('心跳探活：治"半开连接"（TCP 没断但对端已死，不会触发 close，状态一直停在 ONLINE）。'),
    probeInterval: Schema.natural().role('ms').default(60000).description('探活间隔。'),
    probeTimeout: Schema.natural().role('ms').default(15000).description('单次探活超时（超时即算失败）。'),
    probeFailures: Schema.natural().default(2).description('连续失败几次才判定连接已死。'),
    onlineTimeout: Schema.natural().role('ms').default(45000)
      .description('连接卡在 CONNECT/RECONNECT 超过这么久就强制重来（治"握手卡死"：对端接受 TCP 却不应答，既不会 close 也到不了 ONLINE）。设 0 关闭。注意要留够 core 自己 6 次重试的时间（默认 6×5s=30s）。'),
  }).description('连接健康检查'),
])

function apply(ctx, config) {
  if (!config.enabled) {
    ctx.logger(name).info('已按配置关闭（enabled: false）')
    return
  }

  const logger = ctx.logger(name)

  /** sid -> { timer, lastRecoverAt, busy, failures, recovering } */
  const state = new Map()
  function st(bot) {
    let s = state.get(bot.sid)
    if (!s) {
      s = {
        timer: null,
        lastRecoverAt: 0,
        busy: false,
        failures: 0,
        pendingConfirm: false,
        connectingSince: 0,
        /** 我们自己调 stop() 的时刻：用来屏蔽"自己造成的"OFFLINE 事件 */
        selfStopAt: 0,
        /** 下一次 recover 是否强制（探活判死时用：那时 bot.status 还是 ONLINE，但连接已经死了） */
        forceNext: false,
      }
      state.set(bot.sid, s)
    }
    return s
  }

  const wanted = (bot) =>
    config.platforms.includes(bot.platform) &&
    !config.excludeSids.includes(bot.sid) &&
    !bot.parent

  const secs = (ms) => `${(ms / 1000).toFixed(1)}s`

  function scheduleRecover(bot, reason, force = false) {
    const s = st(bot)
    if (s.timer) return // 已经排了一个，别叠
    if (s.busy) return // 正在重连，等它跑完（跑完会自己复查状态）
    if (force) s.forceNext = true
    const since = Date.now() - s.lastRecoverAt
    const wait = Math.max(config.recoverDelay, config.minRecoverInterval - since)
    logger.warn(`[${bot.sid}] ${reason} —— ${secs(wait)} 后自动重连`)
    s.timer = ctx.setTimeout(() => {
      s.timer = null
      recover(bot, reason)
    }, wait)
  }

  async function recover(bot, reason) {
    const s = st(bot)
    if (s.busy) return
    const force = s.forceNext
    s.forceNext = false

    // ★★ 2026-10-03 修的"30 秒自杀循环"（真事故，不是理论）：
    //   现象是恢复后又每 30s 断一次，日志里 `先 stop() 断开旧连接` 后面紧跟
    //   `status === ONLINE`：
    //     17:15:06 ✓ 重连成功，已恢复 ONLINE
    //     17:15:36 状态变成 OFFLINE —— 连接状态还是 ONLINE，先 stop() 断开旧连接
    //   成因是**自己踩自己**：recover() 里 `await bot.stop()` 会让适配器异步 emit
    //   一次 bot-status-updated(OFFLINE)，而那次事件到达时 `s.busy` 已经落回 false
    //   （start() 是发起即返回的，recover 早就跑完了）→ 又排一个 30s 后的重连 →
    //   30s 后把刚连好的健康连接再掐一次，循环自我维持。
    //   所以这里立一条硬规矩：**bot 已经是 ONLINE 就不许再 stop()**。
    //   唯一的例外是探活判死（半开连接）——那时 status 也停在 ONLINE 但连接其实死了，
    //   由 scheduleRecover(..., true) 显式 force 放行。
    if (bot.isActive && bot.status === STATUS_ONLINE && !force) {
      s.pendingConfirm = false
      logger.info(`[${bot.sid}] 连接已是 ONLINE，取消这次重连（${reason}）`)
      return
    }

    s.busy = true
    s.pendingConfirm = true
    s.connectingSince = 0
    s.lastRecoverAt = Date.now()
    try {
      if (bot.isActive) {
        // 半开连接：状态还停在 ONLINE。必须先 stop() 把状态打回 OFFLINE，
        // 否则下面 start() 开头的 `if (this.isActive) return` 会直接吃掉这次重连。
        // ★ 记下时刻：这次 stop() 造成的 OFFLINE 事件不许再排下一次重连。
        s.selfStopAt = Date.now()
        logger.info(`[${bot.sid}] ${reason} —— 连接状态还是 ${statusName(bot.status)}，先 stop() 断开旧连接`)
        await bot.stop()
      }
      await bot.start()
      if (bot.status === STATUS_ONLINE) {
        logger.info(`[${bot.sid}] 重连成功，已恢复 ONLINE`)
        s.pendingConfirm = false
      } else {
        logger.info(`[${bot.sid}] 已发起重连（当前 ${statusName(bot.status)}，等连上确认）`)
      }
    } catch (error) {
      logger.error(`[${bot.sid}] 重连抛错：${error?.message ?? error}`)
    } finally {
      s.busy = false
    }
    // start() 是"发起即返回"的：socket 还没开，失败要等 core 的 6 次重试跑完
    // 才会掉到 OFFLINE。那次事件会被 busy 挡掉，所以这里补一次复查。
    if (!bot.isActive) scheduleRecover(bot, '重连后仍未连上')
  }

  // ── ① 状态事件重连 ────────────────────────────────────────────────────
  ctx.on('bot-status-updated', (bot) => {
    if (!wanted(bot)) return
    const s = st(bot)
    if (bot.isActive) {
      if (bot.status === STATUS_ONLINE) {
        s.failures = 0
        if (s.pendingConfirm) {
          s.pendingConfirm = false
          logger.info(`[${bot.sid}] ✓ 重连成功，已恢复 ONLINE`)
        }
      }
      return
    }
    // 这里就是那个 bug 的落点：状态被适配器打成了 OFFLINE，core 的重连守卫会因此静默 return。
    // ★ 但如果是**我们自己刚 stop()** 造成的 OFFLINE，就别再排了：
    //   recover() 的尾巴（`if (!bot.isActive) scheduleRecover(...)`）会按真实结果决定要不要重试，
    //   这里再排一次就是上面注释里那个 30s 自杀循环的燃料。
    if (s.selfStopAt && Date.now() - s.selfStopAt < 5000) {
      logger.debug(`[${bot.sid}] 这次 OFFLINE 是本次重连自己 stop() 造成的，不重复排重连`)
      return
    }
    scheduleRecover(bot, `状态变成 ${statusName(bot.status)}（core 自己不会重连了）`)
  })

  // ── ② 心跳探活（治半开连接）────────────────────────────────────────────
  if (config.probeEnabled || config.onlineTimeout) {
    const probe = async (bot) => {
      const t0 = Date.now()
      let timer
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`探活超时 ${config.probeTimeout}ms`)),
          config.probeTimeout,
        )
      })
      try {
        // 带超时的 getLogin()：socket 若已半开，_request 会一直等 responseTimeout(默认 60s)，
        // 我们不等那么久 —— 超时即判死。落败的那个 promise 由 race 兜住，不会变成未处理拒绝。
        await Promise.race([bot.getLogin(), timeout])
        return { ok: true, ms: Date.now() - t0 }
      } catch (error) {
        return { ok: false, ms: Date.now() - t0, error: error?.message ?? String(error) }
      } finally {
        clearTimeout(timer)
      }
    }

    ctx.setInterval(async () => {
      for (const bot of ctx.bots) {
        if (!wanted(bot)) continue
        const s = st(bot)

        // ── ONLINE：真正连上了，用心跳探活确认它是不是"假活"（半开连接）──
        if (bot.status === STATUS_ONLINE) {
          s.connectingSince = 0
          if (!config.probeEnabled || s.busy || s.timer) continue
          const r = await probe(bot)
          if (r.ok) {
            if (s.failures) logger.info(`[${bot.sid}] 探活恢复正常（${r.ms}ms）`)
            s.failures = 0
            logger.debug(`[${bot.sid}] 探活正常（${r.ms}ms）`)
          } else {
            s.failures++
            logger.warn(
              `[${bot.sid}] 探活失败 ${s.failures}/${config.probeFailures} 次（${r.ms}ms）：${r.error}`,
            )
            if (s.failures >= config.probeFailures) {
              s.failures = 0
              // ★ force=true：半开连接时 status 还停在 ONLINE，必须绕开 recover() 里
              //   "已是 ONLINE 就不许 stop()" 那条守卫。
              scheduleRecover(bot, '心跳探活连续失败（半开连接）', true)
            }
          }
          continue
        }

        // ── 非 ONLINE 且非 active：掉线，交给状态事件那条路 ──
        if (!bot.isActive) {
          s.connectingSince = 0
          continue
        }

        // ── CONNECT(2)/RECONNECT(4)：正在连。正常只停留几百毫秒 ──
        // 停太久说明握手卡住了（对端接受了 TCP 却不应答）：这种连接**既不会 close、
        // 也永远到不了 ONLINE**，状态事件和探活都够不着它，必须主动再踹一脚。
        if (!config.onlineTimeout || s.busy || s.timer) continue
        if (!s.connectingSince) {
          s.connectingSince = Date.now()
          continue
        }
        if (Date.now() - s.connectingSince > config.onlineTimeout) {
          s.connectingSince = 0
          scheduleRecover(bot, `连接卡在 ${statusName(bot.status)} 超过 ${secs(config.onlineTimeout)}`)
        }
      }
    }, config.probeInterval)
  }

  const watching = ctx.bots.filter(wanted).map((b) => b.sid)
  logger.info(
    `已挂载：看门狗 + ${config.probeEnabled ? `探活（每 ${secs(config.probeInterval)}，超时 ${secs(config.probeTimeout)}，连续 ${config.probeFailures} 次判死）` : '探活已关'}` +
      ` + ${config.onlineTimeout ? `连接卡死判定（${secs(config.onlineTimeout)}）` : '卡死判定已关'}` +
      `；重连延迟 ${secs(config.recoverDelay)}（最小间隔 ${secs(config.minRecoverInterval)}）` +
      (watching.length ? `；当前照看 ${watching.join(', ')}` : '；暂无 bot（等 bot-status-updated）'),
  )
}

module.exports = { name, inject, Config, apply }
