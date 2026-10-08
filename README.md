# QQbot — 自建 QQ 机器人（NapCat + Koishi + ChatLuna）

一个跑在自己小号上的 QQ 群/私聊机器人：NapCat 提供 QQ 通道，Koishi 做框架，
ChatLuna 接大模型。除了市场上的插件，这里还有 **20+ 个自研插件**
（择机插话、长期记忆、表情包、好感度、权限分级、表情包、网页截图预览等）。

> 完整开发过程、需求清单、踩坑记录见 [`进度与交接.md`](进度与交接.md) 与 [`docs/`](docs/)。
> NapCat 侧接线步骤见 [`接线与验证.md`](接线与验证.md)。

---

## 目录结构

```
.
├── 启动面板.cmd          ★ 一键启动面板（双击：起本地控制台 + 开浏览器）
├── tools/panel/          ★ 那个面板（启停 Koishi/NapCat、看日志、显示登录二维码、跳转 WebUI）
├── koishi-app/          ★ 生产实例（端口 5140）
│   ├── koishi.yml        应用配置（密钥已外置为环境变量）
│   ├── package.json      依赖；自研插件以 file:external/<包名> 引入
│   ├── external/         ★ 自研插件源码（入库重点，见下）
│   ├── mcp/              自研 MCP（websearch-server.cjs 联网搜索）
│   └── tools/            测试 rig、剧本（scenarios/）、探针脚本
├── koishi-test/         测试实例（假 OneBot，用 tools/setup-test-app.cjs 搭建，可不装）
├── tools/               跨实例的运维脚本（补丁、建号、启动 NapCat 等）
├── docs/                文档（按主题/轮次分册）
├── _research/           选型调研资料（含各插件源码参考）
├── 进度与交接.md / 接线与验证.md
└── .env.example 见 koishi-app、koishi-test
```

**不入库**（`.gitignore` 已排除，新设备需另行准备）：`node_modules/`、
`NapCat.Framework/`、`NapCat.Shell/`（QQ 框架本体 ~315 MB）、`models/`（本地嵌入模型 ~24 MB，可重下）、
各 `data/`（聊天库）、`.env`（密钥）。

---

## 在新设备上部署

### 0. 前置

- **Node.js 22+**（本机实测 22.x）
- Git
- 一个 **QQ 小号**（机器人账号）
- **NapCat**（QQ 框架，需另装，见第 4 步）

### 1. 克隆

```bash
git clone https://github.com/skaarf9/QQbot.git
cd QQbot
```

### 2. 装依赖（会自动打市场插件补丁）

```bash
cd koishi-app
npm install          # postinstall 会自动执行 ../tools/patch-sticker.cjs
```

> `external/` 下的自研插件是通过 `package.json` 里的 `file:external/<包名>` 依赖安装的，
> `npm install` 会一并链接好，无需手动操作。

### 3. 配置密钥

复制 `koishi-app/.env.example` 为 `koishi-app/.env`，填入真实值：

| 变量 | 说明 |
|---|---|
| `CC_API_KEY` | ChatLuna 用的模型 API key（commandcode 中转） |
| `NAPCAT_TOKEN` | OneBot 握手 token，32 位随机串，**必须与 NapCat 侧完全一致** |

`koishi.yml` 里所有平台都写 `${{ env.CC_API_KEY }}`，不会出现明文。
（`koishi-test/.env` 只需要 `CC_API_KEY`。）

### 4. 安装并启动 NapCat

1. 从 NapCat 官方 Release 下载，解压到项目根目录下的 `NapCat.Shell/`、`NapCat.Framework/`
   （或任意目录，本仓库未入库这两者）。
2. 登录机器人小号，在 NapCat 的 **OneBot 11** 配置里开一个 **WebSocket 服务端**，监听
   `ws://127.0.0.1:3001`，token 与 `.env` 的 `NAPCAT_TOKEN` 保持一致。
3. 本机辅助脚本：`tools/start-napcat-shell.bat`、`tools/start-napcat-framework.bat`。

### 5. ★ 手动补打一个市场插件补丁

`npm install` 只自动打 `patch-sticker`。还有一个补丁**必须手动重跑**（它改的是
`node_modules` 里的构建产物，npm 重装后会被覆盖）：

```bash
cd koishi-app
node tools/patch-long-memory.cjs
```

### 6. 启动

**推荐：双击仓库根目录的 `启动面板.cmd`** —— 它起一个本地面板（<http://127.0.0.1:5151>），
在里面一键启停 Koishi / NapCat、看两边日志、显示 NapCat 的登录二维码，
并给出两个自带 token 的 WebUI 跳转链接。详见 [`tools/panel/README.md`](tools/panel/README.md)
与 [`docs/34-一键启动面板.md`](docs/34-一键启动面板.md)。

或者按老办法手工起：

```bash
cd koishi-app
npm start
```

控制台：<http://127.0.0.1:5140>。看到下面三行即为正常：

```
[I] server server listening at http://127.0.0.1:5140
[I] console webui is available at http://127.0.0.1:5140
[I] adapter connect to server: ws://127.0.0.1:3001/
```

NapCat 没起来时会每 5 秒重试、`ECONNREFUSED 127.0.0.1:3001` 属预期现象。

> 生产实例平时请用 `node koishi-app/tools/run-prod.cjs`（面板走的就是它）：
> 日志按天落盘、跨天自动换文件、启动前查 5140 占用与"孤儿实例"。

---

## 新设备上必须改的「绝对路径」

本仓库是在 `D:\deepseek\QQbot` 下开发的，部分**功能性**配置硬编码了这个路径，
换机器后要按新路径改（改完重启）：

| 位置 | 内容 | 说明 |
|---|---|---|
| `koishi-app/koishi.yml`（搜索 `deepseek`） | MCP 的 `args` / `cwd` 指向 `mcp/websearch-server.cjs` | 不改则联网搜索 MCP 起不来 |
| `koishi-test/koishi.yml` | 同上（若启用测试台） | — |
| `tools/setup-test-app.cjs`、`tools/link-plugin.cjs` 等 | 脚本内的 `APP` / `TEST` 常量 | 仅搭建测试台时需要 |

> `docs/` 里的路径引用只是文档正文，不影响运行。

---

## 自研插件（`koishi-app/external/`）

入库的重点就是这些源码。它们以 `file:external/<包名>` 被 `package.json` 引用，
`npm install` 时自动链入 `node_modules`。新增插件后如果启动报
`[E] app cannot resolve plugin "xxx"`，用下面命令排查/链接：

```bash
node tools/link-plugin.cjs --list                     # 看哪些插件两边没链上
node tools/link-plugin.cjs koishi-plugin-xxx          # 链接单个插件
```

> ⚠️ 修改 `node_modules` 里市场插件（如 `chatluna-sticker`、`chatluna-long-memory`）的补丁
> 由 `tools/patch-sticker.cjs`（postinstall 自动）和 `koishi-app/tools/patch-long-memory.cjs`
> （手动）负责，**升级/重装这些包后都要重新打**。

---

## 许可

个人项目，未附许可证。
