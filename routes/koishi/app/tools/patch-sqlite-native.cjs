/**
 * patch-sqlite-native.cjs —— 把 Koishi 的 SQLite 驱动从 **sql.js(WASM)** 换成 **better-sqlite3(原生)**。
 *
 * ── 为什么（2026-10-27 第二十二轮，查了一整晚）──────────────────────────────
 * `@koishijs/plugin-database-sqlite` 4.7.0 → `@minatojs/driver-sqlite` 4.7.0 →
 * `@minatojs/sql.js` 3.1.0（sql.js 的 WASM 版）。
 *
 * 在 Node 下，这个驱动**从不 export**（`_export()` 只在浏览器 beforeunload 时调），
 * 也就是说持久化完全靠 emscripten 的虚拟文件系统直接写真实文件。
 * 后果是运行时反复出现：
 *
 *   RuntimeError: null function or function signature mismatch
 *       at e._sqlite3_step (@minatojs/sql.js/dist/sql-wasm.js)
 *   → 事务没提交 → 留下 koishi.db-journal
 *   → 之后所有写报 `database disk image is malformed`
 *   → ChatLuna 落库失败 → bot 满嘴「错误码 999/103」，看着像模型挂了
 *
 * 排查排除过的（别重复走）：驱动没被升级 / 不是 taskkill 的热日志 / 不是库太大
 * （VACUUM 到 536 KB 仍复发）/ 不是 sandbox 写大 blob。详见坑 95。
 *
 * 根治要原生驱动，而 `@minatojs/driver-sqlite` 5.x 虽然改用原生，却要求
 * `minato@^4` / `cordis@^4` —— Koishi 4.18.11 够不到（升级要牵连 29 个自研插件）。
 *
 * ── 所以：给驱动塞一个 shim ────────────────────────────────────────────────
 * 驱动对底层 DB 的依赖面**极小**，只有：
 *   factory({locateFile}) → { Database }
 *   new Database(path)
 *   db.create_function(name, fn) / db.prepare(sql) / db.close() / db.export()
 *   stmt.bind(params) / stmt.step() / stmt.getAsObject(params, config) / stmt.run(params) / stmt.free()
 * 把这个面用 better-sqlite3 实现一遍即可，**不动 minato 的任何业务代码**。
 *
 * ── 用法 ──────────────────────────────────────────────────────────────────
 *   node tools\patch-sqlite-native.cjs             # 打补丁（幂等）
 *   node tools\patch-sqlite-native.cjs --revert    # 还原回 sql.js（WASM）
 *
 * 会在被改的驱动目录里留 `native-shim.cjs`，并给 `lib/index.cjs` 那一行加 `[qqbot-patch]` 标记。
 * npm i 重装依赖会覆盖，所以已挂进 postinstall。
 */
const fs = require('node:fs')
const path = require('node:path')

const APP = path.resolve(__dirname, '..')
const DRIVER = path.join(APP, 'node_modules', '@minatojs', 'driver-sqlite')
const TARGET = path.join(DRIVER, 'lib', 'index.cjs')
const SHIM = path.join(DRIVER, 'native-shim.cjs')

const MARK = '[qqbot-patch]'
const ORIGINAL = 'const sqlite = await (0, import_sql.default)({'
const PATCHED = `const sqlite = await require("../native-shim.cjs")({ // ${MARK} 原生 better-sqlite3`

