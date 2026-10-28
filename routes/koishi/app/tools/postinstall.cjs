/**
 * postinstall.cjs —— `npm i` 之后统一跑一遍本地补丁。
 *
 * 为什么要有这个东西（2026-10-27）：
 *   原来 package.json 里直接写
 *     "postinstall": "node ../tools/patch-sticker.cjs || echo ..."
 *   两个问题：
 *   ① 路径在 2026-10-25 目录重组（koishi-app → routes/koishi/app）之后就断了 ——
 *      `../tools` 解析成 routes/koishi/tools，不存在；patch-sticker 其实在**仓库根** tools/。
 *      而它带着 `|| echo 跳过`，所以**一直是静默失败**，谁也没发现。
 *   ② 要跑的不止一个补丁了（2026-10-27 加了 patch-dsh-connector）。在 cmd 里用
 *      `A || echo && B || echo` 拼，优先级很容易出错，还不可移植。
 *
 * 所以：统一在这里按顺序跑，每个都 try/catch，**任何一个失败都不阻断 npm i**
 * （补丁是"锦上添花"，装依赖失败才是真事故），但会把失败明确打出来。
 *
 * 顺序有讲究：patch-sticker 会改 chatluna-sticker 的 lib，patch-dsh-connector 改
 * dsh-connector 的 lib —— 两者互不相干，顺序无所谓，这里按加入时间排。
 */
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

const APP = path.resolve(__dirname, '..')          // routes/koishi/app
const REPO = path.resolve(APP, '../../..')         // 仓库根（app → koishi → routes → 根）

const STEPS = [
  {
    name: 'patch-sticker',
    script: path.join(REPO, 'tools', 'patch-sticker.cjs'),
  },
  {
    // 把 SQLite 驱动从 sql.js(WASM) 换成原生 better-sqlite3。
    // 没了这个补丁，Koishi 会每隔几分钟 `database disk image is malformed`（坑 95 / docs38 §8.1）。
    name: 'patch-sqlite-native',
    script: path.join(APP, 'tools', 'patch-sqlite-native.cjs'),
  },
  // 2026-10-27 第二十二轮起 `koishi-plugin-dsh-connector` 已卸载（DSH 改由
  // `external/koishi-plugin-chatluna-dsh-tool` 以 ChatLuna 工具的形式接入），
  // 所以它的补丁脚本不再进 postinstall。脚本本身留在 tools/ 下作为记录，
  // 将来若重新装回 connector，手动跑一次即可。
  // { name: 'patch-dsh-connector', script: path.join(APP, 'tools', 'patch-dsh-connector.cjs') },
]

let failed = 0

for (const step of STEPS) {
  if (!fs.existsSync(step.script)) {
    console.log(`[postinstall] 跳过 ${step.name}：找不到 ${step.script}`)
    continue
  }
  console.log(`[postinstall] ── ${step.name} ──`)
  const res = spawnSync(process.execPath, [step.script], {
    cwd: REPO,
    stdio: 'inherit',
  })
  if (res.status !== 0) {
    failed++
    console.log(`[postinstall] ⚠️ ${step.name} 退出码 ${res.status}（不影响 npm i，请核对上方输出）`)
  }
}

console.log(
  failed
    ? `[postinstall] 完成，${failed} 个补丁失败 —— 依赖已装好，但对应插件的本地改动没打上`
    : '[postinstall] 完成，全部补丁就位',
)
process.exit(0) // 永远不阻断 npm i
