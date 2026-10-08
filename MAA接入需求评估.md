# MAA / MaaEnd 接入 QQbot —— 需求评估

> 需求原话：「本机已装 maa 和 maa-end，想把功能接进 bot，在群里说一声『帮我清理方舟日常』就自动完成。」
> 本文只做**评估与选路**，不含实现。结论前置，证据在后。

---

## 0. 结论

**可行，且不需要安装任何新软件。** 两个游戏各有一条"被远程驱动"的现成通道：

| 游戏 | 驱动通道 | 状态 |
|---|---|---|
| 明日方舟（MAA） | **MAA 官方远程控制协议** —— MAA 主动轮询我们提供的 HTTP 端点取任务、回报结果 | 你本机 MAA 的配置里已有该功能开关，只是没填端点 |
| 终末地（MaaEnd） | **MXU 内置 Web API**（`http://127.0.0.1:12701/api/...`） | 你的配置里 `webServerEnabled` 已经是 `true` |

而 bot 侧要用的三块能力**本项目里都已经有先例**：ChatLuna 工具注册（7 个自研插件在用）、Koishi HTTP 路由（`chatluna-guard` 在用）、权限分级（`qqbot-auth` 的 authority 1–5）。

所以真正的工程量**不在"能不能通"，而在编排与边界**：谁有资格触发、同一时刻只能跑一个、跑的时候这台电脑还能不能碰、结果怎么回报。

⚠️ **需求里最大的坑不是技术，是物理约束**：终末地那套日常走的是 `Win32-Front` 控制器，`mouse/keyboard = Seize` —— **跑起来会独占你的鼠标键盘，20~60 分钟内这台电脑没法用**。详见 §5。这一条要先拍板，否则做出来也是个不能用的东西。

---

> **实施状态（2026-10-08 同日）**：P1 骨架已落地 —— 新插件 `koishi-plugin-game-auto`，**方舟通道端到端验证通过**
> （rig 25 + 模拟 MAA 客户端：越权被拦 / 触发回执 26ms / 协议往返 200 / 群里收到「跑完了（用时 12 秒）」）；
> **MAA 与模拟器都由 bot 按需拉起**也已实测（rig 26：MuMu 冷启动 23 秒后自动下发任务，全程零人工；见 §7 ⓪ 的落地）。
> 终末地通道代码已写但**未真机验证**，默认 `endfieldEnabled: false`。
> 落地细节、验证证据、实施中踩的 7 个坑见 **[docs/33-游戏自动化接入](docs/33-游戏自动化接入.md)**。

---

## 1. 需求拆解

「群里说一声 → 自动完成」其实是 5 件事，缺一件体验就断：

| # | 子需求 | 说明 | 难度 |
|---|---|---|---|
| **R0** | 前置/独占 | 游戏在跑、模拟器/窗口就绪、同一时刻只允许一个自动化任务 | ★★ 易踩 |
| **R1** | 触发 | 群消息 → 意图（自然语言，不是打指令） | ★ |
| **R2** | 授权 | 谁能喊？群友随便喊就会变成"公共免费代肝机" | ★★ 必须做 |
| **R3** | 执行 | 驱动 MAA / MaaEnd 跑日常 | ★ |
| **R4** | 反馈 | 开跑/进度/跑完/为什么失败，回报到群 | ★★ 容易被限流吃掉 |

---

## 2. 本机现状（实测，非推测）

### 2.1 MAA（明日方舟）—— `F:\MAA`

