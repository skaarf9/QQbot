# 23 —— OneBot 断线后的「静默重连死锁」

> **2026-10-02 22:28:59 实际发生，22:56 定位并恢复，23:39 修复上线。**
> 症状一句话：**NapCat 掉登录再登回来之后，机器人永远不回话了，而 Koishi 日志里连一条报错都没有。**
> 这不是配置问题，也不是 NapCat 的问题 —— 是 `koishi-plugin-adapter-onebot` 与 `@satorijs/core`
> 两层的 `close` 监听器**执行顺序**叠加出的一个真实 bug：**重连被排进了队列，然后被自己的下一个监听器废掉。**
>
> ✅ **现已修复**：自写 `koishi-plugin-onebot-watchdog`（看门狗 + 心跳探活 + 卡死判定），
> 已在测试台 A/B 验证（**关掉它 → 98 秒死寂复现事故；开着它 → 15 秒自愈**），并已上线生产。

---

## 1. 症状与第一反应（以及为什么第一反应会错）

用户观察到的：群里发消息，机器人毫无反应；中间 NapCat 掉过一次登录，重新登录后依然不回话。

最容易走错的两步：

1. **以为 NapCat 没登录好。** 去翻 NapCat/QQ —— 它是好的。
2. **以为 Koishi 崩了。** 进程活着、5140 在听、日志零 `[E]` —— 看起来一切正常。

真相是：**Koishi 活着，但它和 NapCat 之间的那条 WebSocket 已经断了，而且永远不会自己接回来。**

---

## 2. 五分钟定位流程（可复用）

「机器人不回话」有**两个完全不同的故障面**，第一步就是把它们分开：

```powershell
# ① NapCat 侧健康吗？——绕开 Koishi，直连它的 OneBot 端点
cd D:\deepseek\QQbot
node --no-warnings tools\napcat-probe.cjs info
#   能打出 get_login_info / 群列表 → NapCat 健康，问题在 Koishi 侧，继续 ②
#   连不上 / 401                        → NapCat 侧的问题（没起来 / token 不符 / 掉登录）

# ② Koishi 侧到底连上没有？——看有没有一条到 3001 的 TCP 连接
Get-NetTCPConnection -RemotePort 3001 -ErrorAction SilentlyContinue
#   有 Established → 链路在，问题在别处（guard / 触发词 / 模型）
#   什么都没有     → 适配器没连上，看 ③

# ③ 日志里最后一次连上是什么时候？
$f='D:\deepseek\QQbot\koishi-app\tools\logs\prod-<日期>.log'
Get-Content $f | Where-Object { $_ -notmatch 'sqlite >' } | Select-Object -Last 120
#   找 'adapter connect to server' / 'websocket closed with' / 'will retry in'
```

**这次的关键证据**：`Get-NetTCPConnection -RemotePort 3001` **一条连接都没有**（连 `SYN_SENT` 都没有），
而手动探活 PASS —— 说明 Koishi **根本没在尝试连接**，不是"连了但连不上"。

日志里则是这一幕（注意时间）：

```
22:28:56 [D] onebot [receive] { ... notice_type: 'bot_offline', message: '你的账号当前登录已失效，请重新登录。' }
22:28:59 [D] onebot [receive] { ... meta_event_type: 'heartbeat', status: { online: false, good: true } }
22:28:59 [D] adapter websocket closed with 1006
22:28:59 [W] adapter failed to connect to ws://127.0.0.1:3001/, code: 1006, will retry in 5s...
        ← 之后 27 分钟：零重试、零报错、零连接
```

**「说好 5 秒后重试，却再也没动静」** —— 这一条就是全部线索。

---

## 3. 根因：两个 `close` 监听器的顺序 + 一个 `getActive()` 守卫

### 3.1 第一层：core 的 WS 客户端

`@satorijs/core/src/adapter.ts`（`WsClientBase`）：

```ts
const reconnect = (initial: boolean, message: string) => {
  if (!this.getActive() || connectionId !== this.connectionId) return   // ← 守卫 (A)
  let timeout = retryInterval                    // 默认 5s
  if (retryCount >= retryTimes) {                // 默认 6 次
    if (initial) return this.setStatus(Status.OFFLINE, new Error(message))
    else timeout = retryLazy                     // 默认 60s
  }
  retryCount++
  this.setStatus(Status.RECONNECT)
  logger.warn(`${message}, will retry in ${Time.format(timeout)}...`)
  setTimeout(() => {
    if (!this.getActive() || connectionId !== this.connectionId) return // ← 守卫 (B)
    connect()
  }, timeout)
}

const connect = async (initial = false) => {
  logger.debug('websocket client opening')       // ← 只要重试真的发生，就一定有这行
  socket = await this.prepare()
  socket.addEventListener('close', ({ code, reason }) => {              // ← 监听器【先】注册
    logger.debug(`websocket closed with ${code}`)
    reconnect(initial, ...)
  })
  socket.addEventListener('open', () => {
    this.accept(socket)                          // ← 适配器的 close 监听器在这里【后】注册
  })
}
```

