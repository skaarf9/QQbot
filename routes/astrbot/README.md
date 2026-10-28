# AstrBot 路线（QQ → AstrBot → DSH）

这条路线把 **AstrBot 当 IM 网关**、**DeepSeek Harness（DSH）当大脑**：

```
QQ / NapCat ──OneBot──▶ AstrBot :6199 ──HTTP──▶ dsh-astrbot-ingress :3188 ──▶ DSH agent
                                                                              （工具 / skill / 子 agent）
```

与 Koishi 路线的关系：**两条路线可以同时接同一个 QQ 小号**。

| 消息 | 谁处理 |
|---|---|
| **私聊全部消息** | AstrBot → DSH（`private_passthrough: true`） |
| `/dsh <任务>`（私聊/群聊） | AstrBot → DSH |
| 群里普通闲聊、`/help`、`/models` 等 | 仍归 Koishi（现有生产实例，一行不改） |
| 引用 DSH 回复 / 群里 @ 机器人（已绑定） | AstrBot → DSH |

AstrBot 侧的**默认大模型和内置指令已关闭**：它不再自己聊天，只做“把私聊/`/dsh` 转给 DSH、
把 DSH 的回复发回 QQ”。QQ 里说话的是 DSH，人设由 `workspace/AGENTS.md` 提供。

> ⚠️ 同一个号同时跑 Koishi + AstrBot 时，**私聊会双回**（ChatLuna 也接私聊）。
> 测试本路线时先停 Koishi；要长期并行就给 Koishi 加私聊屏蔽，或用第二个小号。
> 群聊普通消息只有 Koishi 回，不会双回。