const SHIM_SOURCE = `/**
 * native-shim.cjs —— 用 better-sqlite3 冒充 sql.js 的 Database 接口。
 *
 * ⚠️ 这个文件是 \`tools/patch-sqlite-native.cjs\` 生成的，别手改；重装依赖后重跑那个脚本。
 *
 * 契约来自 @minatojs/driver-sqlite 4.7.0 的实际调用（只有这些）：
 *   factory({ locateFile }) → { Database }
 *   new Database(path)                      // path 为 ':memory:' 时内存库
 *   db.create_function(name, fn)
 *   db.prepare(sql) → stmt
 *   stmt.bind(params) / stmt.step() / stmt.getAsObject(params, config) / stmt.run(params) / stmt.free()
 *   db.close() / db.export()
 */
'use strict'

const fs = require('node:fs')
const Database = require('better-sqlite3')

class ShimStatement {
  constructor(db, sql) {
    this.db = db
    this.sql = sql
    this.params = undefined
    this.iter = null
    this.cursor = null
    this.row = undefined
    this.done = false
    this.stmt = null
  }

  bind(params) {
    this.params = params
    return this
  }

  /** 第一次 step 时才真正执行；有结果集的用 iterate，没有的直接 run */
  _lazyStart() {
    if (this.stmt || this.done) return
    const stmt = this.db.prepare(this.sql)
    this.stmt = stmt
    const args = Array.isArray(this.params) ? this.params : (this.params === undefined ? [] : [this.params])
    if (stmt.reader) {
      this.iter = stmt.iterate(...args)
      this.cursor = this.iter.next()
    } else {
      stmt.run(...args)
      this.done = true
      this.iter = null
    }
  }

  step() {
    this._lazyStart()
    if (this.done) return false
    if (!this.cursor || this.cursor.done) return false
    this.row = this.cursor.value
    this.cursor = this.iter.next()
    return true
  }

  /**
   * 两种调用方式（驱动里都有）：
   *   _all：先 bind(params) 再循环 step()，最后 getAsObject(null, config) → 取当前行
   *   _get：不 bind 不 step，直接 getAsObject(params, config) → 自己执行一次、取第一行
   */
  getAsObject(params, _columnTypes) {
    if (params !== undefined && params !== null) {
      this.bind(params)
      const ok = this.step()
      return ok ? this.row : undefined
    }
    return this.row
  }

  run(params) {
    this.bind(params)
    const args = Array.isArray(this.params) ? this.params : (this.params === undefined ? [] : [this.params])
    const stmt = this.db.prepare(this.sql)
    this.stmt = stmt
    stmt.run(...args)
    this.done = true
    return this
  }

  free() {
    try {
      if (this.iter) this.iter.return?.()
    } catch { /* ignore */ }
    this.iter = null
    this.cursor = null
    this.stmt = null
  }
}

class ShimDatabase {
  constructor(filePath, buffer) {
    this.path = filePath
    // 浏览器/内存路径会传 buffer，这里退化成内存库 + 事后导出
    if (buffer) {
      this.db = new Database(':memory:')
      this._pendingImport = buffer
    } else {
      this.db = new Database(filePath === ':memory:' ? ':memory:' : filePath)
    }
    // 让 SQLite 自己管日志：原生实现能正确回滚热日志，
    // 这正是 WASM 版做不到、导致 'database disk image is malformed' 的地方。
    try {
      this.db.pragma('journal_mode = DELETE')
    } catch { /* 内存库可能不支持，忽略 */ }
    if (this._pendingImport) {
      try {
        this.db.exec(this._pendingImport.toString('utf8'))
        this._pendingImport = null
      } catch { /* 忽略 */ }
    }
  }

  create_function(name, fn) {
    // 驱动注册的 regexp / regexp2 / modulo / json_array_contains / rand 参数个数不一，
    // 必须 varargs 才接得住。
    this.db.function(name, { varargs: true }, (...args) => fn(...args))
  }

  prepare(sql) {
    return new ShimStatement(this.db, sql)
  }

  close() {
    try {
      this.db.close()
    } catch { /* 已关就忽略 */ }
  }

  export() {
    try {
      return new Uint8Array(fs.readFileSync(this.path))
    } catch {
      return new Uint8Array(0)
    }
  }
}

/** sql.js 的默认导出是「工厂函数」，驱动是 await 它的 */
module.exports = async function initSqlJs(_options) {
  return { Database: ShimDatabase }
}
module.exports.Database = ShimDatabase
`

const revert = process.argv.includes('--revert')

if (!fs.existsSync(TARGET)) {
  console.error(`[patch-sqlite-native] 找不到驱动：${TARGET}`)
  process.exit(1)
}

let src = fs.readFileSync(TARGET, 'utf8')

if (revert) {
  if (src.includes(MARK)) {
    src = src
      .split('\n')
      .map((line) => (line.includes(MARK) ? ORIGINAL : line))
      .join('\n')
    fs.writeFileSync(TARGET, src)
  }
  if (fs.existsSync(SHIM)) fs.unlinkSync(SHIM)
  console.log('[patch-sqlite-native] 已还原成 sql.js（WASM）')
  process.exit(0)
}

// 依赖检查：没有 better-sqlite3 就别打补丁，否则 Koishi 直接起不来
try {
  require(path.join(APP, 'node_modules', 'better-sqlite3'))
} catch (e) {
  console.error('[patch-sqlite-native] 没装 better-sqlite3，先跑：npm i better-sqlite3@^11')
  process.exit(3)
}

if (src.includes(MARK)) {
  // 已经在位：只要保证 shim 文件在（可能被 npm 洗掉了）
  if (!fs.existsSync(SHIM) || fs.readFileSync(SHIM, 'utf8') !== SHIM_SOURCE) {
    fs.writeFileSync(SHIM, SHIM_SOURCE)
    console.log('[patch-sqlite-native] 已重写 native-shim.cjs')
  } else {
    console.log('[patch-sqlite-native] 补丁已在位，跳过')
  }
  process.exit(0)
}

const count = src.split(ORIGINAL).length - 1
if (count !== 1) {
  console.error(`[patch-sqlite-native] 锚点出现 ${count} 次（期望 1 次），驱动版本可能变了，请人工核对：`)
  console.error('  ' + ORIGINAL)
  process.exit(2)
}

fs.writeFileSync(SHIM, SHIM_SOURCE)
src = src.replace(ORIGINAL, PATCHED)
fs.writeFileSync(TARGET, src)
console.log('[patch-sqlite-native] 已切换为原生 better-sqlite3（并写入 native-shim.cjs）')
