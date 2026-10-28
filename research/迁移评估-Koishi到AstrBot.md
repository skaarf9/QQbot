# 迁移评估：Koishi → AstrBot

> 评估日期：**2026-10-17**　｜　结论先行：**不建议整体迁移**；建议走「**双轨并行 + 只借 AstrBot 的 R8**」。
> 本文所有数字均为当日实测（GitHub API / npm registry / PyPI / 本地代码扫描 / 本地 sqlite），非估计。

---

## 0. 一句话结论

| 维度 | 判断 |
|---|---|
| **框架活跃度** | 你的观感**完全正确，且比想象的更悬殊**：Koishi 主仓库 2026 年只有 **5 个 commit**，npm 最新版停在 **2026-02-27**；AstrBot 42k★、最后 push **2026-10-17**、近两月发了 **8 个版本** |
| **但「框架停更」≠「我的东西在腐烂」** | 生产跑的东西 **90% 是自研 21,859 行 + ChatLuna 生态**，ChatLuna 到 10-17 还在发版。Koishi 停了反而意味着**内部 API 不再变**，`docs/04-踩坑记录` 里那堆行号级注释不会失效 |
| **迁移成本** | **不是"麻烦"，是"重写"**。21,859 行里能原样搬走的是**算法**（约 1,800 行，8%），不能搬的是**所有接线**（约 20,000 行，92%） |
| **迁移反向收益** | 只有一处是真正白赚的：**R8（引用含图）在 AstrBot 是一等公民**，我们为此自写了 1,459 行 `chatluna-vision`。其余在 AstrBot 上都要**打折扣**（R13 三档权限 / R7 靠运行时 patch / R2 要装两个插件） |
| **建议** | **①** 生产继续 Koishi；**②** 把 AstrBot 当**副驾**（独立跑、独立小号、只做 Koishi 做不好的事）；**③** 自研插件按层解耦（见 §6），把"要不要搬"这个决定权**留到明年**再说 |

---

## 1. 先回答你"我忘了为啥选 Koishi"

这个答案在 `docs/02-技术选型.md` 里原样躺着，而且**和你的记忆正好相反**。

### 1.1 你的记忆是反的

> 你记得的是：「AstrBot **能直接对接 dsh**，Koishi 需要自己写 MCP」→ 所以选了 Koishi（听起来不合理，所以你觉得忘了为啥）。

`docs/02` 原文（被否方案表）：

> | **AstrBot + dsh** | **唯一有现成 dsh 桥接**（`dsh-astrbot-ingress` 已发 npm）的生态，R8 官方模块最强；但**权限不如 Koishi 精细**，且"命令归框架、agent 归 dsh"是**两套鉴权** |

**即：dsh 桥接从来不是选 Koishi 的理由，它恰恰是 AstrBot 的加分项。** 选 Koishi 的五条理由是：

1. **生态最大**：Koishi registry ≈ **4,695** 条（AstrBot 市场 2,306 条）
2. **R13 最贴**：内置 **authority 0–4 数值等级**，**每条指令、甚至单个选项**都能单独设等级；`authorize` 命令可把等级下发给具体用户
3. **R7 最贴**：`chatluna-sticker` 原生 **pHash 64 位 + 汉明距离**去重
4. **R2 最贴**：ChatLuna 预设目录 + `chatluna.use.preset` 一条命令切人格
5. **权限贯穿到 agent 工具层**：每个 LLM 工具可单独设"所需最低权限等级"（我们的 `selfext.install` 就是 `authority: 4`）

你"要自己写 MCP"的记忆也是真的 —— 项目里确实有自写的 `koishi-app/mcp/websearch-server.cjs`，但它**不是被 dsh 逼出来的**，而是「联网搜索」这个需求在 ChatLuna 里没有现成件（见 `docs/27-模型总览与联网搜索.md`）。**和 dsh 无关。**

### 1.2 `docs/02` 自己留了翻盘条件

> **唯一可能翻盘的变量**：若哪天认为 R12 用不上，就无脑上 Koishi；若认为 R12 的"真·闭环"最重要，则改用 AstrBot + dsh。

