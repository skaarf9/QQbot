# Koishi 当网关直接调 DSH（AstrBot 下线）

> 属于 [QQ 机器人项目 —— 进度与交接](../进度与交接.md) 的分册。
> 第二十一轮（2026-10-27）。目标：**把 AstrBot 从链路上摘掉**，让 Koishi 自己当网关调 DeepSeek Harness。
>
> ⚠️ **本轮的形态在同一天晚上就被改了**：`koishi-plugin-dsh-connector` 已**卸载**，
> DSH 改由自研 `chatluna-dsh-tool` 以 **ChatLuna 工具**的形式接入（模型自己调，不再是人敲指令）。
> 读完本文请接着看 [docs/39-DSH当工具.md](39-DSH当工具.md)。
> 本文仍然有效的部分：ingress 协议、DeepSeek 迁移、**坑 95 的 sqlite 热日志**、以及「哪些插件挂在哪一层」。

---

## 1. 为什么改（决策链）

上一轮（[docs/36](36-AstrBot路线与DSH桥.md)、[docs/37](37-QQ私聊与自我扩展.md)）的形态是：

```
NapCat ──6199──▶ AstrBot（Python，只做转发）──HTTP──▶ dsh-astrbot-ingress:3188 ──▶ DSH
```

问题：**AstrBot 一个字都不思考**（`cmd_config.json` 里 `provider` 数 0、内置指令全关），
却要养一套 uv 环境 + 一个 280 MB 的 Python 进程 + 一条 WS 连接。用户的原话是
「既然 AstrBot 只作为网关，没出什么力」。

三个候选形态：

| | 做法 | 结论 |
|---|---|---|
| **A** | Koishi 当网关，AstrBot 下线 | **采纳** |
| B | Koishi 加一条并行、AstrBot 留着 | 否决：同一个号两条路靠前缀分流，私聊必双回 |
| C | 不动 | 否决：用户明确要摘掉 AstrBot |

A 的额外好处：权限能用 Koishi 的 authority 0–4（AstrBot 只有三档白名单）；
转发前的判定可以复用 Koishi 现有插件（`chatluna-guard` 的 `applyToPrivate: false`
意味着私聊本来就不受屏蔽闸管辖，正好整块交给 DSH）。

---

## 2. 先查市场（硬约束第 0 条）

按 [硬约束](05-硬约束.md) 第 0 条「先本地 → 再市场 → 最后才自己写」：

| 步骤 | 结论 |
|---|---|
| 本地已有？ | 29 个自研插件里**没有**任何 `astrbot-ingress` / `:3188` 的引用 —— 无现成件 |
| 市场有吗？ | **有**：`koishi-plugin-dsh-connector` **1.5.2**（作者 YuzuharaYuka，2026-10-24 更新，16 个版本，月下载 148） |
| 自己写？ | **不需要**。原本估计要 500~700 行，市场件直接覆盖，且功能远超 MVP |

同场排掉的两个：

- `koishi-plugin-dsh` —— npm 上只有 `0.0.1`（2026-08-13）、无 repo 无 deps，**占位空包，别装**。
- `@xmanrui/dsh-im` 5.6.0（DSH 侧插件，官方 Token 赞助、GitHub Trending JS 日榜第 7）——
  能把 11 种 IM 直接接进 DSH，**但它的 QQ 走官方 QQ Bot**（扫码创建机器人 / AppID+AppSecret，
  依赖 `@tencent-connect/qqbot-nodejs`），**不支持 OneBot/NapCat**，我们的小号用不上。

### 顺带记下的一个反面判断

`dsh-astrbot-ingress` 的协议其实**与 AstrBot 无关**，纯 HTTP：

- 端点只有 6 个：`/health` `/inbound` `/binding` `/file-token` `/file/<token>` `/probe-url`
- `POST /inbound` 请求体 5 个字段：`{umo, text, senderId, chatType, files[]}`
- SSE 只有 6 种事件：`ack` `text` `status` `file` `error` `done`
- `umo` 只是个字典 key（`state.sessions[umo]`），任何字符串都行

但 `dsh-connector` 走的是 DSH **自己的** WS mux（`/api/remote.mux` + RPC），
比 ingress 更直接、功能更多（会话列表/绑定/归档/steer/stop/model/permission/审批/余额）。
所以这条路线**不再需要 ingress**。

---

## 3. 配置

### 3.1 `routes/koishi/app/koishi.yml`

