# Koishi 路线（生产）

原 `koishi-app` / `koishi-test` 已按路线归位：

```
routes/koishi/
├── app/     生产实例（端口 5140）
├── test/    测试实例（假 OneBot）
└── models/  本地嵌入模型缓存（不入库）
```

完整说明、插件清单、部署步骤仍然看：

- [`app/README.md`](app/README.md)
- 根 [`README.md`](../../README.md)
- [`docs/`](../../docs/)（开发轮次、踩坑记录、需求）

## 启动

```bash
cd routes/koishi/app
npm start
```

生产建议走 `node routes/koishi/app/tools/run-prod.cjs`（面板走的就是它）。

## 与 AstrBot 路线共存

两条路线可以接同一个 QQ 小号：

- Koishi 继续连 NapCat 的 `ws://127.0.0.1:3001`，处理普通聊天与现有 55 个插件实例。
- AstrBot 通过 NapCat 的反向 WS 客户端接 `ws://127.0.0.1:6199/ws`，只接管 `/dsh`。

AstrBot 侧默认聊天和内置指令已关闭，不会和 ChatLuna 抢回复。
详见 [`../astrbot/README.md`](../astrbot/README.md)。