翻译一下：**当初选型的赌注压在 R12（自我扩展）上**。现在要评估的其实是「**这个赌注下对了吗**」——见 §4.3。

⚠️ 补充事实：`dsh-channel-qq`（当时记的"全 dsh 原生 OneBot 通道"）**在 npm 上已经查不到了**（`registry.npmjs.org` 返回 `KeyError: dist-tags`）。`dsh-astrbot-ingress` 还在（0.3.23，2026-09-27）。→ **"全 dsh 原生"这条路线的证据基础已经消失**，现在只剩"AstrBot 当壳、dsh 当脑"这一条。

---

## 2. 活跃度：坐实你的观感

| | Koishi | AstrBot | ChatLuna 生态 |
|---|---|---|---|
| GitHub stars | 6,254 | **42,036** | 440 |
| 最后 push | 2026-10-08 | **2026-10-17** | 2026-10-13 |
| 2026 年提交数 | **5**（100/100 采样，since 2026-01-01） | 09-01 起 100 条（单日 7~11 条） | 06-10 起 100 条 |
| 最新发行版 | 4.18.11，npm **2026-02-27** | 4.29.1，PyPI **2026-10-17**（近两月 8 版） | chatluna 1.4.2 / agent 1.0.49 / sticker 1.3.7（10-17） |
| open issues | 111 | 944 | — |

**读法**：

- Koishi 的 "2026-10-08 push" 是仓库层面的零星提交，**npm 上一次发版是 2026-02-27**，已经 **7 个多月没发版**。这不是"活跃度下降"，是**基本停更**。
- 但 **ChatLuna 没停**：10-17 还在发 `sticker 1.3.7`。你每天在用的能力（LLM、记忆、表情包、agent）**主体在 ChatLuna，不在 Koishi 本体**。
- **停更对你是双刃剑**：好消息是 `docs/04-踩坑记录` 里那些 `core:730` `chains:883-887` `@satorijs/core:752` 的行号级注释**不会再失效**；坏消息是 OneBot 协议侧的新特性（新消息段、新引用格式）**不会有人帮你接**。

> **这条结论很重要**：你担心的"平台没活力"是真的，但你依赖的**不是那个没活力的部分**。真正该盯的风险不是"Koishi 停更"，而是"**ChatLuna 哪天停更**"——那才是致命的，因为 15 个 LLM 工具全挂在它的 `platform.registerTool` 上。

---

## 3. 迁移成本：为什么说"不是麻烦，是重写"

### 3.1 家底实测

| 项 | 数量 |
|---|---|
| 自研插件 | **29 个** |
| 自研代码 | **21,859 行 JS**（交叉验证两次，结果一致） |
| 自研指令 | **28 条**（`ctx.command` 主名） |
| 自研 LLM 工具 | **15 个**（`platform.registerTool`） |
| 用到数据库的插件 | **8 个**（guard/episode/scene/emotion/sticker-admin/vision/help/replacer） |
| 数据表 | 50 张，非空 27 张，**1,474 行** |
| 数据资产 | `koishi.db` 53MB / `sticker-library` 30MB(107 目录) / `page-cache` 11MB / `long-memory` 81 个 JSON |

### 3.2 耦合点精确清点（决定迁移成本的唯一变量）

| Koishi / ChatLuna API | 出现次数 | AstrBot 有无等价物 | 迁移性质 |
|---|---:|---|---|
| `ctx.command(...)` | 32 | `@filter.command` 有，**但 authority 模型不同**（三档布尔 vs 0–4 数值） | **重写** |
| `ctx.database` | 73 | `PluginKVStoreMixin`（KV）或裸 SQLAlchemy | **重写**（8 个插件） |
| `before-send`（出站总闸） | 53 | 无等价钩子，只能包 `send` 或改 core | **重写**（guard/replyshaper/render 全在这条链上） |
| `ctx.on('ready')` | 17 | `on_astrbot_loaded` | 机械替换 |
| `ctx.middleware(fn, true)` | 7 | `@filter.event_message_type` + 优先级 | **重写**（抢第一的语义要重新实现） |
| `ctx.http` / `ctx.setInterval` | 11 / 13 | aiohttp / asyncio | 机械替换 |
| `ctx.chatluna.chatChain.middleware` / `receiveCommand` | 3 | —— | **换思路**（proactive/followup 的命脉） |
| `ctx.chatluna.createChatModel` | 3 | 有 `Provider` 但**不是同一抽象** | **换思路**（episode/vision/sticker-admin） |
| `ctx.chatluna.platform.registerTool` | **15** | `@filter.llm_tool` 有，**但 selector/authorization 语义得重建** | **重写** |
| `ctx.chatluna.promptRenderer.registerFunctionProvider` | 1 | —— | 换思路（emotion） |
| `ctx.chatluna.messageTransformer.before` | 1 | —— | 换思路（vision） |
| **直接 require `koishi-plugin-chatluna/llm-core/...` 内部路径** | 2 个插件 | —— | **最脆**（models / local-embeddings） |

