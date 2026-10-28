/**
 * patch-dsh-connector.cjs —— 给 koishi-plugin-dsh-connector 打两处最小补丁。
 *
 * ⚠️ **2026-10-27 第二十二轮起已停用**：`koishi-plugin-dsh-connector` 已卸载
 * （DSH 改由 `external/koishi-plugin-chatluna-dsh-tool` 以 ChatLuna 工具的形式接入，
 * 见 `docs/39-DSH当工具.md`）。本脚本不再进 postinstall，**留着只为记录**：
 * 万一将来重新装回 connector，手动跑一次就能恢复这两个修复。
 * 现在跑它会因为找不到插件目录而退出 1，这是预期的。
 *
 * 用法：
 *   node tools\patch-dsh-connector.cjs                  # 给本 app 打（幂等）
 *   node tools\patch-dsh-connector.cjs --revert         # 还原
 *   node tools\patch-dsh-connector.cjs --app ../../test # 给测试实例打
 *
 * ── 补丁 1：chatIdleMinutes = 0 表示「不设空闲窗口，永远直通」 ──────────────
 * 起因（2026-10-27 实测）：插件用 chatIdleMinutes 表示"最近多少分钟内交互过才把私聊
 * 自然语言直通给 DSH"，源码是
 *
 *     const last = deps.lastActive.get(key) ?? 0
 *     return Date.now() - last <= deps.config.chatIdleMinutes * 6e4
 *
 * `lastActive` 是**内存 Map**（dispose 时 clear）。于是：
 *   · Koishi 每次重启后 lastActive 为空 → last=0 → `Date.now() - 0` 是个天文数字
 *     → 判定"没交互过" → 私聊落回 ChatLuna；
 *   · 配成 0（schema 允许的最小值）也不是"不限"，而是 `<= 0` 恒假 → 永不直通。
 * 结果：配置写着 naturalLanguagePrivate: true，实际一条私聊都进不去 DSH，
 * 必须先在私聊里敲一次 `dsh.chat on`（同样是内存态，重启即失效）。
 * 实测证据：tools/logs/rig-10-dsh-gateway.log —— 私聊被 ChatLuna 接走，
 * 回了"当前会话对应的模型 empty 不可用"，dsh-connector 全程没有回合日志。
 *
 * 补丁：`if (deps.config.chatIdleMinutes <= 0) return true;`
 * 为什么改 0 的语义而不是加配置项：0 在现有代码里是个没人会想要的退化值
 * （谁会把"最近 0 分钟内交互过"当需求），take 成"不限"既自然又不破坏兼容，
 * 默认值 30 的行为一字不变。
 *
 * ── 补丁 2：私聊闲聊不刷「已提交到 DeepSeek Harness，正在执行……」 ───────────
 * 起因：那个 ack 在每轮 prompt 之前硬编码发送（MESSAGES.promptAccepted），
 * 没有开关。对 `dsh.run` 这种显式任务它是好的（DSH 慢的时候给个回执），
 * 但对"私聊说句话"就变成每条都插一句系统腔，把大肥鱼的人设打断。
 * 实测 DSH（V4.1-Flash）在这台机器上单轮 1.2~3.7 秒，沉默完全可以接受。
 *
 * 补丁：给 handleRun 加第 4 个参数 quietAck，私聊直通那条中间件传 true；
 * quiet 时不发 ack。`dsh.run` 走原路径，回执照旧。
 *
 * ── 注意 ────────────────────────────────────────────────────────────────
 * npm i 重装该插件会覆盖 lib/index.js，补丁需重打。已在 package.json 的
 * postinstall 里挂上（和 patch-sticker.cjs 同一套路）。
 * 所有改动都带 `[qqbot-patch]` 标记，`--revert` 按标记整行删除。
 */
const fs = require('node:fs')
const path = require('node:path')

const argv = process.argv.slice(2)
const appArg = argv.indexOf('--app')
const APP = appArg >= 0 && argv[appArg + 1]
  ? path.resolve(__dirname, argv[appArg + 1])
  : path.resolve(__dirname, '..')
const TARGET = path.join(APP, 'node_modules', 'koishi-plugin-dsh-connector', 'lib', 'index.js')

