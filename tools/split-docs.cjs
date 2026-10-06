#!/usr/bin/env node
/**
 * split-docs.cjs —— ⚠️ 【已退役 / HISTORICAL】2026-10-02 的一次性迁移工具。
 *
 * ★★ 不要再跑这个脚本。★★
 *   它按**原始行号区间**（下面的 ROADMAP / APPEND）切分，而 `docs/` 从 2026-10-02 起就是
 *   **手写直维护**的（`docs/19`~`docs/31` 全是之后手写的，脚本完全不知道它们）。
 *   重跑 `--from <旧备份>` 会把 2026-10-02 之后的所有改动**整块回退**掉。
 *
 * 现在的文档纪律与工具链（见 docs/00-文档规范.md）：
 *   - 体量红线：单文件 > 800 行 / 80 KB 必须切段；
 *   - 体检：`node tools/check-docs.cjs`（改完文档必跑）；
 *   - 切分：新出现的超长文件手工按"轮次 / 日期 / 编号区间"切，
 *     或照 tools/split-big-docs.cjs 的 PARTS 表加一段（那份也是**一次性**脚本）。
 *
 * 保留本文件只为**记录当初 `docs/01`~`18` 的边界**（ROADMAP），方便回溯。
 * 下面这段原始说明仍然有效，仅供理解历史：
 *
 * ---------------------------------------------------------------------------
 * 把单文件《进度与交接.md》切分成 docs/ 下的多份分册，并重建索引页。
 *
 * 为什么存在：原文件 3269 行 / 190 KB，单节最大 2100 行，已经没法维护了。
 *
 * 用法：
 *   node tools/split-docs.cjs --check     # 只校验，不写盘：旧编号残留 + 链接目标是否存在
 *   node tools/split-docs.cjs             # 真切（先把原文备份成 进度与交接.md.bak-<时间戳>）
 *   node tools/split-docs.cjs --no-backup # 真切，不备份
 *
 * 设计要点（改之前先读）：
 *  1. 切割按**原始行号区间**做，不解析语义 —— 区间表在 ROADMAP / APPEND 里，一目了然。
 *  2. 每个分册内部的 `##` 标题重新从「一、」编号；原「第八·N节」的对应关系记在索引页的
 *     对照表里，所以旧对话、旧笔记里写的"见第八·十三节"仍然查得到。
 *  3. 交叉引用改写走显式表（REF_LONG / REF_SHORT / REF_INDEX），不靠通配。
 *  4. 链接一律**纯文件路径、不带 #锚点** —— 本机渲染器（DSH Web GUI）给标题不生成 id，
 *     带锚点只会看起来像坏链接。详见 README 或本文件末尾注释。
 */
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const SRC = path.join(ROOT, '进度与交接.md')
const DOCS = path.join(ROOT, 'docs')

// 切分来源。默认就是 SRC；但**切分跑过一次之后 SRC 已经是索引页了**，
// 这时要再校验/重切必须指回备份：node tools/split-docs.cjs --from 进度与交接.md.bak-2026xxxx
let SRC_OVERRIDE = null