### 3.3 三档分类（这是评估的核心产出）

#### A 类｜可原样复用 —— **约 1,800 行，8%**

只依赖 node 内置 + `sharp` / `imghash` / `marked` / `js-yaml`，**算法本身与框架无关**：

| 插件 | 行数 | 可复用什么 |
|---|---:|---|
| `chatluna-vision` | 1,459 | pHash 计算、图片压缩、缓存键设计、去重逻辑 |
| `chatluna-sticker-admin` | 702 | pHash + 汉明距离检索、LRU 淘汰、压缩率预筛 |
| `chatluna-webpreview` | 848 | **SSRF 四道闸**（DNS 重绑定检测、私网段拦截等） |
| `chatluna-replacer` | 849 | 文本替换规则引擎 |
| `chatluna-local-embeddings` | 480 | transformers.js 部分（但**接的是 ChatLuna 内部类**，见 C 类） |
| `chatluna-replyshaper` | 154 | 回复整形规则 |
| `chatluna-persona` | 422 | 人设卡片 YAML 解析 |

> 注意：这里的"可复用"指**代码片段能抄**，不是"文件能搬"。真正的价值是**你已经踩过的坑**——pHash 阈值怎么定、SSRF 怎么防、图片去哪拿，这些知识在重写时不用再踩一遍。**这是迁移中唯一真正的"资产转移"，而且它不依赖框架。**

#### B 类｜机械重写 —— **约 9,000 行，41%**

纯 Koishi API、逻辑清晰、照着抄改就能跑，但**一行都不能直接用**：

- 指令族：`qqbot-auth`(990) / `chatluna-help`(1,737) / `chatluna-page`(980) / `chatluna-alias`(329) / `chatluna-cmdname`(160)
- 协议侧：`onebot-watchdog`(292) / `onebot-singleton-guard`(309) / `game-auto`(1,154)
- 场景与状态：`chatluna-scene`(526) / `chatluna-routine`(504) / `chatluna-think`(327) / `chatluna-poke`(900) / `chatluna-reply-style`(459)

**重写风险点**：`chatluna-cmdname` 干的是「运行时摘掉市场插件的中文别名」（改 `Command._aliases`）。AstrBot 的指令注册模型完全不同，**这个插件在 AstrBot 上等于不存在**，得重新设计"中文触发的指令名净化"。

#### C 类｜深度绑 ChatLuna，必须换思路 —— **约 11,000 行，50%**

| 插件 | 行数 | 死在哪 |
|---|---:|---|
| `chatluna-episode` | 1,440 | `createChatModel` + 数据库表 + `chatluna/message-observed` 事件 |
| `chatluna-guard` | 1,302 | `before-send` 四道闸 + `chatChain.middleware` + 令牌桶，**且注释写死了 Koishi 内部行号** |
| `chatluna-affinity-bridge` | 1,091 | 接 `chatluna-affinity` 的 `chatluna_affinity_v2` 表结构 |
| `chatluna-proactive` | 1,048 | `chatChain.receiveCommand`（**主动插话的命脉**） |
| `chatluna-models` | 1,396 | `createChatModel` + **直接 require ChatLuna 内部 `llm-core`** + 4 个模型组的兜底队列 |
| `chatluna-followup` | 412 | `chatChain.middleware` + `ChainMiddlewareRunStatus` |
| `chatluna-emotion` | 481 | `registerFunctionProvider` + `registerTool` + 数据库表 |
| `chatluna-selfext` | 602 | `plugin_search/plugin_request` 工具 + 命名空间解析（**R12 的核心**） |
| `chatluna-vision` | 1,459 | `messageTransformer.before` + `createChatModel`（**算法可复用，接线全废**） |
| `chatluna-sticker-admin` | 702 | 同上 |
| `chatluna-render` | 506 | `before-send` + `render_image` 工具 |
| `chatluna-local-embeddings` | 480 | **直接 require ChatLuna `llm-core/platform/client`** |

