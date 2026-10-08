# 一键启动面板（`tools/panel/`）

Koishi + NapCat 的本地控制台：**一个网页管两件事** —— 启停、看日志，
外加把 NapCat 的**登录二维码**搬到面板里显示，以及两个 WebUI 的**免 token 跳转**。

入口：仓库根目录的 **`启动面板.cmd`**（双击即可）。它做的事只有三件：
**先给自己要一次 UAC 提权**、起 `tools/panel/server.cjs`（本地面板服务，`127.0.0.1:5151`）、打开浏览器。

> 为什么要提权：NapCat 必须往 QQ.exe 里注入，所以要管理员。**面板自己是管理员时，
> 点「启动 NapCat」就是直接创建进程，一次 UAC 都不用**；反过来，非管理员面板要么靠面板里
> 那条隐藏的 powershell 去要 UAC（**本机实测这条弹不出提示**，见下面第 9 条），
> 要么退到「控制台启动」按钮。所以：**让面板自己带管理员跑，是最省事也最稳的路**。
> 不想提权就 `启动面板.cmd --no-elevate`（调试用，之后启动 NapCat 请用「控制台启动」）。

---

## 能做什么

| 功能 | 说明 |
|---|---|
| 一键启动 / 停止 / 重启 **Koishi** | 走 `koishi-app/tools/run-prod.cjs`（日志按天落盘、跨天自动换文件、启动前查孤儿实例）；可选 `--log-level 3` debug 与 `--takeover` 接管旧实例 |
| 一键启动 / 停止 / 重启 **NapCat** | 走 `tools/start-napcat-shell.bat`（Shell）或 `tools/start-napcat-framework.bat`（Framework），两个都是自提权脚本；可填 QQ 号走 `-q` 免扫码快速登录。★ **面板自己以管理员运行时走直接创建进程，不再需要 UAC**；面板不是管理员时面板里那条隐藏提权**实测弹不出提示**，请改用「控制台启动」（见第 9 条） |
| **日志**（两边都在一个面板里） | 级别着色（info/warn/error/debug 左侧色条）、时间戳独立栏、关键字过滤（空格分隔=全部命中）、级别筛选、自动滚动、换行开关、清屏、导出、Koishi/NapCat/**合并**三个标签页；选到旧文件会显式标出"⚠ 这不是实时输出"并写明多久前更新的 |
| **登录二维码** | 直接显示 NapCat 写在 `NapCat.Shell/cache/qrcode.png` 的那张图，盯 mtime 自动换图；旁边显示登录阶段（等待扫码 / 已扫码待确认 / 已登录 / 掉线重连）；可一键「刷新二维码」「重新登录」 |
| **跳转两个 WebUI** | 卡片标题就是链接。NapCat 的链接形如 `http://127.0.0.1:6099/webui/?token=<webui.json 里的 token>` —— 点开**免填 token 直接登录**；另有「复制 token」备用 |
| **启动卡住的逃生口** | 「控制台启动」：开一个真实控制台窗口跑 `tools/start-napcat-*.bat`，用**脚本自己的提权**（= 你双击脚本那条路）——面板不是管理员时的推荐路线；「复位」：把挂着的提权进程收掉、清掉「启动中」。提权本身有 60 秒超时（`PANEL_ELEVATE_TIMEOUT_MS` 可调），超时会明确报错而不是永远转圈 |

---

## 目录与端口

```
tools/panel/
├── server.cjs                服务端：进程启停、端口探测、日志 tail、SSE、二维码/NapCat API 代理
├── public/index.html         页面
├── public/style.css          样式
├── public/app.js             前端逻辑
└── tests/
    ├── smoke.cjs             接口冒烟（13 条判据，只读，不动进程）
    └── mock-napcat-webui.cjs 假 NapCat WebUI：不碰真 QQ 就能回归二维码/登录状态那套
```

| 端口 | 谁的 | 备注 |
|---|---|---|
| 5151 | 本面板 | 只 bind `127.0.0.1`；用 `--port` 或 `set PANEL_PORT=5152` 换 |
| 5140 | Koishi 控制台 | 面板只读它的监听状态 |
| 6099 | NapCat WebUI | 面板用它取登录状态 / 刷新二维码（会自己算 Credential，不改 NapCat 配置） |
| 3001 | NapCat 的 OneBot WS | 判断"链路通没通" |

运行期产生的文件都在 **`.runtime/panel/`**（不进库）：`napcat-launch.cmd`（提权包装器）、
`napcat-console.log`（NapCat 控制台捕获）、`state.json`（记着 NapCat 是什么时候被本面板起的）、
`qrcode.backup.png`（mock 测试用）。

---

## 命令行与调试开关

```powershell
cd D:\deepseek\QQbot
node tools\panel\server.cjs            # 起服务，自己开浏览器 http://127.0.0.1:5151/
node tools\panel\server.cjs --open     # 起服务并自动开浏览器（启动面板.cmd 用的就是这个）
node tools\panel\server.cjs --port 5152
```

面板已经在跑时再执行一次，会打印「面板已经在运行」并只开一个浏览器标签，不会起第二个服务。

两个**只给调试用**的口子（正常运行别用）：

| 开关 | 作用 |
|---|---|
| `--no-elevate` | 面板不提权（`启动面板.cmd --no-elevate` 或 `node server.cjs --no-elevate`）：启动 NapCat 时不走 `Start-Process -Verb RunAs`，直接在当前会话跑包装器。UAC 弹窗没法在无人值守环境里测，所以留了这个 —— 但**本机实测面板自己那条提权根本弹不出提示**（第 9 条），所以不提权的面板请用「控制台启动」 |
| `PANEL_NAPCAT_BAT=<路径>` | 换掉 NapCat 的启动脚本（配合假的 bat 就能把"启动 → 重定向 → 日志 tail"整条链跑通，见 `tests/`） |

---

## 自测

```powershell
# ① 接口冒烟（面板要已经在跑）
node tools\panel\tests\smoke.cjs

# ② 二维码 / 登录状态那条链：先起假 WebUI，再（另开窗口）起面板
node tools\panel\tests\mock-napcat-webui.cjs
node tools\panel\server.cjs
#   假 WebUI 支持 FAKE_PHASE=ready / qrcode_scanned / waiting_qrcode 三种状态，
#   点面板上的「↻ 刷新二维码」会看到它把 cache/qrcode.png 换掉、面板跟着换图。
```

---

## 几个已经踩过的点（改这个面板前先看）

1. **不要给 Koishi 子进程设 `FORCE_COLOR`。** `run-prod.cjs` 会把子进程输出同时写进
   `koishi-app/tools/logs/prod-<日期>.log`；带上 ANSI 转义会污染日志文件，
   破坏 `docs/17-常用命令速查.md` 里那套 `Select-String prod-<日期>.log` 的排障流程。
   日志级别是从 `[I]/[W]/[E]` 这个纯文本标记认的，不需要颜色。
2. **停 NapCat 不是"只会全杀 QQ.exe"。** NapCat 注入在 QQ.exe 里，没有独立进程；
   但面板记着"NapCat 是什么时候被本面板拉起来的"（落盘在 `.runtime/panel/state.json`），
   于是停的时候**只收启动时间在那之后的 QQ.exe**，你原本开着的主号 QQ 不会被牵连。
   只有"面板不知道是谁起的"（比如你先手动开的 NapCat，再打开面板）才退回
   `taskkill /F /IM QQ.exe`（= 仓库里的 `NapCat.Shell/KillQQ.bat`），而且必须由前端
   显式带 `force: true`，二次确认框会把"会连主号一起杀"写清楚。
3. **NapCat 的日志有两个来源**，面板都列出来：`NapCat.Shell/logs/<日期>.log`
   （winston，`fileLogLevel=debug`，需要 `NAPCAT_DISABLE_MULTI_PROCESS=1`，官方 bat 已设）
   和面板自己重定向出来的 `.runtime/panel/napcat-console.log`（含提权 cmd 的启停信息）。
   "自动"的判定只看两件可观测事实：**文件 mtime 是否在 5 分钟内 + 子进程是否存在**，
   不做状态机推断 —— 否则用户每点一次启停，日志视图都会自己跳源，很难解释。
4. **二维码的真相在文件里**：NapCat 每生成一次二维码就覆盖写 `cache/qrcode.png`
   （`napcat.mjs` 里 `writeFile(join(cachePath,'qrcode.png'))`）。所以面板不需要连 QQ 就能拿到图，
   只需要盯 mtime。已登录时这个文件会留在原地（是旧图），所以面板同时显示"刷新于多少秒前"，
   超过 150 秒提示可能过期。
5. **NapCat WebUI 的免 token 链接**：WebUI 的 basename 是 `/webui/`，登录页在读
   `location.search.token` 后自动 `loginWithToken`。所以 `…/webui/?token=<token>` 点开即登录。
6. **面板自己的 API 要过两道校验**：请求头 `X-Panel-Token`（token 随页面下发，别的网页读不到，
   挡本地 CSRF）+ `Host`/`Origin` 必须是本机面板端口（挡 DNS rebinding）。
   `<img>` 带不了请求头，所以二维码图片那个接口额外允许 query 里的 `token`。
7. **`启动面板.cmd` 必须 ASCII-only + CRLF。** cmd.exe 按 OEM 代码页读 `.bat`：中文回显会乱码并
   **连带把后面的行拆错**，LF-only 换行更会让整个脚本碎成一句（症状是
   `'xxx' is not recognized as an internal or external command` 刷屏）。第一版两条都犯了 ——
   所以那个文件里的话全是英文。改它请保持 ASCII + CRLF（`tools/start-napcat-shell.bat`
   的注释里写着同一条规矩）。
8. **"某个服务在跑"的判据要挑对端口。** Koishi 只看 5140 —— 不能拿 OneBot 端口（3001）判断，
   那是 **NapCat** 的 WS 服务端端口，只起 NapCat 时它也在听，而且 `koishi-test` 的伪 OneBot
   同样听 3001。NapCat 同理以 WebUI 端口（6099）为主，OneBot 端口只在 `disableWebUI` 时兜底、
   还要配上"有 QQ.exe 进程"。
9. **★ 非管理员面板里那条 `Start-Process -Verb RunAs` 在本机弹不出 UAC 提示。**
   用户的现场对比（2026-10-08）：**双击 `tools/start-napcat-shell.bat` → UAC 提示正常出现**；
   **在网页面板里点「启动」→ 什么都不出现**，60/100 秒后只等来超时。取证：面板
   `lastStartError = "UAC 提权窗口等了 100 秒没有回应…"`、`.runtime/panel/napcat-console.log`
   **根本没生成**（包装器一行都没跑过）、面板 `app.elevated = false`（走的正是这条路）。
   所以现在的策略是**绕开它**：
   ① `启动面板.cmd` 现在**自己先提权**（照抄 `start-napcat-shell.bat` 里那条被验证无数次的写法），
      面板是管理员 → 启动 NapCat 走直接创建进程，**UAC 一次都不用**；
   ② 面板不是管理员时，「控制台启动」按钮开一个真实控制台跑同一个 bat，让**脚本自己去要 UAC**
      （和双击脚本同一条链）；
   ③ 仍然保留面板侧那条提权（`elevateCommand`）作为兜底，超时从 100 秒收到 60 秒，
      超时/失败都会把 `napcat.startedAt` 清掉并给出下一步提示（否则界面一直"启动中"，
      而且 `managed=true` 会让下一次停止按时间窗口去收 QQ.exe，可能误伤你后来自己开的 QQ）。
   ④ 「复位」按钮兜底。
10. **★ 提权的命令行必须"目标是真 exe、批处理只当参数"。** 面板里这条是：
   `Start-Process -FilePath 'cmd.exe' -WorkingDirectory '<ROOT>' -ArgumentList '/c','<包装器>' -Verb RunAs`。
   以前写的是 `-FilePath '<包装器>.cmd' -Verb RunAs`（拿 .cmd 当提权目标），手机上看着没问题，
   现场就是上面第 9 条那个"没提示、干等到超时"。
   **引号的实测结论**（`.scratch/gen-quote-probe.cjs` 把四种写法各跑了一遍，只去掉 `-Verb RunAs`）：
   路径**没有空格**时，裸路径 / `\"…\"` / `"…"` / `[char]34` 拼引号 **四种都能跑通**；
   路径**带空格**时**四种全部失败** —— 因为路径是被展开进 `-Command "…"` 这个字符串里的，
   powershell 会按空格把它切成两个 token。所以：① 别在路径上堆引号，够用就行；
   ② `启动面板.cmd` 里有一条"路径含空格就明确报错并让你用右键『以管理员身份运行』"的拦截
   （Explorer 那条路不经过这个字符串，所以它不受影响）。
11. **`启动面板.cmd` 里的 `%ROOT%` 必须保留 `%~dp0` 的结尾反斜杠。** 曾经为了"整洁"加了一行
   `for %%I in ("%ROOT%.") do set "ROOT=%%~fI"`，反斜杠被去掉，后面所有 `"%ROOT%tools\…"`
   就变成了 `D:\deepseek\QQbot**tools**\panel\server.cjs` → 启动器直接报
   `[x] tools\panel\server.cjs not found`（面板是纯 CJS，只有这一处拼接，所以一秒就死）。
   改这个文件后**一定要真的双击跑一遍**，别只看语法。
12. **Shell 与 Framework 都是"启动并注入你已装的那个 QQ"**，不是"一个注入已装 QQ、一个自带框架"。
    取证：`NapCat.Framework\napiLoader.bat` 同样从注册表读 QQ 路径；`napimain.exe` 里的字符串是
    `launcher.exe <QQ> [DLL]`。所以**换变体解决不了"主号 QQ 占着 QQNT 单实例"**，
    也都要管理员。两个变体的 `config`/`logs` 是指向 `NapCat.Shell` 的 junction，登录态共用。
    绕开单实例只有两条路：先退出主号 QQ，或另装一份 QQ 专供 NapCat（当前 bat 写死注册表路径，
    面板还没做"指定 QQ 路径"这件事）。
13. **手动启动的口子**：仓库根 `启动NapCat.cmd`（会让你选 Shell/Framework，然后在你自己的控制台里
    应答 UAC）。面板起不来 NapCat 时用它，同样能看到完整的启动输出。

---

## 排障

| 现象 | 看哪里 |
|---|---|
| 面板起不来、端口被占 | 控制台会打印"端口 5151 被别的程序占了"，换端口即可 |
| 点了启动按钮没反应 | 面板卡片上的 pill 会显示 `启动中…` / 失败原因；Koishi 的失败详情在日志标签页的「启动器输出」 |
| **NapCat 启动了但什么都没起来** | 先看它卡片下面那行提示写了什么（会写"上次启动失败：…"）。三件最常见的事：① **面板不是管理员**（卡片提示里写着）→ 用「控制台启动」，或关掉面板重新双击 `启动面板.cmd`（它会自己提权）；② **UAC 提示没人应答**（安全桌面上、屏幕变暗）→ 超时后面板会报错，卡住点「复位」；③ **主号 QQ 开着** → QQNT 单实例，注入不进去（两个变体都一样）|
| **UAC 提示根本没出现**（点「启动」后一直没反应） | 这是**已知现象**：非管理员面板里那条隐藏的提权请求在本机弹不出提示（第 9 条）。点 **「控制台启动」**（开一个真实控制台，走脚本自己的提权），或者关掉面板、重新双击 `启动面板.cmd` —— 它现在会自己请求一次 UAC，之后面板里启动 NapCat 就完全不用 UAC 了 |
| NapCat 启动失败（有报错） | 多半是 UAC 被拒；面板会把 powershell 的报错显示在 NapCat 卡片下方 |
| 二维码一直不出现 | NapCat 卡片要显示"运行中"（6099 在听）；二维码是登录时才生成，已登录不会刷新。必要时点「↻ 刷新二维码」 |
| 二维码明明旧了还在显示 | 只在"没登录 + （NapCat 在跑 或 图 <3 分钟）"时展示；否则会显示"有旧图"的灰框并写明它多久前刷新的 |
| 日志看着像"什么都没有" | 看日志底部那行来源：如果写着「⚠ 这是旧文件、不是实时输出」，说明选到了旧日志（例如 `napcat-framework-console.log` 是几天前的）。切到「启动控制台捕获」才是面板启动 NapCat 的输出 |
| 登录状态显示"读不到登录状态" | NapCat WebUI 没起来 / `webui.json` 里 token 为空 / 开了两步验证（2FA 面板取不到 Credential） |
| 改完面板想看有没有改坏 | `node tools\panel\tests\smoke.cjs`（13 条判据）；二维码那条链用 `tests\mock-napcat-webui.cjs` 假 WebUI 回归；**改过 `启动面板.cmd` 必须真的跑一遍**（第 11 条那个坑语法看不出、一跑就死） |
