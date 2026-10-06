# 阶段 2 计划与 ChatLuna 生态实测

> 属于 [QQ 机器人项目 —— 进度与交接](../进度与交接.md) 的分册。
> 旧编号（如「第八·十三节」）的去向见索引页的章节对照表。

阶段 2 的推进顺序（原「一次只加一样」）。**第二部分的生态、镜像、API 中转实测结论仍然有效**，装任何 ChatLuna 插件前先看它。

## 一、阶段 2 推进顺序（一次只加一样）

1. ~~`@koishijs/plugin-database-sqlite`~~ ✅ **已完成并验证**
2. **ChatLuna 接入** ✅ **已完成并实测跑通对话**。
   已装五个包（`storage-service` 是 chatluna 的 peer 依赖，缺一不可）：
   ```
   koishi-plugin-chatluna 1.4.0
   koishi-plugin-chatluna-deepseek-adapter 1.4.1
   koishi-plugin-chatluna-storage-service 1.0.7
   koishi-plugin-chatluna-long-memory 1.4.0      ← R3 长期记忆（npm 装，非自写）
   koishi-plugin-chatluna-vector-store-service 1.4.0 ← R17 向量库 provider（luna-vdb/faiss/redis/milvus）
   @huggingface/transformers 3.8.1               ← R17 本地嵌入的运行时（transformers.js + ONNX）
   koishi-plugin-chatluna-local-embeddings 0.1.0 ← 自写，R17 本地嵌入模型（在 external/）
   koishi-plugin-chatluna-emotion 0.1.0        ← 自写，R14/R18（在 external/）
   koishi-plugin-chatluna-vision 0.1.0         ← 自写，R6/R7/R8（在 external/）
   koishi-plugin-chatluna-followup 0.1.0       ← 自写，群聊跟进（在 external/）
   koishi-plugin-qqbot-auth 0.1.0              ← 自写，R13（在 external/）
   ```
   API Key 已填（commandcode 中转，见本文件第二部分的「⚠️ API 用的是第三方中转」）。
   预设铺在 `data/chathub/presets/`，**本项目的人格预设是 `default-persona.yml`，标识名（= `keywords[0]`）是 `default-persona`**；
   「星源」「大肥鱼」保留在同一份 keywords 里当触发词（2026-10-02 起改成功能化命名，见 [模型兜底与群聊上下文](22-模型兜底队列与群聊上下文.md)）。
3. **⭐ 眼下该做的第一件事：验证群聊路径**
   图片策略目前**只实测过私聊**（[R6/R7/R8 图片策略](09-图片策略与表情包.md)有完整证据）。要验证：
   - 群里 @bot + 图 → 会等解析完再回
   - 群里 @bot + **引用一条带图的消息** → 引用里的图也会被解析
   - 群里不 @bot 只发图 → bot 完全没反应
   - 同一张图发第二次 → 走缓存，不再烧视觉调用
4. 然后逐个叠（按 R 编号）：
   - R3 记忆：~~`chatluna-long-memory`~~ ✅ **已完成并端到端验收**（见[R3 长期记忆](12-R3长期记忆与向量库.md)）
   - R5/R7 表情包：~~`chatluna-sticker` + `emojiluna`~~ ✅ **`chatluna-sticker` 已完成并端到端验收**
     （`emojiluna` 装了但没启用，原因见[R5/R7 表情包](09-图片策略与表情包.md)）
   - R4 好感度：~~`chatluna-affinity`~~ ✅ **已完成并端到端验收**，并且**已经喂给 2 级「信任」**
     （好感度 ≥51 自动给 2 级、≤40 自动降回，见[R4 好感度](13-R4好感度.md)）
   - R6 图片理解：~~`chatluna-multimodal-service`~~ **已用自写插件解决**（它只能当"换模型的退路"）
   - R9/R11/R12：
     - R9 择机插话：~~`chatluna-proactive-trigger`~~ ✗ **跟 chatluna 1.4.0 不兼容**（room API 被删），
       改为**自写 `chatluna-proactive`** ✅ 已端到端验收（见[R9 择机插话](14-R9插话与R11会话生命周期.md)）
     - R11 会话生命周期：**自写 `chatluna-scene`** ✅（见[R11 会话生命周期](14-R9插话与R11会话生命周期.md)）
     - R12 自我扩展：**自写 `chatluna-selfext`** ✅（模型只搜/申请，安装必须主人点头，见[R12 自我扩展](15-R12自我扩展与R15屏蔽.md)）
   - ~~R14 情绪控制~~ ✅ **已自写并实测跑通**
5. **authority 分级 + 用户组下发**（R13）——机制已探明，见[R13 权限机制](07-R13权限分级.md)。
   `prefixMode: strict` 只是"必须打斜杠"，**权限分级本身还没做**。

### ChatLuna 在 sqlite 里建的表（180 KB 时）

