# NoneBot2 vs Koishi 技术选型调研（13 条需求）

调研日期：**2026-09-28**（所有"最后发布时间"以此为准的时间差判断）

数据源（实际抓取）：
- NoneBot 商店：https://registry.nonebot.dev/plugins.json → 942 条
- Koishi 市场：https://registry.koishi.chat/index.json → 4695 条
- PyPI JSON API（`https://pypi.org/pypi/<pkg>/json`）、npm registry（`https://registry.npmjs.org/<pkg>`）、GitHub REST API

> 说明：本报告中出现的每一个包名/版本/日期都来自上述真实抓取结果。未找到的条目一律写"未找到"，未做任何推测。

---

## 总体判断（250 字内）

**Koishi 是"LLM 群聊拟人化"更成熟的生态，NoneBot 是"自建可控"更灵活。**Koishi 的 ChatLuna 生态已经把 R1/R2/R3/R6/R8/R10/R11 做成了官方插件矩阵（chatluna + long-memory + multimodal-service + agent + character），R4/R5/R7/R9 也有第三方插件（affinity / sticker / memesluna / spark / proactive-trigger），R13 是框架内置 authority + admin。代价是生态碎片化、插件质量参差、深层能力要靠"拼装"。NoneBot 商店里 **没有任何单一插件覆盖全部需求**：pxchat-enhanced、moellmchats、suggarchat、llmchat 各覆盖 60%–70%，R4（好感度）、R7（去重索引）、R9（自主插话）、R12（自我扩展）在两个生态里都没有找到现成插件，需要自写。若目标是快速上线拟人化群聊 Bot，选 Koishi；若需要深度定制、可控性强、Python 技术栈，选 NoneBot 并接受更多自写量。

---

## 逐条结论

图例：【内置】框架自带｜【插件】有现成插件｜【自写】需自己写｜【做不到】硬限制

