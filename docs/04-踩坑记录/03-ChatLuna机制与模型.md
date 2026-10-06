# 踩坑记录 · ChatLuna 机制与模型

> 属于 [踩坑记录（重来一次会浪费几小时的东西）](../04-踩坑记录.md) 的一份。
> **按类型切分**（2026-10-07）：预设名 / 模型名三段式 / 会话级模型 / 中间件与触发条件 / 上下文 / 模型兜底队列。坑号未变；本文件覆盖坑 15、16、18、19、20、21、22、28、47、79、80。

### 坑 15（很坑）：ChatLuna 的**预设名是 `keywords[0]`，不是文件名**

`koishi-plugin-chatluna/lib/preset.cjs` 的 `_updateSchema()`：

```js
this.ctx.schema.set("preset", Schema.union(
  this._presets.value.map(preset => Schema.const(preset.triggerKeyword[0]))   // ← keywords[0]
))
```

而 `loadYamlPreset()` 返回的对象里**根本没有 `name` 字段**（只有 `triggerKeyword`/`rawText`/`messages`/...）。

→ 预设文件叫 `default-persona.yml`、`keywords: [default-persona, 星源, 大肥鱼]` 时，
**`defaultPreset` 要填 `default-persona`（= keywords[0]），填文件名 `default-persona.yml` 或旧名 `星源` 都可能踩到**：

> 2026-10-02 更新：预设已改功能化命名（文件 `default-persona.yml`、id `default-persona`）。
> `getPreset()` 用的是 `triggerKeyword.includes(k)`，**keywords 里任意一个都能命中解析**，
> 所以旧会话里存的 `preset=星源` 仍然能跑；但 schema 枚举/显示名只看 `keywords[0]`，
> 配置面板与 `defaultPreset` 都必须写 `default-persona`。文件名依旧完全无关。

```
当前会话对应的预设 xingyuan 不可用，请联系管理员配置预设。
```

注意 `loadPreset` 对这个错误是**静默**的（只在真正解析失败时才 `logger.error`），
所以「文件明明在那儿却说不存在」时，先怀疑名字而不是文件。

### 坑 16：ChatLuna 的模型名是**三段式**，且模型列表是**懒加载**的

1. **名字格式**：`koishi-plugin-chatluna/lib/llm-core/platform/service.cjs:227`

   ```js
   toModelName: () => platform + "/" + model.name
   ```

   `platform` = 适配器构造时的 `"deepseek"`；`model.name` = 端点原始 id（`deepseek/deepseek-v4.1-flash`）。
   → 完整名 = **`deepseek/deepseek/deepseek-v4.1-flash`**（是的，两个 `deepseek/`）。

2. **模型列表是懒加载的**，不是启动时拉：

   ```js
   async getModels(config) {                    // client.cjs:107
     let models = Object.values(this._modelInfos);
     if (models.length > 0) return models;      // 有缓存就直接返回
     try { models = await this.refreshModels(config); ... }
     catch (e) { err.message = `获取模型列表失败 (${this.platform}): ${reason}`; this.ctx.logger.error(err); throw err }
   }
   ```

   → **控制台 `/plugins/` 里 `defaultModel` 显示「无」是正常的**（还没人聊过天，没触发过拉取）。
   失败一定会打 `获取模型列表失败`，日志里没有这条**就说明压根没调用过**，别去怀疑网络。
   → 但 `defaultModel` 还是应该**显式填上**，否则会看到 `Model "" does not support image input`。

### 坑 18（很坑）：ChatLuna 把模型**存在会话行里**，改 `defaultModel` 不会影响已有会话

`chatluna_conversation` 表有独立的 `model` 列。`defaultModel` 只在**新建会话**时被采用。
所以会出现"配置明明改了，日志还在警告 `Model "xxx" does not support image input`"——
因为老会话仍然钉着老模型。

**两个解法（建议两个都做）：**
1. `chatluna.autoUpdateConversationModel: true`
   （源码：`lib/index.cjs:4815`，还要 `resolved.constraint.autoUpdateModel === true`；
   `autoUpdateModel` 在 `services/chat.cjs:1701` 默认是 `true`，被 `chatluna.use.model` 显式钉住时才为 `false`）
2. 直接改库 / 让用户 `/chatluna.new`：
   ```sql
   UPDATE chatluna_conversation SET model = '<三段式新模型>' WHERE model <> '<三段式新模型>';
   ```

