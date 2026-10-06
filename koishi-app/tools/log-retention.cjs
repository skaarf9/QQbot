/**
 * log-retention.cjs —— 日志保留策略（测试台共用）。
 *
 * 为什么需要：跑一次剧本就会留下 200~400 KB 的 rig 日志，跑了几十轮之后
 * `koishi-app/tools/` 下堆了 58 个文件 / 4.9 MB，只增不减。
 *
 * 策略（两层）：
 *   1. **同名覆盖**：每条命令的日志固定写到一个可预测的名字（见 logPathFor），
 *      重跑同一个剧本不会再多出一个文件，而是覆盖上一次。
 *   2. **超期清扫**：每次跑完（以及单独调用 tools/clean-logs.cjs）按 mtime 删掉
 *      N 天前的日志。测试台自己产出的日志写进 `logs/` 子目录，清扫也以它为主。
 *
 * 用法：
 *   const { pruneLogs, logPathFor } = require('./log-retention.cjs')
 */
const {
  readdirSync,
  statSync,
  unlinkSync,
  renameSync,
  mkdirSync,
  existsSync,
  createWriteStream,
} = require('node:fs')
const path = require('node:path')

/** 默认保留天数。0 = 每次都清干净（只留受保护的）。 */
const DEFAULT_KEEP_DAYS = 7

/** 测试台自己产出的日志都放这里（相对 koishi-app/tools） */
const LOG_SUBDIR = 'logs'

/** 这些名字永远不删（脚本回放、生产日志是排障入口） */
const PROTECTED = new Set(['last-run.log', 'prod.log'])

/**
 * 每条命令一个稳定的日志名 —— 同样参数重跑就覆盖同一个文件。
 * 例：09-final.json -> logs/rig-09-final.log
 */
function logPathFor(toolsDir, scenario, extra) {
  const base = path.basename(String(scenario ?? 'run'), '.json').replace(/[^\w.-]+/g, '_')
  const suffix = extra ? `-${String(extra).replace(/[^\w.-]+/g, '_')}` : ''
  return path.join(toolsDir, LOG_SUBDIR, `rig-${base}${suffix}.log`)
}

function listLogs(dir) {
  if (!existsSync(dir)) return []
  const out = []
  let entries = []
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  for (const name of entries) {
    if (!name.toLowerCase().endsWith('.log')) continue
    const full = path.join(dir, name)
    try {
      const st = statSync(full)
      if (st.isFile()) out.push({ full, name, mtime: st.mtimeMs, size: st.size })
    } catch {}
  }
  return out
}

/**
 * 清扫日志。
 * @param {object} o
 * @param {string[]} o.dirs        要清扫的目录
 * @param {number}   o.keepDays    保留天数（0 = 只留 protected）
 * @param {boolean}  o.dry         只报告不删
 * @param {boolean}  o.verbose
 * @param {string[]} o.keepFiles   绝对路径白名单，永远不删（本次刚写的日志要放进来）
 * @returns {{scanned:number, deleted:number, freed:number, kept:number}}
 */
function pruneLogs({ dirs = [], keepDays = DEFAULT_KEEP_DAYS, dry = false, verbose = false, keepFiles = [] } = {}) {
  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000
  const pinned = new Set(keepFiles.map((f) => path.resolve(f)))
  let scanned = 0
  let deleted = 0
  let freed = 0
  let kept = 0

  for (const dir of dirs) {
    for (const f of listLogs(dir)) {
      scanned++
      // ★ pinned 必须优先于时间判断：keepDays=0 时 cutoff 就是"现在"，
      //   而刚写完的文件 mtime 比"现在"早几毫秒 —— 光看时间会把自己刚写的日志删掉（踩过）。
      if (PROTECTED.has(f.name) || pinned.has(path.resolve(f.full)) || f.mtime >= cutoff) {
        kept++
        continue
      }
      if (verbose) {
        console.log(`  ${dry ? '[dry] 会删' : '删'} ${path.relative(process.cwd(), f.full)}  ${(f.size / 1024).toFixed(0)} KB`)
      }
      if (!dry) {
        try {
          unlinkSync(f.full)
        } catch (e) {
          if (verbose) console.log(`    跳过（${e.code}）`)
          kept++
          continue
        }
      }
      deleted++
      freed += f.size
    }
  }
  return { scanned, deleted, freed, kept }
}

