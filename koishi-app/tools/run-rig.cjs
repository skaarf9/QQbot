/**
 * 一键跑一遍测试台：起伪 OneBot → 起测试实例 → 等剧本跑完 → 收尾。
 *
 *   node tools\run-rig.cjs <剧本文件> [--settle 14000] [--run 70000]
 *                                     [--keep-log]     整场输出另存 tools\logs\rig-<剧本>.log
 *                                     [--no-prune]     这次不清扫旧日志
 *                                     [--keep-days 7]  清扫保留天数（默认 7）
 *                                     [--upstream]     额外起 tools\fake-openai.mjs（伪上游，验兜底队列用）
 *                                     [--default-model m] 临时把测试实例的 defaultModel 改成 m（收尾还原）
 *
 * 为什么要有这个脚本：伪服务端是"客户端一连上就开始演"，所以必须先起它、再起
 * Koishi。分两次手动起很容易把两条时间线错开（踩过），脚本里用固定顺序更稳。
 *
 * ★ 日志策略见 tools/log-retention.mjs。以前是手写 `*> tools\rig-24-all.log` 重定向，
 *   每跑一轮多一个文件，攒到 58 个 / 4.9 MB 只增不减。现在：同名覆盖 + 跑完清扫超期日志。
 */
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const { pruneLogs, makeTee, logPathFor, DEFAULT_KEEP_DAYS } = require('./log-retention.cjs')

const APP = path.resolve(__dirname, '..')
const TEST = path.resolve(__dirname, '../../koishi-test')

const argv = process.argv.slice(2)
const has = (f) => argv.includes('--' + f)
const getArg = (n, d) => {
  const i = argv.indexOf('--' + n)
  return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d
}
const scenario = argv.find((a) => !a.startsWith('--'))
const settle = getArg('settle', '14000')
const runMs = +getArg('run', 75000)
const port = getArg('port', '3002')
const keepDays = Number(getArg('keep-days', String(DEFAULT_KEEP_DAYS)))

if (!scenario) {
  console.error('用法：node tools\\run-rig.cjs tools\\scenarios\\xxx.json [--settle 14000]')
  process.exit(1)
}

// 整场输出（两条进程的时间线）另存一份。同名剧本重跑会**覆盖**，不再堆文件。
const tee = has('keep-log') ? makeTee(logPathFor(__dirname, scenario)) : null
const say = (line) => {
  console.log(line)
  tee?.write(line)
}
if (tee) console.log('（整场输出会写到 ' + path.relative(APP, tee.file) + '）')

