# 把 DSH 降级成 ChatLuna 的一个工具

> 属于 [QQ 机器人项目 —— 进度与交接](../进度与交接.md) 的分册。
> 第二十二轮（2026-10-27）。承接 [docs/38](38-Koishi当网关直连DSH.md)。

---

## 1. 为什么又改了一次

docs/38 做成了形态 A（Koishi 当网关，私聊整条交给 DSH）。但那样是**二选一**：

| 形态 | 私聊归谁 | 私聊里的情绪/好感/记忆/表情包 |
|---|---|---|
| A（docs/38） | DSH | **全停**（ChatLuna 链完全不参与） |
| B | ChatLuna | 全保留，但模型自己**伸不了手**去用 DSH |

用户提了第三种，而且这是对的：**ChatLuna 当脑子，DSH 当手。**

> 「让整个 dsh 被模型来管理，模型可以在 dsh 中开启会话干活，模型只接收结果就行了，
> 模型发起和接收工作，那么整个 dsh 就作为它的一个工具一样的东西」
> 「为了节省 token，模型在开启新会话的时候需要考虑是否可以在旧会话的基础上继续发起聊天，
> 这样就不用每次开启会话的时候阅读项目目录以及文档了」

于是：**私聊回到 ChatLuna（全部插件复活），DSH 退成一个可被模型调用的工具**。

---

## 2. 缺的那一块：模型没有"手"

`koishi-plugin-dsh-connector`（docs/38 用的那个）**只注册 Koishi 指令**，
源码里只有 `ctx.command('dsh.xxx')`，**没有 `ctx.provide`、没有 ChatLuna 工具**
（实测 grep：`Service|ctx.set(|provide(|declare module` 全部为 0 命中）。
指令是**人敲的**，模型调不动 → 光把它加进来，模型还是只能干聊。

### 按硬约束第 0 条查过

| 步骤 | 结论 |
|---|---|
| 本地 29 个自研插件 | 没有任何 ChatLuna 工具桥到 DSH —— **无** |
| Koishi 市场（4818 条） | 同时提到 `dsh/harness` 与 `chatluna/tool` 的包：**0 个** |
| `chatluna-toolbox` | 只提供 OneBot 原生工具（poke/群成员/表情回复）+ 变量，不是声明式 HTTP 工具 |
| `chatluna-mcp-client` | 能做，但要先把 DSH 包成 MCP server，工作量不比自己写小 |
| → 自己写 | **`koishi-plugin-chatluna-dsh-tool`（463 行）** |

---

## 3. 为什么走 ingress，而不是复用 dsh-connector 的连接

`dsh-astrbot-ingress`（:3188）的接口是**纯 HTTP + SSE**，而且正好带着我们要的三样：

| 接口 | 用处 |
|---|---|
| `POST /inbound` | 派活；SSE 事件只有 `ack / text / status / file / error / done` |
| `GET /binding?umo=` | **`{bound, sessionId, cwd}`** —— 「这个聊天有没有旧会话」直接能问 |
| `sessions.json` | umo→sessionId **落盘**，重启也不丢 → 会话复用的基础 |
| 裸命令 `status` / `new` / `compact` / `end` / `stop` | 不用自己实现，原样透传 |

dsh-connector 内部有 client，但**没导出**；要复用它就得 fork 或改它的 3600 行 bundle。
ingress 是文档化的稳定契约，所以选 ingress。

> 因此 **`dsh-astrbot-ingress` 不能摘掉了**（docs/38 §6 曾写"可选摘掉"，已作废）。

---

## 4. 三个工具

| 工具 | 干什么 | 模型什么时候会想到它 |
|---|---|---|
| `dsh_run(task, mode?)` | 派活，拿回结果 | 改代码、查项目、跑脚本、批量处理文件 |
| `dsh_status()` | 有没有绑定会话 / 工作区 / **上下文占用** | 派长活之前先看占用 |
| `dsh_compact()` | 压缩上下文（留结论丢过程） | 占用高了又得接着在旧会话干 |

三个都在 `selector` 里按会话过滤：**私聊默认开**（`privateEnabled`），
**群聊默认关**（`groups` 白名单，留空=一律不给）——防止群里随口一句就烧掉一次任务。

