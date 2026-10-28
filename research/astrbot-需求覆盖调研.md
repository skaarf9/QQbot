# AstrBot 对 13 条需求的覆盖程度调研

调研时间：2026-09-28。数据来源：官方文档 docs.astrbot.app（含仓库内 docs/zh/*.md 源文件）、插件市场 API https://api.soulter.top/astrbot/plugins（共 2306 条，已全量落盘过滤）、插件市场网页、GitHub 仓库 AstrBotDevs/AstrBot 源码与各插件仓库。

---

## 总体判断

AstrBot 与本需求高度契合。R1/R2/R6/R8/R9(基础)/R10(限流门控)/R13 属框架内置，其中「被引用消息（含图片）解析」是官方专门模块（`astrbot/core/utils/quoted_message/`），是本项目最强项。R3/R4/R5/R7/R9(智能判断)/R10(消息聚合) 在插件市场都能找到维护活跃的现成插件（多为 50~400 star）。R11 需自写约 100~200 行，但框架已给 `session_waiter`/`SessionController` 原语。R12 的"搜索、安装、加载"各环节都有现成插件或 OpenAPI 接口，但"LLM 自主闭环"需少量自写胶水代码。工作量集中在选型与配置，不是从零造轮子。

---

## R1 接入 DeepSeek（OpenAI 兼容 provider）

**【内置】**

仓库 `astrbot/core/provider/sources/` 下没有 DeepSeek 专属实现，只有 `openai_source.py` / `openai_responses_source.py` 等，即走 OpenAI 兼容通道。

- 配置路径：WebUI →「模型提供商」→「对话」→ 新增 → 类型选 `OpenAI Compatible` → 填 API Base（如 `https://api.deepseek.com/v1`）+ API Key → 保存并获取模型 → 在「配置文件 → AI 配置 → 模型 → 对话模型」里选中它。
- 文档：https://docs.astrbot.app/providers/llm.html （原文：「兼容 OpenAI API 的服务可选择 OpenAI Compatible」）、https://docs.astrbot.app/providers/start.html
- 连接配置落盘在 `data/cmd_config.json` 的 `provider_sources` / `provider` 字段。

## R2 人格定义：默认人格 + 多份人格 + 命令切换

**【内置】**（命令切换依赖官方扩展插件）

- 多份人格存储：`astrbot/core/persona_mgr.py` 提供 `create_persona` / `update_persona` / `delete_persona` / `get_all_personas` / `move_persona_to_folder` / `get_folder_tree`，DB 持久化 + 文件夹分组（WebUI 有独立人格页 `PersonaPage.vue`）。
- 默认人格：配置项 `provider_settings.default_personality`（默认人格 ID）与 `persona_pool`；新版走 `agent_runner.config.persona.persona_id`。
- 按会话生效：`resolve_selected_persona()` 的优先级 = 会话级强制 persona → 该对话的 `conversation_persona_id` → 配置默认值，即**可给每个群/每个对话单独指定人格**。
- 命令切换：`/persona`（查看/切换）由官方插件 **builtin_commands_extension** 提供，仓库 https://github.com/AstrBotDevs/builtin_commands_extension ，AstrBot 官方，12★，最后 push 2026-09-12（活跃），需在插件市场搜索安装。
- 文档：https://docs.astrbot.app/use/command.html 、https://docs.astrbot.app/dev/astrbot-config.html
- 额外可选（更细的管理）：**astrbot_plugin_persona_plus**，作者 Railgun19457，https://github.com/Railgun19457/astrbot_plugin_persona_plus ，16★，push 2026-09-01，支持指令/自然语言增删改查 + 关键词自动切换 + 同步改 QQ 头像昵称。

## R3 长期记忆与短期记忆（基于群聊内容，跨会话）

**【插件】**（短期记忆属内置）

内置部分：
- 短期记忆 = 会话上下文，按 UMO 隔离，含自动压缩（达模型窗口 82% 时触发，可选"按轮数截断"或"LLM 总结"）。文档 https://docs.astrbot.app/use/context-compress.html
- 群聊记忆注入：`provider_ltm_settings.group_icl_enable`（默认 false，开启后暂存群聊对话并在下次回复时注入系统提示词）+ `group_message_max_cnt`（默认保留 1000 条）。
- 但"跨会话记住群友说过的事"需要向量/图谱记忆，内置没有。

现成插件（star 与 push 时间取自 GitHub API，2026-09-28）：

| 插件名 | 作者 | GitHub | star | 最后 push | 说明 |
|---|---|---|---|---|---|
| astrbot_plugin_livingmemory | lxfight | https://github.com/lxfight-s-Astrbot-Plugins/astrbot_plugin_livingmemory | 351 | 2026-09-16 | 关键词+向量+图谱混合召回，记忆生命周期，Agent 工具 `recall_long_term_memory`/`memorize_long_term_memory`；要求 AstrBot ≥ 4.24.2 |
| astrbot_plugin_mnemosyne | lxfight | https://github.com/lxfight/astrbot_plugin_mnemosyne | 252 | 2026-09-15 | 基于 Milvus 的长期记忆存储与查询 |
| astrbot_plugin_angel_memory | kawayiYokami | https://github.com/kawayiYokami/astrbot_plugin_angel_memory | 187 | 2026-09-15 | 长期记忆 + 人格演化 + 自主学习 |

## R4 与不同群成员的关系度/好感度区分

**【插件】**（按用户 ID 独立存储，随互动变化）

| 插件名 | 作者 | GitHub | star | 最后 push | 说明 |
|---|---|---|---|---|---|
| astrbot_plugin_Favour_Ultra | 糯米茨 | https://github.com/nuomicici/astrbot_plugin_Favour_Ultra | 39 | 2026-09-21 | LLM 自判关系、自然衰减、主动搭话、查询权限配置 |
| favorpro | 天各一方 | https://github.com/Catfish872/astrbot_plugin_favourpro | 50 | 2025-09-05（约 1 年未更新） | 多维内心世界，好感/态度/关系随互动变化 |
| astrbot_plugin_emotionai_pro | asakiyoshi(原作者)/foorgange(修复) | https://github.com/foorgange/astrbot-plugin-emotionai_pro | 4（另有一条 13★ 的旧条目 https://github.com/asakiyoshi/EmotionAI-Pro ，2026-07-25） | 2026-09-19 | 8 维情感 + 4 阶段关系 + 长期记忆 + 衰减 |
| astrbot_plugin_memora | INSide-734 | https://github.com/INSide-734/astrbot_plugin_memora | 4 | 2026-09-28 | 长期记忆顺带做"关系演化 / 好感度"，有 Dashboard |

## R5 主动发送表情包（图片）

**【插件】**（发图能力本身内置）

- 内置：`Comp.Image` 消息段、`event.image_result(url_or_path)`、主 Agent 内置工具 `send_message_to_user`（支持图片/文件/音频/视频）。文档 https://docs.astrbot.app/use/proactive-agent.html
- 表情包库 + 主动挑选：

| 插件名 | 作者 | GitHub | star | 最后 push | 说明 |
|---|---|---|---|---|---|
| astrbot_plugin_meme_manager | anka | https://github.com/anka-afk/astrbot_plugin_meme_manager | 400 | 2026-09-26 | WebUI 表情包管理页 + 资源广场 + 语义检索 + AI 智能发送 + 自动收集 + 会话/人格选包 |
| astrbot_plugin_stealer | nagatoquin33 | https://github.com/nagatoquin33/astrbot_plugin_stealer | 72 | 2026-09-26 | 自动"偷"群里表情包入库，配视觉模型自动分类，对话时按情绪自动发送 |

## R6 识别/理解表情包图片内容（图像理解，需视觉模型）

**【内置】**

- 专用图片转述 provider：`provider_settings.default_image_caption_provider_id` + `image_caption_prompt`（默认 `"Please describe the image using Chinese."`）。配一个多模态 provider 后，用户发图会自动生成描述文本注入对话上下文——正是给纯文本主模型用的。文档 https://docs.astrbot.app/dev/astrbot-config.html
- 多模态主模型可直接收图，框架负责尺寸/格式/动图处理（GIF/动画 WebP/APNG 均匀取最多 9 帧拼 3×3 九宫格）。文档 https://docs.astrbot.app/providers/image-formats.html
- 群聊里别人发的图自动转述：`provider_ltm_settings.image_caption`（默认 false，需配合 `group_icl_enable`；官方提示会显著增加 API 调用与 token 开销）。
- 补充插件（强制转述给纯文本主模型、含引用图片）：**astrbot_plugin_force_image_caption**，作者 akiby17，https://github.com/akiby17/astrbot_plugin_force_image_caption ，1★，push 2026-09-11。

## R7 表情包库管理 + 去重索引（同一张图不重复做图像识别）

**【插件】**（核心只做请求内去重，不做跨请求缓存）

- 官方文档明确：`同一个请求中重复出现的图片引用复用同一份预览`、`不再保留跨请求图片转换缓存`（https://docs.astrbot.app/providers/image-formats.html ）。即**核心层没有图片识别结果缓存**，必须靠插件补。
- 最对症的现成插件：**astrbot_plugin_image_caption_cache**，作者 Florance，https://github.com/FloranceYeh/astrbot_plugin_image_caption_cache ，3★，push 2026-08-05。
  - 本地文件 / base64 图片用**内容哈希**做缓存键；远程 URL 默认用 URL 本身，可开 `fingerprint_remote_images` 下载求内容指纹；
  - TTL（默认 600s）+ 最大图片数（默认 200）双策略；同时覆盖主对话图片转述与**引用消息图片转述**（`patch_quoted_message` 默认开）；
  - 注意：官方没暴露"图片转述前"的稳定 hook，它靠运行时补丁核心函数实现，README 自己声明 AstrBot 升级可能导致接入点失效 → 依赖方需留意版本。
- 图库管理 + 自动收集去重：**astrbot_plugin_meme_manager**（同上，400★）；自动收集时"识别收到的图片…并进行去重"，语义索引需手动生成，接收分类未变时可复用已有描述。
- 读图结果落库避免重复调 VL：**astrbot_plugin_irmia_vision**，作者 伊尔弥亚，https://github.com/irmia2026/astrbot_plugin_irmia_vision ，3★，push 2026-09-05。

## R8 处理引用消息（读到被引用的文字和图片）

**【内置】**——本框架的强项

- 官方专门模块：`astrbot/core/utils/quoted_message/`，含 `extractor.py` / `chain_parser.py` / `image_resolver.py` / `onebot_client.py` / `image_refs.py` / `settings.py`，对外导出两个函数：
  - `extract_quoted_message_text(event, reply_component=None) -> str | None`
  - `extract_quoted_message_images(event, reply_component=None) -> list[str]`
  （`astrbot/core/utils/quoted_message_parser.py` 是兼容转发层）
- 解析链路（`extractor.py`）：先取消息链里的 `Reply` 组件中**内嵌**的文本/图片引用；不够就按 `Reply.id` 调 OneBot `get_msg` 拉原消息；遇到合并转发还会用 `get_forward_msg` 递归取（`max_forward_fetch` 默认 32 跳，`max_forward_node_depth` 默认 6）。
- 图片落地（`image_resolver.py`）：先做本地路径/data URI 归一化，再依次尝试 OneBot action `get_image` / `get_file` / `get_group_file_url` / `get_private_file_url`（每个 action 还会试 `file`/`file_id`/`id`/`image` 多种参数名做兼容），全部失败才 warning 并放弃。
- 进模型前的处理：`astrbot/core/utils/image_input.py` 的 `prepare_request_images(..., max_quoted_fallback_images=默认 20)` 会把引用图片纳入；`preprocess_stage/stage.py` 会对 `Reply.chain` 里的 `Image`/`Record` 做归一化（引用语音还会走 STT 并在文本里标 `(referenced message)`）。
- 官方文档也写明了：图片处理覆盖"普通附件、引用图片及插件 ProviderRequest 中的图片"，并在文本说明里**标明是否来自引用消息**（https://docs.astrbot.app/providers/image-formats.html ）。
- 回归测试存在：`tests/test_quoted_message_parser.py`、`tests/unit/test_aiocqhttp_reply.py`。

## R9 自主监控群聊、判断时机主动插话

**【内置（基础概率式）】** + 智能判断需插件

- 内置：`provider_ltm_settings.group_icl_enable`（监控群聊）+ `provider_ltm_settings.active_reply`：`enable` / `method: possibility_reply` / `possibility_reply`（默认 0.1）/ `whitelist`（按会话 ID 白名单）。这是**概率式**主动回复，不是"判断时机"。文档 https://docs.astrbot.app/dev/astrbot-config.html
- 判断式现成插件：

| 插件名 | 作者 | GitHub | star | 最后 push | 说明 |
|---|---|---|---|---|---|
| astrbot_plugin_Heartflow | Jason.Joestar | https://github.com/advent259141/Astrbot_plugin_Heartflow | 87 | 2026-08-23 | 双模型：小模型按内容/意愿/社交/时机/连贯性五维打分，过阈值且不在冷却才唤醒正常回复流程，按群隔离精力与冷却。README 明确要求关掉内置 active_reply 以免双触发 |
| astrbot_plugin_wakepro | Zhalslar | https://github.com/Zhalslar/astrbot_plugin_wakepro | 64 | 2026-08-18 | 唤醒流水线：阻塞判断→指令屏蔽→智能唤醒（7 种信号，含语义相关性）→消息防抖→沉默检测 |
| astrbot_plugin_proactive_chat | DBJD-CR | https://github.com/Pancakes-Labs/astrbot_plugin_proactive_chat | 398 | 2026-09-28 | 主动发起消息（上下文感知、免打扰时段、独立 WebUI），偏私聊/定时 |

## R10 控制 LLM 请求频率（聚合/批处理/门控/冷却）

**【内置（限流 + 门控）】** + 消息聚合需插件

内置（这是框架级的，不是插件）：
- 消息管道固定顺序（`astrbot/core/pipeline/stage_order.py`）：WakingCheck → WhitelistCheck → SessionStatusCheck → **RateLimit** → ContentSafetyCheck → PreProcess → Process(交给插件或 LLM) → ResultDecorate → Respond。**限流在 LLM 之前**。
- `RateLimitStage`（`pipeline/rate_limit_check/stage.py`）：固定窗口算法，按 UMO 隔离，配置项 `platform_settings.rate_limit.{count,time,strategy}`，`strategy` 可选 `stall`（等待下个窗口自动放行）或 `discard`（直接丢弃本条）。→ 天然避免"群里来一条消息就请求一次 API"的洪水。
- 触发门控：`wake_prefix`（默认 `/`）、@ 唤醒、`platform_settings.friend_message_needs_wake_prefix`、`provider_settings.wake_prefix`（额外 LLM 触发词，官方定位为"防止滥用的手段"）。
- 节奏控制：`platform_settings.segmented_reply.interval`（分段回复间隔，random 1.5~3.5s 或 log 分布）。
- 配置文档 https://docs.astrbot.app/dev/astrbot-config.html

消息聚合/防抖（内置没有，用插件）：

| 插件名 | 作者 | GitHub | star | 最后 push | 说明 |
|---|---|---|---|---|---|
| astrbot_plugin_debounce | Jason.Joestar | https://github.com/advent259141/astrbot_plugin_debounce | 65 | 2026-09-10 | 本地 BERT 模型判断"用户说完一句话没有"，合并连续多条消息后再提交，减少 LLM 调用；含超时强制发送与"取消回复再合并重发" |
| astrbot_plugin_wakepro | Zhalslar | （同上） | 64 | 2026-08-18 | 内置 debounce 阶段：合并同一用户连续消息，可配监听时长、最大合并条数、参与类型（normal/at/reply/command） |
| astrbot_plugin_api_limiter | 小红蛋 | https://github.com/xiaohondan/astrbot_plugin_api_limiter | 3 | 2026-08-04 | 调用间隔/次数+冷却/安静时段切断/分时段限频/群独立配额 |
| astrbot_plugin_chat_buffer | ctrlkk | https://github.com/ctrlkk/astrbot_plugin_chat_buffer | 1 | 2025-10-10（基本停更） | 消息防抖，指定时间内多段消息合并 |

## R11 会话生命周期管理（"开始游戏"→会话开始，"游戏结束/中断"→终止）

**【自写】**（框架原语齐备，工作量约 100~200 行）

- 框架自带"会话控制"，文档明确写「AstrBot 提供了开箱即用的会话控制功能」（https://docs.astrbot.app/dev/star/guides/session-control.html ），示例就是成语接龙：
  - `from astrbot.core.utils.session_waiter import session_waiter, SessionController`
  - `@session_waiter(timeout=60, record_history_chains=False)` 装饰一个 waiter 函数，`await waiter(event)` 挂上后，该发送人之后的消息**优先进入这个 waiter**；
  - `controller.keep(timeout, reset_timeout)` 续期、`controller.stop()` 立即结束会话、`controller.get_history_chains()` 取历史消息链；
  - 可用 `SessionFilter` 自定义会话 ID 算子（把整群当一个会话，适合群游戏/组队）；超时抛 `TimeoutError`。
- 其他可用原语：`/reset`（清上下文）、`/new`（新对话）、`/stop`（停止当前会话正在跑的 Agent 任务）、`SessionServiceManager.is_session_enabled(umo)` 按 UMO 整体启停会话（`session_status_check/stage.py`）、`FunctionTool` 函数调用（https://docs.astrbot.app/use/function-calling.html ）、`PluginKVStoreMixin` 的 `get_kv_data/put_kv_data/delete_kv_data` 持久化状态。
- 为什么仍判【自写】：市场里没有"通用会话/游戏状态机"插件；现有的是具体游戏插件（如 astrbot_plugin_TRPGdice、astrbot_plugin_werewolf、astrbot_plugin_xiuxian 等）。你的需求（识别"开始游戏/游戏结束"关键词 + 状态机）用上面原语自己写最干净：挂 waiter + 结束时 `controller.stop()`，跨重启状态自己存 KV/SQLite。

## R12 自我扩展（自己发现缺能力 → 搜插件 → 下载安装 → 运行）

**【自写】**（各环节都有现成件，但没有现成的"LLM 自主闭环"）

框架层已给出运行时管理接口：
- 内部实现：`astrbot/core/star/star_manager.py` 有 `install_plugin(repo_url, proxy, ignore_version_check, download_url)` / `uninstall_plugin` / `update_plugin` / `turn_on_plugin` / `turn_off_plugin` / `reload` / `install_plugin_from_file`。**但**插件面向的 `Context`（`astrbot/core/star/context.py`，由 `astrbot/api/star` 导出）**没有**暴露 star_manager（只有一行兼容占位 `_star_manager = None`），插件不能干净地直接调用。
- 官方对外入口是 HTTP API（v4.18.0+，WebUI「设置→OpenAPI」建 API Key，scope 含 `plugin`）：
  - `GET /api/v1/plugins/market`（市场列表）
  - `POST /api/v1/plugins/install/github`（另有 `/install/git`、`/install/url`、`/install/upload`）
  - `PATCH /api/v1/plugins/enabled`、`PATCH /api/v1/plugins/{plugin_id}/enabled`
  - `POST /api/v1/plugins/{plugin_id}/reload`、`POST /api/v1/plugins/{plugin_id}/update`、`DELETE /api/v1/plugins/{plugin_id}`
  - 文档 https://docs.astrbot.app/dev/openapi.html 、接口/scope 对照 https://docs.astrbot.app/dev/openapi-scopes.html （`plugin` 是开放给 API Key 的 11 个顶级 scope 之一）

现成插件（覆盖"搜"和"装"两个动作，均已核对仓库）：

| 插件名 | 作者 | GitHub | star | 最后 push | 能力 |
|---|---|---|---|---|---|
| astrbot_plugin_market | 长安某 | https://github.com/zgojin/astrbot_plugin_market | 9 | 2025-11-27（约 10 个月未更新） | `/插件市场` `/插件搜索` `/插件排行` `/插件安装 <编号/名称/GitHub链接>` `/插件卸载`，走官方市场数据 |
| astrbot_plugin_update_manager | bushikq | https://github.com/zhewang448/astrbot_plugin_update_manager | 7 | 2026-09-22 | `安装插件 <链接>` 明确「调用 AstrBot 原生接口安装并加载插件」；另有批量更新、框架更新、更新后自动重启 |
| astrbot_plugin_manager | 小红蛋 | https://github.com/NekoAiDev/astrbot_plugin_manager | 1 | 2026-07-04 | `/plugin list|info|enable|disable|reload|install|uninstall|update`；默认 `allow_install=false` |
| astrbot_plugin_auto_reload | hypxtmc | https://github.com/hypxtmc/astrbot_plugin_auto_reload | 0 | 2026-09-26 | **唯一把管理能力做成 LLM 工具**的：`hot_reload_plugin`、`plugin_list`（但它的 install 仍只是聊天指令，不是 LLM 工具） |
| astrbot_plugin_llm_executor | 珈百璃 | https://github.com/TenmaGabriel0721/astrbot_plugin_llm_executor | 9 | 2026-07-29 | 给 LLM `execute_command` / `list_executable_commands` 工具，可让 LLM 去执行上面那些管理员指令（含"以 Bot 管理员身份执行"开关） |

结论：把"发现缺能力 → 搜 → 装 → 跑"做成 **LLM 一次决策链**，没有单一现成插件；用 `astrbot_plugin_market`（或 update_manager）的指令 + `astrbot_plugin_llm_executor` 的 `execute_command` 可拼出来，但**这条组合我未做端到端实测（未验证）**，且风险高（安装会执行 pip install，且管理员指令默认不该自动执行）。更稳的做法是自写约 100 行工具插件，内部调上面的 OpenAPI（`/api/v1/plugins/market` + `/api/v1/plugins/install/github`）。装完是否能"跑"：普通插件走热加载即可生效；平台适配器类插件和改了 `astrbot/core/**` 的场景通常仍需重启（`astrbot_plugin_auto_reload` 的 README 明确列了必须重启清单）。

## R13 权限系统（可授权指定用户，该用户通过命令完成全部设置）

**【内置】**（"全部设置"要打折扣）

- 管理员名单：配置项 `admins_id`（列表），可用 `/op`、`/deop` 指令动态增删（官方扩展插件提供）。文档 https://docs.astrbot.app/use/command.html 、https://docs.astrbot.app/dev/astrbot-config.html
- 管理员豁免：`platform_settings.wl_ignore_admin_on_group` / `wl_ignore_admin_on_friend`（默认 true，管理员消息无视 ID 白名单）。
- 指令级权限：WebUI「插件 → 管理行为 → 指令」可对每条指令设「所有人 / 仅管理员 / 仅群聊限管理员 / 跟随对话隔离」，对所有配置文件生效（还有"显示系统插件指令"开关）。https://docs.astrbot.app/use/webui.html
- 通过命令做设置：需安装官方 **builtin_commands_extension**（AstrBotDevs，12★，2026-09-12）：`/plugin`（插件管理）、`/provider`、`/model`、`/persona`、`/llm`、`/ls`、`/switch`、`/rename`、`/del`、`/new`、`/reset`、`/set`、`/unset`、`/history`；核心内置的还有 `/sid`、`/stop`、`/help`、`/dashboard_update`。
- **注意**：并非"全部设置"都能用命令完成。平台适配器配置、知识库、MCP、Skills、T2I 模板、系统级配置、插件参数细节等只有 WebUI（或 OpenAPI）能做，聊天指令覆盖的是模型/人格/插件/会话/管理员这一层。要真正"全部设置"，得配合 OpenAPI（11 个 scope 覆盖 bots/provider/persona/config/chat/conversation/file/plugin/mcp/skill 等）。

---

## Q1 AstrBot 处理 QQ 群消息时，被引用消息的图片能否取到？

**能，且是框架一等公民。** 两条路径：

1. **事件字段**：`event.message_obj.message` 是消息链，被引用消息是链里的 `Reply` 组件，`Reply.chain` 里带着被引用消息的消息段（含 `Image` 等）。框架在 `preprocess_stage/stage.py` 里会主动遍历 `Reply.chain`，对 `Image` 做归一化/本地化，对 `Record` 做 STT（并在文本里标 `(referenced message)`）。所以插件只要读 `event.message_obj.message` 里的 `Reply`，就能拿到内嵌文本与图片段。
2. **官方 API**（推荐，能处理"内嵌不全"的情况）：
   - `from astrbot.core.utils.quoted_message import extract_quoted_message_text, extract_quoted_message_images`
   - `text = await extract_quoted_message_text(event)`；`images = await extract_quoted_message_images(event)` → 返回可直接给模型的图片 URL/路径列表。
   - 内部：按 `Reply.id` 调 OneBot `get_msg` 拉原消息，合并转发用 `get_forward_msg` 递归（默认最多 32 次抓取 / 6 层嵌套）；图片再依次尝试 `get_image`、`get_file`、`get_group_file_url`、`get_private_file_url`（并对 `file`/`file_id`/`id`/`image` 参数名做兼容）。
3. 主 Agent 请求阶段还会把引用图片按 `prepare_request_images(..., max_quoted_fallback_images=20)` 纳入模型输入，并在文本说明中标注来源是引用消息（https://docs.astrbot.app/providers/image-formats.html ）。

前置条件：协议端（NapCat / Lagrange / LLOneBot 等 OneBot v11 实现）需支持上述 action；不支持时框架会打 warning 并放弃该图。上限与开关见 `astrbot/core/utils/quoted_message/settings.py`（`max_component_chain_depth` / `max_forward_node_depth` / `max_forward_fetch` / `warn_on_action_failure`）。

## Q2 AstrBot 的插件能否在运行时被机器人自己安装启用？

**能，但走 HTTP API，不是插件内部直调。**

- 内部确实有 `StarManager.install_plugin / uninstall_plugin / update_plugin / turn_on_plugin / turn_off_plugin / reload`（`astrbot/core/star/star_manager.py`），但插件可见的 `Context`（`astrbot/api/star` → `astrbot/core/star/context.py`）**没有暴露** star_manager（只有 `_star_manager = None` 兼容占位）。所以插件想直接调就得 hack 内部，不稳定。
- 官方给的运行时管理入口是 **AstrBot HTTP API**（v4.18.0+，WebUI 设置→OpenAPI 建 API Key，scope `plugin`）：
  - `GET /api/v1/plugins/market`
  - `POST /api/v1/plugins/install/github`（另有 `/install/git`、`/install/url`、`/install/upload`）
  - `PATCH /api/v1/plugins/enabled` / `PATCH /api/v1/plugins/{plugin_id}/enabled`
  - `POST /api/v1/plugins/{plugin_id}/reload`、`POST /api/v1/plugins/{plugin_id}/update`、`DELETE /api/v1/plugins/{plugin_id}`
  - 文档 https://docs.astrbot.app/dev/openapi.html ，接口/scope 对照 https://docs.astrbot.app/dev/openapi-scopes.html
- 直接叫这些名字的现成插件（都已核对仓库）：
  - **astrbot_plugin_market**（长安某）— 指令版插件市场：搜索/排行/安装/卸载/本地管理
  - **astrbot_plugin_update_manager**（bushikq）— `安装插件 <链接>` 调原生接口安装并加载；还能批量更新插件与框架、更新后自动重启
  - **astrbot_plugin_manager**（小红蛋）— `/plugin install|uninstall|enable|disable|reload|update`，默认关闭安装/卸载
  - **astrbot_plugin_auto_reload**（hypxtmc）— 唯一提供 LLM 工具 `hot_reload_plugin` / `plugin_list` 的（安装仍为聊天指令）
  - **astrbot_plugin_llm_executor**（珈百璃）— 给 LLM `execute_command` 工具，让它去执行上面这些管理员指令
- WebUI 侧的插件市场（`插件 → 插件市场`）与"安装插件 (+)"按钮（URL/文件上传）也走同一套后端（`astrbot/dashboard/api/plugins.py`，含 `dashboard_install_plugin`、`install_plugin_from_repository`、`install_plugin_from_url`、`set_plugin_enabled` 等路由）。
- "装完就跑"：市场安装后会加载；但平台适配器类插件、改了 `astrbot/core/**`、全局配置结构变更、数据库 schema 迁移等场景仍需重启。

---

## 实际访问过的关键 URL

**官方文档（渲染页）**
- https://docs.astrbot.app/ （HTTP 200）
- https://docs.astrbot.app/sitemap.xml （取全站页面清单）
- https://docs.astrbot.app/use/command.html （无头浏览器打开，标题「内置指令 | AstrBot」）

**官方文档（读的是仓库内 docs/zh/*.md 源文件，等价于下列文档页）**
- https://docs.astrbot.app/providers/llm.html 、https://docs.astrbot.app/providers/start.html 、https://docs.astrbot.app/providers/image-formats.html
- https://docs.astrbot.app/use/proactive-agent.html 、https://docs.astrbot.app/use/function-calling.html 、https://docs.astrbot.app/use/context-compress.html 、https://docs.astrbot.app/use/knowledge-base.html 、https://docs.astrbot.app/use/plugin.html 、https://docs.astrbot.app/use/webui.html 、https://docs.astrbot.app/use/skills.html 、https://docs.astrbot.app/use/subagent.html
- https://docs.astrbot.app/dev/astrbot-config.html 、https://docs.astrbot.app/dev/openapi.html 、https://docs.astrbot.app/dev/openapi-scopes.html
- https://docs.astrbot.app/dev/star/guides/session-control.html 、https://docs.astrbot.app/dev/star/guides/listen-message-event.html 、https://docs.astrbot.app/dev/star/guides/ai.md 对应页、send-message、storage、other、https://docs.astrbot.app/dev/star/plugin.html
- https://docs.astrbot.app/platform/aiocqhttp.html 、https://docs.astrbot.app/what-is-astrbot.html

**插件市场**
- https://api.soulter.top/astrbot/plugins （Invoke-RestMethod 抓取，2306 条记录，已落盘为 TSV 索引后过滤）
- https://plugins.astrbot.app/ （无头浏览器打开，HTTP 200，标题「AstrBot Plugins」。注意：该站是 SPA，直接读 https://api.soulter.top/astrbot/plugins ，在我的无头环境里被 CORS 拦截，console 报 `Access to XMLHttpRequest ... blocked by CORS policy`，所以数据一律用 API 直连核对）

**AstrBot 源码（GitHub raw / API）**
- https://api.github.com/repos/AstrBotDevs/AstrBot/git/trees/master?recursive=1
- https://raw.githubusercontent.com/AstrBotDevs/AstrBot/master/astrbot/core/utils/quoted_message/{__init__,extractor,image_resolver,image_refs,onebot_client,settings,chain_parser}.py
- …/astrbot/core/utils/quoted_message_parser.py 、…/astrbot/core/utils/image_input.py
- …/astrbot/core/pipeline/stage_order.py 、rate_limit_check/stage.py 、waking_check/stage.py 、session_status_check/stage.py 、preprocess_stage/stage.py 、process_stage/stage.py 、process_stage/follow_up.py 、process_stage/method/agent_request.py 、process_stage/method/agent_sub_stages/internal.py
- …/astrbot/core/star/star_manager.py 、…/astrbot/core/star/context.py 、…/astrbot/core/star/session_llm_manager.py 、…/astrbot/core/persona_mgr.py 、…/astrbot/core/platform/astr_message_event.py 、…/astrbot/core/platform/sources/aiocqhttp/aiocqhttp_message_event.py 、…/astrbot/core/message/components.py
- …/astrbot/dashboard/api/plugins.py 、…/astrbot/dashboard/services/plugin_service.py 、…/astrbot/dashboard/api/open_api.py 、…/astrbot/api/star/__init__.py
- https://api.github.com/repos/<owner>/<repo>（逐个查 star / pushed_at / archived，共 21 个插件仓库）

**插件 README（GitHub raw）**
- NekoAiDev/astrbot_plugin_manager、zgojin/astrbot_plugin_market、hypxtmc/astrbot_plugin_auto_reload、zhewang448/astrbot_plugin_update_manager、FionaFaust/astrbot_plugin_plugin_manager
- FloranceYeh/astrbot_plugin_image_caption_cache、TenmaGabriel0721/astrbot_plugin_llm_executor、anka-afk/astrbot_plugin_meme_manager、nagatoquin33/astrbot_plugin_stealer
- lxfight-s-Astrbot-Plugins/astrbot_plugin_livingmemory、nuomicici/astrbot_plugin_Favour_Ultra、akiby17/astrbot_plugin_force_image_caption
- advent259141/astrbot_plugin_debounce、advent259141/Astrbot_plugin_Heartflow、Zhalslar/astrbot_plugin_wakepro、AstrBotDevs/builtin_commands_extension、Railgun19457/astrbot_plugin_persona_plus

**未获取到的来源（说明）**：AstrBot 仓库 issue/discussion 未逐个检索（GitHub 代码/Issue 搜索需要登录鉴权，本环境无 token）；但相关能力的结论均以官方文档 + 主干源码 + 单测文件（`tests/test_quoted_message_parser.py`、`tests/unit/test_aiocqhttp_reply.py`）为依据验证，不依赖 issue 转述。