const MARK = '[qqbot-patch]'

/** 每项：anchor 是原文（唯一出现一次）；有 from/to 就整行替换，否则把 add 插到 anchor 之后。
 *  id 用于幂等判断（查 `[qqbot-patch] <id>` 是否已在文件里），**不要**靠 add 全文匹配
 *  —— 改一次注释文案就会误判成"没打过"从而重复插入（2026-10-27 真踩过）。 */
const PATCHES = [
  {
    id: 'patch1',
    name: 'chatIdleMinutes<=0 → 永远直通',
    anchor: '  if (override === true) return true;',
    add: '  if (deps.config.chatIdleMinutes <= 0) return true;',
  },
  {
    id: 'patch2a',
    name: 'handleRun 增加 quietAck 形参',
    anchor: 'async function handleRun(deps, session, text) {',
    from: 'async function handleRun(deps, session, text) {',
    to: 'async function handleRun(deps, session, text, quietAck = false) {',
  },
  {
    id: 'patch2b',
    name: 'quietAck 时跳过 ack 发送',
    anchor: '    await session.send(created ? `${MESSAGES.sessionCreated} ${ack}` : ack);',
    from: '    await session.send(created ? `${MESSAGES.sessionCreated} ${ack}` : ack);',
    to: '    if (!quietAck) await session.send(created ? `${MESSAGES.sessionCreated} ${ack}` : ack);',
  },
  {
    id: 'patch2c',
    name: '私聊直通那条中间件传 quietAck=true',
    anchor: '    return handleRun(deps, session, text);',
    from: '    return handleRun(deps, session, text);',
    to: '    return handleRun(deps, session, text, true);',
  },
]

const revert = argv.includes('--revert')

if (!fs.existsSync(TARGET)) {
  console.error(`[patch-dsh-connector] 找不到 ${TARGET}`)
  console.error('[patch-dsh-connector] 先 npm i koishi-plugin-dsh-connector')
  process.exit(1)
}

let src = fs.readFileSync(TARGET, 'utf8')
const markerOf = (id) => ` // ${MARK} ${id}`

if (revert) {
  if (!src.includes(MARK)) {
    console.log('[patch-dsh-connector] 没打过补丁，无需还原')
    process.exit(0)
  }
  for (const p of PATCHES) {
    if (!src.includes(markerOf(p.id))) continue
    if (p.from) {
      src = src.replace(p.to + markerOf(p.id), p.from)
    } else {
      src = src.split('\n').filter((line) => !line.includes(markerOf(p.id))).join('\n')
    }
  }
  // 兜底：任何残留带标记的行都删掉（比如手工改过注释）
  src = src.split('\n').filter((line) => !line.includes(MARK)).join('\n')
  fs.writeFileSync(TARGET, src)
  console.log('[patch-dsh-connector] 已还原')
  process.exit(0)
}

let applied = 0
const failed = []

for (const p of PATCHES) {
  if (src.includes(markerOf(p.id))) continue // 幂等：按 id 判断，不看全文

  const count = src.split(p.anchor).length - 1
  if (count !== 1) {
    failed.push(`${p.name}（锚点出现 ${count} 次，期望 1 次）`)
    continue
  }
  if (p.from) {
    src = src.replace(p.anchor, p.to + markerOf(p.id))
  } else {
    src = src.replace(p.anchor, `${p.anchor}\n${p.add}${markerOf(p.id)}`)
  }
  applied++
}

if (failed.length) {
  console.error('[patch-dsh-connector] 以下补丁失败，插件源码可能变了，请人工核对：')
  for (const f of failed) console.error('  · ' + f)
  if (applied) {
    fs.writeFileSync(TARGET, src)
    console.error(`[patch-dsh-connector] 其余 ${applied} 处已写入，注意核对后再跑`)
  }
  process.exit(2)
}

if (applied === 0) {
  console.log('[patch-dsh-connector] 补丁全都在位，跳过')
} else {
  fs.writeFileSync(TARGET, src)
  console.log(`[patch-dsh-connector] 打上 ${applied} 处补丁（${TARGET}）`)
}