**私聊静默模式**：普通私聊不显示 `已交给 DeepSeek Harness…`、不显示 `💭` 思考首行、
不显示 `⏳`/`🔧` 进度行、不显示 `—— 本回合结束`；审批/提问/错误/文件仍会发。
只有私聊里显式敲 `/dsh …` 才保留任务式的进度与结束标记。详见
[`plugins/README.md`](plugins/README.md#本地补丁)。

---

## 目录

```
routes/astrbot/
├── app/                    AstrBot 工作目录（data/ 不入库）
├── bin/astrbot.exe         uv tool 生成的入口（不入库）
├── .uv-tools/              AstrBot 自身的 Python 环境（不入库）
├── plugins/
│   └── astrbot_plugin_dsh/ 桥插件源码（vendored，v0.3.23 + 私聊去尾标本地补丁）
├── skills/
│   └── astrbot-selfext/    “装插件 / 升级自己 / 重启”技能（junction 到 ~/.dsh/skills）
├── scripts/
│   ├── start-astrbot.cmd
│   ├── start-dsh-qqbot.cmd
│   ├── start-all.cmd
│   ├── selfext.cjs         ★ 自我扩展助手（给 DSH agent 用）
│   ├── run-astrbot.cmd     隐藏前台启动（计划任务用）
│   ├── restart-task.cmd    延迟 → 杀旧进程 → 拉起新进程
│   ├── kill-astrbot.ps1    只杀 routes/astrbot 下的 AstrBot
│   └── restart-astrbot.ps1 手动重启（调试用）
├── workspace/
│   ├── AGENTS.md           ★ 大肥鱼人设 + 自我扩展规矩（DSH 会注入）
│   └── .gitkeep
├── logs/                   本机日志（不入库）
└── README.md
```

DSH 侧不在这个目录：独立 profile `~/.dsh/profiles/qqbot`（端口 8090），
与网页端 `web`（8080）共用 `~/.dsh` 下的凭据、skills 和 sessions 根目录，但**进程与会话互不干扰**。

---

## 首次安装 / 换机

严格要求 **Python 3.12+**。本机用 `uv` 把 AstrBot 装进路线目录（不污染全局）：

```bash
cd routes/astrbot
UV_TOOL_DIR="D:/deepseek/QQbot/routes/astrbot/.uv-tools" \
UV_TOOL_BIN_DIR="D:/deepseek/QQbot/routes/astrbot/bin" \
uv tool install astrbot --python 3.12

cd app
../bin/astrbot.exe init -y
```

> `uv` 默认把下载缓存放在 C 盘；C 盘紧张时加 `UV_CACHE_DIR=.../routes/astrbot/.uv-cache`。

DSH 侧：

```bash
# 建 profile（从 web 模板复制，含 base + web-app）
dsh --profile qqbot --from-default-profile web --dump-config

# 装 ingress（会自动加进 profile 的 bundles）
dsh plugin --profile qqbot add dsh-astrbot-ingress
# 可选：commandcode 中转（额度用完已禁用，见下）
# dsh plugin --profile qqbot add @mars-sea/dsh-commandcode-provider
```

`~/.dsh/profiles/qqbot/cordis.patch.yml` 里固定了：

- 默认模型 **`deepseek-official / deepseek-flash`**（= DeepSeek-V4.1-Flash，支持图片输入；
  2026-10-27 从 commandcode 切过来，因为 commandcode 额度用完）。
  更强的可选 `deepseek-v4-pro`；想让它多想可加 `reasoningEffort: high`（官方只支持 `high`/`low`）。
- `llm-commandcode` 这一行 **`disabled: true`**（包还在 `package.json` 里，随时能改回 `false`）
- ingress `127.0.0.1:3188`、`cwd=routes/astrbot/workspace`、beacon 开
- WebUI `127.0.0.1:8090`（不用可忽略）
- **`permission.defaultPreset: danger-full-access`**：QQ 是无人值守会话，
  selfext / 装插件 / 跑脚本需要完整文件权限；审批策略 `never`，不会卡在 QQ 里等人点“批准”。

AstrBot 侧插件：本仓库已经把 `astrbot_plugin_dsh` 放在 `plugins/`，
`app/data/plugins/astrbot_plugin_dsh` 是指向它的 junction。换机时重建 junction（管理员不需要）：

```powershell
New-Item -ItemType Junction -Path "routes\astrbot\app\data\plugins\astrbot_plugin_dsh" `
  -Target "D:\deepseek\QQbot\routes\astrbot\plugins\astrbot_plugin_dsh"
```

技能：把 `routes/astrbot/skills/astrbot-selfext` junction 到 `~/.dsh/skills/astrbot-selfext`，
DSH 的 `skill` 工具就能加载它（AGENTS.md 里也写了同样的命令）。

---

## 启动

```bat
:: 1) DSH qqbot（先起，ingress 要写 ~/.dsh/astrbot-ingress.json）
routes\astrbot\scripts\start-dsh-qqbot.cmd

:: 2) AstrBot（WebUI http://127.0.0.1:6186）
routes\astrbot\scripts\start-astrbot.cmd

:: 或者一次起两个
routes\astrbot\scripts\start-all.cmd
```

AstrBot 首次登录：`astrbot / <首次日志里的随机密码>`；本机已通过 WebUI 改成
`astrbot / AstrbotTest2026`（密码只写在本机 `.env`，不入库）。

NapCat 侧：`routes/napcat/Shell/config/onebot11_<QQ号>.json` 里有一个反向 WebSocket 客户端：

```json
{
  "enable": true,
  "name": "astrbot",
  "url": "ws://127.0.0.1:6199/ws",
  "messagePostFormat": "array",
  "token": "<app/data/cmd_config.json 里 ws_reverse_token 的值>",
  "reconnectInterval": 30000
}
```

路径是 **`/ws`**（AstrBot 4.29 的 aiocqhttp 路由），不是旧文档里的 `/onebot/v11/ws`。
Koishi 仍然连 NapCat 自己的 `ws://127.0.0.1:3001`，两者不冲突。

---

## 人格：直接用回原来的提示词

