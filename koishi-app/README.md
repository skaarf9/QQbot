# qqbot-koishi

自建 QQ 机器人（**小号 + NapCat + Koishi**）——阶段 1 骨架 + 阶段 2 第 1 步（持久化）。

> 阶段 0（NapCat 侧）的改动与验证步骤见上级目录的 [`接线与验证.md`](<../接线与验证.md>)。
> 项目整体进度、需求清单、选型理由见 [`进度与交接.md`](<../进度与交接.md>)。

## 当前状态

| 项 | 状态 |
|---|---|
| Koishi 4.18.11 启动 | ✅ 已验证 |
| 控制台 http://127.0.0.1:5140 | ✅ 已验证（0 失败请求） |
| OneBot 适配器连接 NapCat | ✅ 已验证（收发行日志齐全） |
| **QQ 群/私聊消息收发闭环** | ✅ **已验证**（`/help`、`/echo` 正常应答） |
| **sqlite 持久化** | ✅ **已验证**（建组 → 重启 → 仍在 → 删除，四步都写进了 `data/koishi.db`） |
| 控制台插件管理页 | ✅ `/plugins/`、`/market`、`/dependencies` 已可用 |

## 启动

```powershell
cd D:\deepseek\QQbot\koishi-app
npm start                                        # 日常
node node_modules\koishi\bin.js start --log-level 3   # 排障：开 debug
```

> **排障一定用第二条。** 默认 info 级别会把适配器的 `[receive]` / `[request]` /
> `[response]` 全部吞掉，看起来像"消息根本没到"，实际只是在正常工作。
>
> 注意：环境变量名字是 `KOISHI_LOG_LEVEL`（不是 `LOG_LEVEL`）且必须是数字，
> 而且**CLI 会把它清空**（`koishi/lib/cli/index.js: process.env.KOISHI_LOG_LEVEL = logLevel || ""`），
> 所以只能靠 `--log-level` 参数，设环境变量无效。

启动成功的标志：

```
[I] server server listening at http://127.0.0.1:5140
[I] console webui is available at http://127.0.0.1:5140
[I] adapter connect to server: ws://127.0.0.1:3001/
```

NapCat 没启动时会每 5 秒重试、随后退避到 1 分钟，`ECONNREFUSED 127.0.0.1:3001` 是**预期现象**，不是故障。

> ⚠️ 重启前务必确认旧实例已退出，否则新实例的 `5140` 会绑定失败，
> 报 `Error: No open ports available` + `server closing`（但适配器仍会照常连接，容易误判）。
>
> **安全停止方式**（★ 千万别用 `Where-Object { $_.CommandLine -like '*koishi*' }`——
> dsh 的 `runner.js` 进程命令行里含有你正在执行的脚本文本，会被自己匹配到而误杀执行器）：
>
> ```powershell
> $c = Get-NetTCPConnection -State Listen -LocalPort 5140 -ErrorAction SilentlyContinue
> if ($c) {
>   $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)"
>   Stop-Process -Id $p.ProcessId -Force                                   # worker（占 5140 的那个）
>   $par = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)"
>   if ($par.CommandLine -like '*bin.js start*') { Stop-Process -Id $par.ProcessId -Force }
> }
> ```

## 当前可用指令

| 指令 | 来自 | 说明 |
|---|---|---|
| `/help` | `@koishijs/plugin-help` | 指令列表；`/help echo` 看单个指令用法 |
| `/echo <内容>` | `@koishijs/plugin-echo` | 原样复读 —— **最好的连通性测试** |
| `/command ...` | `@koishijs/plugin-commands` | 动态创建指令（需高权限） |
| `/authorize ...` | `@koishijs/plugin-admin` | 下发权限等级（R13 的核心，需高权限） |

**`help` / `echo` 不是 `commands` 自带的**，是独立插件。少了它们，
发 `/help` 的现象是**彻底静默**（无回复、无报错），极易误判成链路故障——
这个坑已经踩过一次。

## 配置（koishi.yml）

```yaml
prefix:            # 指令前缀，两种都认
  - /
  - .
plugins:
  server:            # 控制台监听，只绑本机
    host: 127.0.0.1
    port: 5140
  console: {}        # Web 控制台
  config: {}         # 控制台「插件配置」页
  market:            # 控制台「插件市场」页 —— 必须配 endpoint，见下方说明
    search:
      endpoint: https://registry.koishi.chat/index.json
  database-sqlite:   # 持久化数据库（path 无默认值，必填）
    path: data/koishi.db
  commands: {}       # 指令系统（注意：它不带 help / echo）
  admin: {}          # ★ R13 权限下发：/authorize + 控制台「权限管理」页
  help: {}           # /help —— 必须单独装，否则 /help 静默无响应
  echo: {}           # /echo —— 最省事的连通性测试指令
  adapter-onebot:    # QQ 通道
    protocol: ws
    endpoint: ws://127.0.0.1:3001
    token: "<32位随机串，与 NapCat 侧一致>"
    selfId: "2178517838"
```