| # | 需求 | NoneBot2 | Koishi |
|---|---|---|---|
| R1 | 接入 DeepSeek | 【插件】`nonebot-plugin-deepseek` v0.3.0（2026-07-24）；或任一 OpenAI 兼容插件：`nonebot-plugin-suggarchat` v4.0.0（2026-08-21）、`nonebot-plugin-llmchat` v0.6.0（2026-08-25）、`nonebot-plugin-pxchat-enhanced` v2.0.0（2026-06-21）、`nonebot-plugin-moellmchats` v0.22.3（2026-07-17） | 【插件】`koishi-plugin-chatluna` v1.4.0（2026-09-19）+ `koishi-plugin-chatluna-deepseek-adapter` v1.4.1（2026-09-23） |
| R2 | 人格定义/多份存储/命令切换 | 【插件】部分：`nonebot-plugin-pxchat-enhanced`（单一 `px personality set`，非多份）；`nonebot-plugin-moellmchats`（**用户级性格预设**，支持动态切换与自定义模板）；`nonebot-plugin-suggarchat`（`config/prompts/` 多份模板 + `/choose_prompt` 切换，但那是提示词模板不是人格库）；`nonebot-plugin-llmchat`（`/修改设定` 群组专属系统提示词）。**没有找到"默认人格 + 多份人格库 + 命令切换"三合一插件**，需自行拼装或自写 | 【插件】`koishi-plugin-chatluna` 预设系统：文件放 `data/chathub/presets`，`chatluna.preset.list` 列出、`chatluna.use.preset <preset>` 当前会话切换、控制台 `defaultPreset` 设默认；`koishi-plugin-chatluna-preset-market` v1.1.1（2026-05-12）在线预设仓库。角色扮演另有 `koishi-plugin-chatluna-character` v0.0.234（2026-09-08）独立 YAML 预设目录 `chathub/character/presets` |
| R3 | 长期+短期记忆（群聊、跨会话） | 【插件】部分：`nonebot-plugin-pxchat-enhanced`（短期：20 条上下文 + 6 小时群消息缓存 + 群成员记忆；**无真正长期记忆**）；`nonebot-plugin-suggarchat`（`core.llm.memory_length_limit`=50 条 + `/del_memory` + `/show-abstract` 摘要）；`nonebot-plugin-memory` v0.1.13（2025-10-11，为每个对话者形成记忆并生成用户档案）；`nonebot-plugin-moellmchats`（群/用户双层滑动窗口 + TTL）。**跨会话长期记忆需自写或拼装** | 【插件】`koishi-plugin-chatluna-long-memory` v1.4.0（2026-09-19）：四层记忆（Global/Preset/Guild/User），三种引擎 Basic / HippoRAG / EMGAS，向量库 + 嵌入模型，支持主动/被动提取、遗忘衰减；另有 `koishi-plugin-chatluna-livingmemory` v0.24.8（2026-09-27）第一人称叙事记忆。短期靠会话上下文 + `nonebot` 无对应物的 `chatluna-long-memory` 轮次提取 |
| R4 | 每个群友不同好感度/关系度 | 【自写】未找到。商店内无 `好感度/affinity/关系度` 相关插件（按 module_name 与 desc 关键词全量过滤，命中 0 条）。`nonebot-plugin-pxchat-enhanced` 的 `memory.py` 只做发言统计/关键词/互动摘要，可作为自写基础 | 【插件】`koishi-plugin-chatluna-affinity` v0.3.15（2026-08-31）"ChatLuna Character 好感度系统，提供好感度、关系、黑名单变量与控制台仪表盘"；配套 `koishi-plugin-chatluna-affinity-relationship` v0.0.3（2026-09-16）注入 5 类关系提示词变量。其他：`koishi-plugin-satori-ai` v1.4.3（2026-02-23，长期记忆+好感度） |
| R5 | 主动发送表情包 | 【插件】`nonebot-plugin-random-reply` v0.5.4（2025-07-23）：基于 LLM 智能体选择表情包并拟人回复（支持 Gemini / oneapi 格式），另可挂第三方斗图 API；`nonebot-plugin-imagelibrary` v1.1.0（2025-08-18）共享图库；`nonebot-plugin-sticker-saver` v0.1.4（2025-01-18）存表情。**但 random-reply 不是接在主 LLM 插件上的，需要单独接** | 【插件】`koishi-plugin-memesluna` v0.6.0-alpha.12（2026-08-25）图片转发服务，支持 `{memesluna}` 变量注入 ChatLuna（**ChatLuna 官方伪装预设就是用它发表情包**）；`koishi-plugin-chatluna-sticker` v1.1.13（2026-09-25）注册 ChatLuna 工具 `sticker_send`，AI 按表达意图自主选图发送 |
| R6 | 识别/理解表情包图片（视觉模型） | 【插件】`nonebot-plugin-pxchat-enhanced`（多模态模型图片识别，群聊延迟识别/私聊即时）；`nonebot-plugin-moellmchats`（识别用户发送/引用的图片，有图片时强制走视觉模型，历史自动回退纯文本省 token）；`nonebot-plugin-llmchat`（API 预设可设 `support_image`）；专用视觉插件 `nonebot-plugin-gemini-vision` v1.0.9（2025-10-03） | 【插件】`koishi-plugin-chatluna-multimodal-service` v1.4.0（2026-09-19）：`enableContextImageDescription` 为上下文图片生成文本描述、`read_files` 工具让模型直接看图、GIF 拆帧（first/head/average，1–5 帧）、音频 ffmpeg 转码。**DeepSeek 本身不支持图像输入，官方文档明确给出的方案就是"用多模态模型生成描述后注入"** |
| R7 | 表情包库管理 + 去重索引 | 【插件】部分：`nonebot-plugin-imagelibrary`（共享 Bot 图库）、`nonebot-plugin-sticker-saver`（保存表情）——**两者均无去重索引**；`nonebot-plugin-random-reply` 采用"多模态视觉标注 → 知识库 RAG 检索"路线，天然避免重复识别，但依赖外部 emo-visual-data 数据 | 【插件】`koishi-plugin-chatluna-sticker` v1.1.13（2026-09-25，npm 首发 2026-09-18）：监听群聊图片/表情，**pHash(64-bit) 去重 + 汉明距离计算**，本地图片库 + 元数据入库，出现次数达阈值后由 ChatLuna 多模态模型判断是否收藏，过期淘汰；`koishi-plugin-emojiluna` v1.3.3（2026-05-12，ChatLunaLab 官方）表情包管理 + AI 自动分类/标签/搜索；fork 版 `koishi-plugin-emojiluna-plus` v0.0.4（2026-09-15） |
| R8 | 处理引用消息（含图片） | 【内置】OneBot v11 适配器提供 `Reply` 消息段与 `get_msg` API，`event.reply` 可取得被引用消息（含图片段）——协议层与适配器层支持，读取后如何塞进 Prompt 需自写。【插件】`nonebot-plugin-pxchat-enhanced` 的"消息感知"明确支持"识别 @、回复引用、卡片"，并支持模型用完整 msg_id 精确引用；`nonebot-plugin-moellmchats` 支持识别用户引用的图片 | 【插件】ChatLuna 主插件配置项 `includeQuoteReply`（是否在回复内容中包含引用消息的内容）；合并转发读取用 `attachForwardMsgIdToContext` + `koishi-plugin-chatluna-forward-msg` v0.2.4（2026-06-05，支持图片描述工具，兼容 NapCat/LLBot）。`chatluna-character` 预设原生支持 `<message quote="id">` 引用回复 |
| R9 | 自主监控群聊、择机插话 | 【插件】部分：`nonebot-plugin-suggarchat` 有"自动回复模式（概率性随机触发）"；`nonebot-plugin-pxchat-enhanced` 有"智能参与（模型自主判断是否回复 + 置信度过滤 + 动态参与度门槛三级决策）+"突发检测"；`nonebot-plugin-llmchat` 有 `LLMCHAT__RANDOM_TRIGGER_PROB`（默认 0.05）。**这三者都是"同一条消息进来后决定要不要回"，不是"持续旁听群聊后主动开新话题"** | 【插件】`koishi-plugin-chatluna-agent` v1.0.45（2026-08-28）的 **Trigger** 子系统：cron / once / keyword / **activity（按群活跃度触发）** 四类触发器主动唤醒模型发消息，回复方式 channel/user/silent；`koishi-plugin-chatluna-spark` v1.5.1（2026-07-21，基于 Agent Trigger 的主动对话）；`koishi-plugin-chatluna-proactive-trigger` v0.3.12（2026-07-26，空闲触发+活跃度触发） |
| R10 | 控制 LLM 请求频率（聚合/门控/冷却） | 【插件】`nonebot-plugin-pxchat-enhanced`：延迟回复（非 @ 15–20s 后判断、@ 3–5s）+ 三层决策 + 30s 内 ≥10 条自动重置参与度 + 记忆写入 30s 节流 + FC 工具缓存 30s + "合并调用"；`nonebot-plugin-suggarchat`：`usage_limit.enable_usage_limit` 每日用量统计与频率限制（群/用户/全局）；`nonebot-plugin-llmchat`：`LLMCHAT__HISTORY_SIZE` + "自动合并未处理消息，降低 API 用量"；`nonebot-plugin-moellmchats`：对话冷却时间 / 请求队列管理 / 失败重试；通用层 `nonebot-plugin-access-control` v1.2.4（2025-01-23）有 `/ac limit` 限流（按主体+服务+时间窗） | 【内置】ChatLuna 主插件配置项：`msgCooldown`（全局冷却，默认 5s，1–3600）、`messageQueue`（默认 true，多条消息合并成一条）、`messageQueueDelay`（延迟聚合窗口）、`randomReplyFrequency`、`chatLimit`（**按模型适配器**配置每小时聊天次数，支持按用户/用户 ID 分支条件属性）。另有通用 `koishi-plugin-rate-limit` v2.0.4（2024-04-24）、`koishi-plugin-limit-rate` v1.2.3（2026-06-07） |
| R11 | 会话生命周期管理（开始/结束、状态机或工具调用） | 【内置】`T_State` 会话状态字典（生命周期=事件处理流程）+ `matcher.reject()/finish()` 多轮会话控制；【插件】`nonebot-plugin-pxchat-enhanced` 有 `state.py`（连续回复轮数/精力值/话题兴趣度）、`/chatobj` 会话状态、`session.session_control` 会话超时自动清理；`nonebot-plugin-suggarchat` 有 `/sessions` 会话管理 + `/chatobj` + 会话生命周期控制配置项。**"开始游戏→结束/中断"这类显式状态机需自写**，但 Function Calling 已具备（suggarchat/pollmchats/pxchat-enhanced/llmchat 均支持） | 【内置】主插件内置 `agent` 聊天模式（工具调用模式）。会话命令族：`chatluna.new`（创建）、`chatluna.switch`、`chatluna.rename`、`chatluna.archive`（归档）、`chatluna.restore`、`chatluna.export`、`chatluna.compress`、`chatluna.delete`，以及 `chatluna.rule.*` 设置作用域默认行为、`chatluna.rule.lock` 锁定。**"开始游戏/结束游戏"业务状态机仍需自写**，但工具调用（agent 模式 + `chatluna-plugin-common` 的 todos/cron/chat 工具）可直接承载 |
| R12 | 自我扩展：发现缺能力→搜插件→装→跑 | 【做不到 / 未找到】商店 942 条中未找到任何"机器人自主安装插件"的插件（`nonebot-plugin-ret2shell` 等只是执行 shell，非自主扩展）。框架层面 `nb-cli`、`nb plugin install` 是**人工**命令行操作，运行时无官方安装接口 | 【插件】部分，且需人工确认：`@koishijs/plugin-market` v2.11.11（2026-04-25，官方 verified）提供控制台内安装/卸载/更新，并实现 `installer` 服务，服务可被其他插件调用；`koishi-plugin-market-next` v3.6.3（2026-09-19）下一代市场。ChatLuna 侧：`koishi-plugin-chatluna-agent` 的 **Computer** 后端提供 `bash`/`file_write`/`grep`/`glob` 工具（可 `npm install`），**Skills** 支持按需加载 `SKILL.md`（可从 GitHub/ZIP/文件夹导入），`koishi-plugin-chatluna-plugin-common` 的 `command` 工具能让模型执行 Koishi 指令（`commandList[].confirm` 默认 true，**需用户回复确认码**）。**即：能"跑命令装包"，但"自主发现并安装"仍需人工闸门，不是全自动** |
| R13 | 权限系统：把管理权限授予指定用户，该用户能用命令完成全部设置 | 【内置】`SUPERUSERS` 配置 + `Permission`/`PermissionChecker`（https://nonebot.dev/docs/appendices/permission ）；【插件】`nonebot-plugin-access-control` v1.2.4（PyPI 最后发布 2025-01-23，GitHub 仓库 2026-09-07 仍有推送，58 stars）：主体（Subject）模型 `qq:12345678` / `qq:g87654321` / `all` / `superuser`，`/ac permission allow --sbj … --srv …` 按服务树细粒度授权，`/ac limit` 限流，`nb accctrl` CLI。**命令本身仅超级用户可用**，所以"授予他人管理权限"= 用 `/ac permission allow` 开服务给该主体（可做到），但"该用户能完成全部设置"仍需把每个服务逐个 allow。其他选择：`nonebot-plugin-onebot-luckperms` v0.1.2（2026-08-30）、`nonebot-plugin-liteperm` v0.1.1（2025-10-23）、`nonebot-plugin-flexperm` v0.7.0（2023-06-13，已停更）、`nonebot_plugin_rauthman` v2.0.0rc1.post3（2023-07-18，已停更） | 【内置】**authority 等级机制**：0 不存在用户 / 1 所有用户 / 2 高级用户 / 3 管理员 / 4 高级管理员（可管理其他账号），"高权限者能执行一切低权限者操作"；每个指令可单独设 `authority`，甚至单个选项可单独设。授权用官方 `admin` 插件（内置，`@koishijs/plugin-admin` v2.0.0，2026-06-27）的 `authorize <value> -u @user`（别名 `auth`，最低 4 级，且目标用户与目标权限都必须严格低于自己）。控制台设置用 `@koishijs/plugin-console` + `plugin-config` + `plugin-market`。**完全满足 R13** |