`workspace/AGENTS.md` 是从原 Koishi 人格（`routes/koishi/app/data/chathub/presets/default-persona.yml`
+ `data/persona/self.yml`）改编的：

- 保留：硬性设定块、大肥鱼身份/别名/形象/自称/口头禅、说话风格、“什么时候不卖萌”、输出格式。
- 去掉：ChatLuna 专有变量与工具（`{emotion()}`、`{affinity()}`、表情包、长期记忆、作息表）——
  这个形态没有那些服务，留着只会让模型调用不存在的工具。
- 新增：DSH 工具、子 agent、selfext 自我扩展、QQ 输出纪律。

DSH 的 instructions 插件会在会话第一次请求时注入它；改完下一条消息/新会话生效。
如果想更强（进 system prompt 而不是 workspace instructions），可以给 qqbot profile 的
`preset-standard` 换一个 `dsh-persona` 前缀——当前先按 AGENTS.md 走，实测人设已经成立。

---

## 自我扩展（装插件 / 升级自己 / 重启）

给 DSH agent 的入口：

```bash
node D:/deepseek/QQbot/routes/astrbot/scripts/selfext.cjs status
node D:/deepseek/QQbot/routes/astrbot/scripts/selfext.cjs plugins search <关键词>
node D:/deepseek/QQbot/routes/astrbot/scripts/selfext.cjs plugins install <market_id|GitHub URL>
node D:/deepseek/QQbot/routes/astrbot/scripts/selfext.cjs plugins reload <插件名>
node D:/deepseek/QQbot/routes/astrbot/scripts/selfext.cjs plugins update <插件名>
node D:/deepseek/QQbot/routes/astrbot/scripts/selfext.cjs upgrade --check
node D:/deepseek/QQbot/routes/astrbot/scripts/selfext.cjs upgrade
node D:/deepseek/QQbot/routes/astrbot/scripts/selfext.cjs restart --delay 15
node D:/deepseek/QQbot/routes/astrbot/scripts/selfext.cjs logs 80
```

它做的是：

> 如果改了 AstrBot WebUI 密码，记得同步改 `routes/astrbot/.env` 的
> `ASTRBOT_DASHBOARD_PASSWORD`，否则 `selfext` 登录失败（它不读 WebUI 的哈希）。

- 用本机 `.env` 里的 WebUI 账号登录 AstrBot；
- 调 `/api/v1/plugins`、`/api/v1/plugins/market`、`/api/v1/plugins/install/url`、
  `/api/v1/plugins/reload`、`/api/v1/plugins/update`；
- 把每次操作的开始/结果写进 `logs/selfext.log`；
- `upgrade` 用路线内的 `uv tool upgrade astrbot --python 3.12`；
- `restart` 建一个带时间戳的计划任务（`QQbotAstrBotRestart<ts>`），由它
  `timeout` 延迟 → `kill-astrbot.ps1` 杀父/子进程 → `run-astrbot.cmd` 前台拉起。
  计划任务不受 DSH 会话 job 回收影响，AstrBot 能真正活下来；先把最后一句话发回 QQ，再重启。

**实测（2026-10-26）**：

- 在假的 OneBot 客户端里说“我授权你直接装”，bot 自己 `search echo` →
  `install ocetars/astrbot_plugin_echo` → `plugins list` → `reload`，最后回“装好了，reload 也成功了”。
  第一次安装还遇到 `app/.astrbot` 空文件挡路，它自己挪走并说明原因。
- `upgrade` 当场升了 `sse-starlette` / `win32-setctime` / `xinference-client`；
- `restart --delay 5` 后 AstrBot 换 PID 重新监听 6186/6199，NapCat 在 30 秒内自动重连，
  两个插件都重新加载。

---

## 权限：所有者 / 维护者 / 访客

桥插件按发送者分三层，配置在 AstrBot 插件配置里：