> 实际文件里插件名会带实例 ID（如 `market:ht45i0`），那是 Koishi 自己加的，正常。

`token` 必须与 NapCat `onebot11_2178517838.json` → `network.websocketServers[0].token` **完全一致**，否则握手被拒。

### `database-sqlite` 的 `path` 是必填

`@minatojs/driver-sqlite` 的 schema 是 `path: z.string().role("path").required()`——
**没有默认值**，不写直接校验失败。目录要先建好（`data/`）。

### `market.search.endpoint` 也是必填（否则市场页报错）

不配这个，启动日志会出现：

```
[W] market TypeError: this is not a function
    at _Scanner.<anonymous> (@cordisjs/plugin-http/lib/index.cjs:178:36)
```

**这是上游 bug**：`plugin-market/lib/node/index.js:377` 把 `registry.get` 脱绑传给了 Scanner
（`new Scanner(registry.get)`），Scanner 内部 `this.request(...)` 让 `this` 变成 Scanner 实例，
而 http 的 `get` 依赖 `this` 是可调用 Proxy，于是 `this(...)` 抛错。

**绕行**：同文件 378 行的 `if (this.http)` 分支**不走 Scanner**，而 `this.http` 只在配了
`endpoint` 时才赋值（`if (config.endpoint) this.http = ctx.http.extend(config)`）。
所以填上 `search.endpoint` 即可绕过。这正是官方文档「市场加载不出来就填 search.endpoint」的真实原因。

可选镜像（实测于 2026-09-28）：

| 镜像 | 结果 |
|---|---|
| `https://registry.koishi.chat/index.json` | ✅ 1.2 s，4695 条（**当前在用**） |
| `https://koi.nyan.zone/registry/index.json` | ✅ 1.9 s，4907 条 |
| `https://koishi-registry.yumetsuki.moe/index.json` | ✅ 2.2 s，4695 条 |
| `https://kp.itzdrli.cc` | ⚠️ 37 s，太慢 |
| `https://registry.koishi.t4wefan.pub/index.json` | ❌ HTTP 502 |

### ChatLuna 就在官方源里

`chatluna|luna` 在官方索引命中 **138 个包**，包括 `chatluna`、`chatluna-deepseek-adapter`、
`chatluna-long-memory`、`chatluna-sticker`、`chatluna-affinity`、`chatluna-multimodal-service`、
`chatluna-agent`、`chatluna-proactive-trigger` 等。**不需要换源。**

## 依赖版本说明（重要，别乱升级）

搭这个骨架踩了两个坑，都是**同一类问题：依赖里出现第二份框架实例**。记在这里，避免以后踩回去：

| 坑 | 现象 | 原因 | 处置 |
|---|---|---|---|
| `@koishijs/cli` | `Cannot set property name of #<_MainScope>`、`this.ctx.debounce is not a function` | `@koishijs/cli@4.10.10` 内嵌 **cordis 2.10.3**，而当前插件代用 **cordis 3.18.1** → 两份实例 | **不要装它**。`koishi` 包自带 bin（`node_modules/koishi/bin.js`），依赖现代 `@koishijs/loader@4.6.11` |
| `@koishijs/plugin-adapter-onebot` | `Session2 is not a constructor` | 官方版停在 6.0.2（2024-05）并拖入 `@satorijs/satori@3.7.0` → 嵌套 `@satorijs/core@3.7.0`，与根 `4.6.0` 冲突 | 换 **`koishi-plugin-adapter-onebot@6.9.4`**（Koishi 官方组织的新仓库，peer `koishi ^4.18.6`，依赖只有一个 `qface`，无 satori 链） |

自检命令（应只看到**一条** `@satorijs/core`，且无嵌套路径）：

```powershell
Get-ChildItem node_modules -Recurse -Directory -Filter core |
  Where-Object { $_.FullName -match 'node_modules\\@satorijs\\core$' } |
  ForEach-Object { $_.FullName }
```

另外：OneBot 适配器的配置字段是 **`endpoint`**（不是 `url`），写错会报 schemastery 校验错误。