### 省 token 的三个设计

1. **默认续用旧会话**：umo 固定成 `koishi:{group|private}:{id}`，
   ingress 那边 umo→sessionId 落盘。同一个聊天连着派活，DSH 是**同一个会话**，
   不需要每次重读项目目录。`mode: 'new'` 才另起炉灶。
2. **返回截断**：默认 `maxReturnChars: 3000`。工具返回值是**原样进 ChatLuna 上下文**的，
   DSH 一轮上万字全塞回去等于把省下的又花掉。截断时会明确告诉模型"被截了，要细节就再问那一点"。
3. **`dsh_status` 报上下文占用**：直接调 ingress 的 `status` 指令（本来就返回百分比/已用/上限），
   模型据此决定 `dsh_compact` 还是 `new`。

### 两个小细节

- **去掉桥接尾巴**：ingress 会给人看的 `—— 本回合结束` 之类，塞回模型只会浪费 token，
  已在 `clean()` 里剥掉。
- **失败也带半成品**：DSH 常常干完一半才炸，失败时把已经说出来的部分一起返回，
  模型可以接着用，不至于白跑。

---

## 5. 实测

工具层的 HTTP/SSE 已单测（用插件导出的 `__test`）：

```
信标: http://127.0.0.1:3188
binding: {"ok":true,"bound":false,"sessionId":null,"cwd":null}
  sse: ack  {"sessionId":"session-8e74974e-…","reset":false}
  sse: text {"text":"工具层已通\n\n—— 本回合结束"}
  sse: done {"sessionId":"session-8e74974e-…"}
```

**会话复用已验证**（这是省 token 的核心）：同一个 `umo` 再发一句

```
绑定复查: {"ok":true,"bound":true,"sessionId":"session-8e74974e-…","cwd":"…\\routes\\astrbot\\workspace"}
续聊结果: "你说"只回六个字"，内容是"工具层已通"。本鱼数了，那是五个字，少了一个😏"
```

→ 同一个 sessionId，DSH **记得上一轮**，没有重新读项目。

上线后 Koishi 启动日志：

```
chatluna-dsh-tool DSH 工具已注册：dsh_run / dsh_status / dsh_compact（私聊=开，群白名单 0 个）
adapter connect to server: ws://127.0.0.1:3001/
```

---

## 6. ✅ 会话空间已合并：只剩一套

**2026-10-27 晚，用户决定把"人敲指令"那条路整个去掉**，`koishi-plugin-dsh-connector`
已从 `koishi.yml` 删除并从 `node_modules` 卸载（`test` 实例同样处理）。
于是现在只有一个 DSH 客户端：

| 客户端 | 谁在用 | 会话表存在哪 |
|---|---|---|
| `chatluna-dsh-tool`（本插件） | **模型**调 `dsh_run` | ingress 的 `sessions.json`（落盘） |

> 原来两张表并存时的坑（人 `/dsh.new` 的会话模型不会接着用）**已经不存在了**。

代价（有意接受的）：

- 不再有 `/dsh.ping` `/dsh.sessions` `/dsh.model` `/dsh.permission` `/dsh.approve` 这些
  **人敲的运维指令**。要看状态就让模型调 `dsh_status`，要换模型/权限就改 DSH profile 的
  `cordis.patch.yml`（或者直接问 DSH 改）。
- `dsh-connector` 的「审批 / 提问回流」也没了。当前 qqbot profile 是
  `danger-full-access` + `approval: never`，本来不该弹审批；但模型若真的调
  `ask_user_question`，**这次工具调用会一直等到超时**（默认 300 秒），然后带着半成品返回。
  这是已知限制，暂时接受。
- 补丁脚本 `tools/patch-dsh-connector.cjs` 已停用（不进 postinstall），只留作记录。

---

## 7. 现在的分工

```
群聊 ──▶ ChatLuna 链（情绪/好感/记忆/表情包/proactive/人设 全在）
           └─ 需要干活时 → 模型自己调 dsh_run → DSH 干完把结果交回来
私聊 ──▶ 同一条 ChatLuna 链
           └─ 同上
```