| 角色 | 配置 | 能做什么 |
|---|---|---|
| 所有者 | `owner_users`（默认 `2791932480`，绮罗星） | 全部：改仓库、跑命令、装/升插件、派子进程 |
| 维护者 | `maintainer_users`（白名单） | 装插件、升级、维护 `routes/astrbot`、派子进程；不碰生产 Koishi |
| 访客 | 其他所有人 | 只聊天；要 bot 动手会被插件直接挡回 |

- 所有者自动算维护者；AstrBot 的 admin 也算所有者。
- 维护者自动获得 DSH 通行证：`/dsh`、私聊、引用续聊都放行，不用再往 `allow_users` 里加。
- 插件这层是硬闸：访客说“帮我装个插件”根本不会进 DSH，回一句
  “这个我可不敢替你动手，找有权限的人来”。
- 进了 DSH 的消息还会带一行 `[系统注记·勿复述]`，让模型知道这一轮该守什么边界；
  这行不会出现在 QQ 回复里。
- 名单管理（改完自动重载插件）：

```bash
node D:/deepseek/QQbot/routes/astrbot/scripts/selfext.cjs allowlist list
node D:/deepseek/QQbot/routes/astrbot/scripts/selfext.cjs allowlist add 1234567890
node D:/deepseek/QQbot/routes/astrbot/scripts/selfext.cjs allowlist remove 1234567890
```

- `guest_chat`：关掉后名单外的私聊直接不理（默认开，访客能聊天）。
- 别把提示词当权限系统：`danger-full-access` 下模型理论上能改任何文件；这份白名单挡的是
  “在 QQ 里让 bot 动手”这条入口，不是 OS 沙箱。

---

## 子 agent：最多 3 个，先登记地盘

DSH 没有子 agent 并发上限，也不会记谁在改哪个文件。工作区用
`workspace/scripts/subagent-gate.cjs` 记账（状态在 `workspace/.state/`，已 gitignore）：

```bash
node D:/deepseek/QQbot/routes/astrbot/workspace/scripts/subagent-gate.cjs status
node D:/deepseek/QQbot/routes/astrbot/workspace/scripts/subagent-gate.cjs acquire --task "写插件文档" --files "routes/astrbot/README.md"
node D:/deepseek/QQbot/routes/astrbot/workspace/scripts/subagent-gate.cjs release <lease>
```

- 同时最多 **3 个** lease；第 4 个拿不到名额（退出码 3）。
- 文件地盘重叠（同一文件、或目录互相包含）会被拒（退出码 4），并告诉你是和哪个 lease 撞了。
- 子 agent 的 prompt 里要写死“只改 `--files` 里的路径”；两个子 agent 改同一文件必须串行。
- 结束就 `release`；漏了用 `sweep` 清 3 小时以上的僵尸。

这是**流程约束**，不是 DSH 内核限制：规矩写在 `workspace/AGENTS.md`，靠模型自觉执行。

---

## 验证（不依赖 QQ）

```bash
# 1) ingress 活着
curl http://127.0.0.1:3188/health
# {"ok":true,"plugin":"dsh-astrbot-ingress",...,"capabilities":[...]}

# 2) 直接走 ingress，看 DSH 是否回话
TOKEN=$(node -e "console.log(require('C:/Users/27919/.dsh/astrbot-ingress.json').token)")
curl -N -X POST http://127.0.0.1:3188/inbound \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"umo":"test:private:2791932480","text":"你是谁？","senderId":"2791932480","chatType":"private"}'
# 预期：text「我是大肥鱼…」→ done

# 3) 假 OneBot 客户端连 AstrBot :6199/ws，发普通私聊（不带 /dsh）
#    本轮实测：人设回复 + 自行调用 selfext + 子 agent 数文件
```

---

## NapCat 登录排查（2026-10-26）

`http://127.0.0.1:6099` 起来了、能打开 WebUI，不等于 QQ 登录成功。用 NapCat 自己的 API 看：

