# TODO：E2EE 数据面从未启用（未完成项）

> 机械提取自 [verification.md](verification.md) §6。AC1/AC3/AC4/AC4b 已达成；AC5 移交下一项。

## 发布与部署（必做，否则线上不变）

- [ ] `rdsh-hub` 新版本（shim 三处修复）+ 部署到线上 hub：**不部署则线上仍是无 E2EE**
- [ ] 若与 [20260914-remote-webui-settings](../20260914-remote-webui-settings/TODO.md) 的 `rdsh-gateway`/`remote-dsh` 一起发版，合并验证一次
- [ ] 发布后复核（真机）：`window.WebSocket.name === "WrappedWS"`、`/api` 无 405、清 pin 后回落明文

## 范围外（已移交 / 另行立项）

- [x] **AC5 移交**：[20260914-e2ee-fetch-streaming](../20260914-e2ee-fetch-streaming/discussion.md) —— 在真 E2EE 下重跑 ① 文档预览（二进制/流式）② 18 MiB 上传（16 MiB 单帧上限）③ 请求体分片；该记录需新增 F12/F13 同款事实（`URL` 实例、405）作为背景
- [x] **已修**（2026-09-14）：`manifest.webmanifest` 的 Chrome 报错根因是**浏览器取 manifest 不带 cookie**（规范 credentials omit）⇒ hub 判不出 host ⇒ 落到 portal 兜底返回 **HTML** ⇒ Chrome 解析失败。修法：`packages/hub/src/server.ts` 在无 host 上下文时对 `*.webmanifest` 返回合法的同源 manifest（有 host 上下文仍原样转发 DSH 自己的 manifest）；回归测试 `packages/hub/test/manifest-fallback.test.ts`（2 例：无 cookie ⇒ 合法 JSON；导航仍回落 portal）；真机复验：E2EE 页面 console **0 报错**
- [x] LAN（`rdsh host serve`）路径的 E2EE 不存在（无 shim），本次未触及；如需明确文档口径可在 `doc/overview/usage.md` 补一句