// ---------------------------------------------------------------- 分册表
// 区间是原始 进度与交接.md 的 1-based 行号（含两端）。
const ROADMAP = [
  {
    out: '01-项目目标与需求清单.md', from: 14, to: 44, title: '项目目标与需求清单',
    note: 'R1–R18 原始需求 + 用户附加约束',
    header: '需求清单是判定"做完了没有"的唯一依据。每条的验收状态见[索引页](../进度与交接.md)。',
  },
  {
    out: '02-技术选型.md', from: 45, to: 76, title: '技术选型（已定，勿反复）',
    note: '为什么是 Koishi + ChatLuna；四个被否方案的原因',
    header: '这份是**结论**。评估过程与逐条对照见 `../nonebot-vs-koishi-13条需求调研.md` 与 `../astrbot-需求覆盖调研.md`。',
  },
  {
    out: '03-部署与回滚.md', from: 199, to: 281, title: '部署、环境事实与回滚',
    note: '改了哪些配置、本机环境事实、怎么撤回去',
    header: [
      '本机怎么装的、装在哪、改了什么、怎么撤回去。',
      '',
      '> 阶段 0+1 的逐步接线过程另有一份 [`../接线与验证.md`](../接线与验证.md)（启动步骤、三步验证、安全清单），',
      '> 那份偏"第一次怎么装"，本文件偏"现在是什么状态"。',
    ].join('\n'),
  },
  {
    out: '04-踩坑记录.md', from: 282, to: 781, title: '踩坑记录（重来一次会浪费几小时的东西）',
    note: '★ 最值钱的一份：30 条真实踩过的坑',
    header: [
      '**这是全项目最值钱的一份文档。** 每条都是真实踩过、有日志或源码佐证的。',
      '改任何配置前，先在这里搜一遍关键词。',
      '',
      '> 其它分册里的「见坑 N」全部指向本文件的第 N 条。',
    ].join('\n'),
    // ★ 切分文档之后新踩的坑接着往下写（原文件里没有这一条）
    extra: [
      '### 坑 30：跑剧本的日志只增不减，几十轮就堆成几 MB',
      '',
      '以前每跑一轮都手写一遍重定向：`node tools\\run-rig.cjs ... *> tools\\rig-24-all.log`，',
      '文件名各不相同 → `koishi-app/tools/` 下攒了 **58 个日志、4.9 MB**，而且永远只增不减。',
      '（`last-run.log` 是脚本自己用 `flags: "w"` 覆盖写的，不在其中。）',
      '',
      '**现在的规矩**：',
      '',
      '- 要存整场输出就加 `--keep-log`，写到 `koishi-app/tools/logs/rig-<剧本名>.log` ——',
      '  **同名覆盖**，同一个剧本跑一百遍也只有一个文件。',
      '- `run-rig.cjs` 每次收尾会自动清扫超过 `--keep-days`（默认 7 天）的日志；',
      '  想手动清就 `node tools\\clean-logs.cjs`（预演）→ `--force`（真删）。',
      '- 日志文件名里的 `-all` 后缀是"连着 koishi 的 stderr 一起重定向"的意思，',
      '  能拿到完整时间线；`last-run.log` 只有伪 OneBot 的收发，看 koishi 侧日志得用 `--keep-log`。',
      '',
      '**★ 两个实现上的坑（都踩过）**：',
      '',
      '1. **清扫必须排在 tee 落盘之后**。反过来的话本次刚写的日志会被自己删掉 ——',
      '   `keep-days 0` 时尤其明显（cutoff 就是"现在"，而刚写完的文件 mtime 早几毫秒）。',
      '   解法是 `pruneLogs({ keepFiles: [tee.file] })` 把本次日志钉住。',
      '2. 不要用 `writeFileSync` 逐行写日志。剧本一轮几万行，同步写盘会明显拖慢时间线；',
      '   用 `createWriteStream`，并且**记得 `await end()`**，否则最后几行不落盘。',
    ].join('\n'),
  },
  {
    out: '05-硬约束.md', from: 782, to: 802, title: '硬约束（设计时必须遵守）',
    note: '违反就会在别处炸出来的红线',
    header: '违反这里的任何一条，都会在别处炸出来。**加新功能前先读这份。**',
  },
  {
    out: '06-阶段2计划与ChatLuna生态.md', from: 803, to: 866, title: '阶段 2 计划与 ChatLuna 生态实测',
    note: '推进顺序 + 2026-09-28 生态/镜像实测结论',
    partTitles: ['阶段 2 推进顺序（一次只加一样）'],
    header: '阶段 2 的推进顺序（原「一次只加一样」）。**第二部分的生态、镜像、API 中转实测结论仍然有效**，装任何 ChatLuna 插件前先看它。',
  },
  {
    out: '07-R13权限分级.md', from: 985, to: 1032, title: 'R13 权限分级',
    note: '机制调研 → 自写插件实现 → 13/13 验收',
    partTitles: ['权限机制调研（实现前）'],
    header: '**第一部分是实现前的机制调研留档**（Koishi authority 0–4 的数据模型、控制台路径、已确认的门槛样例），**第二部分是实现与验收**。',
  },
  {
    out: '08-R14R18情绪控制.md', from: 1045, to: 1105, title: 'R14 / R18 情绪控制',
    note: '调研 → 方案 → 自写插件 → 过期清扫',
    partTitles: ['R14 情绪控制：调研结论与方案'],
    header: '**R14（情绪）与 R18（情绪过期）是同一件事的两个阶段**，所以放一份里。',
  },
  {
    out: '09-图片策略与表情包.md', from: 1183, to: 1312, title: 'R6/R7/R8 图片策略',
    note: '自写 chatluna-vision：解析、引用图、缓存',
    header: '自写 `chatluna-vision`：私聊解析、群聊引用图解析、解析缓存。表情包（R5/R7）见本文件第二部分。',
  },
  {
    out: '10-消息聚合与跟进触发.md', from: 1313, to: 1435, title: 'R10 消息聚合 + 群聊跟进触发',
    note: '内建聚合/延迟 + 自写 chatluna-followup 挂载点',
    header: '两件事：聚合与延迟用 ChatLuna 内建，跟进触发是自写 `chatluna-followup`。**「挂载点」那一节是这一轮最重要的发现。**',
  },
  {
    out: '11-测试台.md', from: 1436, to: 1573, title: '自动化测试台（★ 以后不用真人拿手机测了）',
    note: '伪 OneBot + 剧本回放 + 独立测试实例',
    header: '伪 OneBot 服务端 + 剧本回放 + 独立测试实例。**所有验收记录都出自这里。** 剧本清单见[常用命令速查](17-常用命令速查.md)。',
  },
  {
    out: '12-R3长期记忆与向量库.md', from: 1731, to: 1891, title: 'R3 长期记忆（现成插件）',
    note: 'long-memory + Emgas/HippoRAG；含 R16 过期、R17 向量库',
    header: '`chatluna-long-memory` 1.4.0 + Emgas/HippoRAG + 真向量库。**R16 知识过期（第二部分）与 R17 向量库（第三部分）是这条线的续集。**',
  },
  {
    out: '13-R4好感度.md', from: 2010, to: 2163, title: 'R4 好感度（现成插件 + 自写桥）',
    note: 'chatluna-affinity + 好感度→2 级信任桥',
    header: '`chatluna-affinity` 0.3.15 + 自写「好感度 → 2 级信任」桥。',
  },
  {
    out: '14-R9插话与R11会话生命周期.md', from: 2164, to: 2286, title: 'R9 择机插话 + R11 会话生命周期',
    note: '两个自写插件：proactive / scene 状态机',
    header: '两个自写插件：`chatluna-proactive`（活跃度 / 空闲触发）与 `chatluna-scene`（scene 状态机 + 收局终止会话）。',
  },
  {
    out: '15-R12自我扩展与R15屏蔽.md', from: 2384, to: 2482, title: 'R12 自我扩展 + R15 群聊屏蔽开关',
    note: '两个自写插件：selfext / guard 四道闸门',
    partTitles: ['R12 自我扩展'],
    header: '两个自写插件：`chatluna-selfext`（搜插件 / 申请 / 主人安装）与 `chatluna-guard`（四道闸门 + HTTP 控制口）。',
  },
  {
    out: '16-真群接入与限流事故.md', from: 2936, to: 3092, title: '接入第一个真实群 + 第一次限流事故',
    note: '★ 2026-10-02 真群 1040488785，刷屏被腾讯限流',
    header: '2026-10-02。**第一个真实群 `1040488785`「空弓玄天下第一！」**：R15 默认静默当场生效 → 放行 → 2 分半发了 20 条被腾讯限流 → 补上两道闸。',
  },
  {
    out: '17-常用命令速查.md', from: 3093, to: 3220, title: '常用命令速查',
    note: '启动/停止、读库、跑剧本、NapCat 探针、git',
    header: '启动 / 停止、读库、跑剧本、NapCat 探针、git。**改动任何东西之前先来这里看有没有现成脚本。**',
    // ★ 切分文档之后新增的命令（原文件里没有这一节）
    extra: [
      '## 日志与文档维护',
      '',
      '```powershell',
      'cd D:\\deepseek\\QQbot',
      '',
      '# 日志：看会删什么（不动手） / 真删 / 改保留天数',
      'node tools\\clean-logs.cjs',
      'node tools\\clean-logs.cjs --force',
      'node tools\\clean-logs.cjs --force --days 2      # 只留最近 2 天',
      'node tools\\clean-logs.cjs --force --days 0      # 除 last-run.log / prod.log 全清',
      'node tools\\clean-logs.cjs --force --all         # 连 koishi-test\\ 下的日志一起扫',
      '',
      '# 跑剧本时想留整场输出（含 koishi 的 stderr）：加到 run-rig 后面即可',
      'cd koishi-app',
      'node tools\\run-rig.cjs tools\\scenarios\\29-guard-cmd-and-ttl.json --settle 22000 --run 165000 --keep-log',
      '#   -> 写到 tools\\logs\\rig-29-guard-cmd-and-ttl.log（同名覆盖，不会越跑越多）',
      '#   --keep-days 3   这次清扫的保留天数',
      '#   --no-prune      这次不清扫',
      'cd D:\\deepseek\\QQbot',
      '',
      '# ★ 启动生产实例：用启动器，别再用 `*> tools\\prod.log`（那是追加，会无限长）',
      'cd koishi-app',
      'node tools\\run-prod.cjs',
      '#   -> 按天一个文件 tools\\logs\\prod-YYYY-MM-DD.log，退出时自动清扫超期日志',
      '#   --log-level 3 / --keep-days 3 / --no-prune 都会被正确解析',
      '#   5140 被占用时直接拒绝启动（防重复启动导致的"静默半死"，见坑 6）',
      'cd D:\\deepseek\\QQbot',
      '',
      '# 文档：分册是 tools\\split-docs.cjs 的生成物，不要直接改 docs\\',
      'node tools\\split-docs.cjs --check --from 进度与交接.md.bak-<时间戳>   # 只校验',
      'node tools\\split-docs.cjs --from 进度与交接.md.bak-<时间戳> --no-backup # 重切',
      '```',
      '',
      '> 日志策略的完整说明见 [踩坑记录第 30 条](04-踩坑记录.md)；',
      '> 文档切分的边界表在 [`tools/split-docs.cjs`](../tools/split-docs.cjs) 的 `ROADMAP` / `APPEND` 里。',
      '> 老的 `koishi-app\\tools\\prod.log`（989 KB，追加式写入的遗留物）确认没用之后可以手删。',
    ].join('\n'),
  },
  {
    out: '18-产出物清单.md', from: 3221, to: 3269, title: '产出物清单',
    note: '仓库里每一个"自己写的东西"和它的用途',
    header: '仓库里每一个"自己写的东西"、它在哪、干什么用的。',
    // ★ 切分文档之后新增的产出物（原文件里没有这一节）
    extra: [
      '## 文档本体',
      '',
      '| 路径 | 内容 |',
      '|---|---|',
      '| `进度与交接.md` | **索引页**：分册导航、当前状态表、未决事项、旧编号对照表 |',
      '| `docs/01` ~ `docs/18` | **18 份分册**，按主题切开（见索引页的「分册导航」） |',
      '| `tools/split-docs.cjs` | **切分脚本**：区间表 + 引用改写 + 校验（`--check` 只校验不写盘） |',
      '| `tools/clean-logs.cjs` | **日志清理**：预演 / `--force` 真删 / `--days N` 改保留期 |',
      '| `koishi-app/tools/run-prod.cjs` | **生产启动器**：按天一个日志 + 退出清扫 + 5140 占用保护（替代 `*> tools\\prod.log`） |',
      '| `koishi-app/tools/log-retention.cjs` | 日志保留策略（同名覆盖 + 超期清扫），被 `run-rig.cjs` / `run-prod.cjs` 复用 |',
      '| `进度与交接.md.bak-<时间戳>` | 切分前的原单文件备份，确认没问题后可以删 |',
      '',
      '> 分册是 `tools/split-docs.cjs` 的**生成物**，不是手写文件。',
      '> 要加一节、挪一节、改交叉引用，改脚本里的 `ROADMAP` / `APPEND` / `REF_*` 再重跑，',
      '> 不要直接编辑 `docs/` 里的文件（下次重跑会被覆盖）。',
      '> 重跑必须先指回原始文件（索引页不能当来源）：',
      '',
      '```powershell',
      'cd D:\\deepseek\\QQbot',
      'node tools\\split-docs.cjs --check --from 进度与交接.md.bak-<时间戳>   # 只校验',
      'node tools\\split-docs.cjs --from 进度与交接.md.bak-<时间戳> --no-backup # 重切',
      '```',
    ].join('\n'),
  },
]