const children = []
function start(name, cmd, args, cwd) {
  const child = spawn(cmd, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  const tag = `[${name}]`
  const pipe = (stream) => {
    let buf = ''
    stream.on('data', (d) => {
      buf += d.toString()
      const lines = buf.split('\n')
      buf = lines.pop()
      for (const l of lines) if (l.trim()) say(`${tag} ${l}`)
    })
  }
  pipe(child.stdout)
  pipe(child.stderr)
  child.on('exit', (code) => say(`${tag} 退出 code=${code}`))
  return child
}

// ★ --default-model：临时改测试实例的"全局默认模型"。
//   为什么要改：轮换组是一个**模型名**，只有让某个角色真的去用它，兜底链路才会被走到。
//   为什么不用命令改：/chatluna.rule.model 要 authority 3，还得赌 guard 放行 —— 配置更直接。
//   一定还原：写在 finish() 里（含 Ctrl-C 路径），中途崩了下次起台前也会被本段重新覆盖。
const CFG = path.join(TEST, 'koishi.yml')
const defaultModel = getArg('default-model', null)
let cfgBackup = null
if (defaultModel) {
  const text = fs.readFileSync(CFG, 'utf8')
  const re = /^(\s*)defaultModel:.*$/m
  // ★ 判定"有没有匹配上"必须看**正则本身**，不能写 `next === text` ——
  //   当文件里已经是目标值（上一次跑台被中途打断、没走到还原）时，replace 出来的
  //   字符串**和原文一模一样**，于是被误判成"没找到 defaultModel 行"并直接退出。
  //   2026-10-06 真踩过：一次 rig 因此只跑了 3 秒就 exit 1，日志还是上一次的。
  if (!re.test(text)) {
    console.error('✗ 没在 ' + CFG + ' 里找到 defaultModel 行，放弃覆盖')
    process.exit(1)
  }
  const next = text.replace(re, `$1defaultModel: ${defaultModel}`)
  cfgBackup = text
  if (next !== text) fs.writeFileSync(CFG, next)
  console.log('（临时把测试实例 defaultModel 改成 ' + defaultModel + '，收尾时还原）')
}

console.log('=== 1) 起伪 OneBot（剧本：' + scenario + '）===')
const logFile = getArg('log', path.join(APP, 'tools', 'last-run.log'))
start(
  'fake',
  process.execPath,
  [
    path.join(APP, 'tools', 'fake-onebot.mjs'),
    scenario,
    '--port',
    port,
    '--imgPort',
    '3003',
    '--settle',
    settle,
    '--log',
    logFile,
  ],
  APP
)
console.log('（剧本回放会写到 ' + logFile + '）')

// ★ --upstream：伪 OpenAI 上游，给"模型兜底队列"用。
//   必须在 Koishi 之前起（ChatLuna 的适配器 ready 时会去拉模型列表）。
if (has('upstream')) {
  console.log('\n=== 1.5) 起伪 OpenAI 上游（验兜底队列用）===')
  start(
    'upstream',
    process.execPath,
    [path.join(APP, 'tools', 'fake-openai.mjs'), '--port', getArg('upstream-port', '3005'), '--fail-first', getArg('fail-first', '1'), '--log', path.join(APP, 'tools', 'last-upstream.log')],
    APP
  )
}

setTimeout(() => {
  console.log('\n=== 2) 起测试实例 ===')
  // ★ 必须用**测试实例自己的** koishi 二进制，不能用 koishi-app 的：
  //   插件名的解析根不是 cwd，而是"跑起来的那个 koishi 装在哪" ——
  //   @koishijs/loader 里 `nsRequire({ namespace:'koishi', prefix:'plugin', dirname: baseDir })`
  //   的 paths() 对完整包名直接返回裸名，最后落到 `require.resolve(name)`，
  //   而 require.resolve 是**相对 ns-require 自己所在目录**往上找 node_modules 的。
  //   用 APP 的 bin 起，解析根就是 koishi-app/node_modules：
  //     · 测试实例里 npm 装的新插件（在 koishi-test/node_modules）永远解析不到
  //     · 实际加载的却可能是 koishi-app 那份同名包，两边版本一不一致都看不出来
  //   实测现象：`/插件安装 koishi-plugin-weather` 装完 → `cannot resolve plugin`
  //   → 连重启都救不回来（因为重启后解析根还是 koishi-app）。
  const testBin = path.join(TEST, 'node_modules', 'koishi', 'bin.js')
  const bin = fs.existsSync(testBin)
    ? testBin
    : path.join(APP, 'node_modules', 'koishi', 'bin.js')
  console.log('    koishi 二进制：' + bin)
  start('koishi', process.execPath, [bin, 'start', '--log-level', '3'], TEST)
}, 2500)

/** 收尾：关进程 + 落盘日志 + 清扫 */
async function finish(label) {
  if (label) console.log(label)
  for (const c of children) {
    try {
      // ★ Koishi 的 CLI 会 fork 一个 daemon 子进程，直接 kill 父进程会留下孤儿占着端口
      //   （就是"静默半死"的来源）。用 taskkill /T 把整棵树带走。
      if (process.platform === 'win32' && c.pid) {
        spawn('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' })
      } else {
        c.kill('SIGTERM')
      }
    } catch {}
  }

  // ★ 还原 --default-model 的临时改动。放在杀进程之后、落日志之前都行，
  //   但**必须在进程退出前**，否则测试实例会带着伪上游的模型名下次启动。
  if (cfgBackup != null) {
    try {
      fs.writeFileSync(CFG, cfgBackup)
      console.log('已还原测试实例 defaultModel')
    } catch (e) {
      console.error('✗ 还原 defaultModel 失败，请手动检查 ' + CFG + '：' + e.message)
    }
  }

  // ★ 顺序要紧：先让本次的日志流落盘，再清扫。
  //   反过来的话，本次刚写的 tee 日志会被自己的清扫删掉（踩过）。
  if (tee) {
    await tee.end()
    console.log('整场输出已写到 ' + path.relative(APP, tee.file))
  }

  // 清扫：测试台自己的 logs/ 为主，顺带捞 koishi-app\tools 下老的 rig-*.log。
  // keepFiles 把本次的日志钉住 —— keep-days 0 时它是唯一该留下的东西。
  if (!has('no-prune')) {
    const r = pruneLogs({
      dirs: [path.join(__dirname, 'logs'), __dirname],
      keepDays,
      keepFiles: tee ? [tee.file] : [],
    })
    if (r.deleted > 0) {
      console.log(`\n=== 日志保留：删了 ${r.deleted} 个超期日志（>${keepDays} 天），释放 ${(r.freed / 1024).toFixed(0)} KB ===`)
    }
  }

  setTimeout(() => process.exit(0), 2500)
}

setTimeout(() => finish('\n=== 3) 收尾，连子孙进程一起关掉 ==='), 2500 + runMs)

process.on('SIGINT', () => {
  void finish()
})