---

## Q1：ChatLuna 到底提供哪些能力？

**包名 `koishi-plugin-chatluna`**，v1.4.0，npm 最后发布 2026-09-19，npm 首发 2023-11-09，累计 **359 个版本**；GitHub [ChatLunaLab/chatluna](https://github.com/ChatLunaLab/chatluna) **440 stars**，最后提交 2026-09-23。**维护状态：非常活跃。**

官方生态（来自 [生态总览](https://chatluna.chat/ecosystem/introduction.html)）：

| 能力 | 插件 | 版本 / 最后发布 |
|---|---|---|
| 核心对话 | `koishi-plugin-chatluna` | 1.4.0 / 2026-09-19 |
| DeepSeek 适配 | `koishi-plugin-chatluna-deepseek-adapter` | 1.4.1 / 2026-09-23 |
| OpenAI 兼容 | `koishi-plugin-chatluna-openai-like-adapter` | 1.4.1 / 2026-09-23 |
| 长期记忆 | `koishi-plugin-chatluna-long-memory` | 1.4.0 / 2026-09-19 |
| Agent 框架（MCP/Skills/Sub-Agent/Computer/Trigger） | `koishi-plugin-chatluna-agent` | 1.0.45 / 2026-08-28 |
| Agent 基础工具 | `koishi-plugin-chatluna-plugin-common` | 1.4.0 / 2026-09-19 |
| 多模态（图像/音频/GIF） | `koishi-plugin-chatluna-multimodal-service` | 1.4.0 / 2026-09-19 |
| 联网检索 | `koishi-plugin-chatluna-search-service` | 1.4.0 / 2026-09-19 |
| 向量库 | `koishi-plugin-chatluna-vector-store-service` | 1.4.0 / 2026-09-19 |
| 嵌入模型 | `koishi-plugin-chatluna-embeddings-service` | 1.4.0 / 2026-09-19 |
| 角色扮演（伪装群友） | `koishi-plugin-chatluna-character` | 0.0.234 / 2026-09-08（74 stars） |
| 预设仓库 | `koishi-plugin-chatluna-preset-market` | 1.1.1 / 2026-05-12 |
| 图片渲染 | `koishi-plugin-chatluna-image-renderer` | 1.4.0 / 2026-09-19 |

**"预设/人格"怎么做**：预设是放在磁盘上的文件，目录 `<Koishi 数据目录>/data/chathub/presets`（[使用预设](https://chatluna.chat/guide/preset-system/switch-preset.html)）。命令 `chatluna.preset.list [-l <limit>] [-p <page>]` 列出、`chatluna.use.preset <preset>` 切换当前会话、控制台配置项 `defaultPreset` 设新会话默认值。会话系统分三层：路由 → 预设通道 → 会话（[会话系统](https://chatluna.chat/guide/session-related/conversation.html)）；同一群可以用 `-p <preset>` 指定通道并行运行多条人格线（如 default / translator / reviewer），也可以发一条以预设别名开头的消息直接路由。角色扮演场景另有一套**不兼容**的 YAML 预设，目录 `<koishi-data>/chathub/character/presets`，内置 `CHARACTER`（默认，XML 块格式）与 `CHARACTER（工具调用）`（推荐，走 `character_reply` 工具）两套模板。

**"长期记忆"怎么做**：[长期记忆文档](https://chatluna.chat/guide/session-related/long-term-memory.html) 明确 —— 基于对话历史由 LLM 提取关键信息存入**向量数据库**，四层：Preset 层 / Global 层 / Guild 层 / User 层，支持联合检索；三种引擎（Basic 直接全量注入 / HippoRAG 知识图谱+Personalized PageRank / EMGAS 激活扩散+时间衰减）；模拟人类记忆分类并实现遗忘；**即使清除房间聊天记录，长期记忆依然存在**。提取方式分被动（按 `longMemoryExtractInterval` 轮次）与主动（注册为工具由 Agent 判断）。预设里用 `{long_memory('global','guild','user')}` 模板函数检索。

**工具调用**：**支持，且是核心卖点**。主插件内置 `agent` 聊天模式（另有 `chat`、`browsing`），该模式本身只提供"允许模型调用工具"的能力，工具需另装 `chatluna-plugin-common` 或 `chatluna-agent`（[聊天模式](https://chatluna.chat/guide/chat-chain/chat-mode.html)）。`chatluna-plugin-common` 提供 request/fs/group/command/chat/think/todos/cron/send/draw/music/actions 共十余个工具（[基础工具合集](https://chatluna.chat/ecosystem/plugin/common.html)）；`chatluna-agent` 提供 MCP 接入、Skills、Computer（Local/E2B/Open Terminal 三后端 + `bash`/`file_read`/`file_write`/`file_edit`/`grep`/`glob`/`file_publish`）、Sub-Agent（内置 plan/explore/general）、Trigger，且**每个工具可单独设置"所需最低 Koishi 用户权限等级"**（`bash` 等默认 3 级）。`chatluna-character` 甚至提供了纯工具调用版的预设模板 `default-tool-call.yml`。DeepSeek 适配器走 OpenAI 兼容协议，官方文档有专门的 [DeepSeek 接入页](https://chatluna.chat/guide/configure-model-platform/deepseek.html)（`https://api.deepseek.com/v1`，`chatluna.model.test deepseek/deepseek-chat`）。

---

## Q2：NoneBot 里做"LLM 群聊 + 人格 + 记忆"最主流的插件

按 GitHub stars × 发布活跃度排序（全部经 PyPI/GitHub 核实）：

**1. `nonebot-plugin-suggarchat`** v4.0.0（2026-08-21，GitHub [LiteSuggarDEV/nonebot_plugin_suggarchat](https://github.com/LiteSuggarDEV/nonebot_plugin_suggarchat)，44 stars，304 个 PyPI release）
- 优势：唯一明确自称"聊天智能体"的；多协议（OpenAI/DeepSeek/Gemini）；**Function Calling 已内置**（含群管工具、不良内容检测、Cookie 提示词防泄露）；可选 MCP；`config/models/` 模块化模型预设 + `config/prompts/` 提示词模板体系；`nonebot-plugin-orm` 持久化；会话生命周期控制 + 每日用量统计与频率限制（群/用户/全局）；插件 API 全开放易扩展；有完整文档站 https://docs.suggar.top/project/suggarchat/
- 劣势：`enable=false` 默认关闭；明确声明"如需完整 Agent 编排能力请迁移到 AmritaBot"——即它不是全功能 Agent；人格=提示词模板而非独立人格库；无视觉默认能力（`multimodal` 配置项）
- 维护：**活跃**（2026-08-21）

**2. `nonebot-plugin-pxchat-enhanced`** v2.0.0（2026-06-21）
- 优势：**覆盖需求最广的一个**——多模型切换（聊天/识图分开指定）+ 上下文记忆 + 智能参与三层决策 + 短期状态（连续回复/精力/话题兴趣）+ 群成员记忆 + 精确引用 + 思考模式 + 图片识别 + MCP 工具 + 自动禁言 + 延迟回复 + 打字节奏 + Token 优化。全功能可用聊天指令 `/px` 配置
- 劣势：人格只有一个（`px personality set`），**无多份人格库**；记忆是短期（6 小时缓存），**无长期记忆**；无好感度；无表情包能力；无自主插话
- 维护：**中等**（2026-06-21，最新），前代 `nonebot-plugin-pxchat` v1.0.3（2025-10-10）已落后

**3. `nonebot-plugin-llmchat`** v0.6.0（2026-08-25，[FuQuan233/nonebot-plugin-llmchat](https://github.com/FuQuan233/nonebot-plugin-llmchat)，52 stars）
- 优势：**多 API 预设 + 运行时热切换**（`API预设` 命令）；MCP 协议（兼容 Claude.app 配置格式）；内置 OneBot 群管工具（禁言/群信息/群成员/戳一戳/撤回，需模型支持 tool_call）；`MAX_TOOL_ROUNDS`/`MAX_REPEATED_TOOL_CALLS` 工具轮数控制很工程化；视觉模型（`support_image`）；图片回复（Gemini 2.5 Flash Image）；`/修改设定` 动态改群组系统提示词
- 劣势：人格是"系统提示词"粒度，非人格库；记忆仅 `HISTORY_SIZE`（默认 20）+ `PAST_EVENTS_SIZE`（默认 10）上下文条数，**无长期记忆**；无好感度、无表情包、无主动插话
- 维护：**活跃**（2026-08-25）

**4. `nonebot-plugin-moellmchats`** v0.22.3（2026-07-17）
- 优势：MoE 混合专家调度（动态路由到最优模型，宣称 Token 降 35%）；用户级性格预设 + 动态切换 + 自定义模板；立体上下文（群/用户双层滑动窗口 + TTL）；对话冷却/请求队列/失败重试；**识别用户发送或引用的图片**（有图强制走视觉模型，历史自动回退纯文本省 Token）；极省 Token 的 Function Calling（预分类-后注入两阶段）；支持写原生 Python 工具（`custom_tools/`）+ 覆盖 NoneBot 插件描述
- 劣势：生态小、文档偏薄；无表情包、无好感度、无长期记忆（只有 TTL 窗口）
- 维护：**较活跃**（2026-07-17）

**5. `nonebot-plugin-anywhere-llm`** v1.1.6（2025-04-15）——定位是"给其他插件提供 LLM 访问能力 + 统一记忆管理"，不是终端聊天 Bot，适合作为基础设施。
**6. `nonebot-plugin-llm-plugins-call`** v0.2.1（2025-04-13）——让 LLM 结合语境调用**已安装的 nonebot 插件**，思路最接近"工具调用"，但已 1 年多未更新。
**7. 老一代（不建议）**：`nonebot-plugin-naturel-gpt` v2.2.0（2023-12-23）、`nonebot-plugin-chatgpt-api` v1.1.5（2025-03-04）、`nonebot-plugin-chatgpt` v0.7.5（2023-04-12）——均已停更或仅修 bug。

**结论**：NoneBot 没有"ChatLuna 级"的统一生态。最省事的组合是 **pxchat-enhanced（拟人化+识图+智能参与）+ suggarchat 或 llmchat（工具调用+预设）**，但两者功能重叠且不会互相打通，实际上要二选一再加装独立插件补缺口。

---

## Q3：Koishi 的 authority 能否满足 R13？NoneBot 侧等价方案？

**Koishi：能，且是框架内置。**

- authority 等级：0 不存在的用户 / 1 所有用户（只能接触有限功能）/ 2 高级用户（几乎一切机器人功能）/ 3 管理员（直接操作机器人事务）/ 4 高级管理员（管理其他账号）。核心规则"高权限者能够执行一切低权限者的操作"（[深入定制机器人 · 权限管理](https://koishi.chat/zh-CN/manual/usage/customize.html#权限管理)）。
- 粒度：每个指令可设 `authority`，甚至单个选项可单独设（例如 `echo -E` 单独设 3 级）（[指令系统 · 权限管理](https://koishi.chat/zh-CN/manual/usage/command.html)）。
- 授予权限：官方 `admin` 插件（`@koishijs/plugin-admin` v2.0.0，2026-06-27，verified）的 **`authorize <value> -u <user>`**（别名 `auth`），最低权限 4，且"目标用户的权限和要设定的权限都必须严格小于自己的权限等级"。可直接 `authorize 3 -u @Koishi`（[数据管理 (Admin)](https://koishi.chat/zh-CN/plugins/common/admin.html)）。
- 其余设置：控制台（`@koishijs/plugin-console` v5.30.11）+ `plugin-config` + `plugin-market` 全部可视化。
- 补充：`@koishijs/plugin-commands` v3.5.5 可在控制台批量改指令权限等级/别名/层级。
- **判定**：R13 完全满足。注意 5 级只来自"配置登录插件"得到的管理员账号，日常授权止于 4 级。

**NoneBot：需要插件，推荐 `nonebot-plugin-access-control`。**

- **`nonebot-plugin-access-control`**（PyPI 同名，v1.2.4）——[ssttkkl/nonebot-plugin-access-control](https://github.com/ssttkkl/nonebot-plugin-access-control)，**58 stars**，GitHub 最后推送 **2026-09-07**，PyPI 最后发布 **2025-01-23**（版本较旧但仓库仍活）。核心模型：**主体 Subject**（`qq:12345678`、`qq:g87654321`、`all`、`superuser`、`<平台名>`、`<协议名>`）+ **服务 Service**（树形：`nonebot` → 插件 → 子服务）；鉴权按"主体优先级从高到低、服务节点深度从深到浅"解析。
  - 授权命令：`/ac permission allow|deny|rm --sbj <主体> --srv <服务>`、`/ac permission ls`
  - 限流：`/ac limit add --sbj <主体> --srv <服务> --limit <次数> --span <间隔> [--overwrite]`
  - 服务查看：`/ac service ls`；主体自测：`/ac subject`
  - CLI：`nb accctrl`（控制台内使用）
  - 配置：`ACCESS_CONTROL_AUTO_PATCH_ENABLED=true` 可对**未适配**插件也做插件级控制
  - **限制**：`/ac` 指令**仅超级用户可用**，所以"把管理权限授予指定用户"实际是"用 `/ac permission allow` 给该主体开服务"。要做到"该用户能完成机器人全部设置"，需要为每个服务/插件逐个 allow（或对根服务 `nonebot` allow），不是一键授予"管理员身份"。
- 备选（均需自行核实维护度）：`nonebot-plugin-onebot-luckperms` v0.1.2（2026-08-30，LuckPerms 风格）；`nonebot-plugin-permission` v0.3.1（2026-07-11）；`nonebot-plugin-liteperm` v0.1.1（2025-10-23，权限节点/权限组/特殊权限）；`nonebot-plugin-flexperm` v0.7.0（**2023-06-13，已停更**）；`nonebot_plugin_rauthman` v2.0.0rc1.post3（**2023-07-18，已停更**）。
- 框架层：`SUPERUSERS` + `Permission` + `PermissionChecker`（[权限控制](https://nonebot.dev/docs/appendices/permission)）只能做布尔判定，**没有等级数值体系**，无法直接表达"3 级管理员"。

---

## Q4：R12（机器人自己安装插件）有没有现成实现？

**NoneBot：没有。** 942 条商店条目里没有"自主安装插件"型插件（`nonebot-plugin-ret2shell` v0.1.2 / 2026-08-16 等只是执行 shell，不涉及插件发现与安装）。框架提供的 `nb-cli` / `nb plugin install` 都是**人工命令行**操作，运行时没有官方安装接口。→ 【做不到】/【自写】

**Koishi：有基础设施，但没有"全自主闭环"。**

- `@koishijs/plugin-market` v2.11.11（2026-04-25，官方 **verified**）——控制台内安装/卸载/更新插件，并在 manifest 中**实现（implements）了 `installer` 服务**，理论上其他插件可以调用该服务做安装。这是最接近 R12 的官方能力，但入口在控制台、面向人。
- `koishi-plugin-market-next` v3.6.3（2026-09-19）——下一代市场与依赖管理中心。
- `koishi-plugin-chatluna-agent` v1.0.45（2026-08-28）：**Computer** 后端提供 `bash` 工具（可执行 `npm install koishi-plugin-xxx`）、`file_write`/`file_edit`，**Skills** 允许从 GitHub / ZIP / 文件夹导入 `SKILL.md` 并由模型按需加载、**Sub-Agent** 可委托任务、**Trigger** 可定时唤醒。配套 `koishi-plugin-chatluna-plugin-common` 的 `command` 工具让模型执行 Koishi 指令，其中 `commandList[].confirm` 默认 `true`——**执行前会要求用户回复一个随机确认码**。
- 所以链条是：模型发现缺能力 → 用 `bash`/`file_write` 装包 → 但**"发现并选择正确插件"这一步仍需人工（或人工白名单）**，且高危操作有确认闸门。官方文档还明确警告：Computer 的 Local 后端直接操作宿主机，"不要在面向普通用户的群聊中随意开放，也不要打开 `dangerouslySkipPermissions`"。

→ **判定：Koishi 【插件】部分实现（可跑命令装包 + 市场提供 installer 服务），但不是开箱即用的自主闭环；NoneBot 【做不到】。**

---

## 实际访问过的关键 URL 清单

**数据源（直接抓取）**
- https://registry.nonebot.dev/plugins.json （942 条）
- https://registry.koishi.chat/index.json （4695 条）
- https://pypi.org/pypi/nonebot-plugin-suggarchat/json
- https://pypi.org/pypi/nonebot-plugin-llmchat/json
- https://pypi.org/pypi/nonebot-plugin-pxchat-enhanced/json
- https://pypi.org/pypi/nonebot-plugin-pxchat/json
- https://pypi.org/pypi/nonebot-plugin-moellmchats/json
- https://pypi.org/pypi/nonebot-plugin-anywhere-llm/json
- https://pypi.org/pypi/nonebot-plugin-llm-plugins-call/json
- https://pypi.org/pypi/nonebot-plugin-access-control/json
- https://pypi.org/pypi/nonebot-plugin-memory/json
- https://pypi.org/pypi/nonebot-plugin-random-reply/json
- https://pypi.org/pypi/nonebot-plugin-imagelibrary/json
- https://pypi.org/pypi/nonebot-plugin-sticker-saver/json
- https://pypi.org/pypi/nonebot-plugin-onebot-luckperms/json
- https://pypi.org/pypi/nonebot-plugin-permission/json
- https://pypi.org/pypi/nonebot-plugin-liteperm/json
- https://pypi.org/pypi/nonebot-plugin-flexperm/json
- https://pypi.org/pypi/nonebot-plugin-gemini-vision/json
- https://pypi.org/pypi/nonebot-plugin-imageutils/json
- https://pypi.org/pypi/nonebot-plugin-htmlrender/json
- https://pypi.org/pypi/nonebot-plugin-alconna/json
- https://pypi.org/pypi/nonebot2/json
- https://registry.npmjs.org/koishi-plugin-chatluna
- https://registry.npmjs.org/koishi-plugin-chatluna-deepseek-adapter
- https://registry.npmjs.org/koishi-plugin-chatluna-openai-like-adapter
- https://registry.npmjs.org/koishi-plugin-chatluna-long-memory
- https://registry.npmjs.org/koishi-plugin-chatluna-character
- https://registry.npmjs.org/koishi-plugin-chatluna-agent
- https://registry.npmjs.org/koishi-plugin-chatluna-affinity
- https://registry.npmjs.org/koishi-plugin-chatluna-multimodal-service
- https://registry.npmjs.org/koishi-plugin-chatluna-preset-market
- https://registry.npmjs.org/koishi-plugin-chatluna-plugin-common
- https://registry.npmjs.org/koishi-plugin-chatluna-sticker
- https://registry.npmjs.org/koishi-plugin-emojiluna
- https://registry.npmjs.org/koishi-plugin-memesluna
- https://api.github.com/repos/ChatLunaLab/chatluna
- https://api.github.com/repos/ChatLunaLab/chatluna-character
- https://api.github.com/repos/Procyon-Nan/koishi-plugin-chatluna-livingmemory
- https://api.github.com/repos/wj6ej3ck6y3/koishi-plugin-chatluna-sticker
- https://api.github.com/repos/Sor85/AAAAACAT-chatluna-plugins
- https://api.github.com/repos/lumia1998/koishi-plugin-memesluna
- https://api.github.com/repos/LiteSuggarDEV/nonebot_plugin_suggarchat
- https://api.github.com/repos/FuQuan233/nonebot-plugin-llmchat
- https://api.github.com/repos/ssttkkl/nonebot-plugin-access-control

**ChatLuna 官方文档**
- https://chatluna.chat/guide/configure-model-platform/deepseek.html
- https://chatluna.chat/guide/useful-configurations.html
- https://chatluna.chat/guide/preset-system/switch-preset.html
- https://chatluna.chat/guide/session-related/long-term-memory.html
- https://chatluna.chat/guide/session-related/chat-limit.html
- https://chatluna.chat/guide/session-related/conversation.html
- https://chatluna.chat/guide/chat-chain/chat-mode.html
- https://chatluna.chat/guide/model-plugin-system/introduction.html
- https://chatluna.chat/guide/model-plugin-system/command-execution.html
- https://chatluna.chat/guide/best-practice/character-recommended-plugins.html
- https://chatluna.chat/ecosystem/introduction.html
- https://chatluna.chat/ecosystem/plugin/long-term-memory.html
- https://chatluna.chat/ecosystem/plugin/extension-agent.html
- https://chatluna.chat/ecosystem/plugin/multimodal-service.html
- https://chatluna.chat/ecosystem/plugin/common.html
- https://chatluna.chat/ecosystem/other/character.html
- https://preset.chatluna.chat
- https://github.com/ChatLunaLab/awesome-chatluna-presets

**Koishi 官方文档**
- https://koishi.chat/zh-CN/manual/usage/customize.html
- https://koishi.chat/zh-CN/manual/usage/command.html
- https://koishi.chat/zh-CN/plugins/common/admin.html
- https://koishi.chat/zh-CN/plugins/console/market.html

**NoneBot 官方文档**
- https://nonebot.dev/docs/appendices/permission
- https://nonebot.dev/docs/appendices/session-state
- https://nonebot.dev/docs/appendices/session-control
- https://onebot.adapters.nonebot.dev/docs/api/v11/event/
- https://onebot.adapters.nonebot.dev/docs/api/v11/bot/
- https://docs.suggar.top/project/suggarchat/
- https://www.npmjs.com/package/koishi-plugin-chatluna

**未访问成功（404，已改走其它路径，仅作记录）**
- https://chatluna.chat/guide/ （404）
- https://nonebot.dev/docs/next/api/adapters/onebot-v11 （404）
- https://nonebot.dev/docs/next/adapter/onebot-v11/api （404）
- https://nonebot.dev/docs/next/adapter/onebot-v11/ （404）