**没有人敲 DSH 指令这条路了**——`dsh-connector` 已卸载。

配置要点（`routes/koishi/app/koishi.yml`）：

```yaml
  chatluna-dsh-tool:dsht01:
    ingressUrl: ''                  # 留空读 ~/.dsh/astrbot-ingress.json
    token: ''
    privateEnabled: true            # 私聊：模型能用
    groups: []                      # 群聊：留空 = 模型看不见这几个工具
    maxReturnChars: 3000
```

`groups` 是**工具注入开关**（`selector`），不是"让模型自己判断"：
名单外的会话里，这三个工具**根本不会出现在模型的工具列表里**。

---

## 8. 派活前先回执（2026-10-27 晚加）

**问题**：DSH 一轮实测 8~44 秒，用户发了消息之后**界面完全没动静**，
以为没收到、或者以为挂了。

**做法**：`dsh_run` 在被调用时**先自己发一句**，再等 DSH。

```yaml
    ackEnabled: true
    ackText: 我让 DSH 去查了，出结果了回复你    # 支持 {task} 占位符（任务前 30 字）
```

要点：

- 这条是**插件直接 `session.send`**，不经过模型 —— 所以不会被人格改写、也不占模型 token。
- 发送失败（风控/限流）**不阻断派活**，只记 warn 日志。
- 之后模型拿到结果还会再回一条正式答复，所以一轮会有**两条消息**：回执 + 结果。这是有意的。

## 9. 数据库自愈看护（`tools/watch-koishi-db.cjs`）

这套栈的 `sqlite` 驱动是 **sql.js（WASM 版）**，真机负载下会偶发
`RuntimeError: null function or function signature mismatch`；一旦发生，那笔事务不提交、
留下 `koishi.db-journal`，之后**所有写操作**报 `database disk image is malformed`，
表现就是 bot 满嘴「错误码 999/103」——而模型请求其实都成功
（详见 [坑 95](04-踩坑记录/08-断线与运行时故障.md)）。

排查过的、**不是**原因的东西：

- 驱动版本没变过（`@minatojs/sql.js` 3.1.0，2023-11-13 发布，本机 9-28 装的，今天没被 `npm i` 动过）
- 不是 `taskkill /F` 的热日志（这一次没硬杀也复发了）
- 不是库太大（VACUUM 到 536 KB 之后仍复发）
- 不是沙箱写大 blob（改 memory 后仍复发，只是频率降了）

根治要换**原生** sqlite 驱动，但 `@minatojs/driver-sqlite` 4.7.0 只认 sql.js；
5.x 驱动改用原生，却要求 `minato@^4` / `cordis@^4`，Koishi 4.18.11 够不到。

所以先加**兜底**：`node tools/watch-koishi-db.cjs`（间隔 25s、冷却 180s）

- 盯 `tools/logs/prod-err.log` 的新增内容，出现 `malformed` / `null function` 就自愈
- 自愈流程 = **杀 supervisor（精确匹配 `*koishi*bin.js*`，别用 `*bin.js*` 会误杀 DSH）**
  → 等 4 秒 → 原生 sqlite 回滚热日志 → 重新拉起 Koishi
- 全过程写 `tools/logs/watchdog.log`

它是**兜底不是修复**：真频繁触发，要回头查是哪个插件在制造超大写入。

## 10. 还欠的

- 群聊里要不要给模型开 `dsh_run`：现在白名单空 = 全关。想开就填群号
  （工具注入开关，见 §7），改完**必须按 [docs/38 §8](38-Koishi当网关直连DSH.md) 的安全流程重启 Koishi**。
- 提问/审批回流没有：模型若调 `ask_user_question`，这次工具调用会等到超时（见 §6）。
- 测试实例（`routes/koishi/test`）还没装本插件，rig 里验不了"模型会不会自己调工具"。
- 已经验证过的一点：**会话跨 DSH 重启存活**——重启 DSH 后同一 umo 仍是
  `session-8e74974e…`，它答"我这边只有刚才那两轮"，上下文没丢，没重读项目。

---

[← 回索引页](../进度与交接.md)