```yaml
  dsh-connector:dshc01:
    mode: direct                     # 同机直连，读 ~/.dsh 的 browser-session secret 换 cookie
    baseUrl: http://127.0.0.1:8090   # ★ 必须写死，别让它自动发现（会撞到 web profile 的 8080）
    defaultWorkspace: 'D:\deepseek\QQbot\routes\astrbot\workspace'
    replyFormat: text
    naturalLanguagePrivate: true     # 私聊不带前缀的话直接交给 DSH
    chatIdleMinutes: 0               # ★ 0 = 不限（靠 patch，见 §4.1）
    allowUsers:
      - '2791932480'
    defaultPermission: danger-full-access
    showUsage: false                 # 每条都附 token 用量太打断人设
    showCost: false
    enableImages: true
    enableFiles: true
```

★ **顺序要紧**：这一块必须排在 `chatluna:03llpk` **之前**。
`dsh-connector` 用 `ctx.middleware(fn)` 抢私聊（不调 `next()` 就吞掉），
而 ChatLuna 的中间件是 `next(callback)` 形态——**谁注册早谁先跑**。
实测把 dsh-connector 放在第 11 位、chatluna 第 12 位，私聊只有 DSH 一条回复。

> ⚠️ **写进 `koishi.yml` 的注释会被 Koishi 删掉**（老坑，见 [踩坑记录](04-踩坑记录.md)）。
> 上面的 ★ 说明只活在这份文档里，改 yml 前先回来读一眼。

### 3.2 NapCat：开 3001、关 6199

`routes/napcat/Shell/config/onebot11_2178517838.json`（备份 `*.bak-koishi-gateway-*`）：

| 项 | 改前 | 改后 |
|---|---|---|
| `websocketServers[koishi]`（3001） | `enable: false` | **`true`** |
| `websocketClients[astrbot]`（6199） | `enable: true` | **`false`** |

**这个文件不会热加载**（实测改完等 30 秒毫无反应，NapCat 日志目录也是空的），
必须重启 NapCat。本机是 **Shell 注入变体**（注入 `F:\qq\QQ.exe`），
重启要关掉自己正在用的 QQ + 过 UAC，见 §6。

---

## 4. 两个本地补丁

`tools/patch-dsh-connector.cjs`（幂等，支持 `--revert` 与 `--app <dir>`；
npm i 重装插件后需重打，**已挂 postinstall**）。打完后插件目录里 4 行带 `[qqbot-patch]` 标记。

> 挂 postinstall 时才发现：原来的 `"postinstall": "node ../tools/patch-sticker.cjs || echo 跳过"`
> 在 10-25 目录重组后**路径就是断的**（`../tools` → `routes/koishi/tools` 不存在，
> 真正的位置是仓库根 `tools/`），而 `|| echo` 把失败吞了，**一直静默没打补丁**。
> 现已收成 `tools/postinstall.cjs`（步骤表 + 逐个 try/catch + 永远 exit 0 但明确报失败），
> 详见 [踩坑 94](04-踩坑记录/10-脚本与命令行.md)。

### 4.1 `chatIdleMinutes = 0` → 不限空闲窗口

插件的源码是：

```js
const last = deps.lastActive.get(key) ?? 0
return Date.now() - last <= deps.config.chatIdleMinutes * 6e4
```

`lastActive` 是**内存 Map**（`dispose` 时 `clear()`）。于是：

- Koishi 每次重启后 `lastActive` 为空 → `last = 0` → `Date.now() - 0` 是个天文数字
  → 判"没交互过" → 私聊落回 ChatLuna；
- 配成 `0` 也不是"不限"，而是 `<= 0` 恒假 → **永不直通**。

**实测证据**（`tools/logs/rig-10-dsh-gateway.log` 第一次跑）：私聊被 ChatLuna 接走，
回了「当前会话对应的模型 empty 不可用」，`dsh-connector` 全程没有回合日志。

补丁一行：`if (deps.config.chatIdleMinutes <= 0) return true;`
为什么改 0 的语义而不加配置项：0 在现有代码里是个没人会想要的退化值
（谁会把"最近 0 分钟内交互过"当需求），take 成"不限"不破坏兼容，默认值 30 一字不变。

### 4.2 私聊闲聊不刷「已提交到 DeepSeek Harness，正在执行……」