> **C 类占一半。这就是"迁移不是麻烦，是重写"的全部理由。**
> 而且 C 类恰好是**这个项目最有价值的 50%**——主动插话、情绪、记忆、表情包、模型兜底、自我扩展，全在这里。A 类和 B 类反而是"谁都写得出来"的部分。

### 3.4 数据资产：能导出，但**语义搬不过去**

| 数据 | 量 | 可迁移性 |
|---|---|---|
| `sticker-library` 图片 + `sticker_meta`(43) + `sticker_occurrence`(467) | 30MB | **✅ 可搬**。图片是文件，pHash 是字符串，AstrBot 侧自写插件照样读 |
| `chatluna_image_cache`(85) | — | **✅ 可搬**（hash + description 的纯 KV） |
| `chatluna_affinity_v2`(15) | — | **✅ 可搬**（字段清晰，重写读写层即可） |
| `chatluna_episode`(223) | — | **⚠️ 半可搬**（schema 清晰，但消费它的 `episode` 逻辑要重写） |
| `chatluna_docstore`(16) + `long-memory/{hippo,emgas}/*.json`(81) | 828KB | **❌ 搬不了**。这是 **HippoRAG** 的落盘格式，AstrBot 侧（`astrbot_plugin_livingmemory`）是"关键词+向量+图谱"的另一套引擎，**格式与召回语义都不同** |
| `page-cache`(11MB) | — | **❌ 没意义**（纯缓存，重建就行） |
| `chatluna-sandbox.model-request`(445) | — | **❌ 没意义**（测试台遗留） |

> **记忆是最贵的那一项**：223 条情景 + 81 个长期记忆 JSON，是这一个多月"陪聊"攒出来的。**换引擎 = 全部清零重来**。这一条本身就足以否掉"整体迁移"。

---

## 4. 反向收益：迁过去到底赚什么

别只看成本。把 AstrBot 真正比 Koishi **强**的地方摊开看（数据来自 `astrbot-需求覆盖调研.md`）：

### 4.1 真正白赚的：R8（引用消息含图）—— 唯一一项

AstrBot 有专门模块 `astrbot/core/utils/quoted_message/`：

- `extract_quoted_message_text()` / `extract_quoted_message_images()`
- 按 `Reply.id` 调 `get_msg`；合并转发走 `get_forward_msg` **递归**（默认 32 跳 / 6 层）
- 图片依次试 `get_image` → `get_file` → `get_group_file_url` → `get_private_file_url`

**这正是我们自写 1,459 行 `chatluna-vision` + 踩了一堆坑才换来的能力。** 在 AstrBot 是**一等公民**，`any` 消息直接带上引用图。

### 4.2 要打折扣的：R13 / R7 / R2

| 需求 | Koishi 现状 | AstrBot |
|---|---|---|
| **R13 权限** | authority **0–4 数值**，每条指令甚至单个选项可单独设 | `admins_id` + `/op` `/deop`，指令级**只有三档**（所有人 / 仅管理员 / 仅群聊限管理员），**不是数值等级**；"全部设置"必须配合 OpenAPI 的 11 个 scope |
| **R7 表情包** | `chatluna-sticker` **核心层** pHash 去重 | 核心层**明确无跨请求图片缓存**，要装 `astrbot_plugin_image_caption_cache`（3★，**靠运行时 patch 核心函数**，作者自认升级会失效） |
| **R2 人格** | 预设目录 + `chatluna.use.preset` 一条命令 | 要装 `builtin_commands_extension` + `persona_plus` 两个插件 |
| **R12 自我扩展** | `chatluna-selfext` 602 行（工具名 `plugin_search`/`plugin_request`） | `StarManager.install_plugin` **存在**，但插件可见的 `Context` **没暴露**（只留 `_star_manager = None` 占位），**只能走 HTTP OpenAPI** |