```
chatluna_conversation / chatluna_message / chatluna_binding / chatluna_constraint
chatluna_archive / chatluna_acl / chatluna_meta / chatluna_docstore
chatluna_storage_temp        ← storage-service 的
cache                        ← ChatLuna 的 key-value 缓存
chathub_*（6 张）             ← 旧版迁移用，已 purge，留着无害
chatluna_emotion             ← 自写 R14 插件建的
chatluna_image_cache         ← 自写 R6/R7/R8 插件建的
chatluna_docstore            ← ★ R3 长期记忆的正文表（key = 记忆层 ID，metadata 存 type/importance/simhash）
sticker_occurrence           ← ★ R5/R7 表情包索引（pHash 主键 + count + status）
sticker_meta                 ← ★ R5/R7 已收藏表情的元数据（tags/description/usageHint/useCount）
chatluna_affinity_v2         ← ★ R4 好感度（scopeId+userId 主键，affinity/长期/短期/chatCount/关系）
chatluna_user_alias_v2       ← R4 自定义昵称
chatluna_blacklist_v2        ← R4 插件自带黑名单（**本项目没用**，R13 自己有名单）
```

**要加自己的表，就加在这一批旁边。**

---
## 二、ChatLuna 生态实测结果（2026-09-28）

### ⚠️ API 用的是第三方中转，不是官方 DeepSeek

`D:\deepseek\QQbot\key.txt` 里给的是 **commandcode 中转**，不是 `api.deepseek.com`：

| 项 | 值 |
|---|---|
| Key | `key.txt` 第 1 行（`user_` 前缀，93 字符） |
| API 地址 | `https://api.commandcode.ai/provider/v1` |
| 当前模型 | `deepseek/deepseek-v4.1-flash` |

**实测可用**：`POST /chat/completions` 返回 200、约 2.3 秒、带 `reasoning_tokens`（会思考）。

该端点 `/models` 共 **82 个模型**，其中 deepseek 系 5 个：

```
deepseek/deepseek-v4-pro              ctx=1e6  /chat/completions, /responses
deepseek/deepseek-v4-flash            ctx=1e6  /chat/completions, /responses
deepseek/deepseek-v4-flash-vision-exp ctx=1e6  /chat/completions, /responses   ← 视觉模型！
deepseek/deepseek-v4-flash-fast       ctx=1e6  /chat/completions
deepseek/deepseek-v4.1-flash          ctx=1e6  /chat/completions, /responses
```

**★ 对 R6（识别表情包图片内容）的意义**：`deepseek-v4-flash-vision-exp` 是视觉模型。
**2026-09-29 已实测**：拿用户发的真实表情包直接打 API，**两个模型都能看懂图**：

| 模型 | 实测结果 |
|---|---|
| `deepseek/deepseek-v4-flash-vision-exp` | HTTP 200，5.5 s，「蓝发蓝眼的Q版3D女仆装角色，头顶左侧气泡框里写着"鳔子"」 |
| `deepseek/deepseek-v4.1-flash` | HTTP 200，6.4 s，「头戴白色蕾丝女仆头饰……围裙上有鲸鱼图案，气泡中写着"鳔子"」 |

**所以中转侧 `v4.1-flash` 本身就能看图**，阻碍在 ChatLuna 这一侧——
`@chatluna/v1-shared-adapter/lib/index.cjs:208` 的 `imageModelMatchers` 白名单：

```js
var imageModelMatchers = [
  "vision", "vl", "gpt-4o", "claude", "gemini", "qwen-vl", "omni", ...
  // deepseek-flash and glm-5.3-flash support image input.
  "deepseek-flash", "glm-5.3-flash"
].map(createGlobMatcher);
```

- `deepseek/deepseek-v4.1-flash` → **不匹配任何一条**（注释里那个 `deepseek-flash` 是 glob，
  中间隔着 `v4.1-`，匹配不上）→ ChatLuna 拒绝传图，打
  `Model "..." does not support image input`
- `deepseek/deepseek-v4-flash-vision-exp` → 含 **`vision`**，**匹配** → 启用 `ImageInput` + `deepseekFileHandlingConfig`

**结论（2026-09-29 当时的结论）：`defaultModel` 用 `deepseek/deepseek/deepseek-v4-flash-vision-exp`**，
不用装 `chatluna-multimodal-service`，也不用改 node_modules。

> ⚠️ **2026-10-07 更正：这条结论已经过时 —— 主模型现在是 `deepseek/deepseek-v4.1-flash`。**
>
> **「DeepSeek 支不支持视觉」的定论（不用再"待确认"了）：**
> **v4 系列不支持图像输入；从 v4.1 起，flash 与 pro 都支持。**
> 上面那张对照表（`v4.1-flash` 6.4 s 正确读出画面）就是最直接的实测证据 ——
> 它证明的是**中转侧支持**；当时之所以还留着 vision-exp，卡的是 ChatLuna 的**模型名白名单**
> `imageModelMatchers`（`deepseek-v4.1-flash` 一条都不匹配）。
> 现在这层障碍由本项目适配器配置里**显式声明 `image_input`** 绕开，
> 详见 [模型选型 §1.2](21-模型选型与结构化渲染.md)。

> 若哪天觉得 vision-exp 的聊天质量不如 v4.1-flash，替代方案是装 `chatluna-multimodal-service`：
> 主模型保持 v4.1-flash，图片由多模态模型生成描述后注入。代价是多一次 API 调用 + 一个插件。