那个 ack 在每轮 prompt 前硬编码发送（`MESSAGES.promptAccepted`），没有开关。
对 `dsh.run` 这种显式任务它是好的，对"私聊说句话"就是每条插一句系统腔，把人设打断。
实测 DSH（V4.1-Flash）在本机单轮 **1.2~3.7 秒**，沉默完全可接受。

补丁：`handleRun(deps, session, text, quietAck = false)`，私聊直通那条中间件传 `true`；
`quiet` 时不发 ack。`dsh.run` 走原路径，**回执照旧**。

---

## 5. 实测（都跑过，不是推测）

测试台：`tools/run-rig.cjs` + `tools/fake-onebot.mjs` + `tools/scenarios/*.json`，
测试实例 `routes/koishi/test`（5141 / 3002），与生产完全隔离。

> 顺手修了一处：`run-rig.cjs` 里 `TEST` 路径还是重组前的 `../../koishi-test`，
> 已改成 `../../test`，否则测试台起不来。

| 断言 | 结果 |
|---|---|
| 私聊自然语言 → DSH | ✅ 回「网关已通」，1.2s，**只有一条**，ChatLuna 没插嘴 |
| 群聊 @bot → ChatLuna | ✅ DSH 没抢（`shouldRunNaturalLanguage` 先判 `session.isDirect`） |
| 私聊 `/dsh.ping` | ✅ 走指令系统，回完整状态卡（direct / 8090 / 68 个会话 / 事件桥已连接 / 模型 V4.1-Flash / 完全权限） |
| 私聊 `/help` | ⚠️ 掉给 DSH 了 —— **测试实例解析不到 `chatluna-help`**（日志 `app cannot resolve plugin "chatluna-help"`），不是桥的问题 |
| ack / 用量行 | ✅ 关掉后回复是干净的「网关已通」 |

剧本留在：`tools/scenarios/10-dsh-gateway.json`（私聊直通）、
`11-dsh-routing.json`（群聊/指令/自然语言三分流）、`12-dsh-command-in-private.json`（带前缀指令）。

### 一条值得记住的机制

`/dsh.ping` 这类**真注册了的指令不会被吞**：Koishi 的指令执行在 `dsh-connector`
的中间件之前，指令一命中就直接结束链路。所以桥只在"没人认领的普通文本"上生效。
反过来说，**没注册的命令名（如本测试实例的 `/help`）会掉给 DSH** 当自然语言处理——
这是设计使然，不是 bug。

---

## 6. 现在的状态与还差的一步

| 项 | 状态 |
|---|---|
| `dsh-connector` 1.5.2 | ✅ 已装生产 + 测试两份；生产启动日志 `已连接 DSH (direct) http://127.0.0.1:8090` |
| 两个补丁 | ✅ 两份都打了，幂等验证过 3 次 |
| Koishi 生产实例 | ✅ 已启动，5140 监听，56 个插件全载 |
| onebot 适配器 | ✅ 已连上（`adapter connect to server: ws://127.0.0.1:3001/`，20:20） |
| NapCat | ✅ 已重启，3001 监听中；6199 的 astrbot 客户端已关 |
| ChatLuna 模型 | ✅ 已切官方 `deepseek-flash` / `deepseek-v4-pro`，实测单轮回复正常 |
| AstrBot | ✅ 已下线（进程与 6186/6199 都没了） |
| 数据库 | ⚠️ 踩过热日志（见 §8），已修复，现 `integrity ok` |

### 你要做的一步：重启 NapCat

```bat
:: 1) 先退出你自己正在用的 QQ（QQNT 单实例，注入时它必须不在）
:: 2) 跑启动器，选 1（Shell 变体，注入 F:\qq\QQ.exe）
启动NapCat.cmd
:: 3) 过 UAC；登录状态和 OneBot 配置会被复用，不需要重新扫码
```

起来后验证三件：

```bash
netstat -ano | grep -E ":(3001|6199)\s"      # 3001 应该 LISTENING，6199 应该没有
# Koishi 侧日志应出现 adapter connect to server 不再是 ECONNREFUSED
```

**为什么不用 Koishi 的 `ws-reverse` 绕开这次重启**：`ws-reverse` 让 Koishi 当服务端
（`ctx.server.ws(path)`，要 `x-client-role: Universal` 和 `x-self-id` 头，NapCat 都会发），
听起来可以省掉改 NapCat——但 Koishi 的 server 只监听 5140，NapCat 现在拨的是 6199，
**还是得改 NapCat 的 url**。所以绕不开，除非在 6199 上加一个纯转发的 WS 中继（多一个进程，不值）。

