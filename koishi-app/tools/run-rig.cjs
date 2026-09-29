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
  const bin = require('node:fs').existsSync(testBin)
    ? testBin
    : path.join(APP, 'node_modules', 'koishi', 'bin.js')
  console.log('    koishi 二进制：' + bin)
  start('koishi', process.execPath, [bin, 'start', '--log-level', '3'], TEST)
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
