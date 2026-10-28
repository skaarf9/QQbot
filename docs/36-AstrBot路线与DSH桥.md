# AstrBot 路线：QQ → AstrBot → DSH

> 属于 [QQ 机器人项目 —— 进度与交接](../进度与交接.md) 的分册。
> 第十九轮（2026-10-25）。这一轮只做一件事：**按技术路线分目录，并把 AstrBot 这条新路线真正跑通**。

## 一、结论先行

| 问题 | 答案 |
|---|---|
| 项目为什么要分目录 | 原来 Koishi（生产）、NapCat（协议端）、调研资料、AstrBot 试验混在根目录；现在统一收到 `routes/` 与 `research/` |
| AstrBot 能直接连 DSH 吗 | **不能"原生直连"**。必须两端各装一个插件：DSH 侧 `dsh-astrbot-ingress`，AstrBot 侧 `astrbot_plugin_dsh` |
| 接上后能用 DSH 的工具和 skill 吗 | **能**。真正干活的是 DSH agent，AstrBot 只做 OneBot 收发。本轮已实测 `write` / `read` 工具落盘 |
| 会和现有 Koishi 抢消息吗 | 不会。AstrBot 的默认大模型与内置指令已关，只保留 `/dsh`；同一个 QQ 小号可以两条路线并存 |
| 迁移建议变了吗 | 没变。仍不建议把 Koishi 的 2 万行插件整体重写；AstrBot 先当副驾（见 [`research/迁移评估-Koishi到AstrBot.md`](../research/迁移评估-Koishi到AstrBot.md)） |

---

## 二、目录重组

```
routes/
├── koishi/{app,test,models}   原 koishi-app / koishi-test / models
├── astrbot/{app,plugins,scripts,workspace}
└── napcat/{Shell,Framework}   原 NapCat.Shell / NapCat.Framework
research/                      原根目录调研 md + _research + maibot_research
```

重组时踩到的三个真实问题：

1. **npm `file:` 依赖是绝对路径 junction**：`node_modules/koishi-plugin-chatluna-*`
   原指向 `D:\deepseek\QQbot\routes\koishi\app\external\...`，整目录移动后全部断链。
   用 PowerShell 扫 `node_modules` 里所有 Junction，把目标前缀替换成新路径后重建（55 个）。
2. **NapCat.Framework 的 `config/`、`logs/` 是绝对路径 junction**，指向 `NapCat.Shell`。
   移动后必须 `DirectoryInfo.Delete()` 再 `New-Item -ItemType Junction`，不能 `rmdir` 递归删。
3. **本地嵌入模型的缓存路径是"仓库根/models"**：插件按 `koishi-app/../models` 算，
   目录一搬就变成 `routes/koishi/models`；把原 `models/` 一并移过去，避免重下 24 MB。

验收：Koishi 仍能起、5140 在听、55 个插件全部 apply、MCP 联网搜索能找到新路径；
`node tools/check-docs.cjs` 0 ERROR / 0 WARN；面板仍能读新路径的 Koishi/NapCat 日志。

---

## 三、AstrBot 是怎么接上 DSH 的

```
QQ / NapCat
  ├─ OneBot 服务端 :3001 ──▶ Koishi :5140（普通聊天）
  └─ 反向 WS 客户端 ────────▶ AstrBot :6199/ws（只接 /dsh）
                                   │ HTTP + Bearer
                                   ▼
                          dsh-astrbot-ingress :3188
                                   │ ctx.agents / ctx.sessions
                                   ▼
                          DSH agent（工具 / skill / 审批 / 提问）
```

- **AstrBot 侧**：`astrbot_plugin_dsh` 0.3.23（vendored 在 `routes/astrbot/plugins/`）。
  它把 `/dsh` 消息 POST 到 ingress，消费 SSE，把文本/文件/审批问题发回 QQ。
- **DSH 侧**：`dsh-astrbot-ingress` 跑在独立 profile `qqbot` 里（`~/.dsh/profiles/qqbot`），
  监听 `127.0.0.1:3188`，把实际端口 + token 写进 `~/.dsh/astrbot-ingress.json`（beacon）。
- **同机零配置**：AstrBot 插件的 `ingress_url` / `token` 留空，启动时读 beacon；
  Docker 部署才需要手填 `host.docker.internal:3188` 与 token。

### 为什么不在当前 `web` profile 上装

`dsh plugin add` 会改 profile；`web` 正是用户当前这个 GUI 和本次对话用的 profile。
重启它会中断会话。因此新建 `qqbot` profile（从 `web` 模板复制），跑在 8090，
共享 `~/.dsh` 下的凭据、`skills/` 和 sessions 根目录，但**进程与会话隔离**。