### 然后：停 AstrBot

```bash
taskkill /PID 15308 /T /F
# 如果它的 cmd /k 窗口还在：taskkill /IM cmd.exe /FI "WINDOWTITLE eq *start-astrbot*"
```

可选：`dsh-astrbot-ingress`（3188）也可以从 qqbot profile 摘掉，这条路线不再用它。

---

## 7. 群聊的模型：已从 commandcode 切到 DeepSeek 官方

**群聊仍归 ChatLuna**，而 ChatLuna 原来指向已欠费的 commandcode 中转：

```
HTTP 400 {"error":{"message":"You have insufficient credits...","code":"BAD_REQUEST"}}
```

（⚠️ 是 **400 不是 401**，别误判成 key 写错。）

2026-10-27 已切官方。一次性脚本 `tools/migrate-chatluna-to-deepseek.cjs`
（`--dry-run` 预演，幂等：已经在位时每条命中 0 次、自动跳过）。

| 改动 | 前 | 后 | 命中 |
|---|---|---|---|
| 三个适配器的端点 | `https://api.commandcode.ai/provider/v1` | `https://api.deepseek.com` | 3 |
| key 引用 | `${{ env.CC_API_KEY }}` | `${{ env.DEEPSEEK_API_KEY }}` | 3 |
| 主力模型 | `deepseek/deepseek-v4.1-flash` | `deepseek-flash` | 4 |
| 降级位 | `deepseek/deepseek-v4.1-flash-fast` | `deepseek-v4-pro` | 3 |
| `chatluna-vision.fallbackModel` | `deepseek/deepseek/deepseek-v4.1-flash` | `cc/q.dialogue` | 1 |
| 删除 Qwen 块 | `Qwen/Qwen3.8-Flash`（q.vision / q.sticker） | 官方无对应物 | 2 |
| 删除 free 块 | `inclusionai/ling-3.1-flash:free` / `ling-3.0-flash-sante:free` | 官方无对应物 | 1+1 |

切换后四个组：`q.dialogue` = flash→v4-pro、`q.vision` = flash→v4-pro、
`q.sticker` = flash→v4-pro、`q.memory` = flash（单模型，无兜底）。

要点：

- **官方只有两个模型 id**：`deepseek-flash`、`deepseek-v4-pro`（`GET https://api.deepseek.com/models` 实测）。
  所以原来 `-flash-fast` 的降级位改成 `v4-pro` —— **不同模型才算真兜底**，改成同一个就没意义了。
- `fallbackModel` 为什么写成 `cc/q.dialogue` 而不是三段式：ChatLuna 的完整名是 `平台/厂商/模型`
  （`parseRawModelName` 按**第一个** `/` 切），官方的厂商段是什么没有权威说明；
  写模型组**一定解析得到**（`visionModel: cc/q.vision` 本来就是组名）。
- `.env` 里 `DEEPSEEK_API_KEY` 取自 `~/.dsh/.credentials.yaml` 的 `refs.DEEPSEEK_API_KEY`
  （与 DSH 共用同一把 key）。**`.env` 只在进程启动时读一次 → 改完必须重启 Koishi**。
  `CC_API_KEY` 保留着没删，只是没人引用了。
- 端点 `https://api.deepseek.com` 与 `https://api.deepseek.com/v1` **都能用**（都实测 200），
  适配器会自己拼 `/chat/completions`。
- ⚠️ **未验证**：`deepseek-v4-pro` 在 q.vision 组里仍声明着 `image_input`。
  官方目录里 v4-pro 没标图片输入（DSH 的 `DEFAULT_MODELS` 里它没有 `inputModalities`）。
  它是备用位，真出图只有 flash 出错时才会轮到；若那时报"不支持图片"，把 v4-pro 从 q.vision 摘掉即可。

### 切完的验证

- 启动日志不再出现 `insufficient credits` / `ChatLunaError`
- `chatluna-vision 图片策略已挂载（视觉模型：cc/q.vision（备用 cc/q.dialogue）…）` ← fallback 生效
- `auto-sticker 判断模型已就绪: cc/q.sticker` ← 组解析成功
  （它前面那行 `未能获取 Chatluna 模型列表，judgeModel 回退为 deepseek/deepseek-v4-flash`
  是**启动顺序**的瞬时告警，下一秒就解析成组名了，不用管）

---

## 8. 上线当天的事故：bot 满嘴报错码，其实是 sqlite 热日志