| 项 | 实测值 |
|---|---|
| 版本 | 配置里记录 `v6.19.0-beta.1` |
| 进程 | 我评估期间它**正在跑日常**：02:15:43 启动 → **02:36:23 七项全部完成（用时 19m52s）** → 02:37:41 GUI 退出。**说明 MAA 不是常驻的**，见 §7 的「拉起」职责 |
| 活动配置 | `F:\MAA\config\gui.new.json`（17 KB，02:16 还在被 MAA 写入 → 这份是活的；`gui.json` 是 10-07 的旧格式残留） |
| 任务队列 | 9 项，**启用 7 项**：开始唤醒 / 理智作战(1-7) / 剩余理智 / 自动公招 / 基建换班 / 信用收支 / 领取奖励；关闭：自动肉鸽、生息演算 |
| 连接 | `MuMuEmulator12` 预设，adb = `D:\Program Files\Netease\MuMu\nx_main\adb.exe`，地址 `127.0.0.1:16384`，TouchMode `Adb` |
| 远程控制 | `RemoteControl` 段**已配好**：两个端点在 03:11:44 / 03:12:02 被写入（DPAPI 加密，解出来就是本机 5140 那两条 URL），`PollIntervalMs = 1000` → **MAA 一启动就自己开始轮询，不需要人再点任何东西** |
| 定时器 | 8 个槽位，**全部 `IsEnabled: false`** |
| 模拟器 | MuMu（`MuMuNxDevice`）在跑，13284/5555/7555 在听 |

### 2.2 MaaEnd（终末地）—— `D:\MaaEnd-win-x86_64-v2.3.0`

| 项 | 实测值 |
|---|---|
| GUI | `MaaEnd.exe` = **MXU 2.7.1**（文件版本），Tauri + WebView2 |
| 项目清单 | `interface.json`，`interface_version: 2`（PI v2），`version: v2.31.0`，`import` 引了 65 个任务文件 |
| 控制器 | `Win32-Front`（Win32 / `UnityWndClass` / 窗口 `Endfield` / **screencap ScreenDC、mouse Seize、keyboard Seize**）、`ADB`、`CloudADB`、PlayCover、Linux×3、macOS×2 |
| Agent | `agent/go-service`、`agent/cpp-algo`（任务跑起来要靠这两个子进程） |
| 已保存实例 | 5 个：**全套日常**（启用 ProtocolSpace / DailyRewards / CloseGamePC）、**快速日常**、**实时辅助**、自动倒卖、基质刷取 |
| 前置动作 | 「全套日常」有一个 preAction：`▶️ 启动 Endfield.exe` → `D:\Hypergryph Launcher\games\EndField Game\Endfield.exe`（skipIfRunning） |
| 内置 Web 服务 | `webServerEnabled: true`，`webServerPort: 12701`，`allowLanAccess: false`（→ 只绑 127.0.0.1） |
| 其它开关 | `autoRunOnLaunch: false`，热键 F10 开跑 / F11 停，`minimizeToTray: false` |
| 迷惑项 | `maafw\MaaPiCli.exe` 存在，**但它在自己的目录里找 `interface.json`**（我实测报 `failed to parse D:/MaaEnd-win-x86_64-v2.3.0/maafw/interface.json`）→ 不能直接拿来驱动 MaaEnd，正路是 MXU |

### 2.3 bot 侧（本项目）

| 能力 | 现成的东西 |
|---|---|
| LLM 工具注册 | `ctx.chatluna.platform.registerTool(name, { selector, authorization, description, createTool })` —— episode / scene / vision / sticker-admin / webpreview / emotion / selfext 共 7 个插件在用，模板现成 |
| HTTP 路由 | `ctx.server.get/post(path, route)` —— `chatluna-guard` 已有 `/qqbot/guard`，且**带了令牌 + 落到 `data/guard-control.json`** 的成熟做法，可照抄 |
| 权限分级 | `qqbot-auth` 把名单映射成 Koishi authority 1–5，并给指令写 `permissions = ['authority:N']`；`session.user.authority` 随时可读 |
| 出站限流 | `chatluna-guard`：群 `1040488785` burst 2 / 8 条每分钟；群 `454444539` burst 6 / 30 条每分钟 → **回报消息不能刷屏** |
| MCP 客户端 | `chatluna-mcp-client` 已在用（当前挂了 websearch）。**但它没实现 elicitation**（我 grep 过 `lib/index.mjs`，无 `elicit`/`sampling`） |

---

## 3. 明日方舟：三条路，推荐官方远程控制

### 3.1 ★ 推荐：MAA 官方远程控制协议

