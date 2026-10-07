/**
 * koishi-plugin-chatluna-poke —— 戳一戳
 *
 * 需求（用户原话，2026-10-05）：「将戳一戳视为用户对 bot 的互动，需要对话模型做出反应」、
 * 「bot 什么也不发信息，但是能够回应对方的戳一戳（也戳戳他/她）」、「戳一戳相当于 @，
 * 不一定回复消息，但要有反应（以戳回去回复）」、「高频或者多人戳的时候按照合并窗口 +
 * 全局冷却处理」、「拦截命令也需要拦截这个，先过 guard 的判定函数」。
 *
 * ------------------------------------------------------------------ 为什么必须新开一个入口
 *
 * Koishi **只对 `message` 事件跑中间件**：`ctx.on('message', this._handleMessage)`
 * （`@koishijs/core/lib/index.cjs:679`），中间件队列只在 `_handleMessage` 里组装
 * （`:811-847`）。而适配器把戳会话标成了 `session.type = 'notice'`
 * （`koishi-plugin-adapter-onebot/lib/index.js:498-505`），
 * `@satorijs/core` 的事件别名表又只有三条（`src/bot.ts:12-16`），所以派发出去的是
 * `notice`，**永远不是 `message`**。
 *
 * 结论（用真实流量验证过，见 `koishi-app/tools/prod.log:326`：戳事件进了适配器，
 * 后面没有任何 chatluna 活动）：
 *   · `allow_reply`（`chatluna/lib/index.cjs:2902`）**根本不会被调用** —— 改它没用；
 *   · guard 的准入中间件（`chatluna-guard/lib/index.js:883`）同样进不去 ——
 *     也就是说戳事件现在是无声无息地掉在所有闸门**之前**的。所以本插件必须
 *     **自己**去问 guard 的对外服务（见下面「闸门」一节）。
 *
 * ------------------------------------------------------------------ 怎么做到"什么也不发，但戳回去"
 *
 * `chatChain.receiveCommand(session, '', options)` 支持 `invocation.delivery`：
 *
 *     // chatluna/lib/index.cjs:4530-4531, 4580-4585
 *     const shouldSend = delivery !== 'capture' && delivery !== 'silent'
 *     captureOnly = delivery === 'capture' || delivery === 'silent'
 *     await replyStream.end(captureOnly ? void 0 : { type: 'done', message: response })
 *
 * `silent` = 模型照常思考、照常调工具，但**产出的正文一个字都不发**。
 * `invocation.persist === false` 则连这一轮的记录都不落库（`:4572`）。
 *
 * 于是本插件这样拼：
 *   ① 反应是**代码保证**的：直接 `internal._request('group_poke'|'friend_poke')`，
 *      不赌模型会不会调工具（`group_poke`/`friend_poke`/`send_poke` 三个 action
 *      NapCat 都有：`NapCat.Shell/napcat.mjs:40362-40383`，payload 形状见 `:78268-78311`）。
 *   ② 同时起一轮 **silent + 不落库** 的模型调用，把「被戳了、文案是什么」告诉它。
 *      它想说话就说（正文按配置决定投不投递），但它**不负责**戳回去 —— 那件事代码已经做了。
 *   ③ 因此即使模型一个字都不吐，对方也一定收得到一个戳。这正是需求里那句
 *      "bot 什么也不发信息，但是能够回应对方的戳一戳"。
 *
 * ------------------------------------------------------------------ 关键字段语义（踩错就会误判）
 *
 *   `user_id`   = **戳的人**     `target_id` = **被戳的人**
 *
 * 所以群里必须判 `target_id === self_id` 才算"戳了 bot"；私聊里 `target_id` 固定是对方
 * （`napcat.mjs:71744-71756` 的 `parsePaiYiPai`：`new Oge(core, peerUid, o[0].uid, o[1].uid, items)`，
 * 两个 uid 解析成 user_id / target_id）。**不能用 `userId === selfId` 判"我被戳了"** ——
 * 适配器把 `session.userId` 设成了 `data.user_id`（`adapter-onebot/lib/index.js:441`），
 * 那个值永远是戳的人。
 *
 * 文案从哪来：群聊和私聊两条解析路径都把完整的灰条 JSON 原样带出来
 * （`parsePaiYiPai` 传 `items`，`parsePrivatePokeEvent` 传 `i`），适配器再用
 * `session.setInternal('onebot', data)` 把整包挂到会话上（`adapter-onebot/lib/index.js:411`
 * + `@satorijs/core/src/session.ts:122-127`），所以读 `session.internal.rawInfo` 就行。
 * 实测形状（`prod.log:326`）：
 *
 *     raw_info: [ {type:'qq'}, {type:'img'}, {type:'nor', txt:'戳了戳'}, {type:'qq'}, {type:'nor', txt:''} ]
 *
 * 取 `type === 'nor'` 且 txt 非空的项拼起来就是文案；用户自己改过就是用户那句。
 * ★ 默认的"戳了戳"是**平台固定文案**（`napcat.mjs:40362` 附近），不是用户编辑过的，判掉。
 *
 * ------------------------------------------------------------------ 闸门（先过 guard）
 *
 * guard 已经导出了给别的插件用的口子（`chatluna-guard/lib/index.js:1239-1272`）：
 *   · `isAllowed(session)` —— 语义反转的对外口子，**`null` 表示它自己还没 ready**
 *     （启动窗口），这时应当**静默丢弃**，别猜；
 *   · `bucket.peek(groupId)` —— **只查不扣**。注释里专门写了"不要在这里 take"，
 *     扣令牌只在 `before-send` 一处，两处都扣等于额度减半。
 *
 * 本插件在"决定反应"之前先 `isAllowed` + `bucket.peek`，被静音 / 没额度就只记日志、
 * 一个令牌都不动。
 *
 * ------------------------------------------------------------------ 限流（合并窗口 + 全局冷却）
 *
 *   · 单人冷却 `userCooldownSeconds`：同一个人 N 秒内只算一次（默认 30s）。
 *   · 群合并窗口 `mergeWindowSeconds`：窗口内多人戳，**合并成一件事**只跑一轮模型，
 *     但**每人各回戳一下**（默认 0 = 关，即各自立即处理）。
 *   · 全局冷却 `cooldownSeconds`：任意一次反应之后，整个会话静默 N 秒（默认 5s）。
 *
 * 合并窗口怎么实现：戳事件到达时**同步**把反应做掉（戳回去是 API 调用，极快），
 * 模型那一轮放进窗口末尾的统一批次里 —— 这样"反应"永远是即时的，
 * 被合并的只是"叫醒模型"这件事，不会让用户等。
 */

