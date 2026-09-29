# 艾珀莉亚的插件管理小助手

> 作者：艾珀莉亚（FionaFaust）

轻量化 AstrBot 插件管理助手：查询插件列表、初始化编号、定向查询插件信息、导出插件文档（txt/pdf）。

## 功能与指令

| 指令 | 功能 |
|---|---|
| `/plg` | 查询当前已激活的插件列表 |
| `/plg all` | 查询所有插件，标注 ✅已激活 / ❌未激活 |
| `/plg num` | 给所有插件初始化编号（1、2、3...），一次编号存档内编号唯一 |
| `/plg {编号}` | 按编号定向查询插件信息 |
| `/plg {插件解释名称}` | 按显示名查询插件信息 |
| `/plg {插件名称}` | 按插件名（如 astrbot_plugin_xxx）查询插件信息 |
| `/plg {编号/名称} txt` | 导出插件文档（txt 文件） |
| `/plg {编号/名称} pdf` | 导出插件文档（PDF 文件） |

## 插件信息内容

定向查询时返回：
- 市场发布信息：市场 ID（作者/插件名）、仓库地址、版本、作者
- 运行状态：已激活 / 未激活
- 插件描述
- 指令列表（已激活插件可获取）

## 配置说明

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `numbering_order` | `active_first` | 编号排序：激活插件优先 / 按名称排序 |
| `doc_max_lines` | `200` | 导出文档最大行数 |

## 使用示例

```
/plg
/plg all
/plg num
/plg 1
/plg 艾珀莉亚的Roblox小助手
/plg astrbot_plugin_roblox
/plg 1 pdf
/plg 2 txt
```

## 说明

- 插件数据来自 AstrBot 运行时（`context.get_all_stars()`）与插件目录扫描；
- 编号存档通过 KV 存储持久化，重载插件后仍保留；
- PDF 使用 reportlab 内置 CID 字体（STSong-Light）生成，无需额外字体文件；
- 依赖：`reportlab`（见 requirements.txt）。

---

© 艾珀莉亚 (FionaFaust) · AstrBot 插件