`getActive()` 来自 `WsClient`（`adapter.ts:124-131`）：

```ts
getActive() { return this.bot.isActive }
setStatus(status, error) { this.bot.status = status; this.bot.error = error }
```

而 `bot.isActive`（`@satorijs/core/src/bot.ts:125-127`）是：

```ts
get isActive() {
  return this._status !== Status.OFFLINE && this._status !== Status.DISCONNECT
}
```

`Status`（`@satorijs/protocol/src/index.ts:318-324`）：`OFFLINE=0, ONLINE=1, CONNECT=2, DISCONNECT=3, RECONNECT=4`。
→ **`RECONNECT` 仍是 active，`OFFLINE` 不是。**

### 3.2 第二层：onebot 适配器的 `close` 监听器

`koishi-plugin-adapter-onebot/lib/index.js:681-684`：

```js
socket.addEventListener("close", () => {
  delete bot.internal._request
  bot.offline()          // ← 把 status 置成 OFFLINE(0)，即 isActive = false
})
```

### 3.3 合起来：一次断线发生了什么

`socket.addEventListener` 的监听器**按注册顺序触发**。core 的 `close` 监听器在 `connect()` 里
**先**注册；适配器的 `close` 监听器要等 `open` 时 `accept(socket)` 被调用才注册，所以**在后**。

于是 22:28:59 那一刻：

| 步 | 谁 | 做什么 | 此时 `bot.status` |
|---|---|---|---|
| 1 | core 的 close 监听器 | `logger.debug('websocket closed with 1006')` | 1 (ONLINE) |
| 2 | ↳ `reconnect()` 守卫 (A) | `getActive()` 还是 **true** → **通过** | 1 |
| 3 | ↳ | 算出 `timeout=5s`，`setStatus(RECONNECT)`，**打印那句 `will retry in 5s`** | 4 |
| 4 | ↳ | `setTimeout(重试, 5000)` —— **重试确实被排进了队列** | 4 |
| 5 | onebot 的 close 监听器 | `bot.offline()` | **0 (OFFLINE)** |
| 6 | 5 秒后，定时器触发 | 守卫 (B) `if (!this.getActive() ...) return` | 0 → **静默 return** |

**重试在第 4 步被排进去，在第 5 步被作废，在第 6 步一声不响地丢掉。**

这就是为什么日志里**恰好只有一条警告**：
- 有那条警告 → 说明守卫 (A) 在那一刻通过了（`bot.offline()` 还没执行）；
- 之后再无任何 `websocket client opening` → 说明守卫 (B) 每次都拦下了（`bot.offline()` 已经执行了）。

而且 `retryCount` 只加了一次，**连 `retryLazy`（60s 那档）都轮不到** —— 它是一次性的，不是"退避变慢"，是**彻底停止**。

### 3.4 一句话总结

> 适配器在断线时把 bot 标成 `OFFLINE`，而 core 的重连逻辑**恰好以"bot 是否 active"作为重连前提**。
> 两者单独看都合理，叠在一起就成了：**断线 → 标记下线 → 拒绝重连**。
> 一旦走到这里，**重启是唯一的出路**。

---

## 4. 影响面（为什么必须当回事）

- **不是"慢一点恢复"，是"永远不恢复"。** 没有超时、没有上限、没有兜底 —— 静默等死。
- **零报错。** 监控如果只看 `[E]`，完全发现不了。进程健康、端口在听、心跳…… 心跳也停了，但没人看。
- **任何一次 NapCat 抖动都会触发**：掉登录、QQ 被挤下线、NapCat 重启、网络瞬断。
  本次就是 NapCat 在 22:29:03 重启（`QQ.exe` PID 变化）触发的。
- **模型层的兜底队列救不了它** —— 队列管的是"上游模型挂了换一个模型"，
  而这里**消息根本没进到 ChatLuna**，四个组一个都不会被调用。

---

## 5. 修复（已实施：看门狗 + 探活 + 卡死判定）

**结论：已按方案 B 实施并验证上线。**

**插件**：`koishi-app/external/koishi-plugin-onebot-watchdog`（自写，约 200 行）
**生产配置**：`koishi.yml` 里的 `onebot-watchdog:wdg001`

### 5.1 它做三件事，对应三种断线