### 关于小号改名 / 换头像

- **换头像**：对 Koishi / ChatLuna 无任何功能影响。
- **改名**：★ **已经发生了**。2026-09-29 用户把小号改名成 **「大肥鱼」**（原来叫「星源」）。
  已同步的地方：
  1. `chatluna.botNames` → `[大肥鱼, 星源]`
     （群聊靠它匹配昵称触发对话；第一个是"真正的 bot 名"，其余只用来触发）
  2. 顶层 `nickname` → `[大肥鱼, 星源]`
     （★ 这是 Koishi **自己**的字段，`@koishijs/core` 的 `get stripped()` 用它算 `stripped.appel`；
      跟 `chatluna.botNames` 是**两套独立机制**，别只改一个）
  3. `defaultPreset` **不用动** —— 它是预设的 `keywords[0]`（见坑 15），跟 QQ 昵称无关
- 查当前昵称：连 NapCat 的 WS 发 `get_login_info`（见[常用命令速查](17-常用命令速查.md)），**别靠猜**。
  ChatLuna 自己的触发逻辑还受 `isNickname`（默认 true）、`enablePresetKeywordTrigger`（默认 true，
  以预设 keywords 开头的消息也会触发回复）影响，见坑 20。

`koishi-plugin-chatluna-deepseek-adapter` 正好是为 `deepseek-v4` 系列写的
（`refreshModels` 动态拉模型列表并过滤含 "deepseek" 的；有 `deepseek-v4-` 的 thinking 变体展开、
`supportImageInput(model)` 的图片处理配置），所以**这个中转和这个适配器是匹配的**。

> 🔐 **key.txt 里的凭据已经出现在本次对话记录里**（我脱敏用的正则是 `sk-` 开头，
> 而它是 `user_` 前缀，没匹配上）。如果这份记录可能外流，建议去 commandcode 后台**轮换这个 key**。

### ChatLuna 生态（原结论仍然成立）

**结论：交接文档原先那句「官方源可能搜不到 ChatLuna，需换源」是错的。**

在 `https://registry.koishi.chat/index.json`（total=4695）里，
`chatluna|luna` 关键词命中 **138 个包**，计划中要用的**全部在列**。

### 计划内的（确认存在）

`chatluna`、`chatluna-deepseek-adapter`、`chatluna-long-memory`、`chatluna-sticker`、
`emojiluna`、`chatluna-affinity`、`chatluna-multimodal-service`、`chatluna-agent`

### 文档当时没看到、但很有用的（同一次搜索发现）

| 需求 | 插件 | 说明 |
|---|---|---|
| **R9 择机插话** | `chatluna-proactive-trigger`、`proactive-chatluna` | 主动触发，直接对应 R9 |
| **R2 人格** | `chatluna-preset-market`、`chatluna-preset-editor`*、`chatluna-character-card` | 预设市场/编辑器/角色卡 |
| **R12 自我扩展** | `chatluna-mcp-client`、`chatluna-mcp-server` | 走 MCP 而不是装插件，安全性好得多 |
| R3 记忆增强 | `chatluna-vector-store-service`、`chatluna-embeddings-service`、`chatluna-memory`、`chatluna-livingmemory` | 向量检索 / 长期记忆 |
| R6 图片 | `chatluna-image-service`、`chatluna-image-resolver`、`chatluna-image-desc-bridge` | 图片描述桥接 |
| R9 场景控制 | `chatluna-scene-rules`、`chatluna-schedule` | 场景规则 / 定时 |
| 工具层 | `chatluna-toolbox`、`chatluna-actions`、`chatluna-command-tool` | 工具注册 |
| 调试 | `chatluna-message-viewer`、`chatluna-usage`、`chatluna-log-helper` | 消息查看 / token 用量 |
| 上下文控制 | `chatluna-self-attention`、`chatluna-regex-middleware`、`chatluna-forward-msg` | 注意力 / 正则改写 / 合并转发 |

\* `chatluna-preset-editor` 只在 Lipraty 镜像有（`https://koi.nyan.zone/registry/index.json`）。

### 镜像实测（2026-09-28）

| 镜像 | HTTP | 耗时 | total | 可用 |
|---|---|---|---|---|
| `registry.koishi.chat/index.json`（官方） | 200 | 1.2 s | 4695 | ✅ **当前在用** |
| `koi.nyan.zone/registry/index.json`（Lipraty，大陆） | 200 | 1.9 s | 4907 | ✅ 备选（包略多） |
| `koishi-registry.yumetsuki.moe/index.json`（Q78KG） | 200 | 2.2 s | 4695 | ✅ |
| `kp.itzdrli.cc`（itzdrli） | 200 | **37 s** | 4695 | ⚠️ 太慢 |
| `registry.koishi.t4wefan.pub/index.json`（t4wefan，大陆） | **502** | 0.6 s | — | ❌ 挂了 |

切换方式：改 `koishi.yml` 里 `market.search.endpoint`，重启。

---


[← 回索引页](../进度与交接.md)
