---
name: astrbot-selfext
description: Install or update AstrBot plugins, upgrade AstrBot itself, reload plugins, restart AstrBot, or inspect AstrBot status from the QQ bot. Use when the user asks to install an AstrBot plugin, upgrade the bot, fix a plugin, or check what is installed.
---

# AstrBot 自我扩展

所有操作都通过这个脚本（在任意目录执行都可以）：

```
node D:/deepseek/QQbot/routes/astrbot/scripts/selfext.cjs <命令>
```

## 命令

| 命令 | 作用 |
|---|---|
| `status` | AstrBot 版本、已装插件、ingress 是否健康 |
| `plugins list` | 已安装插件（名称/版本/作者） |
| `plugins search <关键词>` | 搜官方插件市场（返回 market_id、名称、版本、仓库） |
| `plugins install <market_id 或 GitHub URL>` | 安装并尽量热加载 |
| `plugins reload <插件名>` | 重载已安装插件 |
| `plugins update <插件名>` | 更新插件 |
| `upgrade --check` | 查 AstrBot 新版本 |
| `upgrade` | 升级 AstrBot 本体（需再 restart） |
| `restart --delay 15` | 延迟重启 AstrBot，先把话说完 |
| `logs 80` | 看最近 80 行 AstrBot 日志 |

## 工作流

1. **安装插件**：`plugins search 关键词` → 把名称/作者/版本/用途告诉主人 → 主人同意 →
   `plugins install <market_id>` → `plugins list` 确认 → 如果没热加载，`plugins reload <名字>` 或
   `restart --delay 15`。
2. **升级 AstrBot**：`upgrade --check` → 告诉主人当前/最新版本 → 同意 → `upgrade` →
   `restart --delay 15`。重启会短暂离线。
3. **排障**：`status` → `logs 80` → 把最后几行错误原样告诉主人。

## 硬规矩

- 只从官方市场或可信 GitHub 仓库安装；不要执行插件里的安装脚本或粘贴不明代码。
- 安装/升级前必须让主人知道**装什么、谁的、什么版本、干什么**；主人明确授权才动手。
- 不要用这个脚本改 AstrBot 核心代码、删 `data/`、或安装需要管理员权限的东西。
- 失败就说失败，把 `selfext` 的 stderr/最后几行贴出来，不要编“装好了”。
- 每次操作都会写进 `routes/astrbot/logs/selfext.log`。