> **结论**：`docs/02` 当年给 AstrBot 打的分数依然成立——**它赢在 R8，输在 R13/R2/R7**。你现在有 15 个 LLM 工具、28 条指令、复杂的权限分层，**R13 的权重比当初更高了**，不是更低。

### 4.3 关于 R12 那个赌注（`docs/02` 留的翻盘条件）

当初赌 R12 选 Koishi。**现在看这个赌注下对了吗？**

- Koishi 侧：`chatluna-selfext` 602 行跑通了，但**我们自己也在 `docs/15` 里给它加了人工确认闸**（硬约束第 2 条：R12 必须人工确认），且 `plugin.install` 的安全含义**至今挂在"未决事项"**里。→ **"真·闭环"其实也没敢真闭环。**
- AstrBot 侧：`install_plugin` 存在但 Context 不暴露，只能走 OpenAPI。

**两边都没做到"真·闭环"。** 所以当初那个"翻盘变量"，实际结果是**平局**——不构成迁移理由，也不构成留下的强理由。

### 4.4 别忽略的第三条路：dsh

`dsh-astrbot-ingress` 0.3.23（2026-09-27）还在，**这是 AstrBot 独有的能力**：HTTP ingress 让 AstrBot 驱动 dsh agent。
但 `dsh-channel-qq` **已从 npm 消失**。

→ **"要不要上 dsh" 和 "要不要迁 AstrBot" 现在是同一个决策，而且只能走"AstrBot 当壳"这一种形态。** 这件事建议**单独评估**，别和迁移混在一起——混在一起会两边都做不好。

---

## 5. 三个方案对比

| | 方案 A：整体迁移 | 方案 B：双轨并行（**推荐**） | 方案 C：不迁，只补短板 |
|---|---|---|---|
| 做法 | 29 个插件全重写到 AstrBot 插件体系 | 生产留 Koishi；AstrBot 独立部署、独立小号，只做 Koishi 做不好的事 | 生产留 Koishi；把 R8 那一套自己再打磨，盯 ChatLuna 存活 |
| 一次性成本 | **20,000 行重写 + 记忆清零** | 1~2 个专用插件的成本 | 0 |
| 保留记忆/好感/表情包 | ❌ 记忆基本清零 | ✅ 全部保留 | ✅ 全部保留 |
| 拿到 R8 一等公民 | ✅ | ✅（在副驾上） | ❌ |
| 拿到 dsh 桥接 | ✅ | ✅（副驾上试） | ❌ |
| 主号风险 | **高**（重写期功能倒退） | 低（互不干扰） | 无 |
| 运维复杂度 | 中 | **高**（两套栈、两个号、两个进程） | 低 |
| 适合"明年怎么选" | 锁死 | **保留选择权** | 锁死 |

### 为什么推荐 B 而不是 A

1. **A 的核心成本不在"写"，在"清零"**：223 条情景 + 81 个记忆文件 + 43 张表情包标签 + 15 条好感度，是**时间攒的，不是代码写的**。迁过去代码能重写，**这些得重新攒几个月**。
2. **A 的收益（R8）用一个副驾插件就能拿到**，不需要赔上整个生产。
3. **A 会让你失去"对比能力"**：迁完就再也说不清"到底哪个好"了。B 保留了对照组。
4. **Python 栈是真门槛**：自研 21,859 行是 JS，AstrBot 插件是 Python。你现有的"改一行 → 重启 worker → 看日志"的迭代速度，换成 Python 后**调试链路会重建**（venv、依赖、asyncio 调试、热重载）。

### B 方案的具体形态（建议）

```
Koishi（生产，主号 2178517838「星源」，端口 5140）
  └─ 全部现有 55 个插件实例，一行不改
        ↓ 共享：NapCat（可多号）
AstrBot（副驾，另一个小号，独立端口）
  └─ 只装：官方 quoted_message + 1 个自写实验插件
     用途 ①：验证 R8 引用含图到底比我们强多少
     用途 ②：试 dsh-astrbot-ingress 这条路
     用途 ③：当作"如果明年重写，要长什么样"的原型场
```

