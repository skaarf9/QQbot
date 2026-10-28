# astrbot_plugin_dsh（vendored）

来源：<https://github.com/CCYellowStar2/astrbot_plugin_dsh>
版本：**0.3.23**（与 `dsh-astrbot-ingress` 版本对齐）
许可：MIT

为什么放这里：AstrBot 的 `data/` 不入库，而桥插件是这条路线的关键接线，
把源码入库才能在换机时一次装好，也方便对照版本。

`routes/astrbot/app/data/plugins/astrbot_plugin_dsh` 是指向本目录的 junction；
AstrBot 只读这里的 `main.py` / `metadata.yaml` / `_conf_schema.json`。

升级：

```bash
# 从 npm 包或 GitHub 取新版本，覆盖 astrbot_plugin_dsh/
npm pack astrbot_plugin_dsh@latest   # 若已上架
# 或 git clone https://github.com/CCYellowStar2/astrbot_plugin_dsh
```

升级后重启 AstrBot，并确认 DSH 侧 `dsh-astrbot-ingress` 版本兼容（看 `/health` 的 `capabilities`）。

## 本地补丁

`main.py` 有四段本地补丁（2026-10-26），都是为了让私聊更像聊天、并且知道谁能让它动手：

1. **静默模式**（`on_message` + `_emit_sse`）：
   - 私聊普通消息不发 `已交给 DeepSeek Harness…`；
   - 私聊丢弃 `💭` 思考首行、`⏳`/`🔧` 进度行；
   - 私聊去掉末尾 `—— 本回合结束`；
   - 群聊 / 私聊 `/dsh` 命令保留 ack、进度和结束标记。
2. **自然口吻的错误**：私聊超时说“这次等太久了，我先停下来了；任务可能还在跑。”，
   连接失败说“DSH 那边没连上，稍后再试。”；技术细节留给群聊/`/dsh`。
3. **身份分层**（`_role` / `_role_note` / `_GUEST_DENY`）：
   - `owner_users`（默认 `2791932480`）全权限，`maintainer_users` 是维护者白名单；
   - 访客要在 QQ 里让 bot 装插件/升级/改代码/派子进程时，插件直接回
     “这个我可不敢替你动手，找有权限的人来”，不进 DSH；
   - 进 DSH 的消息带一行 `[系统注记·勿复述] 发言人=…（角色）：…`，只给模型看。
4. **`guest_chat`**：名单外的私聊默认仍可聊天；关掉后直接不理。

配套：`_conf_schema.json` 新增 `owner_users` / `maintainer_users` / `guest_chat`；
`scripts/selfext.cjs` 新增 `allowlist list|add|remove`（改完自动重载本插件）。

升级上游时记得把这些补丁重新加回去（或改成上游配置项，如果以后提供）。