// 同一份分册里要接在后面的追加区间（原「第八·N节」）。
// ★★ 这两张表必须是**不重叠的划分**，不是嵌套：比如 08 的主区间到 1105，
//    追加区间从 1106 起。写重叠了会整段重复（本脚本的 --check 会报「区间重叠」）。
const APPEND = {
  '06-阶段2计划与ChatLuna生态.md': [
    { from: 867, to: 984, title: 'ChatLuna 生态实测结果（2026-09-28）' },
  ],
  '07-R13权限分级.md': [
    { from: 1574, to: 1730, title: 'R13 权限分级：已实现并端到端验收（自写插件）' },
  ],
  '08-R14R18情绪控制.md': [
    { from: 1106, to: 1182, title: 'R14 情绪控制：已实现（自写插件）' },
    { from: 2875, to: 2935, title: 'R18 情绪过期：绝对保质期 + 后台清扫' },
  ],
  '09-图片策略与表情包.md': [
    { from: 1892, to: 2009, title: 'R5/R7 表情包：已实现并端到端验收（现成插件）' },
  ],
  '12-R3长期记忆与向量库.md': [
    { from: 2645, to: 2743, title: 'R16 知识过期：用 chatluna 自带的 autoArchive' },
    { from: 2744, to: 2874, title: 'R17 长期记忆接真向量库' },
  ],
  '14-R9插话与R11会话生命周期.md': [
    { from: 2287, to: 2383, title: 'R11 会话生命周期：自写插件' },
  ],
  '15-R12自我扩展与R15屏蔽.md': [
    { from: 2483, to: 2644, title: 'R15 群聊屏蔽开关：自写插件' },
  ],
}