机制（[官方协议文档](https://docs.maa.plus/zh-cn/protocol/remote-control-schema.html)）：MAA 以固定间隔（默认 1 s）POST 到我们提供的**获取任务端点**；我们返回 `{"tasks":[...]}`；每跑完一个任务，MAA POST 到**汇报任务端点**告知结果。文档里的**范例工作流标题就是「用 QQBot 控制 MAA」** —— 我们不是硬凑，是踩在官方设计意图上。

对我们有用的任务类型：

| type | 作用 |
|---|---|
| `LinkStart` | **启动一键长草** —— 即 GUI 里勾选的那整条队列（正常用法就是这个） |
| `LinkStart-Fight` / `-Recruiting` / `-Mall` / `-Base` … | 单独跑某个子功能，**无视界面勾选框** |
| `StopTask` | 结束当前任务 |
| `HeartBeat` | 立即返回当前在跑的任务 id（拿来做"跑完了吗"的探针） |
| `CaptureImageNow` / `CaptureImage` | 截图回报（base64 几十 MB，别经过网关，本机直连没问题） |

**优点**：零新增安装；用的就是你 GUI 里那套队列（不存在"两份配置漂移"）；天然有分阶段进度、截图、停止。**代价**：MAA GUI 要常驻并开启远程控制；它跑的时候你不能手动用 MAA。

### 3.2 备选：`maa-cli`（官方 Rust CLI）+ 自写驱动

不依赖 GUI 常驻，`maa run <task> --batch` 可以完全无人值守。但：本机没装（PATH / winget / cargo / scoop 全无），要另装一份 MaaCore + 资源（约 GB 级），**而且任务清单要另维护一份 → 和你 GUI 里的队列必然漂移**。适合"以后要把方舟搬到另一台无 GUI 的机器上"，不是现在的需求。

### 3.3 不推荐：`maa-mcp-adapter`（sac432）

看起来最像"一句话日常"的现成方案（12 个 MCP 工具、默认计划从 MAA GUI 的 `gui.json` 派生、**执行前弹确认表单核对计划哈希**）。但两个硬伤：

1. **它的安全设计依赖 MCP form elicitation 做确认，而 ChatLuna 的 MCP 客户端没有实现 elicitation** → 只能退到 `confirmation = "none"`，**恰恰把它最值钱的"确认即所得"拆掉了**，还多背 12 个工具的 schema 进上下文。
2. 它也去读 MAA GUI 配置来派生计划 —— 既然都要读 GUI 的队列，不如直接用官方远程控制，链路更短、没有第三方在中间。

---

## 4. 终末地：MXU 内置 Web API（唯一现实路径）

我读了 MXU 源码 `src-tauri/src/web_server.rs`（47 KB），路由是实打实存在的：

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/maa/instances/{id}/tasks/start` | **起任务**，可带 `agentConfigs`（能拉起 `go-service`/`cpp-algo`）、`cwd`、`resetState` |
| POST | `/api/maa/instances/{id}/tasks/run` | 起一批任务但**不启动 agent**（走不通 MaaEnd 的大多数任务） |
| POST | `/api/maa/instances/{id}/tasks/stop` | 停 |
| PUT / DELETE | `/api/maa/instances/{id}` | 建/销毁实例（幂等） |
| POST | `/api/maa/instances/{id}/connect` | 连控制器（Win32/ADB 配置由请求体给） |
| POST | `/api/maa/instances/{id}/resource/load` | 加载资源 |
| GET | `/api/maa/state`、`/screenshot`、`/logs` | 状态 / 截图 / 日志 |
| GET | `/api/ws` | WebSocket 实时事件推送 |

**关键约束**：

1. **无鉴权。** 代码里没有 token 层，只靠"绑 127.0.0.1"兜底。→ 我们的方案里 `allowLanAccess` **必须永远保持 `false`**。
2. **preActions / pretasks 暴露不出来**（这是 MXU [Issue #348](https://github.com/MistEO/MXU/issues/348) 的原话）。而你的「全套日常」实例正有一个 preAction 负责启动 `Endfield.exe` → **bot 得自己 `Start-Process Endfield.exe`**，或者改用下面第 3 条路。
3. **`MaaEnd.exe` 没有命令行参数**（社区 [Issue #2546](https://github.com/MaaEnd/MaaEnd/issues/2546) 在要，未实现）→ 只能通过 Web API 或配置开关驱动。
4. Web API 的 `tasks/start` 需要请求方自己把界面选项解析成 `pipelineOverride`（这段逻辑在前端 TS 里，`pipelineOverride.ts` 等）→ **要么复刻这段解析，要么把某个实例的请求体抓一次固化下来**，要么走第 3 条。

**绕开 PI 解析的省事路径**：把 `mxu-MaaEnd.json` 的 `autoRunOnLaunch` 改成 `true`（配合 `lastActiveInstanceId` 指定跑哪个实例），bot 只负责"把 MaaEnd.exe 拉起来"，MXU 自己按上次配置**全套跑（含 preAction 启动游戏）**；bot 用 `/api/maa/state` + `/api/logs` 看进度、用 `/tasks/stop` 停。**代价**：每次换实例要改配置文件；`autoRunOnLaunch` 是全局的，你也失去了"手动开着 MaaEnd 不自动跑"的自由。

---

## 5. ⚠️ 必须先拍板的物理约束

这一节比技术选型重要：

1. **终末地跑起来会抢走你的鼠标键盘。** `interface.json` 里 `Win32-Front` 是 `screencap: ScreenDC` + `mouse/keyboard: Seize`，意思是前台独占输入、且游戏窗口必须可见不被遮挡。→ **"群里喊一声"和"你正在用这台电脑"是互斥的。** 你在打游戏/开会/写代码时让 bot 开跑，鼠标会被抢走。
   - 缓解方向：把终末地也搬到模拟器里走 `ADB` 控制器（后台控制，像 MAA 那样不抢鼠标）。但要先确认模拟器能跑终末地、且 MXU 的 ADB 控制器对终末地的资源支持到位（`resource_adb` 存在，看着有戏）。
2. **方舟这边不抢鼠标**（ADB 连 MuMu），但会占用模拟器。
3. **同一时刻只能跑一个。** MAA 和 MaaEnd 都吃资源/都要窗口；插件里必须有一把全局互斥锁，否则两句"帮我跑日常"就会互相打架。
4. **都必须在你的交互式桌面会话里跑。** bot 现在就在你的会话里（没问题），但**别把 Koishi/MaaEnd 改成 Windows 服务**，一改截图和输入就全废。
5. **跑一次的时间尺度是"几十分钟"，不是几秒。** 实测：方舟七项日常 **19m52s**（2026-10-08 02:16→02:36）。终末地未实测，量级应该更长。
   → 触发必须异步、回报必须异步，绝不能阻塞对话；一条"帮我跑日常"的回执应该在**秒级**，而不是等 20 分钟才回话。

---

## 6. 先别写代码：现成的定时方案

如果你的真实目的是「日常别断」，**这两个 GUI 自己就能干完，零代码**：

- MAA：8 个定时器（当前全关）→ 到点自动跑整条队列。
- MXU：自带 SchedulePanel + scheduleService → 定时跑实例。

bot 触发**额外**买到的只有三样：**随时临时跑**（不等到点）、**群里可见进度与截图**、**别人（授权后）也能喊**。
→ 请确认这个增量值不值得这份工程量。如果只是"不想忘"，直接开定时器。

---

## 7. 推荐架构（若继续做）

一个自研插件 `koishi-app/external/koishi-plugin-game-auto/`，三块：

```
⓪ 拉起（前置）        MAA.exe / MaaEnd.exe 没在跑就 Start-Process 起来，等就绪再进下一步
① MAA 任务源端点      ctx.server.post('/maa/getTask', '/maa/reportStatus')
                      → 绑 127.0.0.1 + 令牌（照抄 chatluna-guard 的 data/*-control.json 做法）
                      → 队列里放 {type:'LinkStart'}；reportStatus 回来时翻转状态、推群
② MaaEnd 客户端       fetch http://127.0.0.1:12701/api/...（起/停/状态/日志）
③ 门面               状态机 + 全局互斥锁 + 指令 + ChatLuna 工具 + 回报节流
```

**⓪ 是必需项，不是优化项**：远程控制协议只在 **MAA 进程活着**时才轮询端点，而实测你的 MAA 跑完就退出了（02:37:41）。同理 MaaEnd 的 Web API 只在 MXU 进程活着时存在。所以插件必须自己负责"没开就拉起来、并等到就绪"——否则"群里喊一声"在 MAA/MaaEnd 没开的绝大多数时间里都会直接失败。

> **已落地（2026-10-08）**：这一环比最初设想的还多一层 —— **MAA 自己也开不了模拟器**（它的"启动模拟器"是另一套设置，`StartGame` 只能启动模拟器里的游戏）。所以插件现在是三段式：拉起 MAA（`MAA.exe`）→ 拉起模拟器（`MuMuManager.exe control -v 0 launch`，用 `info -v 0` 的 `is_android_started` 等它真的开机）→ 就绪后才下发 `LinkStart`。实测冷启动 23 秒，期间群里能看到"正在等它开机"。细节见 [docs/33 §4.2](docs/33-游戏自动化接入.md)。

**门面设计（关键）**：

- **指令**（确定性）：`/方舟日常`、`/终末地日常`、`/游戏状态`、`/停止` —— 走 `qqbot-auth` 的 `authority:N`，建议 **N ≥ 4**（只有你）。
- **ChatLuna 工具**：只暴露**白名单枚举**，比如 `game_auto(action: 'arknights_daily' | 'endfield_daily' | 'status' | 'stop')`。**真实任务清单永远来自你 GUI/MXU 里保存的配置，绝不由 LLM 生成。** 这样即使被 prompt injection，最坏结果也只是"多跑一次日常"，不会"花掉有限资源"。
  - `selector`：只在本群白名单里可见；`authorization`：读 `session.user.authority` 判定。
- **回报节流**：guard 出站限流很紧（群 `1040488785` 只有 2 条/8 分钟……准确说是 burst 2、每分钟 8 条）→ 只发"开跑了"和"跑完了（含结果/截图）"两条，中间进度靠 `/游戏状态` 主动查。

**为什么不直接用 MCP 挂上去**：MaaMCP 那类服务器给的是**低层原语**（OCR、点击、pipeline），要 LLM 靠视觉一步步操作终末地 UI —— 又慢又不稳，还要把几十个工具的 schema 塞进每轮上下文。我们要的是"跑一套现成的 pipeline"，不是"让 AI 玩手游"。

---

## 8. 分阶段实施计划

| 阶段 | 内容 | 验证判据 |
|---|---|---|
| **P0 链路证明**（不写插件） | ① 临时 HTTP 服务 + MAA 填远程控制端点，确认 MAA 会来 `getTask`；② 拉起 `MaaEnd.exe` 后 `curl http://127.0.0.1:12701/api/maa/state` | 两个 `curl` 都有正常响应；MAA 能靠 `LinkStart` 跑完整套 |
| **P1 骨架插件** | 端点 + MXU 客户端 + 4 条指令 + 互斥锁 + 回报 | 群里 `/方舟日常` 真能跑；第二次触发被正确拒绝；`/停止` 有效 |
| **P2 LLM 工具** | 白名单枚举工具 + `selector`/`authorization` | 群友说"帮我清理方舟日常"能触发；无权限者被拒且不留痕 |
| **P3 体验** | 节流、截图回报、失败原因（`reportStatus` / MAA 日志尾部） | 失败时群里能看懂"为什么"（没开模拟器 / 卡住超时 / 掉登录） |
| **P4 文档** | 新建 `docs/NN-...`、更新 `17-常用命令速查.md`、`18-产出物清单.md` | `node tools/check-docs.cjs --strict` 过 |

> 实际执行：**P1 与 P2 在 2026-10-08 同一天做完并验证**（工具随插件一起落地），P4 的文档 `docs/33` 已写；
> P0 的第 1 步已完成，第 2/3 步见 §10；P3 的「进度分段 / 截图回报 / 终末地完成检测」仍未做。

---

## 9. 已拍板（2026-10-08）

| # | 决策 | 结论 |
|---|---|---|
| 1 | 方舟通道 | **MAA 官方远程控制**（复用现有 GUI 队列，零安装，MAA GUI 常驻） |
| 2 | 终末地独占 | **接受独占**，就按现状 `Win32-Front` 跑；鼠标键盘被抢是预期行为 |
| 3 | 谁能触发 | **只有你**（`authority ≥ 4`）；别人在群里喊一律无视 |
| 4 | 定时 | **本轮只做群里喊**，不动 MAA Timer / MXU Schedule |

由此确定的范围：插件只服务单机单用户（owner），不需要多用户/多设备账号体系，也不需要"别人也能喊"的名单管理。

---

## 10. 剩下的手工步骤

P1 骨架已经做完并验证（见文首状态行 + [docs/33](docs/33-游戏自动化接入.md)）。**第 1、2 步已经做完**，剩下的是"要不要真跑一次"和你自己决定的事：

| # | 动作 | 位置 | 判据 |
|---|---|---|---|
| 1 | ~~等 MAA 跑完当前日常~~ **已完成** —— 02:36 七项跑完，02:37 GUI 已退出 | — | `gui.log` 末行 `MaaAssistantArknights GUI exited` |
| 2 | ~~把两条 URL 填进「获取任务端点」/「汇报任务端点」~~ **已完成**（03:11:44 / 03:12:02 两条 `RemoteControl*Uri has been set`） | MAA GUI → 设置 → 远程控制 | 插件日志 `MAA 首次来取任务：user=… device=…`；先敲 `/maa.probe` 验握手（**不消耗理智**） |
| 3 | 真跑一次 `/maa.daily`（约 20 分钟，**会真消耗理智**）—— 由你决定什么时候 | 群里 | 20 分钟后收到「方舟日常 跑完了」 |
| 4 | 终末地那条：拉起 `MaaEnd.exe` → `curl http://127.0.0.1:12701/api/maa/state` → `/endfield.probe` | MaaEnd GUI（`allowLanAccess` 保持关闭） | 有正常响应；再据此补"跑完自动回报" |

**环境自启已经不用你管了**：MAA 没开、模拟器（MuMu）没开，插件都会自己拉起来并等到就绪再下发（实测冷启动 23 秒）。两条 URL 也不用手抄 —— 插件启动时直接打印（含令牌），令牌落在 `koishi-app/data/game-auto-control.json` 且**重启不变**。

**我不会碰的东西**：`F:\MAA` 的文件、`D:\MaaEnd-win-x86_64-v2.3.0` 的已保存实例（只有终末地那条通道会改 `lastActiveInstanceId` + `autoRunOnLaunch`，且改前留 `.qqbot-bak` 备份）、`allowLanAccess`、MAA 的定时器。**唯一例外**：插件会用 MuMu 官方 CLI 开关模拟器（`MuMuManager.exe control -v 0 launch|shutdown`），那是模拟器的正常开关方式，不改任何配置。

---

## 附：证据来源

- MAA 远程控制协议（含"用 QQBot 控制 MAA"范例）：<https://docs.maa.plus/zh-cn/protocol/remote-control-schema.html>
- MAA 官方 CLI：<https://github.com/MaaAssistantArknights/maa-cli>
- maa-mcp-adapter（评估后不推荐）：<https://github.com/sac432/maa-mcp-adapter>
- MaaMCP（低层设备控制 MCP，不推荐用于本需求）：<https://github.com/MAA-AI/MaaMCP>
- MXU Web API 源码：`src-tauri/src/web_server.rs` @ <https://github.com/MistEO/MXU>
- MXU Issue #348（Web API 不含 preActions/pretasks）：<https://github.com/MistEO/MXU/issues/348>
- MaaEnd Issue #2546（MaaEnd.exe 无启动参数）：<https://github.com/MaaEnd/MaaEnd/issues/2546>
- 本机实测：`F:\MAA\config\gui.new.json`、`F:\MAA\debug\gui.log`、`D:\MaaEnd-win-x86_64-v2.3.0\interface.json`、`D:\MaaEnd-win-x86_64-v2.3.0\config\mxu-MaaEnd.json`、`D:\MaaEnd-win-x86_64-v2.3.0\maafw\MaaPiCli.exe --help`、`koishi-app\koishi.yml`、`koishi-app\external\*`、`koishi-app\node_modules\koishi-plugin-chatluna-mcp-client\lib\index.mjs`
