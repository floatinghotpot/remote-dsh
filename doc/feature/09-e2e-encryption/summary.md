# 09-e2e-encryption — 总结（summary.md）

> **日期**: 2026-08-29
> **状态**: 主线完成并真实环境验证通过

## 做了什么

为 remote-dsh 实现**数据面端到端加密（E2EE）**：hub 对 DSH 流量（`/h/<hostId>/`）只做「路由 / 可用性 / 认证」，**读不到内容**（prompt、代码、文件、API key、会话结果）；浏览器 ↔ host 端到端加密，DSH 前端零改动。

- **协议层**（tunnel）：新增 raw stream（`flags` bit0 = `FLAG_E2E`、OPEN `kind:"raw"`），hub 纯字节双向转发、不解析 HTTP；向后兼容（bit=0 走原 HTTP 感知转发）。
- **内层加密**：Noise NK 握手（X25519 + HKDF-SHA256 + AES-256-GCM），host 静态密钥 + 浏览器临时密钥，会话密钥每连接轮换，前向保密 + AEAD 防篡改。Node（gateway）与 WebCrypto（portal）双实现线级兼容，直接实现、无第三方库。
- **透明拦截**：hub 向 `/h/` HTML 注入 shim 脚本，包装 `window.fetch` + `window.WebSocket` 走 `/e2e` raw 通道；DSH 前端零改动。
- **密钥与 pinning（TOFU）**：host 持久化 X25519 密钥对（`~/.rdsh/e2ee-key.json`），join 时公钥指纹上送；portal 展示指纹、首次信任弹窗、指纹变更告警；pin 仅存浏览器 localStorage，绝不存 hub。
- **配置开关**：hub `e2ee.mode: off|optional|required`（默认 optional）。
- **数据面边界**：仅 `/h/` E2EE，`/portal/` 明文。

## 改了什么（文件）

- `packages/tunnel/`：`PROTOCOL.md` + `src/frame.ts`（raw stream）
- `packages/hub/`：`config.ts`（e2ee 三档）、`tunnel.ts`（`openRawStream`/`sendRawData`）、`relay.ts`（`handleRawUpgrade` + shim 注入）、`server.ts`（`/e2e` 路由）、`e2ee-shim.ts`（新）、`db.ts`/`api.ts`（`e2ee_public_key` 存储上送）
- `packages/gateway/`：`e2ee.ts`（新，Noise NK Node）、`e2ee-key-store.ts`（新，密钥持久化）、`join.ts`（raw 分支 + 内层分发器）
- `packages/portal/`：`e2ee.ts`（新，WebCrypto）、`e2ee-frame.ts`（新，帧编解码）、`pages.tsx`（pin/信任 UI + 盾牌图标）、`api.ts`（`e2eePublicKey`）、`i18n.ts`（词条）

## 验证结果

- 单测全绿（hub 64/64、gateway 81/81）+ `pnpm build`（tsc strict）全绿；Noise 握手/篡改/防 MITM/序列化 + Node↔WebCrypto 互操作 + 帧字节互操作。
- 真实环境：新 host + 新 hub 端到端加密 ✅、老 host + 新 hub 明文降级 ✅、生产 portal 已部署 E2EE UI ✅。

## 已知差距与待办

唯一剩余项：**host 侧 `e2ee` 开关未实现**（R5，defer → [TODO.md](TODO.md)）。生产前 watch-list（Noise 交叉审计、TOFU 变更告警实测、mode off/required 实测）见 [verification.md](verification.md) §4。
