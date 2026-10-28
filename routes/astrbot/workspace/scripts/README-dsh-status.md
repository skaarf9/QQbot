# dsh-status — DSH 自检 / 状态查询

一条只读命令，回答「现在是什么状况」：

- 当前工作目录、项目根、是不是 git 仓库、分支、未提交改动；
- MCP 服务清单与状态（已连接 / 启动中 / 卡住 / 失败 / 未运行），以及**有没有任务在等某个 MCP 安装完成**；
- 最近任务记录：哪些超时/被杀/超过 300 秒、等了多久、卡在哪一步；
- 当前会话上下文的近似占用（来自模型返回的真实 `usage`）。

> 所有数据都来自本机的真实文件 / 进程 / 端口 / 会话记录。
> 读不到就输出「不可用」并写明原因，**不编数字**。

## 一条命令

Windows：

```bat
D:\deepseek\QQbot\routes\astrbot\workspace\scripts\dsh-status.cmd
```

或者：

```bat
cd D:\deepseek\QQbot\routes\astrbot\workspace
node scripts\dsh-status.cjs
```

机器可读：

```bat
scripts\dsh-status.cmd --json
```

## 输出怎么读

| 段落 | 内容 | 主要数据源 |
| --- | --- | --- |
| `[1] 工作区 / Git` | cwd、git 根、分支、最近提交、未提交数量、上游领先/落后 | `git rev-parse` / `git status` / `git log` |
| `[2] MCP 服务` | 每个 MCP 的每个 DSH 实例状态、PID、存活时长、端口、依赖 | `~/.dsh/cordis.patch.yml`、`~/.dsh/profiles/<profile>/cordis.patch.yml`、Win32_Process、`netstat` |
| `[3] 最近任务 / 超时` | 超时/中断/失败/超 300s 的 job，耗时和工具调用步骤 | `~/.dsh/sessions/<workspace>/*/session.v4.jsonl.zstd` 里的 `job/registered`、`job/settled`、`tool/call` |
| `[4] 上下文占用` | 最近一次模型调用的 prompt tokens、窗口占比、会话文件大小 | 会话记录里的 `assistant/message.usage`、`request/context.contextWindow` |
| `[5] 数据来源 / 不可用项` | 本次读了哪些文件/命令，哪些失败了 | 运行时汇总 |

### MCP 状态的含义

- **已连接**：匹配到该 MCP 的服务进程，且存活超过 20 秒。stdio MCP 没有独立的协议握手探针，所以这是**进程级推断**，输出里会写证据。
- **启动中**：服务进程刚拉起（<20s），或启动器还在、服务进程尚未出现（<60s）。
- **卡住**：服务进程在，但配置里的上游端口（如 godot-ai 的 8001/8002）不通；或启动器存活 >60s 仍没有服务进程。
- **失败**：配置里的启动器路径不存在。
- **未运行**：配置存在，但当前 DSH 实例没有对应进程。stdio MCP 可能按需启动，第一次调用工具后才出现，不一定代表坏了。

### “等待中的 MCP 安装/启动”

同时检查四类真实信号：

1. 正在运行的安装进程（`uv/uvx/pip/npm/pnpm/yarn/git clone/winget/choco`），且命令行/目标能关联到 MCP；
2. 配置指向的启动器路径不存在（疑似没装完）；
3. 会话记录里 `job/registered` 但一直没有 `job/settled` 的任务，且命令像安装/MCP；
4. 这些任务已等待多久、是否超过 180 秒（可能卡住）。

输出只有 `有` / `未发现` 两种结论；`未发现` 时会说明检查过哪些信号。

### 超时记录

- `中断(被杀)`：job 状态是 `killed/cancelled/aborted`；
- `超时`：状态或 detail 里出现 `timeout/timed out/超时/ETIMEDOUT`；
- `超300s(完成)`：任务完成但耗时 >300 秒（违反长任务保护线）；
- `失败`：job 状态是 `failed`；
- `运行中>300s`：会话里登记了 job，但一直没有结算记录。

“卡在哪一步”会显示：工具名 + `turn/step` + 命令摘要（去掉 PowerShell 前置赋值）。
如果命令里出现 `everything-mcp`、`godot-ai`、`pip install`、`图片` 等关键词，会在前面加 `[关键词]`，方便一眼看出卡在哪条链路。

### 上下文占用

`assistant/message.usage` 是 provider 返回的真实用量。`promptTokens` 按下面的方式取：

```text
promptTokens = totalTokens - outputTokens
```

也就是「未缓存输入 + 缓存命中」。输出会同时列出未缓存输入和缓存命中，避免把 `inputTokens` 只有几百误读成上下文很小。
如果会话记录里没有 `usage`，直接输出 `不可用`，不做字符数估算。

## 参数

```text
--cwd <path>      要检查的工作目录（默认当前目录）
--profile <name>  DSH profile（默认 $DSH_PROFILE，否则按进程祖先推断）
--days <n>        会话回溯天数（默认 14）
--limit <n>       最近任务表最多显示几条（默认 12）
--json            输出 JSON，便于别的脚本消费
--help            显示帮助
```

## 依赖与限制

- Node >= 22.15（使用 `node:zlib` 的 zstd 解压）。当前机器 v22.22.2 满足。
- Windows 下会调用 `powershell.exe` 查询 `Win32_Process`，调用 `netstat.exe` 查询监听端口。
- 只扫描**当前工作目录对应**的会话目录；该目录不存在时按会话里的 `cwd` 过滤，跨工作区的历史不会混进来。
- `--json` 的 `tasks.events` 受 `--limit` 限制。
- MCP “已连接”是进程级推断；要确认协议层可用，实际调用一次该 MCP 的工具最可靠。
- 输出会对 `token/api_key/secret/password/authorization/cookie/bearer` 这类赋值做 `***` 遮蔽。
- 非 Windows 的 `ps`/`ss` 分支已写但未在本机验证。

## 纪律（重要）

1. **独立、互不依赖的任务必须开独立会话。** 不要把「装 MCP」「查文档」「改代码」「验收」塞进同一个会话串行做；上下文会互相污染，一个卡住会把整条线堵死。
2. **预计可能超过 300 秒的任务，先拆步或加超时保护。** 例如：
   - 把「安装 + 验证 + 改配置」拆成三次独立调用；
   - 命令层加 `timeoutMs`，或用 `Start-Process` / 看门狗，卡住就杀；
   - 不要在一个工具调用里盲等网络安装。
3. **卡住超过 300 秒，先跑 `dsh-status`**，看是 MCP、端口、网络还是某个 job 卡住，再决定重试/换路；不要重复盲等。
4. 一个会话只承担一条主线；需要并行时用 `subagent`（先 `subagent-gate.cjs acquire`），不要在一个会话里开多个互不相关的大任务。

## 文件

- `scripts/dsh-status.cjs` — 主脚本（只读，无副作用）
- `scripts/dsh-status.cmd` — Windows 一条命令入口
- `scripts/README-dsh-status.md` — 本文