```bash
# 1) 用 webui.json 的 token 换 Credential
# 2) POST /api/QQLogin/CheckLoginStatus
```

上午曾返回：

```json
{"isLogin":false,"loginPhase":"waiting_qrcode","coreReady":false,
 "loginError":"当前账号(2178517838)已登录,无法重复登录"}
```

含义：腾讯认为 **2178517838 还在别的设备/电脑 QQ 上在线**，所以 NapCat 这边不能重复登录。
处理：

1. 在手机 QQ / 其他电脑上把 **2178517838** 退出登录；
2. 回到 NapCat WebUI（`http://127.0.0.1:6099`）点快速登录 / 扫二维码；
3. 看到 `isLogin: true` 且 `coreReady: true`；
4. AstrBot 的反向 WS（`ws://127.0.0.1:6199/ws`）会自动连上，私聊直接和 DSH 说话。

**当天下午已通**：`isLogin:true, loginPhase:"ready", coreReady:true`，
`:6199` 与 NapCat 的连接 ESTABLISHED，AstrBot 日志开始出现真实事件。

> 注意：NapCat 的 OneBot **服务端** `3001`（给 Koishi）当前是 `enable:false`。
> 要用 Koishi 时把它改回 true 并重启 NapCat；AstrBot 用的是独立的反向 WS 客户端 `:6199`。

---

## 安全边界

- 只监听本机：ingress `127.0.0.1:3188`、OneBot `127.0.0.1:6199`、WebUI `127.0.0.1:6186`。
- **DSH qqbot 用 `danger-full-access`**：这是为了让 QQ 里的 bot 能装插件/跑脚本/改自己；
  代价是它理论上能改本机任何文件。AGENTS.md 里写了“不碰 routes/koishi 生产、不读密钥、
  破坏性操作先问”，但这是提示词约束，不是 OS 沙箱。
- QQ 侧“能不能让它动手”由 `maintainer_users` 白名单控制：访客只能聊天，
  插件会在消息进 DSH 之前就把装插件/升级/改文件/派子进程的请求挡回去。
- `selfext` 只从官方插件市场/可信仓库装；升级前会先让 bot 在 QQ 里说明。
- DSH 的审批 / 提问仍可在 QQ 里回答；超时或 `取消` 不会替人做选择。

---

## 已知本机状态（2026-10-27）

| 项 | 值 |
|---|---|
| AstrBot | 4.29.3，`routes/astrbot/app`，WebUI `http://127.0.0.1:6186` |
| 已装 AstrBot 插件 | `astrbot_plugin_dsh` 0.3.23、`astrbot_plugin_echo` 1.0.0（后者为自装测试） |
| DSH profile | `qqbot`，WebUI `http://127.0.0.1:8090`，ingress `:3188`，默认权限 `danger-full-access` |
| **DSH 模型** | **`deepseek-official / deepseek-flash`**（DeepSeek 官方，key 在 `~/.dsh/.credentials.yaml` 的 `refs.DEEPSEEK_API_KEY`）；commandcode 已禁用 |
| 人格 | `workspace/AGENTS.md`（大肥鱼；不刻意喊“主人”） |
| 自我扩展 | `scripts/selfext.cjs`（含 `allowlist` 维护者白名单）+ `skills/astrbot-selfext` |
| 权限 | `owner_users` = `2791932480`（绮罗星）；`maintainer_users` 白名单；访客只聊天 |
| 子 agent | `workspace/scripts/subagent-gate.cjs`：最多 3 个并行 + 文件地盘租约 |
| OneBot | 反向 WS `ws://127.0.0.1:6199/ws`，token 在 `app/data/cmd_config.json`；已与 NapCat ESTABLISHED |
| NapCat | **已登录**（`isLogin:true`，coreReady:true）；给 Koishi 的 `3001` 服务端当前 `enable:false` |
| Koishi 路线 | **当前未运行**（5140/3001 都没监听）；且它的 `CC_API_KEY` 已欠费，启动也聊不了，见下 |

