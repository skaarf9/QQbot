# QQbot — 自建 QQ 机器人（两条路线：Koishi + AstrBot）

一个跑在自己小号上的 QQ 群/私聊机器人。项目现在按**技术路线**分目录：

| 路线 | 组成 | 负责 |
|---|---|---|
| **Koishi**（生产） | NapCat → Koishi → ChatLuna + 20+ 自研插件 | 群聊日常、记忆、好感度、表情包、主动插话、权限分级…… |
| **AstrBot**（新增） | NapCat → AstrBot → `dsh-astrbot-ingress` → DeepSeek Harness | **私聊全部消息 + `/dsh`**：DSH 用工具/skill 聊天、写代码、跑命令，并能自己装 AstrBot 插件/派子 agent |

> 私聊现在由 AstrBot → DSH 接管（`private_passthrough`）；群里普通闲聊归 Koishi，
> 群里 `/dsh` 走 AstrBot。
>
> ⚠️ **同一个号同时跑两条线时**：群聊不会双回（只有 Koishi 回普通消息），但**私聊会双回**
> （Koishi 的 ChatLuna 也会接私聊）。测试 AstrBot 私聊时先把 Koishi 停掉；要长期并行，
> 就给 Koishi 加私聊屏蔽，或者干脆用第二个小号。

> 完整开发过程、需求清单、踩坑记录见 [`进度与交接.md`](进度与交接.md) 与 [`docs/`](docs/)。
> 选型调研与迁移评估在 [`research/`](research/)。NapCat 接线见 [`接线与验证.md`](接线与验证.md)。

---

## 目录结构

```
.
├── routes/                        ★ 按技术路线分
│   ├── koishi/                    Koishi 路线
│   │   ├── app/                   生产实例（端口 5140）
│   │   ├── test/                  测试实例（假 OneBot）
│   │   ├── models/                本地嵌入模型缓存（不入库）
│   │   └── README.md
│   ├── astrbot/                   AstrBot 路线（新增）
│   │   ├── app/                   AstrBot 工作目录（data/ 不入库）
│   │   ├── plugins/               astrbot_plugin_dsh 桥插件（vendored）
│   │   ├── skills/                astrbot-selfext 技能（装插件/升级/重启）
│   │   ├── scripts/               启动脚本 + selfext.cjs
│   │   ├── workspace/             QQ 侧 DSH 工作区 + AGENTS.md 人设
│   │   └── README.md
│   └── napcat/                    QQ 协议端（两条路线共用）
│       ├── Shell/                 注入已安装 QQ；配置/日志在这里（不入库）
│       ├── Framework/             自带框架；config/logs 是指向 Shell 的 junction（不入库）
│       └── README.md
├── tools/                         跨实例运维脚本 + 一键启动面板
├── docs/                          文档（按主题/轮次分册）
├── research/                      选型调研、迁移评估、上游资料存档
├── 启动面板.cmd                   ★ Koishi/NapCat 一键面板
├── 启动NapCat.cmd                 手动启动 NapCat
├── 进度与交接.md / 接线与验证.md
└── .env.example 见 routes/koishi/app、routes/koishi/test
```

**不入库**（`.gitignore` 已排除，新设备需另行准备）：`node_modules/`、
`routes/napcat/Shell|Framework/`（QQ 框架本体 ~315 MB）、`routes/koishi/models/`
（本地嵌入模型 ~24 MB，可重下）、各 `data/`（聊天库）、`routes/astrbot/.uv-tools`、
`routes/astrbot/bin/`、`.env`（密钥）。

---

## 两条路线怎么分工

```
QQ / NapCat
 ├─ OneBot 服务端 :3001 ──▶ Koishi :5140 ──▶ ChatLuna（群聊日常，现有全部插件）
 └─ 反向 WS 客户端 ────────▶ AstrBot :6199 ──▶ dsh-astrbot-ingress :3188 ──▶ DSH agent
                                                                    （私聊全部 + /dsh）
```

