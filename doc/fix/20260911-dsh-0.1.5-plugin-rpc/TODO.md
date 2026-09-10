# TODO（dsh 0.1.5-rc.2 兼容修复）

> 机械提取自 [plan.md](plan.md) 的 `❌` / `⏭️` 项。

**当前无待办项** —— 全部任务（T1–T12）已完成，含 2026-09-11 的 npm 发布：

| 包 | 版本 | registry 状态（2026-09-11 核对） |
|---|---|---|
| `rdsh-gateway` | 0.8.2 | ✅ `latest` = 0.8.2，产物含 `DSH_COMPAT_MAX = "0.1.5-rc.2"` |
| `dsh-web-remote` | 0.5.1 | ✅ `latest` = 0.5.1，产物含 `dist/rpc-route.js` 且 `index.js` 引用 `handleRpcRoute`、依赖 `rdsh-gateway 0.8.2` |
| `remote-dsh`（CLI） | 0.10.2 | ✅ `latest` = 0.10.2，依赖 `rdsh-gateway 0.8.2` + `rdsh-hub 0.7.0` |

历史记录：

- T11（网关 `DSH_COMPAT_MAX` 扩展）于 2026-09-11 完成：真机实测通过后扩到 `0.1.5-rc.2`，见 [plan.md](plan.md) 与 [doc/review/20260911-dsh-0.1.5-rc.2-plugin-compat.md](../../review/20260911-dsh-0.1.5-rc.2-plugin-compat.md) §6。
- T12（npm 发布）于 2026-09-11 完成；注意发布过程中 `dsh-web-remote` 曾走 npm 12 的 **staged publish**（`Cannot publish over previously staged version`），需在 npm 侧批准后才出现在 registry —— 见 [doc/review/20260911-dsh-0.1.5-rc.2-plugin-compat.md](../../review/20260911-dsh-0.1.5-rc.2-plugin-compat.md) §6 末尾的发布记录。
