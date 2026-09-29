// 验证 sharp 装好了、能解码这批测试图、压缩效果如何
// 放在 koishi-app 里跑（Node 从脚本所在目录解析模块）
const fs = require('node:fs')
const path = require('node:path')
const sharp = require('sharp')

const DIR = path.join(__dirname, 'test-images')
const MAX = 1024
const Q = 80

async function main() {
  console.log('sharp 已加载')
  for (const name of fs.readdirSync(DIR)) {
    const src = path.join(DIR, name)
    const t0 = Date.now()
    const meta = await sharp(src).metadata()
    const out = await sharp(src)
      .rotate() // 按 EXIF 摆正
      .resize({ width: MAX, height: MAX, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: Q, mozjpeg: true })
      .toBuffer()
    const ms = Date.now() - t0
    const before = fs.statSync(src).size
    console.log(
      `${name.padEnd(12)} ${String(meta.width).padStart(5)}x${String(meta.height).padStart(5)} ` +
        `${String(meta.format).padEnd(5)} ${String(before).padStart(8)}B → ${String(out.length).padStart(7)}B ` +
        `(减 ${(100 - (out.length / before) * 100).toFixed(1)}%)  耗时 ${ms}ms`
    )
  }
}

main().catch((e) => {
  console.error('失败：' + e.message)
  process.exit(1)
})