**判定标准（跑 1~2 个月后回头看）**：如果副驾上那个 R8 实验插件**明显比 `chatluna-vision` 稳**，且 Koishi 侧再出一次框架级故障（比如 `docs/23` 的断线死锁那种），**那时候再谈迁移**；否则**永远不要迁**。

---

## 6. 如果最终还是要迁：先做这四件事（降耦，现在就能做，且不迁也有收益）

这几件事**无论迁不迁都该做**，做了以后"要不要迁"从"重写"降级成"换壳"：

### 6.1 把 C 类插件的"算法"和"接线"拆开（收益最大）

现在 `chatluna-vision` 1,459 行里，pHash 计算 / 图片压缩 / 缓存键 应该和 `messageTransformer.before` 的注册**分成两个文件**。
- 拆完以后：算法文件**直接就是 AstrBot 插件能 require 的模块**（纯函数，无框架依赖）
- 影响：A 类从 8% 提到 **25~30%**

### 6.2 把 8 个用库插件的读写层收成一个薄 DAO

现在 `ctx.database` 出现 73 次，散在 8 个插件里。抽一层 `store.js`（只有 `get/set/list/remove` 四个方法），以后换 AstrBot 的 `PluginKVStoreMixin` **只改一个文件**。

### 6.3 把 `before-send` 出站链画成文档

53 处 `before-send` 引用，实际是 `guard → replyshaper → render` 三段流水线。**这个语义在任何框架上都要重建**，现在趁还记得清楚写下来（`docs/17` 里有零散的，但没有成链的图）。迁的时候这张图就是规格书。

### 6.4 把"踩坑知识"从代码注释里搬出来

`docs/04-踩坑记录` 里有很多 `koishi-plugin-chatluna/lib/index.cjs:2908-2977` 这类行号注释——**这些是"为什么这么写"的唯一记录**，但和框架版本绑死。建议每条坑补一句"**现象 + 根因（脱离框架描述）**"，行号作为附录。

---

## 7. 未取证的项（诚实标注）

以下我没能实测定论，**不要当作结论使用**：

1. **AstrBot 侧"LLM 工具 + 权限"能否复刻我们的 15 个工具**：`@filter.llm_tool` 有，但 `selector`（哪个群/哪个模型能调）和 `authorization`（最低权限等级）的语义**没有源码级核对**，只知道指令级权限是三档。→ 这是**B/C 类迁移的最大未知数**。
2. **AstrBot 的 `before-send` 等价物**：只确认了「无同名钩子」，没核到底能不能干净地包住 `send`（不改 core）。→ 影响 `guard`(1,302) + `render`(506) + `replyshaper`(154)。
3. **AstrBot 插件热重载**：文档说有，但**是否像 Koishi 的 worker 重启那样快**没实测。→ 这直接影响开发体验，可能是比代码量更痛的成本。
4. **`astrbot_plugin_livingmemory` 的记忆数据格式**：只看了 README 级别的描述，没看 schema。→ 决定"记忆能不能部分导入"。
5. **ChatLuna 的维护持续性**：只看到 10-17 还在发版，**没看作者近期的 issue 响应速度**。→ 这是比 Koishi 停更更关键的风险源。

---

## 8. 最终建议（一句话版）

> **不迁。** 你担心的框架老化是真的，但你依赖的核心是 ChatLuna（没停），而且停更反而让内部 API 冻结、我的那些行号注释不再失效。
> **花 2 周搭个 AstrBot 副驾**，专门验证 R8 和 dsh 两条线，成本极低、选择权全留。
> **同时做 §6 的四件降耦**——它们不迁也有收益（可读性、可测性），迁了能把成本从"重写"降到"换壳"。
> **明年再看**：如果副驾上的 R8 明显更强 + ChatLuna 出现停更迹象，那时候迁，成本已经被 §6 砍掉一半。

**最该盯的那个指标不是 Koishi 的 commit 数，是 `chatluna-sticker` / `chatluna-agent` 的发版节奏。** 它停了，才是真的要迁。