// 索引页正文要保留的原文区间
const INDEX_STATUS = { from: 79, to: 198 }   // 原「三、当前状态」的正文
const INDEX_TODO = { from: 1035, to: 1041 }  // 原「八·七、未决/待验证」的正文

// ---------------------------------------------------------------- 引用改写
// 分册之间的链接在两种上下文里前缀不同：
//   分册内部（docs/ 里）→ 兄弟文件，直接 `07-R13权限分级.md`
//   索引页（仓库根）    → 要写成 `docs/07-R13权限分级.md`
// 所以下面统一只写**裸文件名**，由 rewriteRefs 按上下文补前缀。
const INDEX_HEADING = '章节对照表（原单文件 → 现在的分册）'

const REF_LONG = [
  ['第八·十一节', `[消息聚合与跟进触发](${'10-消息聚合与跟进触发.md'})`],
  ['第八·十三节', `[R13 权限分级](${'07-R13权限分级.md'})`],
  ['第八·二十四节', `[真群接入与限流事故](${'16-真群接入与限流事故.md'})`],
  ['第八·二十三节', `[R18 情绪过期](${'08-R14R18情绪控制.md'})`],
  ['第八·二十二节', `[R17 长期记忆接真向量库](${'12-R3长期记忆与向量库.md'})`],
  ['第八·二十一节', `[R16 知识过期](${'12-R3长期记忆与向量库.md'})`],
  ['第八·二十节', `[R15 群聊屏蔽开关](${'15-R12自我扩展与R15屏蔽.md'})`],
  ['第八·十九节', `[R12 自我扩展](${'15-R12自我扩展与R15屏蔽.md'})`],
  ['第八·十八节', `[R11 会话生命周期](${'14-R9插话与R11会话生命周期.md'})`],
  ['第八·十七节', `[R9 择机插话](${'14-R9插话与R11会话生命周期.md'})`],
  ['第八·十六节', `[R4 好感度](${'13-R4好感度.md'})`],
  ['第八·十五节', `[R5/R7 表情包](${'09-图片策略与表情包.md'})`],
  ['第八·十四节', `[R3 长期记忆](${'12-R3长期记忆与向量库.md'})`],
  ['第八·十二节', `[自动化测试台](${'11-测试台.md'})`],
  ['第八·十节', `[R6/R7/R8 图片策略](${'09-图片策略与表情包.md'})`],
  ['第八·九节', `[R14 情绪控制](${'08-R14R18情绪控制.md'})`],
  ['第八·六节', `[R13 权限机制](${'07-R13权限分级.md'})`],
  ['第八·五节', `[ChatLuna 生态实测](${'06-阶段2计划与ChatLuna生态.md'})`],
]

// 短引用按**出现它的分册**分别定义（"第八·五节"在坑 14 那条里、在生态章里含义不同）
const REF_SHORT = {
  '06-阶段2计划与ChatLuna生态.md': [
    ['第八·六节', '本文件第一部分'],
    ['API Key 已填（commandcode 中转，见[ChatLuna 生态实测](06-阶段2计划与ChatLuna生态.md)）', 'API Key 已填（commandcode 中转，见本文件第二部分的「⚠️ API 用的是第三方中转」）'],
    ['第八·十节', '[R6/R7/R8 图片策略](09-图片策略与表情包.md)'],
    ['第八·十四节', '[R3 长期记忆](12-R3长期记忆与向量库.md)'],
    ['第八·十五节', '[R5/R7 表情包](09-图片策略与表情包.md)'],
    ['第八·十六节', '[R4 好感度](13-R4好感度.md)'],
    ['第八·十七节', '[R9 择机插话](14-R9插话与R11会话生命周期.md)'],
    ['第八·十八节', '[R11 会话生命周期](14-R9插话与R11会话生命周期.md)'],
    ['第八·十九节', '[R12 自我扩展](15-R12自我扩展与R15屏蔽.md)'],
    ['第八·二十四节', '[真群接入与限流事故](16-真群接入与限流事故.md)'],
    ['第九节', '[常用命令速查](17-常用命令速查.md)'],
  ],
  '08-R14R18情绪控制.md': [
    ['第八·二十三节', '本文件第三部分'],
  ],
  '09-图片策略与表情包.md': [
    ['第七节硬约束 1', '[硬约束](05-硬约束.md)第 1 条'],
    ['第六节模型能力判定', '[R14 情绪插件那节的「两个必须记住的 API 事实」](08-R14R18情绪控制.md)'],
  ],
  '12-R3长期记忆与向量库.md': [
    ['第八·十三节', '[R13 权限分级](07-R13权限分级.md)'],
  ],
  '15-R12自我扩展与R15屏蔽.md': [
    ['硬约束第八节第 2 条', '[硬约束](05-硬约束.md)第 2 条'],
  ],
  '17-常用命令速查.md': [
    ['见第八·十二节', '见[自动化测试台](11-测试台.md)'],
    ['见第三节警告', '见[部署与回滚](03-部署与回滚.md)里的警告'],
  ],
  '18-产出物清单.md': [
    [
      '| `D:\\deepseek\\QQbot\\进度与交接.md` | **本文件** |',
      '| `D:\\deepseek\\QQbot\\进度与交接.md` | **索引页**（原单文件已拆分，见本文件末尾「文档本体」） |',
    ],
  ],
}

