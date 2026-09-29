/**
 * 一键跑一遍测试台：起伪 OneBot → 起测试实例 → 等剧本跑完 → 收尾。
 *
 *   node tools\run-rig.cjs <剧本文件> [--settle 14000] [--run 70000]
 *
 * 为什么要有这个脚本：伪服务端是"客户端一连上就开始演"，所以必须先起它、再起
 * Koishi。分两次手动起很容易把两条时间线错开（踩过），脚本里用固定顺序更稳。
 */
const { spawn } = require('node:child_process')
const path = require('node:path')

const APP = path.resolve(__dirname, '..')
const TEST = path.resolve(__dirname, '../../koishi-test')

const argv = process.argv.slice(2)
const scenario = argv.find((a) => !a.startsWith('--'))
const getArg = (n, d) => {
  const i = argv.indexOf('--' + n)
  return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d
}
const settle = getArg('settle', '14000')
const runMs = +getArg('run', 75000)
const port = getArg('port', '3002')

if (!scenario) {
  console.error('用法：node tools\\run-rig.cjs tools\\scenarios\\xxx.json [--settle 14000]')
  process.exit(1)
}

const children = []
function start(name, cmd, args, cwd, color) {
  const child = spawn(cmd, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  const tag = `[${name}]`
  const pipe = (stream) => {
    let buf = ''
    stream.on('data', (d) => {
      buf += d.toString()
      const lines = buf.split('\n')
      buf = lines.pop()
      for (const l of lines) if (l.trim()) console.log(`${tag} ${l}`)
    })
  }
  pipe(child.stdout)
  pipe(child.stderr)
  child.on('exit', (code) => console.log(`${tag} 退出 code=${code}`))
  return child
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

setTimeout(() => {
  console.log('\n=== 2) 起测试实例 ===')
  start('koishi', process.execPath, [path.join(APP, 'node_modules', 'koishi', 'bin.js'), 'start', '--log-level', '3'], TEST)
}, 2500)

setTimeout(() => {
  console.log('\n=== 3) 收尾，连子孙进程一起关掉 ===')
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
  setTimeout(() => process.exit(0), 2500)
}, 2500 + runMs)

process.on('SIGINT', () => {
  for (const c of children) {
    try {
      c.kill()
    } catch {}
  }
  process.exit(0)
})