| # | 机制 | 治什么 | 关键点 |
|---|---|---|---|
| ① | **状态事件重连** | 正常 `close`（NapCat 死掉 / 掉登录） | 监听 `bot-status-updated`，一旦某个 bot 非 active，延迟 `recoverDelay` 调 `bot.start()`。此刻状态**恰好**是 OFFLINE，`start()` 开头那句 `if (this.isActive) return` 挡不住它 → 能走完整重连流程（`adapter.connect()` → `WsClient.start()` → `connectionId++` → 全新连接），正好绕开那个死掉的守卫 |
| ② | **心跳探活** | **半开连接**：TCP 没断但对端已死，**永远不会触发 `close`** | 只对 `status === ONLINE` 的 bot 定期发带超时的 `getLogin()`；连续 `probeFailures` 次超时就判死 |
| ③ | **连接卡死判定** | **握手卡死**：对端接受了 TCP 却不应答 | 状态卡在 `CONNECT/RECONNECT` 超过 `onlineTimeout` 就再踹一脚。这种连接**既不会 close、也到不了 ONLINE**，①②都够不着它 |

> **②③ 必须先 `stop()` 再 `start()`。** 半开/卡死时状态还是 active，
> 直接 `start()` 会被开头那句 `if (this.isActive) return` 吃掉 —— 所以先 `stop()` 把状态打回 OFFLINE。

> **限流**：`minRecoverInterval`（生产 30s）。连续失败时 core 自己 6 次重试（约 30s）后会 `setStatus(OFFLINE)`，
> 看门狗会再触发一次 —— 这是**有意为之**（等于持续重试，NapCat 一回来就接上），但不会打转。

### 5.2 实施中踩到的坑

`chatluna-sandbox` 会注册一个**模拟 bot `onebot:20001`**（源码里的 `DEFAULT_BOT_ID`，全内存、0ms 应答）。
它不是真连接，不该被重连 → 用 `excludeSids: ['onebot:20001']` 排除。
**YAML 里这个值必须加引号**：`onebot:20001` 带冒号，不加引号会被解析成映射。

（另外记一笔：`koishi.yml` 由 Koishi 自己回写，**写进去的注释会被吃掉** ——
所以配置的说明只能放文档里，别指望留在 yml 里。）

### 5.3 评估过但没采用

- **`ws-reverse`**：改成 NapCat 主动连 Koishi（`WsServer` 不走 `WsClientBase`，能绕开本 bug）。
  但要改 NapCat 的网络配置 + 重验鉴权（`x-self-id` / `x-client-role` 头），**动静比看门狗大得多**。
- **fork 适配器**：直接改上游 `close` 监听器的顺序、或去掉那次 `bot.offline()`。
  能治本，但会把我们**钉死在一个 fork 上**，与「先本地 → 再市场 → 最后自写」的取舍相悖。

---

## 6. 复现与验证（已做，A/B 对照）

### 6.1 为什么不拿真 NapCat 试
杀掉 NapCat = QQ 掉登录，要重新扫码，还可能连累生产。所以测试台在中间插一个**可控 TCP 代理**来伪造断线，
**完全不碰 NapCat 和生产**。

### 6.2 测试台怎么起

```powershell
cd D:\deepseek\QQbot\koishi-app
# ① 伪 OneBot（空剧本：只立服务端，不播任何事件）
node --no-warnings tools\fake-onebot.mjs tools\scenarios\00-idle.json --port 3002 --imgPort 3003
# ② 断线模拟器：代理 3012 → 3002，控制口 3013
node --no-warnings tools\ws-link-sim.cjs --listen 3012 --target 3002 --control 3013
# ③ 把 koishi-test 的 adapter endpoint 改成 ws://127.0.0.1:3012，再起测试实例
```

> 注：`fake-onebot.mjs` 的参数解析把「第一个不以 `--` 开头的参数」当剧本路径，
> 所以 `--port` 传值前**必须先给剧本** —— `scenarios\00-idle.json`（空 steps）就是干这个用的。

代理控制口（`POST`，默认 `http://127.0.0.1:3013`）：

| 命令 | 制造什么 |
|---|---|
| `/cut?down=12000` | **干净断开 + 端口下线 12 秒**（对端进程消失的样子）→ 会触发 `close` |
| `/freeze` / `/resume` | **半开连接**：socket 保持打开，两个方向都不再转发一个字节 → **永不触发 `close`** |
| `GET /state` | 当前是否冻结、活连接数、是否在监听 |

### 6.3 A/B 对照结果（同一实验，只差看门狗开关）

**A. 关掉看门狗（`enabled: false`）＝ 复现线上事故**

```
23:28:44  adapter websocket closed with 1006
23:28:44  adapter failed to connect ... will retry in 5s...
          ↓ 端口 23:28:56 就恢复了
          ↓ 之后 98 秒：零重试、零连接，代理侧 connections: 0
```