---

## 故障：8090 打不开 / ingress 不响应（2026-10-27 实修）

**现象**：`netstat` 能看到 `127.0.0.1:8090` 和 `:3188` 都在 LISTENING，但
`curl http://127.0.0.1:8090/` **超时（http_code=000，不是 401）**，`/health` 也挂住；
NapCat 那边 AstrBot 收得到消息却一直不回。

**根因**：老的那个 `dsh --profile qqbot` 进程**挂死但没退出**，端口一直占着。
之后每次 `start-dsh-qqbot.cmd` 都在启动阶段炸掉——`~/.dsh/logs/startup-*.log` 里是：

```
dsh: startup failed: 2 required plugins did not activate
  webserver (required)  Error: listen EADDRINUSE: address already in use 127.0.0.1:8090
  dsh-astrbot-ingress   listen failed: EADDRINUSE 127.0.0.1:3188
```

日志里连着 4 次（18:31:55 / 18:32:01 / 18:32:35 / 18:58:02）全是同一个 EADDRINUSE，
说明**不是配置问题，是被僵尸进程占位**。

**怎么判断是不是这一类**：

```bash
netstat -ano | grep -E ":(8090|3188)\s"     # 有 LISTENING → 看 PID
curl -s -m 8 -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8090/   # 000=超时=挂了；401=活着
```

**修法**（照这个顺序，别只重启）：

```bash
# 1) 找到占端口的 dsh qqbot 进程
powershell -c "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ? { \$_.CommandLine -like '*--profile qqbot*' } | select ProcessId,CreationDate"

# 2) 连子进程一起杀掉（/T），再确认端口空了
taskkill /PID <那个PID> /T /F
netstat -ano | grep -E ":(8090|3188)\s"      # 应该什么都不输出

# 3) 重新起
routes\astrbot\scripts\start-dsh-qqbot.cmd
```

**验活标准**（三个都要对）：

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8090/   # 401
curl -s http://127.0.0.1:3188/health                              # {"ok":true,...}
cat ~/.dsh/astrbot-ingress.json                                   # pid = 新进程，updatedAt 是刚才
```

> `~/.dsh/astrbot-ingress.json` 的 `updatedAt` 是**心跳**（beacon 每 30 秒写一次）。
> 它停在某个时刻不动 = 进程在那一刻之后就没心跳了，这是判断"挂死 vs 只是慢"最快的信号。

### 顺带：8090 直接开浏览器会 401，不是端口没起来

`http://127.0.0.1:8090/` **裸开永远是 401**——WebUI 要带登录令牌。令牌**每次启动都变**，
在 `dsh` 自己的 stdout 里打出来：

```
dsh web: http://127.0.0.1:8090/?token=xxxxxxxx
```

所以判断"8090 到底活没活"要看 `http_code`：

| 返回 | 含义 |
|---|---|
| **000 / 超时** | 进程挂了或卡死 → 按上面的排障做 |
| **401** | **活着**，只是没带 token |
| **303** | 活着，token 有效（会 303 跳到主界面并种 cookie） |

如果当初窗口已经关了、找不到那行 token，重启一次就能拿到新的。

### 顺带：commandcode 额度耗尽的报文

```
{"error":{"message":"You have insufficient credits to make this request. ...",
          "code":"BAD_REQUEST"}}
```

`http_code` 是 **400**（不是 401），所以**别把 400 当成 key 写错**。

⚠️ **Koishi 路线同样中招**：`routes/koishi/app/.env` 的 `CC_API_KEY` 走的是同一个中转，
实测也是这个报文。也就是说 Koishi 现在就算启动起来也聊不了；要用得把 ChatLuna 的
`ccfree` 适配器换成 DeepSeek 官方端点（`https://api.deepseek.com`，模型 `deepseek-chat` 等）。
本机当前 Koishi 未运行（5140 未监听），所以暂时不影响。
