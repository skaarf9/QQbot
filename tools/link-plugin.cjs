// 把自研插件链接进两份 node_modules（新增插件时最容易漏的一步 —— 坑 63）
//
// 为什么要这个脚本：`koishi-app/external/<插件>` 只是源码，Koishi 要靠
// `node_modules/<包名>` 才 require 得到。而两个实例的 node_modules **形态不一样**：
//   · koishi-app/node_modules  —— 我们直接给它建一个指向 external/<插件> 的 junction 就够
//   · koishi-test/node_modules —— ★ **不是** junction（`setup-test-app.cjs` 当年建过，
//     后来在那个目录跑过一次 npm install，它变成了真实目录，里面每个依赖是
//     "目录 + 指向 koishi-app/external/<插件>/{lib,package.json} 的链接"）
// 只建一边的症状是**启动即报 `[E] app cannot resolve plugin "xxx"`**，
// 紧接着别名层报「目标缺失 N」、命令变成"没有这个指令" —— 很容易误判成代码写错。
//
// 用法：
//   node tools/link-plugin.cjs koishi-plugin-chatluna-models
//   node tools/link-plugin.cjs koishi-plugin-chatluna-models --test-only
//   node tools/link-plugin.cjs --list            # 列出 external 下有哪些插件、两边链没链
//
// ★ 只读检查用 --list；建链接是幂等的（已存在就跳过）。

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const ROOT = 'D:/deepseek/QQbot'
const APP = path.join(ROOT, 'koishi-app')
const TEST = path.join(ROOT, 'koishi-test')
const EXTERNAL = path.join(APP, 'external')

/** mklink 是 cmd 内建命令，必须走 cmd /c；/J = 目录联接（不需要管理员） */
function junction(link, target) {
  if (fs.existsSync(link)) return 'exists'
  fs.mkdirSync(path.dirname(link), { recursive: true })
  execFileSync('cmd', ['/c', 'mklink', '/J', link, target], { stdio: 'pipe' })
  return 'created'
}

function listExternal() {
  return fs
    .readdirSync(EXTERNAL, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('koishi-'))
    .map((d) => d.name)
}

function linked(nodeModulesDir, name) {
  return fs.existsSync(path.join(nodeModulesDir, name, 'package.json'))
}

function main() {
  const args = process.argv.slice(2)
  const testOnly = args.includes('--test-only')

  if (args.includes('--list') || args.length === 0) {
    console.log('插件名'.padEnd(46) + 'koishi-app  koishi-test')
    for (const name of listExternal()) {
      const a = linked(path.join(APP, 'node_modules'), name)
      const t = linked(path.join(TEST, 'node_modules'), name)
      const flag = a && t ? '' : '   ← ★ 少一边！'
      console.log(name.padEnd(46) + (a ? '  ✓        ' : '  ✗        ') + (t ? '✓' : '✗') + flag)
    }
    if (args.length === 0) {
      console.log('\n用法：node tools/link-plugin.cjs <插件名> [--test-only]')
    }
    return
  }

  const name = args.find((a) => !a.startsWith('--'))
  if (!name) throw new Error('要指定插件名（见 --list）')
  const src = path.join(EXTERNAL, name)
  if (!fs.existsSync(path.join(src, 'package.json'))) {
    throw new Error(`external/${name} 里没有 package.json —— 插件名写错了？`)
  }

  if (!testOnly) {
    const link = path.join(APP, 'node_modules', name)
    // koishi-app 这边整目录一个 junction 就够（npm 那份是"目录+分项链接"，两种都能 require）
    const r = junction(link, src)
    console.log(`koishi-app  ${r === 'created' ? '已建' : '已存在'}  ${link}`)
  }

  // koishi-test：照抄 npm 的形态（目录 + lib/package.json 两个分项链接）
  const testDir = path.join(TEST, 'node_modules', name)
  if (linked(path.join(TEST, 'node_modules'), name)) {
    console.log(`koishi-test 已存在  ${testDir}`)
  } else {
    fs.mkdirSync(testDir, { recursive: true })
    for (const item of fs.readdirSync(src)) {
      const from = path.join(src, item)
      const to = path.join(testDir, item)
      if (fs.existsSync(to)) continue
      if (fs.statSync(from).isDirectory()) {
        junction(to, from)
      } else {
        // 文件用硬链接（和 npm 在这个目录里的做法一致；同盘才可行）
        fs.linkSync(from, to)
      }
    }
    console.log(`koishi-test 已建  ${testDir}`)
  }

  // 顺手把依赖写进两边 package.json（不然下次 npm install 会把链接清掉）
  for (const [dir, dep] of [
    [APP, `file:external/${name}`],
    [TEST, `file:../koishi-app/external/${name}`],
  ]) {
    const pkgPath = path.join(dir, 'package.json')
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    pkg.dependencies ||= {}
    if (pkg.dependencies[name] === dep) {
      console.log(`${path.basename(dir)}/package.json 已有依赖项`)
    } else {
      pkg.dependencies[name] = dep
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
      console.log(`${path.basename(dir)}/package.json 已写入 ${name}: ${dep}`)
    }
  }

  console.log('\n自测：')
  for (const dir of [APP, TEST]) {
    const target = path.join(dir, 'node_modules', name)
    try {
      const resolved = require.resolve(name, { paths: [dir] })
      console.log(`  ${path.basename(dir)} → ${resolved}`)
    } catch (e) {
      console.log(`  ${path.basename(dir)} → 解析失败：${e.code}（检查上面的链接）`)
      process.exitCode = 1
    }
  }
}

main()