const { Schema, Logger, h } = require('koishi')

const name = 'chatluna-poke'
const inject = { required: ['http'], optional: ['chatluna', 'qqbotGuard'] }

const logger = new Logger('chatluna-poke')

/** PacketBackend 那条警告只打一次（它每个戳都会复现，刷屏没意义） */
let napcatHintLogged = false

/**
 * 环境级故障闩锁：一旦确认 PacketBackend 不可用（= 这个 QQ 构建根本发不出戳），
 * 后续就**不再尝试、也不再叫模型** —— 试也是白试，叫模型只是让它为一件做不到的事
 * 组织语言。自动恢复：`pokeBack` 成功一次就解锁（比如用户换完 QQ 版本、不用重启）。
 */
let packetBackendBroken = false

const Config = Schema.intersect([
  Schema.object({
    enabled: Schema.boolean().default(true).description('总开关。关掉后戳事件完全不处理（保持现在的"静默丢弃"行为）'),
    pokeBack: Schema.boolean().default(true).description('被戳必戳回去（代码保证，不依赖模型是否调工具）'),
    privateEnabled: Schema.boolean().default(true).description('私聊里的戳是否处理'),
    groupEnabled: Schema.boolean().default(true).description('群聊里的戳是否处理（只处理"戳的是 bot 自己"的那些）'),
  }),
  Schema.object({
    callModel: Schema.boolean().default(true).description('把这次戳作为一轮对话喂给模型（silent：模型想说话可说，但正文默认不投递）'),
    deliverPrivate: Schema.boolean().default(false).description('私聊里**投递模型正文**（默认关：只戳回去，不发消息）'),
    deliverGroup: Schema.boolean().default(false).description('群聊里**投递模型正文**（默认关：只戳回去，不发消息）'),
    persist: Schema.boolean().default(false).description('这一轮是否写进会话历史。默认关 = 不污染记忆（需求明确要求不要据此生成记忆）'),
    modelTimeoutSeconds: Schema.natural().min(5).max(180).default(60).description('单轮模型调用的兜底超时（秒）'),
  }),
  Schema.object({
    userCooldownSeconds: Schema.natural().min(0).max(3600).default(30).description('同一个人 N 秒内只戳回去一次（防连点；这一层管"戳回去"）'),
    cooldownSeconds: Schema.natural().min(0).max(3600).default(5).description('整个会话 N 秒内不叫模型（★ 只压模型那一轮，不压"戳回去"——被戳必须有反应）'),
    mergeWindowSeconds: Schema.natural().min(0).max(120).default(0).description('群聊合并窗口：窗口内多人戳合并成一轮模型调用（0 = 不合并）。戳回去仍是每人即时各一下'),
  }),
  Schema.object({
    quietDefaultText: Schema.boolean().default(true).description('把平台的默认文案"戳了戳"视作"没有自定义文案"（不当成用户内容送给模型）'),
    blockToolboxPokeTool: Schema.boolean()
      .default(true)
      .description('这一轮屏蔽 chatluna-toolbox 的戳一戳工具（不然模型会再戳一次，和代码那次重复）'),
    blockTools: Schema.string()
      .default('')
      .role('textarea')
      .description('额外要屏蔽的工具名，逗号分隔。留空即可'),
    debug: Schema.boolean().default(false).description('打印每次判断与限流决策'),
  }),
])

// ------------------------------------------------------------------ 小工具

function asString(v) {
  return v == null ? '' : String(v)
}

/**
 * 从 `session.internal.rawInfo` 里抽出"这个戳在客户端上显示成什么"。
 *
 * ★ 一定要拼**整句**，不能只取"戳了戳"后面那截（2026-10-05 生产实测踩到）：
 *   QQ 把灰条拆成 "前缀 txt" + "对象 QQ号" + "后缀 txt" 三段，例如
 *       [戳了戳][号][的尾巴]        → "戳了戳 号 的尾巴"
 *       [号][捏了捏][的脸，被附身了] → "号 捏了捏 的脸，被附身了"
 *   老实现把"戳了戳"当平台默认文案**整段丢掉**（quietDefaultText），只剩 "的尾巴"——
 *   模型看到的是一句残缺的话，还会读成"戳了戳自己的尾巴"。前缀是这句动作的一部分，必须留。
 *
 * 位置信息很重要：名字要插到 QQ 号原本待的那个位置（见 `labelWithPoked`），
 * 所以这里把每段标上"在 QQ 号之前 / 之后"。
 *
 * @returns {{t:'text', s:string, rel:'before'|'after'}[]} 文本片段（按灰条原始顺序）；没有可说的内容时返回 []
 */