AstrBot 关掉、NapCat 重启后 Koishi 连上了（`adapter connect to server: ws://127.0.0.1:3001/`），
但群里一开始真实流量，bot 就回：

> 使用 ChatLuna 时出现错误，错误码为 **999**（另一次 **103**）。请联系开发者以解决此问题。

**为什么容易误判**：模型请求记录（`chatluna-sandbox.model-request`）里那几条偏偏是
**`success`**，模型确实回了话（`deepseek-flash`，响应里有正文）。于是很容易一路往
"迁移把模型配错了"方向查——错了半小时。

**真因（完整链条）**：

1. 我为了省事反复用 **`taskkill /F`** 杀 Koishi（换 `.env`、换配置时），
   其中至少一次它正在跑 sqlite 写事务；
2. 于是 `data/koishi.db-journal`（12 KB 的热日志）留了下来；
3. `@koishijs/plugin-database-sqlite` 4.7.0 底下用的是 **`@minatojs/driver-sqlite` +
   `@minatojs/sql.js`（WASM 版）**，**不做热日志回滚** → 自己判定
   `database disk image is malformed`；
4. 所有写库失败 → ChatLuna 在"保存会话"那步抛异常 → 包装成 999 / 103 →
   用户看到"模型坏了"。

**文件本身从来没坏**：用原生 sqlite 打开一次，`pragma integrity_check` 直接 `ok`、50 张表齐全。

**修法**（详见 [踩坑 95](04-踩坑记录/08-断线与运行时故障.md)）：

```bash
cd routes/koishi/app/data
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('koishi.db');
console.log(d.prepare('pragma journal_mode').get(),d.prepare('pragma integrity_check').all());d.close()"
# journal_mode=delete / integrity ok；之后 koishi.db-journal 自动消失，重启 Koishi 即可
```

**新规矩**：**不要 `taskkill /F` 杀 Koishi**。要停用 `Ctrl+C`（SIGINT，优雅退出）、
`tools/run-prod.cjs --takeover`、或面板的"停止"。历史经验"只杀 worker 让它重读配置"
（坑 84）**只对配置文件成立，对数据库是反的**。

> 顺手确认了一件无关的事：`better-sqlite3` 装了也不会被用到（驱动只认 sql.js），
> 已卸掉。测试实例报 `当前会话对应的模型 empty 不可用` 是它自己的老问题
> （迁移前 19:37 那次跑台就是同一句），与本次迁移无关。

### §8.1 根治：把 WASM 驱动换成原生 better-sqlite3（2026-10-27 深夜）

**为什么非换不可**：清了死数据、关了沙箱大写入之后，`malformed` **仍然每几分钟复发一次**。
排查排除掉的东西见 [坑 95](04-踩坑记录/08-断线与运行时故障.md)；结论是
`@minatojs/sql.js` 在 Node 下**靠 emscripten 的虚拟文件系统直接写真实文件**
（驱动的 `_export()` 只在浏览器 `beforeunload` 时调，Node 路径下从不 export），
这条路径在真机负载下会烂。

**为什么不能直接升级**：`@minatojs/driver-sqlite` 5.x 确实改成原生，但要求
`minato@^4` / `cordis@^4`，Koishi 4.18.11 够不到；市场里也没有第三方原生 sqlite 插件
（只有官方 sqlite / postgres / mysql）。

**做法**：驱动对底层只有 7 个调用点，用 `better-sqlite3` 照着实现一遍即可 ——
`tools/patch-sqlite-native.cjs`（幂等、`--revert`、已挂 postinstall）：

| 驱动要的 | shim 怎么给 |
|---|---|
| `factory({locateFile})` → `{Database}` | `async () => ({ Database: ShimDatabase })` |
| `new Database(path)` | `new BetterSqlite3(path)`，并 `pragma journal_mode = DELETE` |
| `db.create_function(name, fn)` | `db.function(name, {varargs: true}, fn)` ← **必须 varargs**，因为 `regexp`/`regexp2`/`modulo` 参数个数不同 |
| `stmt.bind(p)` / `stmt.step()` / `stmt.getAsObject(null,c)` | 惰性执行：首次 `step()` 用 `stmt.iterate(...)`，逐行给 |
| `stmt.getAsObject(p, c)`（不 bind 不 step）| 内部 bind + step 一次，返回第一行 |
| `stmt.run(p)` / `stmt.free()` / `db.close()` / `db.export()` | 直接映射 |

