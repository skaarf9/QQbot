# 插件管理助手

在聊天中管理 AstrBot 插件，无需登录管理后台。

## 功能

| 指令 | 说明 |
|------|------|
| `/plugin help` | 查看帮助 |
| `/plugin list` | 查看所有插件（按启用/禁用/保留分组） |
| `/plugin info <名称>` | 查看插件详情 |
| `/plugin enable <名称>` | 启用插件 |
| `/plugin disable <名称>` | 禁用插件 |
| `/plugin reload <名称>` | 重载插件 |
| `/plugin install <GitHub URL>` | 从仓库安装插件（需开启配置） |
| `/plugin uninstall <名称>` | 卸载插件（需开启配置） |
| `/plugin update <名称>` | 从仓库更新插件 |

## 安装

下载本插件文件夹，放入 AstrBot 的 `data/plugins/` 目录，重启 AstrBot。

或从 AstrBot 插件市场搜索「插件管理助手」一键安装。

## 配置说明

在 AstrBot 插件配置页面找到「插件管理助手」，可设置：

- **allow_install**：是否允许通过聊天安装插件（默认关闭，安全考虑）
- **allow_uninstall**：是否允许通过聊天卸载插件（默认关闭，安全考虑）

## 权限

所有指令需要 **管理员权限**。

## 注意事项

- 卸载插件会删除插件目录，请谨慎操作
- `install` 会执行 `pip install`，请确认仓库来源可信后再开启
- 本插件无法卸载自身（防止把自己搞没）

## 作者

小红蛋 · xiaohondanmiao@qq.com