- AstrBot 侧的**默认大模型和内置指令已关闭**，只保留 DSH 桥：它不会自己聊天，
  所有私聊/`/dsh` 都交给 DSH；群聊普通闲聊仍归 Koishi。
- DSH 是**独立的 profile**（`~/.dsh/profiles/qqbot`，端口 8090），与网页端 `web` profile
  共用凭据、skills 和 sessions 根目录，但进程与会话互不干扰。
- AstrBot **不是原生直连 DSH**：它通过 `astrbot_plugin_dsh` +
  `dsh-astrbot-ingress` 两个插件把消息转给 DSH。工具、skill、子 agent 都由 DSH 提供。
- 人设来自 [`routes/astrbot/workspace/AGENTS.md`](routes/astrbot/workspace/AGENTS.md)（大肥鱼）；
  自我扩展（装 AstrBot 插件/升级/重启）走 `routes/astrbot/scripts/selfext.cjs`。

详见 [`routes/astrbot/README.md`](routes/astrbot/README.md)。

---

## 在新设备上部署

### 0. 前置

- **Node.js 22+**（本机实测 22.x）
- **Python 3.12+**（AstrBot 要求）与 [`uv`](https://docs.astral.sh/uv/)
- Git
- 一个 **QQ 小号**（机器人账号）
- **NapCat**（QQ 框架，需另装，见第 4 步）

### 1. 克隆

```bash
git clone https://github.com/skaarf9/QQbot.git
cd QQbot
```

### 2. Koishi 依赖（会自动打市场插件补丁）

```bash
cd routes/koishi/app
npm install          # postinstall 自动执行 ../../../tools/patch-sticker.cjs
```

> `external/` 下的自研插件通过 `package.json` 的 `file:external/<包名>` 依赖安装，
> `npm install` 会一并链接好。`routes/koishi/test` 的 `file:../app/external/...` 同理。

### 3. 配置密钥

复制 `routes/koishi/app/.env.example` 为 `routes/koishi/app/.env`，填入：

| 变量 | 说明 |
|---|---|
| `CC_API_KEY` | ChatLuna 用的模型 API key（commandcode 中转） |
| `NAPCAT_TOKEN` | OneBot 握手 token，32 位随机串，**必须与 NapCat 侧完全一致** |

### 4. 安装并启动 NapCat

1. 从 NapCat 官方 Release 下载，解压到 `routes/napcat/Shell/`、`routes/napcat/Framework/`。
2. 登录机器人小号；在 OneBot 11 配置里：
   - **WebSocket 服务端** `ws://127.0.0.1:3001`（给 Koishi），token 与 `.env` 一致；
   - **WebSocket 客户端** `ws://127.0.0.1:6199/ws`（给 AstrBot，可选），
     token 与 `routes/astrbot/app/data/cmd_config.json` 的 `ws_reverse_token` 一致。
3. 启动脚本：`tools/start-napcat-shell.bat`、`tools/start-napcat-framework.bat`。

> Framework 的 `config/`、`logs/` 是指向 `Shell/` 的绝对路径 junction；整体搬动
> `routes/napcat/` 后要重建，见 [`routes/napcat/README.md`](routes/napcat/README.md)。

### 5. ★ 手动补打一个市场插件补丁

`npm install` 只自动打 `patch-sticker`。还有一个补丁**必须手动重跑**（它改的是
`node_modules` 里的构建产物，npm 重装后会被覆盖）：

```bash
cd routes/koishi/app
node tools/patch-long-memory.cjs
```

### 6. 启动 Koishi

**推荐：双击仓库根目录的 `启动面板.cmd`** —— 它起一个本地面板（<http://127.0.0.1:5151>），
在里面一键启停 Koishi / NapCat、看两边日志、显示 NapCat 登录二维码。
详见 [`tools/panel/README.md`](tools/panel/README.md) 与 [`docs/34-一键启动面板.md`](docs/34-一键启动面板.md)。

或者手工：

```bash
cd routes/koishi/app
npm start
```

控制台：<http://127.0.0.1:5140>。看到下面三行即为正常：

```
[I] server server listening at http://127.0.0.1:5140
[I] console webui is available at http://127.0.0.1:5140
[I] adapter connect to server: ws://127.0.0.1:3001/
```

> 生产实例平时请用 `node routes/koishi/app/tools/run-prod.cjs`（面板走的就是它）：
> 日志按天落盘、跨天自动换文件、启动前查 5140 占用与“孤儿实例”。

### 7. AstrBot 路线（可选，新增）

一次性安装：

```bash
cd routes/astrbot
UV_TOOL_DIR="D:/deepseek/QQbot/routes/astrbot/.uv-tools" \
UV_TOOL_BIN_DIR="D:/deepseek/QQbot/routes/astrbot/bin" \
uv tool install astrbot --python 3.12

cd app && ../bin/astrbot.exe init -y

# DSH 侧：建独立 profile，并装 ingress + commandcode provider
dsh --profile qqbot --from-default-profile web --dump-config
dsh plugin --profile qqbot add dsh-astrbot-ingress @mars-sea/dsh-commandcode-provider
```

日常启动：

```bat
routes\astrbot\scripts\start-all.cmd
```

- AstrBot WebUI：<http://127.0.0.1:6186>（账号见 `routes/astrbot/.env`）
- DSH qqbot WebUI：<http://127.0.0.1:8090>
- ingress 健康检查：<http://127.0.0.1:3188/health>

在 QQ 里**私聊直接说话**即可（不再需要 `/dsh`）；群里发 `/dsh 你好`。
装 AstrBot 插件/升级自己可以说“用 selfext 装个 xxx”或“升级你自己”。
命令、配置、验证与 NapCat 登录排查见
[`routes/astrbot/README.md`](routes/astrbot/README.md)。

---

## 新设备上必须改的「绝对路径」

本仓库是在 `D:\deepseek\QQbot` 下开发的，部分**功能性**配置硬编码了这个路径，
换机器后要按新路径改（改完重启）：

| 位置 | 内容 | 说明 |
|---|---|---|
| `routes/koishi/app/koishi.yml`（搜索 `deepseek`） | MCP 的 `args` / `cwd` 指向 `mcp/websearch-server.cjs` | 不改则联网搜索 MCP 起不来 |
| `routes/koishi/test/koishi.yml` | 同上（若启用测试台） | — |
| `routes/astrbot/README.md` 里的 DSH `cwd` | `~/.dsh/profiles/qqbot/cordis.patch.yml` 的 ingress 工作区 | 不改则 QQ 任务落在旧路径 |
| `tools/setup-test-app.cjs`、`tools/link-plugin.cjs` 等 | 脚本内的 `APP` / `TEST` 常量 | 仅搭建测试台时需要 |

> `docs/` 里的路径引用只是文档正文，不影响运行。

---

## 自研插件（`routes/koishi/app/external/`）

入库的重点就是这些源码。它们以 `file:external/<包名>` 被 `package.json` 引用，
`npm install` 时自动链入 `node_modules`。新增插件后如果启动报
`[E] app cannot resolve plugin "xxx"`，用下面命令排查/链接：

```bash
node tools/link-plugin.cjs --list                     # 看哪些插件两边没链上
node tools/link-plugin.cjs koishi-plugin-xxx          # 链接单个插件
```

> ⚠️ 修改 `node_modules` 里市场插件（如 `chatluna-sticker`、`chatluna-long-memory`）的补丁
> 由 `tools/patch-sticker.cjs`（postinstall 自动）和 `routes/koishi/app/tools/patch-long-memory.cjs`
> （手动）负责，**升级/重装这些包后都要重新打**。

---

## 许可

个人项目，未附许可证。vendored 的 `astrbot_plugin_dsh` 与 `dsh-astrbot-ingress` 为 MIT。