---

## 四、实测记录（2026-10-25）

### 1) ingress 直接入站

```bash
curl -N -X POST http://127.0.0.1:3188/inbound \
  -H "Authorization: Bearer <beacon token>" -H "Content-Type: application/json" \
  -d '{"umo":"test:private:2791932480","text":"只回复两个字：成功","senderId":"2791932480","chatType":"private"}'
```

返回：

```
event: ack
data: {"sessionId":"session-5ccd...","reset":false}

event: text
data: {"text":"成功\n\n—— 本回合结束"}

event: done
```

### 2) AstrBot 全链路（假 OneBot 客户端）

没有启动 NapCat，直接用一个假 OneBot 客户端连 `ws://127.0.0.1:6199/ws`
（headers：`X-Self-ID`、`X-Client-Role: Universal`、`Authorization: Bearer <ws_reverse_token>`），
发一条 `/dsh 只回复两个字：桥通`。AstrBot 回：

```
send_private_msg {"user_id":2791932480,"message":[{"type":"text","data":{"text":"​​已交给 DeepSeek Harness…"}}]}
send_private_msg {"user_id":2791932480,"message":[{"type":"text","data":{"text":"​​桥通\n\n—— 本回合结束"}}]}
```

→ 证明 AstrBot 的 `/dsh` 命令、ingress 发现、SSE 回传、`send_private_msg` 全部通。

### 3) DSH 工具调用（关键）

```bash
# text: 请在当前工作区创建文件 dsh-proof.txt，内容写 hello-from-dsh，然后只回复 done
```

SSE 过程：

```
event: status  🔧 write D:\deepseek\QQbot\routes\astrbot\workspace\dsh-proof.txt
event: status  🔧 read  D:\deepseek\QQbot\routes\astrbot\workspace\dsh-proof.txt
event: text    done
```

文件落盘 15 字节，内容 `hello-from-dsh`。→ **工具不是 AstrBot 的，是 DSH 的**。

---

## 五、"工具与 skill"到底共享到什么程度

| 资源 | 是否可用 | 说明 |
|---|---|---|
| DSH 工具（shell / file / 检索 / browser / 任务板等） | ✅ | 由 `qqbot` profile 的 bundles 决定；当前 = base + web-app，和网页端同一套基础工具 |
| `~/.dsh/skills` 下的 skill | ✅ | 与网页端共享同一目录；本轮实测 qqbot 能看到 `grilling`、`hindsight-coding-agent` |
| ingress 自带 `dsh-qq-send-file` | ✅ | ingress 用 `ctx.skills.registerProvider` 自动注册，教模型用 `[SEND_FILE: 路径]` 发文件 |
| 网页端专属插件带的 skill（如 `frontend-verify` / `hatch-pet`） | ⚠️ 取决于 bundle | `qqbot` 只复制了 `web` 的 base + web-app；要完全对齐就把对应插件也加进 `qqbot` 的 bundles |
| DSH 会话 / 上下文压缩 / 审批 / 提问 | ✅ | `/dsh new|lst|use|status|compact|perm|model` 操作的都是 DSH 会话 |
| AstrBot 自己的 LLM / 内置指令 / 工具 | ❌（本路线主动关闭） | 避免和 Koishi 双回复；AstrBot 只当网关 |
| QQ 图片 / 文件双向 | ✅ | 入站 base64 / 共享目录 / URL；出站直发或向 ingress 拉取 |

**一句话**：不是"AstrBot 学会了 DSH 的工具"，而是"**DSH 还是那个 DSH，只是把聊天窗口从网页换成了 QQ**"。

---

## 六、边界与后续

- **同一小号双开**：NapCat 同时给 Koishi 服务端和 AstrBot 反向 WS 供事件。AstrBot 只对 `/dsh` 出声；
  但若以后打开 AstrBot 默认聊天，必须改 `wake_prefix` 或换号，否则会双回复。
- **路径**：NapCat 反向 WS 是 `ws://127.0.0.1:6199/ws`（AstrBot 4.29 的 aiocqhttp 路由），
  不是旧文档里的 `/onebot/v11/ws`；写错会 404。
- **审批**：DSH 的 shell 写工作区目前直接放行；写工作区外/敏感操作会在 QQ 里发审批卡片，
  超时或 `取消` 不会替人选择。
- **未做**：把 AstrBot 的启停接进 `tools/panel`（面板目前只管 Koishi/NapCat）；
  在真实 QQ 群里跑一轮（本轮用假 OneBot 客户端验到协议层，NapCat 真机留给用户首启时点一次登录）。

---

[← 回索引页](../进度与交接.md)
