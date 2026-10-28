// 涓€娆℃€ф帰閽堬細Satori 鐨?Session.parse 鎬庝箞鍒?token锛堝懡浠よЕ鍙戝啓娉曞叏闈犲畠锛?// 璺戞硶锛堝繀椤诲湪 koishi-app 涓嬶紝Node 浠庤剼鏈洰褰曡В鏋愭ā鍧楋級锛?//   node tools\probe-parse.cjs
const { Argv } = require('koishi')

const cases = [
  '/chatluna.stop',
  '/chatluna/stop',
  '/鏉冮檺/鎴戠殑',
  '/鏉冮檺.鎴戠殑',
  '/qqbot.auth/me',
  '!鏉冮檺/鎴戠殑',
  '/echo 浣犲ソ',
  '/鏉冮檺/璁剧疆 10005 3',
]

for (const c of cases) {
  try {
    const argv = Argv.parse(c)
    console.log(
      JSON.stringify(c).padEnd(24),
      '鈫?tokens =',
      JSON.stringify(argv.tokens.map((t) => t.content))
    )
  } catch (e) {
    console.log(JSON.stringify(c).padEnd(24), '鈫?鎶涢敊:', e.message)
  }
}