**与 22:28 那次生产事故一字不差** —— 这一次同时证明了两件事：
**诊断是对的**，而且**看门狗就是让它活过来的那个原因**。

**B. 开看门狗（`/cut`）**

```
23:17:39  websocket closed with 1006 / will retry in 5s...
23:17:44  adapter websocket client opening              ← 重试这一次真的跑了
23:17:44  onebot-watchdog 已发起重连（当前 CONNECT）
23:17:54  adapter connect to server: ws://127.0.0.1:3012/
23:17:54  onebot-watchdog ✓ 重连成功，已恢复 ONLINE      ← 全程 15 秒，无人工干预
```

**C. 半开连接（`/freeze`）—— 注意全程没有任何 `close`**

```
23:23:50  [D] onebot [request] get_login_info     ← 探针发出，石沉大海
23:23:55  探活失败 1/2 次（5016ms）：探活超时 5000ms
23:24:05  探活失败 2/2 次（5015ms）
23:24:10  心跳探活连续失败（半开连接）—— 连接状态还是 ONLINE，先 stop() 断开旧连接
23:24:40  连接卡在 CONNECT 超过 20.0s —— 5.0s 后自动重连     ← ③ 卡死判定生效
23:25:33  （解冻）
23:25:45  adapter connect to server → ✓ 重连成功，已恢复 ONLINE
```

### 6.4 现场怎么快速判断有没有中这个坑

```powershell
Get-NetTCPConnection -RemotePort 3001 -ErrorAction SilentlyContinue   # 空 ⇒ 适配器没连上
node --no-warnings tools\napcat-probe.cjs info                        # 通过 ⇒ NapCat 侧健康 ⇒ 死的是 Koishi 侧
```

---

## 7. 本次处置记录

| 时间 | 事件 |
|---|---|
| 22:28:56 | NapCat 报 `bot_offline`（登录失效） |
| 22:28:59 | WS 断（code 1006），Koishi 打印唯一一条 `will retry in 5s` |
| 22:29:03 | NapCat（`QQ.exe`）重启，用户重新登录 —— **NapCat 侧已恢复** |
| 22:29:04 起 | 重试被守卫静默丢弃，**此后 27 分钟零连接** |
| 22:55 | 定位：无 TCP 连接 + `tools/napcat-probe.cjs info` 通过 → 判定 Koishi 侧死锁 |
| 22:56:09 | 重启生产恢复（**PID 8092**）→ `adapter connect to server: ws://127.0.0.1:3001/` |
| 22:56:40 | 心跳恢复 `status: { online: true, good: true }` |
| 23:16–23:26 | 写好看门狗后在测试台做 A/B 验证：干净断开 ✅ / 半开连接 ✅ / 卡死判定 ✅ / **反证复现事故** ✅ |
| 23:33 | 看门狗首度上线生产（`onebot-watchdog:wdg001`） |
| 23:39 | 补 `excludeSids` 排除沙箱模拟 bot `onebot:20001` 后重启 —— **当前生产 PID 21004**，只照看 `onebot:2178517838` |

证据日志留档：`.scratch/prod-2026-10-02.ws-dead.log`（事故现场）、
`.scratch/watchdog-test.log`（A/B 验证全过程）。

---

## 8. 留给后续的教训

1. **"说好重试却再没动静"是强信号** —— 有承诺、无后续，几乎一定是守卫/条件把重试吃掉了。
2. **零 `[E]` 不代表健康。** 这次全程无报错，故障却在"成功路径"上。健康检查要看**连接数和心跳**，不能只看错误数。
3. **两个各自合理的模块叠在一起可能互锁。** 适配器"断线就标记下线" + core"非 active 就不重连" = 死锁。
4. **先分层再定位。** `tools/napcat-probe.cjs info` 把「NapCat 侧 vs Koishi 侧」一刀切开，省掉大量猜测。
5. **"断开"不止一种。** 正常 close / 半开连接 / 握手卡死，三种表现不同、探测手段也不同 ——
   只治最直观的第一种会留下两个更隐蔽的洞。**卡死那条是写测试时才发现的**，光靠读代码没想到。
6. **自愈逻辑必须能被反证。** 只说"装上就好了"不算数：**把开关关掉、复现出故障**，
   才算证明它就是生效的那个原因。这次 A/B 对照（同一条命令，98 秒死寂 vs 15 秒自愈）就是那个证明。
7. **兜底代码自己也要有日志。** 看门狗每次动作都打一行（`已发起重连` / `✓ 重连成功` / `探活失败 N/M`），
   所以"它到底有没有干活"是**看得见**的 —— 否则就会重演本次事故那种"零报错、静默死"。`