// 指向已经不存在的节的引用，手工修掉
const DANGLING = [
  ['（见第八节末）', '（见 [18-产出物清单](18-产出物清单.md)）'],
  ['（见第八·十三节）', '（见 [R13 权限分级](07-R13权限分级.md)）'],
]

// ---------------------------------------------------------------- 工具
const readSrc = () => fs.readFileSync(SRC_OVERRIDE ?? SRC, 'utf8').split(/\r?\n/)
const isH2 = (s) => /^## /.test(s)
const isH3 = (s) => /^### /.test(s)
/**
 * 是不是真的一级标题。
 * ★ 不能简单用 /^# / —— PowerShell 代码块里的注释（`# 启动 Koishi`）长得一模一样，
 *   本项目的文档里这种注释有 30+ 条（见 17-常用命令速查.md）。所以判断必须**跳过代码围栏**，
 *   用 fenceMask()。见坑 12 的同源问题。
 */
const isH1 = (s) => /^# /.test(s)

/** 返回与 lines 等长的布尔数组：true 表示该行在代码围栏里（或被围栏行本身占用） */
function fenceMask(lines) {
  const mask = []
  let inFence = false
  for (const l of lines) {
    if (/^\s*(```|~~~)/.test(l)) { mask.push(true); inFence = !inFence; continue }
    mask.push(inFence)
  }
  return mask
}

function cnNum(n) {
  const d = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九']
  if (n <= 9) return d[n]
  if (n === 10) return '十'
  if (n < 20) return '十' + d[n - 10]
  if (n === 20) return '二十'
  return '二十' + d[n - 20]
}

function rewriteRefs(text, file, { index = false } = {}) {
  let out = text
  // 索引页里"教你怎么查旧编号"的那一行必须原样保留旧编号，
  // 否则会被 REF_LONG 换成链接、句子就废了。用占位符挡一下。
  const GUARD = '\u0000GUARD\u0000'
  if (index) out = out.split('「第八·十三节」这种').join(`${GUARD}这种`)
  for (const [from, to] of REF_LONG) out = out.split(from).join(to)
  for (const [from, to] of REF_SHORT[file] ?? []) out = out.split(from).join(to)
  for (const [from, to] of DANGLING) out = out.split(from).join(to)
  if (index) out = out.split(GUARD).join('「第八·十三节」')
  // 补前缀：索引页（仓库根）要 docs/，分册之间不要
  out = out.replace(/\]\((?:\.\/)?(\d\d-[^)/]+\.md)\)/g, (_, f) => `](${index ? 'docs/' : ''}${f})`)
  // 索引页自己的分册目录链接
  if (index) out = out.replace(/\]\(docs\)/g, '](docs/)')
  return out
}

// ---------------------------------------------------------------- 切分册
function buildFiles() {
  const src = readSrc()
  const slice = (from, to) => src.slice(from - 1, to)
  const out = {}

  for (const entry of ROADMAP) {
    // 第一部分的标题默认跟 entry.title 相同（那就压掉这个多余的小标题）；
    // 但一份分册装了多个主题（比如 14 = R9 + R11）时，第一部分需要一个**只描述自己**的名字，
    // 否则会读成"这份文件只有 R9"。用 partTitles[0] 覆盖。
    const firstTitle = entry.partTitles?.[0] ?? entry.title
    const parts = [{ title: firstTitle, lines: slice(entry.from, entry.to) }]
    for (const extra of APPEND[entry.out] ?? []) {
      parts.push({ title: extra.title, lines: slice(extra.from, extra.to) })
    }

    const body = []
    let emitted = 0
    parts.forEach((part) => {
      // 丢掉原文的 `## ...` 行（它的旧编号我们已经不需要了），保留其余一切
      const rest = part.lines.filter((l) => !isH2(l))
      while (rest.length && rest[0].trim() === '') rest.shift()
      while (rest.length && rest[rest.length - 1].trim() === '') rest.pop()
      if (part.title !== entry.title) {
        emitted += 1
        body.push(`## ${cnNum(emitted)}、${part.title}`, '')
      }
      body.push(...rest, '', '---', '')
    })

    // extra：切分之后新加的内容（原文件里没有的）。改这里 == 改产出文件。
    if (entry.extra) body.push(entry.extra, '', '---', '')

    let text = body.join('\n')
    text = rewriteRefs(text, entry.out)
    // 相邻的两个 `---`（原段落自带的 + 我们分块加的）合并成一个
    text = text.replace(/(?:^|\n)-{3,}\s*\n\s*\n-{3,}\s*\n/g, '\n---\n')
    text = text.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'

    out[entry.out] = [
      `# ${entry.title}`,
      '',
      '> 属于 [QQ 机器人项目 —— 进度与交接](../进度与交接.md) 的分册。',
      '> 旧编号（如「第八·十三节」）的去向见索引页的章节对照表。',
      '',
      entry.header ? `${entry.header}\n` : '',
      text,
      '',
      '[← 回索引页](../进度与交接.md)',
      '',
    ].join('\n')
  }
  return out
}

// ---------------------------------------------------------------- 索引页
const REF_INDEX_TITLE = '章节对照（原单文件 → 现在的分册）'