/**
 * 本地日期（YYYY-MM-DD）。
 *
 * ★ 别用 `new Date().toISOString().slice(0, 10)` —— 那是 **UTC**，
 *   在东八区会在**早上 08:00** 换日，而不是半夜 00:00。2026-10-06 实测踩到：
 *   `prod-2026-10-05.log` 里混进了 `2026-10-06 00:33` 的日志，看着像"跨天没滚动"，
 *   其实是文件名算的是 UTC 日期。
 */
function localDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 本地时间戳 HHMMSS（给"上次没跑完的日志"存档用） */
function localTimeStamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/**
 * 给某个日志文件开一个"边打屏边落盘"的写入器（覆盖式，不是追加）。
 * ★ 用流不用 writeFileSync：run-rig 的输出是逐行的，每行同步写盘会明显拖慢剧本。
 * 用完记得 end()，否则最后几行可能没落盘。
 */
function makeTee(file) {
  mkdirSync(path.dirname(file), { recursive: true })
  const stream = createWriteStream(file, { flags: 'w' })
  return {
    file,
    write: (line) => {
      try {
        stream.write(line + '\n')
      } catch {}
    },
    end: () =>
      new Promise((res) => {
        try {
          stream.end(res)
        } catch {
          res()
        }
      }),
  }
}

/**
 * 按**本地日期**分文件的写入器，运行中跨天会自动换文件。
 *
 * 解决两件事（2026-10-06 修）：
 *   ① 旧实现只在启动时算一次 `toISOString()`（UTC）文件名，起完就再也不换：
 *      跑过半夜的实例会把 10-06 的日志一直写进 `prod-2026-10-05.log`。
 *   ② `makeTee` 是 `flags: 'w'`（覆盖）。同一天重启一次就把上一段日志抹掉了，
 *      而排障恰恰经常要"上一段"。现在同名文件已存在时先改名存档
 *      （`prod-2026-10-05.prev-221530.log`），再写新的，等价于按"运行段"留存。
 *
 * @param {(date:string)=>string} pathForDate 由日期算出文件全路径
 * @param {{archive?:boolean, now?:()=>Date}} [opts]
 */
function makeRotatingTee(pathForDate, opts = {}) {
  const { archive = true, now = () => new Date() } = opts
  let date = localDate(now())
  let file = pathForDate(date)
  let stream = null

  function archiveExisting(target) {
    if (!archive || !existsSync(target)) return
    const move = (suffix) => {
      try {
        renameSync(target, `${target}${suffix}`)
        return true
      } catch {
        return false
      }
    }
    move(`.prev-${localTimeStamp(now())}`) || move('.prev')
  }

  function open() {
    mkdirSync(path.dirname(file), { recursive: true })
    archiveExisting(file)
    stream = createWriteStream(file, { flags: 'w' })
    // 流上的错误不处理会变成未捕获异常，把进程带走
    stream.on('error', () => {})
  }
  open()

  return {
    /** 当前正在写的文件（跨天后会变，所以是 getter） */
    get file() {
      return file
    },
    get date() {
      return date
    },
    /** 换日时换文件；返回是否换了 */
    rotate() {
      const today = localDate(now())
      if (today === date) return false
      try {
        stream.end()
      } catch {}
      date = today
      file = pathForDate(today)
      open()
      return true
    },
    write: (line) => {
      try {
        stream.write(line + '\n')
      } catch {}
    },
    end: () =>
      new Promise((res) => {
        try {
          stream.end(res)
        } catch {
          res()
        }
      }),
  }
}

module.exports = {
  DEFAULT_KEEP_DAYS,
  LOG_SUBDIR,
  PROTECTED,
  localDate,
  localTimeStamp,
  logPathFor,
  pruneLogs,
  makeTee,
  makeRotatingTee,
}