### 坑 19：`prefixMode: strict` —— 不设的话**私聊里不打斜杠也能触发指令**

`@koishijs/core` 的 `Commander`（`lib/index.cjs:1446`）：

```js
const isStrict = this.config.prefixMode === "strict" || (!isDirect && !stripped.appel)
if (argv.root && stripped.prefix === null && isStrict) return
```

- 默认 `prefixMode` 是 `auto` → **群聊**里没前缀、也没 @bot 时不会当指令；但**私聊**里不设防，
  `help` 直接就能触发。
- 设成 `strict` 后，**私聊也必须带 `/` 或 `.`**。群聊里 @bot 但没打斜杠同样不触发指令。
- 位置：**`koishi.yml` 顶层**（跟 `prefix` 同级），不是插件配置。
- 注意它**不拦** ChatLuna 的聊天触发——那走的是 `allow_reply` 里的 `atSelf`/`botNames` 逻辑，两套体系。

### 坑 20：ChatLuna 的 `allow_reply` 是**整条链的第一个中间件**

`lib/index.cjs:2902`，`.before("lifecycle-check")`。它返回 STOP 时，
`read_chat_message` 和 `transform_chat_message` **根本不会跑**。

推论（做图片策略时必须知道）：群里**没 @bot 的消息压根不会进 `messageTransformer`**，
所以"群聊里 AI 不知道有图"这个需求在默认配置下是**天然的**，不依赖我们的插件。
真正需要插件介入的是：**@了 bot 的消息**（`allowAtReply` 默认 `true`）、
**以 botNames 开头的消息**（`isNickname` 默认 `true`）、
**以预设 keywords 开头的消息**（`enablePresetKeywordTrigger` 默认 `true`，见坑 15 的 preset keyword 机制）、
以及 `randomReplyFrequency > 0` 时的随机插话（**默认 0**）。

### 坑 21：ChatLuna **已经内建**消息聚合/延迟，别自己写

`lib/index.cjs:3267-3520`（`message_delay.ts`），配置项两个：

| 字段 | 默认 | 说明 |
|---|---|---|
| `messageQueue` | `true` | 总开关 |
| `messageQueueDelay` | `0` | **单位是秒**（源码 `config.messageQueueDelay * 1e3` 喂给 setTimeout）。范围 0–1800 |

行为：
- 第一条消息进来 → 建一个 turn，state = `collecting`，**起一个 `messageQueueDelay` 秒的定时器**
- 同一个用户在定时器没到之前又发消息 → **并进同一个 turn**，并把定时器**顺延**（真正的 debounce）
- 定时器到点 → `mergeMessages()` 把这段时间的消息按时间排序、用换行拼成**一条**输入，再送给模型
- 换人说话会开新 turn（`tailTurn.userName === userName` 才合并）

**所以"延迟收集同一用户的连续消息再一次回复"是配置问题，不是开发问题。** 设 `messageQueueDelay: 3` 即可。

⚠️ 注意它挂的位置是 `.after("transform_chat_message")`，所以**图片解析发生在 3 秒收集窗口之前**，
总延迟 ≈ 图片解析时间 + messageQueueDelay + 模型时间。

### 坑 22：`prefixMode: strict` 之后，私聊里打裸指令名会掉进 Koishi 的"猜测指令"

`@koishijs/core` 的 `Commander` 里有一个 suggest 中间件（`lib/index.cjs:1294-1316`）：

```js
if (argv?.command || !isDirect && !prefix && !appel) return next()
```

**私聊**这一支不设防：没前缀也会去猜。实测（2026-09-29 15:02）：私聊发 `help` →
bot 回「您要找的是不是"help"？回复句号以使用推测的指令。」，回复 `.` 之后才真的执行 `/help`。

也就是说：私聊里恰好撞上指令名（`help` / `echo` / `emotion` / `vision` / `chatluna` / `plugin` / `followup`）
且相似度够高的消息，会**先被指令系统截走**，模型要等 suggest 超时才拿到这条消息。
中文群聊里基本撞不上，暂时不动它；哪天觉得烦，优先考虑把 `help` 插件关掉。

### 坑 28：群聊里**不 @ bot，连对话轮次都不会产生** —— 长期记忆自然也不会抽

rig 32 前两轮白跑，就是因为剧本里三条喂料消息是**裸文本**：