function buildIndex() {
  const src = readSrc()
  const sliceClean = ({ from, to }) =>
    src.slice(from - 1, to).filter((l) => !isH2(l) && !/^---\s*$/.test(l)).join('\n').replace(/\n{3,}/g, '\n\n').trim()

  const status = sliceClean(INDEX_STATUS)
  const todo = sliceClean(INDEX_TODO)

  const navRows = ROADMAP.map((e) => `| [${e.title}](docs/${e.out}) | ${e.note} |`).join('\n')

  // 旧第八·N节 → 现在在哪
  const SM = [
    ['第八', '下一步：阶段 2 顺序（一次只加一样）', '06-阶段2计划与ChatLuna生态.md', '一'],
    ['第八·五', 'ChatLuna 生态实测结果', '06-阶段2计划与ChatLuna生态.md', '二'],
    ['第八·六', 'R13 权限机制——已探明的实现细节', '07-R13权限分级.md', '一'],
    ['第八·七', '未决 / 待验证', '（已并回本索引页的「未决」）', ''],
    ['第八·八', 'R14 情绪控制——调研结论与方案', '08-R14R18情绪控制.md', '一'],
    ['第八·九', 'R14 情绪控制——已实现', '08-R14R18情绪控制.md', '二'],
    ['第八·十', 'R6/R7/R8 图片策略——已实现并实测跑通', '09-图片策略与表情包.md', '一'],
    ['第八·十一', '消息聚合 + 群聊跟进触发', '10-消息聚合与跟进触发.md', '一'],
    ['第八·十二', '自动化测试台', '11-测试台.md', '一'],
    ['第八·十三', 'R13 权限分级——已实现并端到端验收', '07-R13权限分级.md', '二'],
    ['第八·十四', 'R3 长期记忆——已实现并端到端验收', '12-R3长期记忆与向量库.md', '一'],
    ['第八·十五', 'R5/R7 表情包——已实现并端到端验收', '09-图片策略与表情包.md', '二'],
    ['第八·十六', 'R4 好感度——已实现并端到端验收', '13-R4好感度.md', '一'],
    ['第八·十七', 'R9 择机插话——自写插件', '14-R9插话与R11会话生命周期.md', '一'],
    ['第八·十八', 'R11 会话生命周期——自写插件', '14-R9插话与R11会话生命周期.md', '二'],
    ['第八·十九', 'R12 自我扩展——自写插件', '15-R12自我扩展与R15屏蔽.md', '一'],
    ['第八·二十', 'R15 群聊屏蔽开关——自写插件', '15-R12自我扩展与R15屏蔽.md', '二'],
    ['第八·二十一', 'R16 知识过期——用 chatluna 自带 autoArchive', '12-R3长期记忆与向量库.md', '二'],
    ['第八·二十二', 'R17 长期记忆接真向量库', '12-R3长期记忆与向量库.md', '三'],
    ['第八·二十三', 'R18 情绪过期——绝对保质期 + 后台清扫', '08-R14R18情绪控制.md', '三'],
    ['第八·二十四', '接入第一个真实群', '16-真群接入与限流事故.md', '一'],
  ]

  const top = [
    ['一', '目标', '01-项目目标与需求清单.md'],
    ['二', '技术选型（已定，勿反复）', '02-技术选型.md'],
    ['三', '当前状态', '（就是本索引页的「当前状态」）'],
    ['四', '已做的改动（可回滚）', '03-部署与回滚.md'],
    ['五', '环境事实', '03-部署与回滚.md'],
    ['六', '踩坑记录', '04-踩坑记录.md'],
    ['七', '硬约束（设计时必须遵守）', '05-硬约束.md'],
    ['八', '下一步 / 各 R 实现记录', '拆成 06 ~ 16 共 11 份，见下表'],
    ['九', '常用命令速查', '17-常用命令速查.md'],
    ['十', '产出物清单', '18-产出物清单.md'],
  ]

  const doc = [
    `# QQ 机器人项目 —— 进度与交接`,
    ``,
    `> 用于对话压缩后的续接。**只信这份文件，不要靠记忆。**`,
    `> 最后更新：2026-10-02 01:00（**接入第一个真实群** \`1040488785\`「空弓玄天下第一！」：`,
    `> R15 默认静默当场生效（34 条群消息全被丢弃）；放行 + 接入 R9 主动插话后**踩了第一个真群事故**——`,
    `> \`chatluna-followup\` 的窗口是按人开的，30 人群里 2 分半发了 20 条，被腾讯限流（\`retcode 1200\`）。`,
    `> 已给 followup 补上「**按群覆盖**」+「**整群熔断**」两道闸并机台验收（rig 34/35），生产已重新放行，`,
    `> 见 [真群接入与限流事故](docs/16-真群接入与限流事故.md) 与 [踩坑记录第 29 条](docs/04-踩坑记录.md)。`,
    `> 上一轮：**R17 长期记忆接真向量库**、**R18 情绪过期**，见 [R3 长期记忆与向量库](docs/12-R3长期记忆与向量库.md) 与 [R14/R18 情绪控制](docs/08-R14R18情绪控制.md)；`,
    `> 坑 27/28 是那轮踩的。R9/R11/R12/R13/R14/R15/R16/R17/R18 各项均已验收上线，git 仓库已建立。）`,
    ``,
    `> **本文件已于 2026-10-02 拆分。** 原来是一个 3269 行 / 190 KB 的单文件，`,
    `> 现在正文按主题放进 [\`docs/\`](docs/)，本页只留导航、当前状态和未决事项。`,
    `> 拆分原因与边界见 [产出物清单](docs/18-产出物清单.md)。`,
    ``,
    `---`,
    ``,
    `## 怎么用这份文档`,
    ``,
    `1. **先看下面的「当前状态」表** —— 每个 R 的验收状态、指向哪份分册。`,
    `2. **要改配置 / 加功能**：先读 [硬约束](docs/05-硬约束.md)，再去 [踩坑记录](docs/04-踩坑记录.md) 搜关键词。`,
    `3. **要跑验收**：剧本清单和命令全在 [常用命令速查](docs/17-常用命令速查.md)，机制在 [自动化测试台](docs/11-测试台.md)。`,
    `4. **旧笔记里写的「第八·十三节」「坑 15」怎么查**：`,
    `   - 「坑 N」⇒ 搜 [踩坑记录](docs/04-踩坑记录.md)（序号没变）；`,
    `   - 「第八·十三节」这种 ⇒ 查本页下面的「${INDEX_HEADING}」。`,
    `5. **每份分册的结尾都有「← 回索引页」**，不会迷路。`,
    ``,
    `---`,
    ``,
    `## 分册导航`,
    ``,
    `| 分册 | 内容 |`,
    `|---|---|`,
    navRows,
    ``,
    `> 根目录还有三份**阶段 0+1 的原始留档**（不在 \`docs/\` 里）：`,
    `> [\`接线与验证.md\`](接线与验证.md)、[\`nonebot-vs-koishi-13条需求调研.md\`](nonebot-vs-koishi-13条需求调研.md)、`,
    `> [\`astrbot-需求覆盖调研.md\`](astrbot-需求覆盖调研.md)。`,
    ``,
    `---`,
    ``,
    `## 当前状态`,
    ``,
    status,
    ``,
    `---`,
    ``,
    `## 未决 / 待验证`,
    ``,
    todo,
    ``,
    `---`,
    ``,
    `## ${INDEX_HEADING}`,
    ``,
    `原顶层章节：`,
    ``,
    `| 原章节 | 现在在哪 |`,
    `|---|---|`,
    ...top.map(([n, t, where]) => `| ${n}、${t} | ${where} |`),
    ``,
    `原「第八·N节」：`,
    ``,
    `| 原编号 | 标题 | 分册 | 第几部分 |`,
    `|---|---|---|---|`,
    ...SM.map(([n, t, f, p]) => `| ${n} | ${t} | ${f.startsWith('（') ? f : `[\`docs/${f}\`](docs/${f})`} | ${p} |`),
    ``,
    `> 「坑 N」全部在 [\`docs/04-踩坑记录.md\`](docs/04-踩坑记录.md) 里，序号没变 —— 直接搜「坑 N」即可。`,
    ``,
    `---`,
    ``,
    `## 我改了文档结构（可回滚）`,
    ``,
    `2026-10-02 把本文件拆成了 \`docs/\` 下的 18 份分册。回滚方式：`,
    ``,
    '```powershell',
    `# 原文件已备份成 进度与交接.md.bak-<时间戳>，直接覆盖回来即可`,
    `Get-ChildItem 进度与交接.md.bak-* | Sort-Object LastWriteTime -Descending | Select-Object -First 1 |`,
    `  Copy-Item -Destination 进度与交接.md -Force`,
    `# 分册是生成物，可以整目录删掉：`,
    `Remove-Item docs -Recurse -Force`,
    '```',
    ``,
    `拆分的脚本是 [\`tools/split-docs.cjs\`](tools/split-docs.cjs)（保留下来，以后要重新切或加分册就改它）。`,
    ``,
  ].join('\n')

  return rewriteRefs(doc, '进度与交接.md', { index: true })
}

// ---------------------------------------------------------------- 校验
function verify(files, indexText) {
  const problems = []
  const all = { ...files, '进度与交接.md': indexText }
  // 计划产出 + 磁盘上已有的文件，合并成"可达目标"集合（支持 --check 在写盘前跑）
  const diskDocs = fs.existsSync(DOCS) ? fs.readdirSync(DOCS) : []

  // 1) 旧编号残留（放过索引页的对照表本身：那里的旧编号是有意保留的反查数据）
  for (const [name, text] of Object.entries(all)) {
    const ls = text.split('\n')
    const fence = fenceMask(ls)
    ls.forEach((l, i) => {
      if (fence[i]) return                                   // 代码块里的原文照旧，不动
      if (isH1(l) || /^\s*#{2,6} /.test(l)) return            // 标题行里提到旧编号是在解释历史
      if (/^>\s*旧编号/.test(l)) return                        // 分册页眉里的说明
      if (/^\|\s*[^|]*第[一二三四五六七八九十·]+/.test(l)) return // 对照表的行
      if (/「第八·N节」/.test(l)) return                        // 解释"旧编号怎么查"的说明文字
      if (/^\s*-\s*「第八·十三节」这种/.test(l)) return          // 索引页里那一条举例
      for (const pat of ['第八·', '见第八节', '见第六节', '见第七节', '见第三节', '见第九节']) {
        if (l.includes(pat)) problems.push(`旧编号残留 ${name}:${i + 1} 「${pat}」 ${l.trim().slice(0, 90)}`)
      }
    })
  }

  // 2) 链接目标存在（相对链接按该文件所在目录解析）
  for (const [name, text] of Object.entries(all)) {
    const base = name === '进度与交接.md' ? ROOT : DOCS
    const re = /\]\((?!https?:|#)([^)#]+?)(?:#[^)]*)?\)/g
    let m
    while ((m = re.exec(text))) {
      const rel = m[1]
      if (fs.existsSync(path.resolve(base, rel))) continue
      // 直接看计划产出里有没有（--check 时磁盘还是空的）
      const bare = rel.replace(/^docs\//, '')
      if (Object.prototype.hasOwnProperty.call(files, bare) || diskDocs.includes(bare)) continue
      if (rel === 'docs/' && Object.keys(files).length) continue
      problems.push(`死链 ${name}: ${rel}`)
    }
  }

  // 3) 分册里不该再有裸的顶层「第N节」短引用
  for (const [name, text] of Object.entries(files)) {
    text.split('\n').forEach((l, i) => {
      if (/[（(]见[一二三四五六七八九十]+节/.test(l)) {
        problems.push(`短引用未改 ${name}:${i + 1} ${l.trim().slice(0, 90)}`)
      }
    })
  }

  // 4) 每个分册都应恰好有一个 h1、且结尾有回索引页的链接
  //    ★ 必须跳过代码围栏：本项目的 powershell 代码块里有 30+ 条 `# 注释`，与 h1 长得一样。
  for (const [name, text] of Object.entries(files)) {
    const ls = text.split('\n')
    const fence = fenceMask(ls)
    const h1 = ls.filter((l, i) => !fence[i] && isH1(l)).length
    if (h1 !== 1) problems.push(`${name} 的 h1 数量是 ${h1}（应为 1）`)
    if (!text.includes('[← 回索引页](../进度与交接.md)')) problems.push(`${name} 缺少回索引页的链接`)
  }

  // 5) 覆盖性：原文每一行要么被某份产出接管，要么是"有意丢弃"的（旧 h2 标题 / 分隔线 / 索引页自己留的）
  const taken = new Set()
  for (const e of ROADMAP) for (let i = e.from; i <= e.to; i++) taken.add(i)
  for (const list of Object.values(APPEND)) for (const e of list) for (let i = e.from; i <= e.to; i++) taken.add(i)
  for (let i = INDEX_STATUS.from; i <= INDEX_STATUS.to; i++) taken.add(i)
  for (let i = INDEX_TODO.from; i <= INDEX_TODO.to; i++) taken.add(i)
  const src = readSrc()
  const dropped = []
  for (let i = 1; i <= src.length; i++) {
    if (taken.has(i)) continue
    const l = src[i - 1]
    // 允许丢的：空行、`---`、旧 h2 标题、以及顶部那 13 行旧页眉
    const ok = i <= 13 || l.trim() === '' || /^-{3,}$/.test(l.trim()) || isH2(l) || isH3(l)
    if (!ok) dropped.push(`原文第 ${i} 行没有被任何分册接管，且不是可丢内容：${l.trim().slice(0, 80)}`)
  }
  problems.push(...dropped)

  // 6) 区间不许重叠 —— 重叠 = 同一段正文被写进两份分册（或者一份里出现两次）。
  //    ★ 覆盖检查（第 5 条）抓不到这个，因为"被覆盖过"依然成立。
  const owner = new Map()
  const claim = (who, from, to) => {
    for (let i = from; i <= to; i++) {
      if (owner.has(i)) problems.push(`区间重叠：原第 ${i} 行同时被 ${owner.get(i)} 和 ${who} 认领`)
      else owner.set(i, who)
    }
  }
  for (const e of ROADMAP) claim(e.out, e.from, e.to)
  for (const [out, list] of Object.entries(APPEND)) for (const e of list) claim(`${out}(追加)`, e.from, e.to)
  claim('索引页', INDEX_STATUS.from, INDEX_STATUS.to)
  claim('索引页', INDEX_TODO.from, INDEX_TODO.to)

  // 7) 同一份分册里不该出现重复正文块（≥4 行连续实质内容重复）
  for (const [name, text] of Object.entries(files)) {
    const ls = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 12 && !/^[|>-]/.test(l))
    const seen = new Map()
    for (let i = 0; i + 4 <= ls.length; i++) {
      const key = ls.slice(i, i + 4).join('\u0001')
      if (seen.has(key)) {
        problems.push(`重复正文块 ${name}：${JSON.stringify(ls[i].slice(0, 60))} 出现至少两次`)
        break
      }
      seen.set(key, i)
    }
  }

  return problems
}

// ---------------------------------------------------------------- 主流程
function main() {
  const args = process.argv.slice(2)
  const fromAt = args.indexOf('--from')
  if (fromAt >= 0) {
    const p = path.resolve(ROOT, args[fromAt + 1] ?? '')
    if (!fs.existsSync(p)) {
      console.error(`--from 指定的文件不存在：${args[fromAt + 1]}`)
      process.exit(1)
    }
    SRC_OVERRIDE = p
  }

  const files = buildFiles()
  const indexText = buildIndex()

  if (args.includes('--check')) {
    const problems = verify(files, indexText)
    for (const p of problems) console.log('  ✗ ' + p)
    console.log(
      problems.length
        ? `\n❌ ${problems.length} 个问题`
        : `\n✅ 校验通过（来源：${path.relative(ROOT, SRC_OVERRIDE ?? SRC)}）`,
    )
    process.exitCode = problems.length ? 1 : 0
    return
  }

  // 已经切过一次了还直接重跑，会把索引页当成来源 -> 必须拦住
  const current = fs.readFileSync(SRC, 'utf8')
  if (!SRC_OVERRIDE && current.includes('章节对照（原单文件 → 现在的分册）')) {
    console.error(
      '进度与交接.md 已经变成索引页了，不能再当切分来源。\n' +
        '请指定原始文件：node tools/split-docs.cjs --from 进度与交接.md.bak-<时间戳>',
    )
    process.exit(1)
  }

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  if (!args.includes('--no-backup')) {
    const backup = `${SRC}.bak-${stamp}`
    fs.copyFileSync(SRC, backup)
    console.log(`已备份 → ${path.basename(backup)}`)
  }

  if (!fs.existsSync(DOCS)) fs.mkdirSync(DOCS, { recursive: true })

  let total = 0
  for (const [name, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(DOCS, name), text, 'utf8')
    total += Buffer.byteLength(text)
    console.log(`  docs/${name.padEnd(34)} ${String((text.length / 1024).toFixed(1)).padStart(6)} KB  ${String(text.split('\n').length).padStart(4)} 行`)
  }

  fs.writeFileSync(SRC, indexText, 'utf8')
  console.log(`  进度与交接.md（索引页）${String((indexText.length / 1024).toFixed(1)).padStart(14)} KB  ${String(indexText.split('\n').length).padStart(4)} 行`)

  console.log(`\ndocs/ ${Object.keys(files).length} 份分册，合计 ${(total / 1024).toFixed(1)} KB`)

  const problems = verify(files, indexText)
  for (const p of problems) console.log('  ✗ ' + p)
  console.log(problems.length ? `❌ ${problems.length} 个问题` : '✅ 校验通过：旧编号无残留、链接全部可达')
}

main()