function extractPokeText(rawInfo, quietDefaultText) {
  if (!Array.isArray(rawInfo)) return []
  const out = []
  let seenId = false
  for (const item of rawInfo) {
    if (!item || typeof item !== 'object') continue
    // 灰条里"被戳的人"那一项：type=qq 且带 tp（戳的人那项没有 tp）。
    // 实测结构： [qq:戳的人] [img] [txt:前缀] [qq+tp:被戳的人] [txt:后缀]
    if (item.type === 'qq' && item.tp !== undefined) {
      seenId = true
      continue
    }
    if (item.type !== 'nor') continue
    const txt = asString(item.txt).trim()
    if (!txt) continue
    out.push({ t: 'text', s: txt, rel: seenId ? 'after' : 'before' })
  }
  if (!out.length) return []
  // 一点自定义都没有（纯平台默认）时，确实没什么可告诉模型的
  if (quietDefaultText && out.length === 1 && out[0].rel === 'before' && /^戳了戳$/.test(out[0].s.replace(/\s+/g, ''))) {
    return []
  }
  return out
}

/**
 * 把"被戳的人"补回整句里（插在 QQ 号原本待的位置）：
 *   [{s:'戳了戳',rel:'before'},{s:'的尾巴',rel:'after'}] + "大肥鱼" → "戳了戳 大肥鱼 的尾巴"
 *   [{s:'揉了揉',rel:'before'}]                            + "大肥鱼" → "揉了揉 大肥鱼"
 *   [{s:'捏了捏',rel:'after'},{s:'的脸，被附身了',rel:'after'}] + "美人鱼" → "美人鱼 捏了捏 的脸，被附身了"
 *
 * 为什么必须补（2026-10-05 生产实测）：那段号是个**裸 QQ 号**，老实现把它跳过了，
 * 于是给模型的文案变成"戳了戳的尾巴"——读起来像"对方戳了自己的尾巴"，语义正好反了。
 *
 * 已经带名字的就不再补（幂等）。
 */
function labelWithPoked(parts, pokedName) {
  const arr = Array.isArray(parts) ? parts.filter((p) => p && p.s) : []
  if (!arr.length) return ''
  const name = asString(pokedName)
  if (!name) return arr.map((p) => p.s).join(' ')
  if (arr.some((p) => p.s === name)) return arr.map((p) => p.s).join(' ')

  const at = arr.findIndex((p) => p.rel === 'after')
  const texts = arr.map((p) => p.s)
  if (at < 0) texts.push(name)
  else texts.splice(at, 0, name)
  return texts.join(' ')
}

/**
 * 把 QQ 号换成"群里显示的那个名字"。
 *
 * ★ 为什么必须自己查（2026-10-05 生产实测，这就是"AI 不知道谁戳了他、乱回复"的根因）：
 *   OneBot 的 poke notice **不带名字**，`raw_info` 里那两段 `nm` 实测都是空串，
 *   而适配器建的 notice 会话**没有 author**，所以
 *       session.author?.name || session.username
 *   两个都取不到 → 于是巡回落到 pokerId，进模型就变成
 *       「群友[2969981414]（QQ 2969981414）说：…」
 *   同一时刻真正发消息的人却是「群友[热心群众小夏]」。一个大群里两种格式混着来，
 *   模型自然认不清谁是谁，就答错人。
 *
 * ★ 第二个坑（2026-10-06 生产诊断抓到的）：**适配器不能从 `session.bot` 上拿**。
 *   这里拿到的 `session` 是 Koishi 的 Session，它的 `bot` 解析到的是 **Context 服务**
 *   （`@satorijs/core` 的 `Context.associate` 让 `'bot'` 查到 ctx 上的 `bot` 服务），
 *   实测 `session.bot.internal === undefined`，于是请求根本发不出去。
 *   适配器要从 `ctx.bots` 里按 platform + selfId 找（见调用方传进来的 adapter）。
 *
 * 查不到就返回 ''（调用方自己回落到 QQ 号），失败绝不影响"戳回去"那一步。
 */
async function resolveDisplayName(adapter, groupId, userId) {
  const id = asString(userId)
  if (!id) return ''
  const internal = adapter?.internal
  if (!internal) return ''
  const isDirect = !groupId
  const action = isDirect ? 'getStrangerInfo' : 'getGroupMemberInfo'
  if (typeof internal[action] !== 'function') return ''

  /*
   * ★ 必须用**位置参数**，不能传对象（2026-10-06 生产实测踩到）：
   *   适配器的 `Internal.define(name, ...params)` 把参数名逐个映射成 args[0]、args[1]…
   *   （`Internal.prepareArg`：`Object.fromEntries(params.map((n, i) => [n, args[i]]))`）。
   *   传一个对象进去，NapCat 收到的是 `group_id: undefined` + `user_id: {…}`，
   *   请求发出去了、也不报错，但拿回来的东西没法用 —— 排查时极容易误判成"接口没实现"。
   */
  const data = isDirect
    ? await internal.getStrangerInfo(id, false) // (user_id, no_cache)
    : await internal.getGroupMemberInfo(asString(groupId), id, false) // (group_id, user_id, no_cache)
  if (!data) return ''
  // 群名片优先，退回昵称；空串一律当"没查到"
  const name = asString(data.card).trim() || asString(data.nickname).trim()
  // 有些实现会把号本身回在 nickname 里，那种不算名字
  return name === id ? '' : name
}

function clip(s, n) {
  const t = asString(s)
  return t.length > n ? t.slice(0, n) + '…' : t
}

/**
 * 给模型的那段"发生了什么"。
 *
 * ★ 地点必须用 `groupId` 判，不能拿 `groupName` 的有无来判（2026-10-05 生产实测踩到）：
 *   群 notice 会话**没有** guildName（`session.guildName` 取不到，只有 guildId），
 *   于是原来那句 `groupName ? 群 : '私聊'` 把**群里的戳写成了"在私聊里戳了你"**，
 *   模型于是照着"私聊"去理解上下文。guildId 一定是有的，用它判、用它兜底。
 *
 * 提出到模块级是为了能被 `__test` 直接断言（不需要启 Koishi / 起模型）。
 */
