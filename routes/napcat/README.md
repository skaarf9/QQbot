# NapCat（QQ 协议端，两条路线共用）

NapCat 是 QQ 的 OneBot 11 实现。它不属于某一条机器人路线，
Koishi 和 AstrBot 都可以接同一个 NapCat（同一个 QQ 小号）。

```
routes/napcat/
├── Shell/       注入已安装 QQ（NapCatWinBootMain），配置/日志在这里
└── Framework/   自带框架，不碰已安装 QQ；config、logs 是指向 Shell 的 junction
```

**不入库**（`.gitignore` 已排除）：`routes/napcat/Shell/`、`routes/napcat/Framework/`
（QQ 框架本体约 315 MB，新设备从 NapCat 官方 Release 另装）。

## 两个出口

| 用途 | 方向 | 地址 | 配置位置 |
|---|---|---|---|
| Koishi | NapCat 做服务端，Koishi 连进来 | `ws://127.0.0.1:3001` | `Shell/config/onebot11_<QQ号>.json` → `network.websocketServers` |
| AstrBot | AstrBot 做服务端，NapCat 连出去 | `ws://127.0.0.1:6199/ws` | 同一文件 → `network.websocketClients`（`name: astrbot`） |

两边的 token 各自独立：Koishi 的 token 与 `routes/koishi/app/.env` 的 `NAPCAT_TOKEN` 一致；
AstrBot 的 token 在 `routes/astrbot/app/data/cmd_config.json` 的 `platform[0].ws_reverse_token`。

## 启动

```bat
routes\..\tools\start-napcat-shell.bat
:: 或
tools\start-napcat-framework.bat
```

两个都需要管理员（注入 QQ 进程）；QQ 主号在跑时 Shell 变体会因为单实例冲突失败，
用 Framework 变体，或先退出主号 QQ。

> Framework 的 `config/`、`logs/` 是指向 `Shell/` 的**绝对路径 junction**。
> 如果整体移动 `routes/napcat/`，要重建这两个 junction（参见本仓库 2026-10-25 的目录重组）。