| 观测 | 结论 |
| --- | --- |
| 日志里能收到 `onebot [receive] … message_id: 100003` | 事件到 Koishi 了 |
| 但**没有** `chatluna Creating new turn for …` | ChatLuna 没开轮次 |
| `chatluna_docstore` 始终 0 行 | 记忆抽取挂在"对话轮次"上，没轮次就没抽取 |

ChatLuna 默认 `allowAtReply: true`：群里只有被 @ / 被叫名字才回。所以
**"bot 没理我"和"bot 没记住"是同一件事的两面**，写剧本喂料时必须带上 `["at", "2178517838"]`。
（rig 31 那次碰巧被 R9 主动插话触发了，属于运气，别拿来当基准。）

### 坑 47（★ 报错信息会把你带偏）：`createChatModel` 是 async，而且返回的是**响应式 ref**

`ctx.chatluna.createChatModel(name)`（`services/chat.cjs:5105`）：

1. 它是 **async** 的；
2. 它返回的**不是模型**，而是一个 `computed(...)` ref —— 真模型在 **`.value`** 上。

拿错的报错长得像"模型名写错了"，其实不是：

```
[W] chatluna-episode 滚动总结失败：model.invoke is not a function
```

**正确写法**（照抄 [vision 插件](../../koishi-app/external/koishi-plugin-chatluna-vision/lib/index.js) 的 `describeWith`）：

```js
const ref = await ctx.chatluna.createChatModel(modelName)
const model = ref?.value
if (!model || typeof model.invoke !== 'function') throw new Error(`拿不到模型 ${modelName}`)
const res = await model.invoke(prompt, { timeout: 60000 })
```

**教训**：看到 `xxx is not a function` 先确认"我拿到的是不是我以为的那个对象"，而不是先去改参数。
同一个 API 在别的插件里有正确用法时，**去抄那一行**。

---

### 坑 79（R20 静默第一号）：配置里的模型组名**带平台前缀**，队列注册表里的组名**不带**

**症状**：`/stages` 能列出每个阶段"配置里写的是谁"，但"**实际在用**"那一列**整整齐齐全是空的**
（只打印组内顺序），而且**一条日志、一个异常都没有**。

**根因**：两边的命名空间不一样 ——
- `koishi.yml` 里写的是 `cc/q.vision`（`<platform>/<组名>`，ChatLuna 对用户展示的**模型全名**）；
- 而 `chatluna-multi-adapter` 的注册表按**裸组名**建索引：`plan()` 收到的是 ChatLuna 传下来的
  `params.model`，那是 `q.vision`（日志实证：`route ok: q.vision -> …`，没有 `cc/` 前缀）。

于是 `registry.hasGroup('cc/q.vision')` 恒假 → 拿不到候选 → 静默降级成"只显示配置值"。

**修法**：三种写法都试一遍（原样 / 去掉前缀 / 加上本注册表的前缀），命中哪个用哪个。

**教训**：**跨插件的"名字"必须双边核对**，尤其是"看着一样、其实多一层前缀"这种 ——
它不会报错，只会让功能**静默失效**。写显示类功能时，先打一行 debug 证明自己真的读到了数据。

---

### 坑 80（判据假失败）：Koishi 会把一条长文本**拆成多个 text 元素**，只取第一个就会"看不见"

**症状**：rig 66 判据 C 全灭 —— `/stages.set` 的清单在群里**明明发出来了**，check 脚本却找不到。

**根因**：出站日志里那条消息是

```
message: [ { type: 'text', data: { text: '【按阶段换模型】用法：`/stages.set ' } },
           { type: 'text', data: { text: ' [序号|模型名]`\n' + … } } ]
```

—— **被切成了两个 text 元素**（切口正好在代码段 `` ` `` 那里）。
而 check 脚本（抄自上一轮）只解析**第一个** `data: { text: … }`，
于是拿到的永远只有前半句。上一轮之所以没暴露，是因为那些输出恰好没被切开。

**修法**：`textOf()` 改成扫**整行所有** `data: { text: … }` 并按顺序拼接。

**教训**：判据脚本解析的是**别人（Koishi/适配器）的日志格式** ——
格式一变、切法一改，判据就会"假失败"（或更糟：**假通过**）。
看到"群里明明有、脚本说没有"时，先怀疑解析器，别急着改业务代码。

---

[← 回 踩坑记录 索引](../04-踩坑记录.md)