## 两个「看着像故障、其实无害」的报错

> ⚠️ **2026-10-06 更正**：下面第 1 条**不再成立**。`PacketBackend` 挂掉时"收消息/发消息"
> 确实照常，但**戳一戳（`send_poke`/`group_poke`）、私聊文件直链**这类能力会直接失效，
> 而且不抛错、只在 action 回包里带 `retcode 1400`。详见
> [docs/04-踩坑记录.md 坑 8](../docs/04-踩坑记录.md)。现在本机 QQ 是 `9.9.33-52230`
> （在 NapCat 4.18.30 的表内），报错已消失。

~~跑起来后一定会看到这两条，**都不用管**：~~

**1. NapCat 控制台（已过期，勿照抄）：**

```
[error] [Core] [Packet] PacketBackend 不支持当前QQ版本架构：9.9.36-53644-x64
```

~~这是 NapCat 的**包级 hook** 认不出你的 QQ 版本，会退回元素级 API。功能正常——~~
旧结论的依据是 `get_login_info` 正常返回，**但它根本不走 PacketBackend**，所以证明不了什么。
真正的判据是直接打一次走 PacketBackend 的 action：

```powershell
node ..\tools\napcat-probe.cjs call group_poke '{"group_id":454444539,"user_id":2791932480}'
```

`status: ok` 才算真正常。**根治就是换一个在 NapCat 版本表里的 QQ 构建号**（别再信
"没必要降级"）：表里有多少个、最高到哪，直接读 `NapCat.Shell\napcat.mjs`。
本机 4.18.30 的表最高到 `9.9.36-53489`；`9.9.36-53644` 恰好超出，所以当时失败。

**2. NapCat 控制台：**

```
[error] 星源 | [OneBot] [WebSocket Client] 反向WebSocket (ws://localhost:8080/...) 连接错误 ECONNREFUSED
```

这是 NapCat 在往你**旧的 NoneBot 项目**（`ws://localhost:8080`）重连，而它没在运行。
想消除这个噪音，把 `onebot11_2178517838.json` 里那条 `websocketClients` 的 `enable` 改成 `false` 即可（**不改也不影响**）。

## ⚠️ koishi.yml 由 Koishi 自己接管

启动后 Koishi 会**重写** `koishi.yml`：给插件名加上实例 ID（`server:meey6h`）、去掉注释、规范化引号。

**这是正常行为，不是故障。** 但意味着：

- 不要指望在 `koishi.yml` 里写注释能留住
- 手改配置后如果 Koishi 正在运行，改动会被覆盖 —— **先停进程再改文件**，或者直接改 `koishi.yml` 后重启
- 生产上更推荐通过 Web 控制台（http://127.0.0.1:5140）改配置


## 直接查看数据库（独立于 Koishi 的验证手段）

`data/koishi.db` 是**标准 SQLite 文件**，可以用 Node 22 内置的 `node:sqlite` 只读打开：

```js
// db-read.mjs   运行： node --experimental-sqlite db-read.mjs
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("D:/deepseek/QQbot/koishi-app/data/koishi.db", { readOnly: true });
for (const t of ["user", "group", "perm_track", "channel", "binding"]) {
  console.log(t, db.prepare(`SELECT * FROM "${t}"`).all());
}
db.close();
```

> 即使脚本完全成功，PowerShell 也会因为 stderr 上的 `ExperimentalWarning` 报 `exit code: 1`，
> 这是 PowerShell 把 stderr 当错误的老毛病，**不是脚本失败**。

表结构（`@koishijs/plugin-admin` 建的）：

| 表 | 关键列 | 用途 |
|---|---|---|
| `user` | `id, name, authority, permissions, locales` | 用户；**`authority` 就是 0–4 权限等级** |
| `group` | `id, name, permissions` | 用户组 |
| `perm_track` | `id, name, permissions` | 用户组路线 |
| `channel` / `binding` | — | 频道 / 账号绑定 |

**组成员关系不是关联表**，而是写在 `user.permissions` 里的 `group:<id>` 标记（逗号分隔）。
Koishi 启动时就是这么查的：

```sql
SELECT count(distinct `id`) FROM `user`
WHERE (',' || `permissions` || ',') LIKE '%,group:1,%'
```

## 目录

```
koishi-app/
├── koishi.yml          应用配置（唯一需要手改的文件）
├── package.json
├── node_modules/
└── data/
    └── koishi.db       ★ SQLite 数据库（用户/用户组/权限等级都在这）
```
