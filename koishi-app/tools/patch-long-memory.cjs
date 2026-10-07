/**
 * 给 `koishi-plugin-chatluna-long-memory` 打一个小补丁：**请求不存在/未启用的记忆层时降级，而不是报错**。
 *
 * 为什么必须补（2026-10-03 生产日志实证，本轮用户报障的直接原因之一）：
 *   群里引用了一句 bot 06:37 说的话，模型很聪明地调了
 *     memory_search("2026/10/03 早上 06:37 群里的对话 熬夜", layer=[guild,user,global])
 *   但生产只启用了 Guild / User 两层（koishi.yml 的 enabledLayers），于是
 *     `initMemoryLayers` → `throw new Error('Memory layer global not found')`
 *   → 工具 catch 后只回一句 "An error occurred while searching for memories."
 *   → 模型拿不到任何东西，只能对用户说"我都不记得了"。
 *
 *   三处都值得修，这里修最要命的一处：
 *     ① 工具描述里**永远**列出 user/preset/guild/global 四层（描述是写死的字符串），
 *        却不知道哪些层真的启用了 —— 模型是照着描述填的，填错不怪它；
 *     ② `_call` 把用户给的层原样传下去，没有和"可用层"求交；
 *     ③ `initMemoryLayers` 遇到没有 creator 的层直接抛异常，把整次检索带走。
 *   本补丁改的是 ③（+ 顺手让 ② 传下来的非法层不再炸）：**丢掉不可用的层，用剩下的继续搜**；
 *   一个都不剩时才退回服务默认层（enabledLayers）。这样模型多写一个 global 不会再有代价。
 *
 * 用法：
 *   node tools/patch-long-memory.cjs           # 空跑，只报告
 *   node tools/patch-long-memory.cjs --apply   # 真写（幂等，打过就跳过）
 *
 * ★ 打的是 node_modules 里的构建产物：**pnpm/npm 重装或升级这个包之后必须重跑**。
 *   用法与 patch-sticker.cjs 一致（那个挂在 koishi-app 的 postinstall 上）。
 */
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const TARGETS = [
  path.join(ROOT, 'node_modules', 'koishi-plugin-chatluna-long-memory', 'lib', 'index.cjs'),
  path.join(ROOT, '..', 'koishi-test', 'node_modules', 'koishi-plugin-chatluna-long-memory', 'lib', 'index.cjs'),
]

const MARKER = '记忆层降级补丁'

const OLD = `      this._memoryLayerNamespaces[namespace] = await Promise.all(
        layerTypes.map(async (layerType) => {
          const creator = this._memoryLayerCreators[layerType];
          if (creator == null) {
            throw new Error(\`Memory layer \${layerType} not found\`);
          }`

const NEW = `      const availableTypes = layerTypes.filter((layerType) => this._memoryLayerCreators[layerType] != null);
      const droppedTypes = layerTypes.filter((layerType) => !availableTypes.includes(layerType));
      if (droppedTypes.length > 0) {
        this.ctx.logger.warn(\`[${MARKER}] \${droppedTypes.join(",")} 层没有启用，已跳过，改用 \${availableTypes.join(",") || "(默认层)"} 继续检索\`);
      }
      this._memoryLayerNamespaces[namespace] = await Promise.all(
        (availableTypes.length > 0 ? availableTypes : this.defaultLayerTypes).map(async (layerType) => {
          const creator = this._memoryLayerCreators[layerType];
          if (creator == null) {
            throw new Error(\`Memory layer \${layerType} not found\`);
          }`

function patch(file) {
  if (!fs.existsSync(file)) return `跳过（没这个文件）：${file}`
  const text = fs.readFileSync(file, 'utf8')
  if (text.includes(MARKER)) return `已打过（幂等跳过）：${path.relative(ROOT, file)}`
  if (!text.includes(OLD)) {
    return `★ 没找到目标片段，包结构可能变了，需要人工看一眼：${path.relative(ROOT, file)}`
  }
  const count = text.split(OLD).length - 1
  const next = text.split(OLD).join(NEW)
  if (apply) {
    fs.writeFileSync(file, next)
    return `已打补丁（${count} 处）：${path.relative(ROOT, file)}`
  }
  return `[空跑] 会改 ${count} 处：${path.relative(ROOT, file)}`
}

const apply = process.argv.includes('--apply')
for (const f of TARGETS) console.log(patch(f))
if (!apply) console.log('\n加 --apply 才真写。')