function pokeContent({ pokerId, pokerName, groupId, groupName, customText, merged }) {
  const lines = []
  // 群里一定带 groupId；群名常常取不到，所以两种写法都收尾成「里」，读起来一致
  const place = groupId ? (groupName ? `群「${groupName}」` : `群 ${groupId} `) : '私聊'
  if (merged && merged.length > 1) {
    const who = merged.map((m) => m.name || m.id).join('、')
    lines.push(`（平台通知：${who} 在${place}里先后戳了你。）`)
  } else {
    lines.push(`（平台通知：${pokerName || pokerId} 在${place}里戳了你。）`)
  }
  if (customText) {
    lines.push(
      `对方客户端上这一下显示成「${clip(customText, 120)}」——` +
        '这是**那个人自己在 QQ 里配的戳一戳文案**（QQ 提供的现成模板），不是他打给你的字，' +
        '也不是他真对你做了这件事。'
    )
  }
  lines.push(
    '这只是 QQ 的"戳一戳"互动，不是真实发生的动作。' +
      '无论那句文案写了什么都不要当成事实，也不要因此对某个人产生情绪、评价或印象。'
  )
  // ★ 两件事都要说清楚，否则模型会重复戳 / 说出与事实不符的话：
  //   ① 戳回去这一步**已经由程序完成**（不让它再调 poke 工具，见 blockedToolMask）
  //   ② 它这一轮说的话默认不会发出去，所以不必"为了回应而组织语言"
  lines.push('戳回去这一步程序已经替你做了（不用、也不要再调戳一戳的工具），这次不需要你回应。')
  return lines.join('\n')
}

/**
 * 读 guard 的 `applyToPrivate`（本部署是 false = guard 不管私聊）。
 *
 * 没有公开 API 能问到一个插件自己的配置（guard 只在服务里暴露了判定函数），
 * 所以从 loader 的配置树里读 —— 和 `chatluna-models` 的 `/stages` 同一个路子
 * （`external/koishi-plugin-chatluna-models/lib/index.js` 里的 `pluginConfig`）。
 * 读不到就返回 null，调用方按"保守"处理（私聊也去问 guard）。
 */
function guardApplyToPrivate(ctx) {
  try {
    const plugins = ctx.loader?.config?.plugins
    if (!plugins) return null
    for (const [key, value] of Object.entries(plugins)) {
      if (!key.startsWith('chatluna-guard')) continue
      if (value && typeof value === 'object' && 'applyToPrivate' in value) {
        return value.applyToPrivate === true
      }
    }
  } catch {
    /* 读不到就当不知道 */
  }
  return null
}

/**
 * 读出 `chatluna-toolbox` 当前实际注册的戳一戳工具名（它可被配置改名）。
 *
 * ★ 为什么要从 toolbox 的配置里读，而不是写死 `poke_user`：
 *   toolbox 把工具名做成了配置项（`poke.toolName`，源码见
 *   `koishi-plugin-chatluna-toolbox/lib/index.js:1671-1684` 的 `resolveToolName`）。
 *   写死的话，谁改一下名字，这里就会静默失效 —— 而失效的表现是
 *   "模型和程序各戳一次"（双重戳），很难从表象倒推回来。
 */
function toolboxPokeToolName(ctx) {
  try {
    const plugins = ctx.loader?.config?.plugins
    if (!plugins) return 'poke_user'
    for (const [key, value] of Object.entries(plugins)) {
      if (!key.startsWith('chatluna-toolbox')) continue
      if (!value || typeof value !== 'object') continue
      const name = value.poke?.toolName
      if (typeof name === 'string' && name.trim()) return name.trim()
    }
  } catch {
    /* 读不到就用默认名 */
  }
  return 'poke_user'
}

/**
 * 这一轮要屏蔽的工具 —— 目前就一个：戳一戳工具。
 *
 * ★ 为什么必须屏蔽（2026-10-05 生产实测）：
 *   生产上线后那一轮里，模型**自己调了** `poke_user`（库里留下
 *   `role=tool name=poke_user → "已在 群 454444539 戳了一下 2791932480。"`），
 *   与此同时本插件的"代码保证戳回去"也在跑 —— 同一个动作两条路，
 *   对方会连收两次戳。而"戳回去"本来就该由代码保证，模型不需要再管。
 *
 * 返回的是**完整的 ToolMask 结构**（mode/allow/deny 三个字段），
 * 因为 `chatluna/lib/index.cjs:4569` 会把它原样透传给
 * `PlatformService#getFilteredTools`，而那里是按 `mask.deny.includes(...)`
 * 直接取用的（`llm-core/platform/service.cjs:171-181`），缺字段会炸。
 */