补丁实际只改驱动的一行：`await (0, import_sql.default)({` → `await require("../native-shim.cjs")({`，
shim 落在驱动目录里，**minato 的业务代码一行没动**。

**验证**（先用副本库跑四种调用风格，再接生产）：

```
① _all : [{"name":"SteamUser"},{"name":"binding"},{"name":"cache"}]
② _get : {"c":120}
③ _run : {"a":"x","b":42}
④ func : {"m":1,"r":1}        // modulo(7,3) 与 regexp 的自定义函数都通
✅ shim 行为符合驱动预期
```

切换后：**`malformed` / `null function` 计数归零**，写库正常，
而且 `data/koishi.db-journal` **不再残留**（原生驱动会正确提交/回滚事务）。

> 代价：多一个原生模块 `better-sqlite3@11`（要能编译/有预编译包）。
> 换机或 `npm i` 之后必须重跑 `node tools/patch-sqlite-native.cjs`（已在 postinstall 里）。

### §8.2 兜底：数据库自愈看护

`node tools/watch-koishi-db.cjs`（间隔 25s、冷却 180s）盯日志，命中损坏特征就
杀 supervisor → 原生 sqlite 回滚热日志 → 重新拉起。换原生驱动后它基本不会再触发，
留作保险（它也兼作"Koishi 挂了自动拉起"）。

---

## 9. 哪些插件还在哪条链上生效（换网关前必须先想清这件事）

消息有两条完全不同的路，**跑的插件不是同一批**：

```
群聊 ──▶ ChatLuna 链（allow_reply → 人设 → 记忆 → 工具 → 出站整形）
私聊 ──▶ dsh-connector 中间件直接吞掉 ──▶ DSH agent（Koishi 这边只负责收发）
```

判据只有一条：**插件挂在哪一层**。

| 挂载层 | 例子 | 群聊 | 私聊(DSH) |
|---|---|---|---|
| `ctx.middleware` 抢消息 | guard 的屏蔽判定 | ✅ | ❌ 被 dsh 中间件先吞 |
| ChatLuna `chatChain.middleware` | `allow_reply` / `censor` / 工具 / 人设 / 记忆 / 表情包 / proactive / followup / scene / routine / emotion / affinity / episode | ✅ | ❌ **整条链不参与** |
| `ctx.on('before-send')` | **replacer(11 处) / replyshaper(4) / render(2) / guard 的出站令牌桶(13)** | ✅ | ✅ **照样生效** |
| Koishi 指令系统 | `/help`、`/dsh.*`、`/favor`、`/sticker.*` | ✅ | ✅（指令在 dsh 中间件之前执行） |

### 私聊（DSH 链）里**不再生效**的

- `{emotion()}` 情绪、`{affinity()}` 好感度（DSH 的 AGENTS.md 里已明确写了"这个形态没有"）
- 长期记忆（HippoRAG）、情景记忆 `{episode()}` / `{focus()}`、`recall` 工具
- 表情包：发、收、判定全不走（`sticker_*` 工具在 DSH 里不存在）
- `proactive` 主动插话、`followup` 追问、`scene` 场景、`routine` 作息、`think`
- 人设：私聊用的是 `routes/astrbot/workspace/AGENTS.md`，**不是** `data/persona/self.yml`
- `chatluna-vision` 的图片缓存/去重（DSH 用 `deepseek-flash` 自己看图，但不写 `chatluna_image_cache`，
  也不认"这是不是我自己/是不是表情包"）

### 私聊里**仍然生效**的

- **出站三层**：`replacer` 文本替换、`replyshaper` 整形、`render` 结构化渲染 ——
  它们挂在 `before-send`，对 DSH 的回复一样跑
- `guard` 的出站令牌桶（但配置里 `outboundApplyToPrivate: false`，私聊本来就不限速）
- 全部指令（含 `/dsh.chat on` 临时把私聊切成 DSH 自然语言模式，内存态、重启失效）

**一句话**：**群聊一点没变；私聊从「ChatLuna 人格闲聊」变成「DSH 干活」，
代价是私聊里的情绪/好感/记忆/表情包全停。**

如果哪天觉得这个代价不值，把 `dsh-connector` 的 `naturalLanguagePrivate` 改 `false` 就行：
私聊立刻回到 ChatLuna（全部插件恢复），DSH 只在 `/dsh.*` 或 `dsh.run` 显式调用时才用。

---

[← 回索引页](../进度与交接.md)