function blockedToolMask(ctx, config) {
  const deny = new Set()
  const userList = String(config?.blockTools ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  for (const n of userList) deny.add(n)
  if (config?.blockToolboxPokeTool !== false) deny.add(toolboxPokeToolName(ctx))
  return { mode: 'deny', allow: [], deny: [...deny] }
}

/**
 * NapCat 拒绝发包时给出的可执行提示（模块级：纯函数，自检脚本也要用）。
 *
 * ★ 2026-10-05 实测：生产上线后"戳回去失败"，根因不在本插件 ——
 *   NapCat 的 `group_poke` / `friend_poke` / `send_poke` 都走 PacketBackend，
 *   而 PacketBackend 只认**特定区间的 QQ 构建号**。当前 QQ 是 9.9.36-53644，
 *   远超 NapCat 文档写的 Windows 支持区间 `28418-36580`，于是：
 *
 *     {"status":"failed","retcode":1400,
 *      "message":"packetBackend发包能力不可用…PacketBackend 不支持当前QQ版本架构：9.9.36-53644-x64"}
 *
 *   即：**戳一戳是 PacketBackend 的功能，QQ 构建一越界就整体失效**（`send_poke` 同样失败），
 *   与本插件怎么写无关。这里把它翻译成能直接执行的建议。
 */
function napcatHint(resp) {
  const text = `${asString(resp?.message)} ${asString(resp?.wording)}`
  if (!/packetBackend/i.test(text)) return ''
  const ver = /(\d+\.\d+\.\d+)-(\d+)/.exec(text)
  const shown = ver ? `${ver[1]}-${ver[2]}` : '未知构建'
  return (
    `NapCat 的 PacketBackend 不支持当前 QQ 构建（${shown}）；` +
    'NapCat 文档标注的 Windows 支持区间是 28418-36580。' +
    '戳一戳属于 PacketBackend 功能，QQ 构建越界就整体失效。' +
    '两条路：① 换到区间内的 QQ 构建（如 9.9.15-27597 / 9.9.19-35469）并关掉 QQ 自动更新；' +
    '② 让 NapCat 走外部 packet 服务（napcat.json：packetBackend 配成 packet + packetServer）。'
  )
}

/**
 * 读出 `chatluna-toolbox` 当前实际注册的戳一戳工具名（它可被配置改名）。
 *
 * ★ 为什么要从 toolbox 的配置里读，而不是写死 `poke_user`：
 *   toolbox 把工具名做成了配置项（`poke.toolName`，源码见
 *   `koishi-plugin-chatluna-toolbox/lib/index.js:1671-1684` 的 `resolveToolName`）。
 *   写死的话，谁改一下名字，这里就会静默失效 —— 而失效的表现是
 *   "模型和程序各戳一次"（双重戳），很难从表象倒推回来。
 */
function toolboxPokeToolName(ctx) {
  try {
    const plugins = ctx.loader?.config?.plugins
    if (!plugins) return 'poke_user'
    for (const [key, value] of Object.entries(plugins)) {
      if (!key.startsWith('chatluna-toolbox')) continue
      if (!value || typeof value !== 'object') continue
      const name = value.poke?.toolName
      if (typeof name === 'string' && name.trim()) return name.trim()
    }
  } catch {
    /* 读不到就用默认名 */
  }
  return 'poke_user'
}

/**
 * 这一轮要屏蔽的工具 —— 目前就一个：戳一戳工具。
 *
 * ★ 为什么必须屏蔽（2026-10-05 生产实测）：
 *   生产上线后那一轮里，模型**自己调了** `poke_user`（库里留下
 *   `role=tool name=poke_user → "已在 群 454444539 戳了一下 2791932480。"`），
 *   与此同时本插件的"代码保证戳回去"也在跑 —— 同一个动作两条路，
 *   对方会连收两次戳。而"戳回去"本来就该由代码保证，模型不需要再管。
 *
 * 返回的是**完整的 ToolMask 结构**（mode/allow/deny 三个字段），
 * 因为 `chatluna/lib/index.cjs:4569` 会把它原样透传给
 * `PlatformService#getFilteredTools`，而那里是按 `mask.deny.includes(...)`
 * 直接取用的（`llm-core/platform/service.cjs:171-181`），缺字段会炸。
 */
function blockedToolMask(ctx, config) {
  const deny = new Set()
  const userList = String(config?.blockTools ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  for (const n of userList) deny.add(n)
  if (config?.blockToolboxPokeTool !== false) deny.add(toolboxPokeToolName(ctx))
  return { mode: 'deny', allow: [], deny: [...deny] }
}

// ------------------------------------------------------------------ 应用

function apply(ctx, config) {
  /** 会话键 -> 上一次反应的时间戳 */
  const lastAt = new Map()
  /** `${sessionKey}|${userId}` -> 上一次对这个人的反应时间戳 */
  const lastUserAt = new Map()
  /** groupId -> { timer, sessions: Map<userId, session> } */
  const pending = new Map()

  const log = (...a) => config.debug && logger.info(...a)

  const keyOf = (session) => `${session.platform}:${session.selfId}:${session.channelId ?? session.guildId ?? session.userId}`

  /**
   * 只读地问 guard：这个会话现在能不能说话。
   *
   * ★ 为什么要分私聊/群聊问 —— 实测踩到的坑（rig 64 第一次跑）：
   *   guard 的对外 `isAllowed(session)` 就是 `!isBlocked(session)`，而 `isBlocked`
   *   **不看 `applyToPrivate`**（那个开关是在 guard 自己的中间件里单独判的）。
   *   本部署的 guard 是 `defaultPolicy: 'silent'`，于是私聊会话也被判成"被静音"，
   *   私聊的戳**一个都过不去**（日志：`guard 说这个会话在被静默，戳不反应`）。
   *   所以私聊要先看 `applyToPrivate`：关着就等于 guard 不管私聊，别问它。
   *
   * 返回 { allowed, ready }：`ready:false` = guard 自己还没 ready（启动窗口），
   * 调用方按"不确定"处理（群聊丢弃、私聊放行）。
   */
  function askGuard(session) {
    const guard = ctx.reflect?.get?.('qqbotGuard') ?? null
    if (!guard) return { allowed: true, ready: true } // 没装 guard：不越权替它做判断

    const isDirect = session.isDirect || !session.guildId
    if (isDirect && guardApplyToPrivate(ctx) !== true) {
      return { allowed: true, ready: true } // guard 不适用私聊（部署里就是这么配的）
    }

    try {
      const allowed = guard.isAllowed(session)
      if (allowed == null) return { allowed: false, ready: false }
      return { allowed: !!allowed, ready: true }
    } catch (e) {
      logger.warn('问 guard 失败，按不允许处理：%s', e.message)
      return { allowed: false, ready: true }
    }
  }

  /** 出站令牌桶只剩 0 就别开口（只查不扣，扣令牌只在 before-send 一处） */
  function bucketHasToken(session) {
    const guard = ctx.reflect?.get?.('qqbotGuard') ?? null
    const gid = session.guildId
    if (!guard?.bucket || !gid) return true
    try {
      const left = guard.bucket.peek(String(gid))
      if (typeof left === 'number' && left <= 0) {
        log('群 %s 出站令牌已空，戳不反应', gid)
        return false
      }
    } catch (e) {
      logger.warn('问出站令牌桶失败（按有额度处理）：%s', e.message)
    }
    return true
  }

  /**
   * 戳回去。
   *
   * 直接打 OneBot action，不走 `chatluna-toolbox` 的 `poke_user` 工具 ——
   * 那个工具要靠模型主动调用，而需求是"**必须**有反应"。
   * payload 形状对齐 toolbox（`chatluna-toolbox/lib/index.js:1019-1053`）：
   *   · 群：`group_poke { user_id, group_id }`
   *   · 私聊：`friend_poke { user_id }`
   *
   * ★ `status !== 'ok'` 必须当失败上报，并把 **message/wording + raw 一起打出来**：
   *   第一版只看了 status、只打印"action 返回 failed"，把 NapCat 那段
   *   "PacketBackend 不支持当前QQ版本架构" 的关键信息整个吞掉了 —— 排查白跑一趟。
   */
  async function pokeBack(session, userId, groupId) {
    const internal = session?.bot?.internal
    if (!internal) return { ok: false, reason: '适配器没有暴露 internal' }

    const payload = { user_id: asString(userId) }
    if (groupId) payload.group_id = asString(groupId)
    const action = payload.group_id ? 'group_poke' : 'friend_poke'

    try {
      let resp
      if (typeof internal._request === 'function') {
        resp = await internal._request(action, payload)
      } else if (typeof internal[action] === 'function') {
        resp = await internal[action](payload)
      } else if (typeof internal.sendPoke === 'function') {
        resp = await internal.sendPoke(payload.group_id, payload.user_id)
      } else {
        return { ok: false, reason: '当前适配器未实现 poke API' }
      }

      // Echo 响应：{ status, retcode, data, message, wording }
      const status = asString(resp?.status).toLowerCase()
      const retcode = resp?.retcode
      if (status && status !== 'ok') {
        const hint = napcatHint(resp)
        if (hint) {
          // 环境级原因：刷屏没意义，一个进程只打一次完整现场
          if (!napcatHintLogged) {
            napcatHintLogged = true
            logger.warn('%s 动作=%s raw=%s', hint, action, clip(JSON.stringify(resp), 600))
          }
          packetBackendBroken = true
          return { ok: false, reason: 'PacketBackend 不可用（QQ 构建不受支持）', hint }
        }
        const detail = clip([asString(resp?.message) || asString(resp?.wording)].filter(Boolean).join(' '), 300)
        return {
          ok: false,
          reason: `action 返回 ${status}${retcode != null ? ` retcode=${retcode}` : ''}${detail ? `：${detail}` : ''}`,
          raw: resp,
        }
      }
      // 成功一次就解锁（用户换完 QQ 版本不用重启也能自动恢复）
      if (packetBackendBroken) {
        packetBackendBroken = false
        logger.info('戳一戳已恢复：PacketBackend 现在可用')
      }
      return { ok: true }
    } catch (e) {
      return { ok: false, reason: e.message }
    }
  }

  /**
   * 造一个"戳的人"的会话。
   *
   * ★ 不能克隆 notice 会话的那些方法：Koishi 的 session 方法（`resolve`/`text`/`stripped`…）
   *   是 `ctx.mixin` **混入到实例上**的（`@koishijs/core/lib/index.cjs:1762-1785`），
   *   手写克隆会全丢，实测报 `TypeError: session.resolve is not a function`。
   *   所以走框架正路：`bot.session(event)` 拿一个真的 Session，只换 event 里
   *   "谁发的、说了什么"那几个字段（同 chatluna-proactive 的做法）。
   */
  function sessionFor(base, userId, username, text) {
    const event = { ...(base.event || {}) }
    event.user = { id: asString(userId), name: asString(username) || asString(userId) }
    delete event.member // 留着 member 会让真实群名片盖掉我们的身份
    event.timestamp = Date.now()
    event.message = {
      id: `poke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      elements: [h.text(text)],
    }
    return base.bot.session(event)
  }

  /* pokeContent 已提到模块级（见文件顶部），这里只留调用方 */

  /**
   * 一轮模型调用：模型能看到这次戳。
   *
   * `deliver=false`（默认）→ `invocation.delivery = 'silent'`
   *   `chatluna/lib/index.cjs:4530-4531, 4580-4585` 里 `captureOnly` 为真，
   *   `replyStream.end(undefined)`，**正文一个字节都不发**（但工具照常执行）。
   * `deliver=true` → 不传 delivery，正文照常发到会话里；
   *   但 `persist` 仍然听配置（默认 false = 这轮不落库、不喂长期记忆）。
   */
  async function callModel(session, pokerId, pokerName, groupId, customText, merged) {
    const chatluna = ctx.chatluna
    if (!chatluna?.chatChain) {
      log('chatluna 不可用，跳过模型那一轮（戳回去已经做过了）')
      return
    }
    // 环境级故障（PacketBackend 不可用 = 这个 QQ 构建根本发不出戳）期间不叫模型：
    // 叫了也只是让它为一件做不到的事组织语言，纯烧 token
    if (packetBackendBroken) {
      log('PacketBackend 不可用，跳过模型那一轮（这个环境发不出戳）')
      return
    }
    const isGroup = !!session.guildId
    const deliver = isGroup ? config.deliverGroup : config.deliverPrivate

    // 群名基本取不到（notice 会话不带），所以传 groupId，让 pokeContent 自己去兜底
    const content = pokeContent({ pokerId, pokerName, groupId, groupName: session.guildName || '', customText, merged })
    const turn = sessionFor(session, pokerId, pokerName, content)

    let timer = null
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`模型轮超时（${config.modelTimeoutSeconds}s）`)),
        config.modelTimeoutSeconds * 1000
      )
      // ★ 不 unref：这一轮真的在跑，超时必须能兜住它。
    })

    const options = {
      message: [h.text(content)],
      is_proactive: true,
      invocation: {
        ...(deliver ? {} : { delivery: 'silent' }),
        persist: config.persist,
        source: { kind: 'poke' },
        toolMask: blockedToolMask(ctx, config),
      },
      // ★ 给下游插件认这一轮是谁（chatluna-episode 就是这么认主动发言的）
      poke: { pokerId: asString(pokerId), groupId: asString(session.guildId) || null, merged: !!merged },
    }
    if (deliver) options.deliverySession = session

    try {
      await Promise.race([chatluna.chatChain.receiveCommand(turn, '', options), timeout])
    } catch (e) {
      logger.warn('戳的模型轮失败（不影响已经戳回去的那一下）：%s', e.message)
    } finally {
      // ★ 必须清掉：否则每来一次戳就留一个 60s 的活定时器，进程退出会被拖住
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * 限流判定 —— 两级冷却管的是**两件不同的事**（rig 64 第一次跑暴露出来的）：
   *
   *   · `userCooldownSeconds`（同一个人）→ 连戳不重复反应（挡连点）
   *   · `cooldownSeconds`（整个会话）    → **只压模型那一轮**，不压"戳回去"
   *
   * 为什么全局冷却不能压"戳回去"：需求是"被戳要有反应（以戳回去回复）"。
   * 第一次跑的时候 5 秒全局冷却把第 3、4 步的戳回去也一起吞了，日志是
   *   `（合并模式）会话 … 全局冷却中（5s），这次不反应`
   * —— 结果"被戳了却什么都没发生"。那是 bug 不是省流。
   *
   * 所以：`takeUserSlot` 管戳回去（每人限一次），`takeModelSlot` 管叫醒模型（全局限频）。
   */
  function takeUserSlot(session, pokerId, tag) {
    const key = keyOf(session)
    const now = Date.now()
    const uk = `${key}|${pokerId}`
    if (config.userCooldownSeconds > 0 && now - (lastUserAt.get(uk) ?? 0) < config.userCooldownSeconds * 1000) {
      log('%s同一人 %s 冷却中（%ds），这次不反应', tag, pokerId, config.userCooldownSeconds)
      return false
    }
    lastUserAt.set(uk, now)
    return true
  }

  function takeModelSlot(session, tag) {
    const key = keyOf(session)
    const now = Date.now()
    if (config.cooldownSeconds > 0 && now - (lastAt.get(key) ?? 0) < config.cooldownSeconds * 1000) {
      log('%s会话 %s 的模型轮在冷却中（%ds），这次只戳回去不叫模型', tag, key, config.cooldownSeconds)
      return false
    }
    lastAt.set(key, now)
    return true
  }

  /** 一次完整反应：先戳回去（即时），再按需叫醒模型 */
  async function react(session, pokerId, pokerName, groupId, customText = null) {
    if (!takeUserSlot(session, pokerId, '')) return

    // 调用方一般已经把整句文案算好了；这里兜底，避免漏传时模型看不到文案
    if (customText == null) {
      const rawInfo = session.internal?.rawInfo ?? session.internal?.raw_info
      const parts = extractPokeText(rawInfo, config.quietDefaultText)
      const selfName = asString(pickAdapter(session)?.user?.name) || asString(session.selfId)
      customText = labelWithPoked(parts, selfName)
    }
    if (config.pokeBack) {
      const r = await pokeBack(session, pokerId, groupId)
      if (r.ok) logger.info('已戳回 %s（%s）', pokerId, groupId ? `群 ${groupId}` : '私聊')
      else logger.warn('戳回去失败（%s）：%s', pokerId, r.reason)
    }

    if (!config.callModel) return
    if (!takeModelSlot(session, '')) return
    await callModel(session, pokerId, pokerName, groupId, customText, null)
  }

  /** 合并模式下要用的"只戳回去"半段：模型那一轮进窗口，戳回去必须即时 */
  async function reactImmediate(session, pokerId, groupId) {
    if (!takeUserSlot(session, pokerId, '（合并模式）')) return
    if (!config.pokeBack) return
    const r = await pokeBack(session, pokerId, groupId)
    if (r.ok) logger.info('已戳回 %s（群 %s）', pokerId, groupId)
    else logger.warn('戳回去失败（%s）：%s', pokerId, r.reason)
  }

  // ---------------------------------------------------------------- 合并窗口

  function scheduleMerged(session, groupId, item) {
    const key = `${session.platform}:${session.selfId}:${groupId}`
    let slot = pending.get(key)
    if (!slot) {
      slot = { sessions: new Map(), timer: null }
      pending.set(key, slot)
    }
    slot.sessions.set(asString(item.pokerId), item)
    if (slot.timer) return
    slot.timer = setTimeout(() => {
      pending.delete(key)
      const items = [...slot.sessions.values()]
      // ★ 全局冷却在这里判：合并窗口到点时如果刚叫过模型，就整个批次跳过
      if (!takeModelSlot(session, '（合并模式）')) return
      const base = items[items.length - 1].session
      const merged = items.map((i) => ({ id: i.pokerId, name: i.pokerName }))
      const customText = items
        .map((i) => i.customText)
        .filter(Boolean)
        .join(' / ')
      log('合并窗口到点，%d 个人的戳合成一轮模型调用', items.length)
      void callModel(base, merged[0].id, merged[0].name, groupId, customText, merged)
    }, Math.max(1, config.mergeWindowSeconds) * 1000)
    slot.timer.unref?.()
  }

  // ---------------------------------------------------------------- 事件入口

  ctx.on('notice', async (session) => {
    if (!config.enabled) return
    if (session.subtype !== 'poke') return

    const internal = session.internal || {}
    const selfId = asString(session.selfId)
    const pokerId = asString(session.userId)
    const targetId = asString(internal.targetId ?? internal.target_id)
    const groupId = asString(session.guildId)
    // 被戳的通常是 bot 自己；文案里那段 QQ 号就是"被戳者"，换成 bot 的名字才读得通
    const adapter = pickAdapter(session)
    const selfName = asString(adapter?.user?.name) || asString(session.selfId)

    // 自己戳自己（有的客户端会回显）：忽略，否则会自己跟自己来回戳
    if (pokerId && pokerId === selfId) return

    if (groupId) {
      if (!config.groupEnabled) return
      // ★ 群里只处理"戳的是 bot 自己"。判 target_id，不能判 user_id。
      if (targetId && targetId !== selfId) {
        log('群 %s 里 %s 戳的是 %s（不是 bot），不处理', groupId, pokerId, targetId)
        return
      }
      const g = askGuard(session)
      if (!g.allowed) {
        log(g.ready ? 'guard 说群 %s 在被静默，戳不反应' : 'guard 还没 ready，群里这次不反应（避免启动窗口误判）', groupId)
        return
      }
      if (!bucketHasToken(session)) return
      const pokerName = await lookupName(session, groupId, pokerId)
      const parts = extractPokeText(internal.rawInfo ?? internal.raw_info, config.quietDefaultText)
      const customText = labelWithPoked(parts, selfName)
      const item = { session, pokerId, pokerName, customText }
      if (config.mergeWindowSeconds > 0) {
        // 合并模式下：戳回去仍然即时，只有模型那一轮进窗口
        void reactImmediate(session, pokerId, groupId)
        scheduleMerged(session, groupId, item)
      } else {
        void react(session, pokerId, pokerName, groupId, customText)
      }
      return
    }

    // ---- 私聊 ----
    if (!config.privateEnabled) return
    const gp = askGuard(session)
    if (!gp.allowed && gp.ready) {
      log('guard 说私聊在被静默，戳不反应')
      return
    }
    const pokerName = await lookupName(session, '', pokerId)
    const parts = extractPokeText(internal.rawInfo ?? internal.raw_info, config.quietDefaultText)
    void react(session, pokerId, pokerName, '', labelWithPoked(parts, selfName))
  })

  /**
   * 名字解析：先看会话里有没有真名，没有再去查群名片/昵称。
   * 全程不抛：查不到就回落 QQ 号，"戳回去"那一步绝不受影响。
   *
   * ★ `session.username` **不能信**：OneBot notice 会话上它会回落成 **QQ 号本身**
   *   （实测 `username="2791932480"`），拿它当"名字"会让下面整段查询被短路掉。
   *   所以只认 `author.name` / `author.nickname`，且必须不等于号本身。
   */
  async function lookupName(session, groupId, pokerId) {
    const id = asString(pokerId)
    const candidates = [asString(session.author?.name), asString(session.author?.nickname)]
    for (const c of candidates) {
      if (c && c !== id) {
        log('会话里已有 %s 的显示名：%s', id, c)
        return c
      }
    }
    try {
      const adapter = pickAdapter(session)
      const resolved = await resolveDisplayName(adapter, groupId, id)
      if (resolved) {
        log('查到 %s 的显示名：%s', id, resolved)
        return resolved
      }
      log('查 %s 的显示名：没拿到可用名字（适配器 %s）', id, adapter ? '有' : '没找到')
    } catch (e) {
      log('查 %s 的显示名失败，这次先用 QQ 号：%s', id, e?.message ?? e)
    }
    return id
  }

  /**
   * 拿真正的 OneBot 适配器。
   *
   * ★ 不能写 `session.bot`：那是 Koishi 的 Context（`internal === undefined`，实测）。
   *   `bot.session(event)` 造出来的会话上，适配器挂在 session 的原型 `bot` 上；
   *   两条路都试，最后兜 `ctx.bots`。
   */
  function pickAdapter(session) {
    const direct = Object.getPrototypeOf(session)?.bot
    if (direct?.internal) return direct
    if (session.event?.bot?.internal) return session.event.bot
    const list = ctx.bots ?? []
    return (
      list.find((b) => b.internal && b.platform === session.platform && String(b.selfId) === String(session.selfId)) ??
      list.find((b) => b.internal && b.platform === session.platform) ??
      null
    )
  }

  ctx.on('dispose', () => {
    for (const slot of pending.values()) if (slot.timer) clearTimeout(slot.timer)
    pending.clear()
    lastAt.clear()
    lastUserAt.clear()
  })

  logger.info(
    '戳一戳已挂载：戳回去=%s，私聊=%s，群聊=%s，模型轮=%s（私聊投递=%s，群投递=%s，落库=%s），冷却=%ds/人 %ds/会话，合并窗口=%ds',
    config.pokeBack ? '开' : '关',
    config.privateEnabled ? '开' : '关',
    config.groupEnabled ? '开' : '关',
    config.callModel ? '开' : '关',
    config.deliverPrivate ? '开' : '关',
    config.deliverGroup ? '开' : '关',
    config.persist ? '开' : '关',
    config.userCooldownSeconds,
    config.cooldownSeconds,
    config.mergeWindowSeconds
  )
}

module.exports = {
  name,
  inject,
  Config,
  apply,
  __test: {
    extractPokeText,
    labelWithPoked,
    napcatHint,
    blockedToolMask,
    pokeContent,
    resolveDisplayName,
  },
}
