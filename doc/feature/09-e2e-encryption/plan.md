# 09-e2e-encryption — 计划（plan.md）

> **日期**: 2026-08-28
> **状态**: 实施完成（代码已提交，真实环境验证通过）
> **来源**: [req.md](req.md)（R1–R8）+ [solution.md](solution.md)（T1–T5）

## 1. RTTM（req → task 追溯矩阵）

| 需求 | 任务 | 状态 |
|---|---|---|
| R1 协议先行（raw stream） | T1 | ✅ |
| R2 内层 Noise NK | T3 / T4 | ✅ |
| R3 透明拦截（DSH 零改动） | T4 | ✅ |
| R4 密钥与 pinning | T3 / T4 | ✅ |
| R5 配置开关（hub + host） | T2 | ⏭️ host 开关未实现（defer → TODO） |
| R6 数据面边界 | T2 / T4 | ✅ |
| R7 返回条注入迁移 | T3 | ✅（data-plane-only 下无需迁移：HTML 壳明文，hub 照常注入） |
| R8 兼容性 | T1 / T2 / T3 | ✅ |

## 2. 任务清单

### T1 协议先行（tunnel）
- [x] `tunnel/PROTOCOL.md`：定义 raw stream（`flags` bit0 语义 + OPEN `kind:"raw"` + DATA 透传 + E2E 握手字节流）
- [x] `tunnel/src/frame.ts`：`RequestOpen.kind` 加 `"raw"`（`constants.ts` 已含 `FLAG_E2E`）

### T2 hub：e2ee 配置 + raw 透传
- [x] `hub/src/config.ts`：`E2eeConfig` + `normalizeE2ee`（`mode: off|optional|required`，默认 optional）
- [x] `hub/src/tunnel.ts`：`openRawStream`/`sendRawData`（raw 流 DATA 双向透传，`flags` bit0）
- [x] `hub/src/relay.ts` + `server.ts`：`/e2e` 路由（WS upgrade → raw 字节双向互转）；HTML `<head>` 注入 `E2EE_SHIM_HTML`（`mode !== "off"` 时）
- [x] `hub/src/db.ts` + `api.ts`：`hosts.e2ee_public_key` 列 + 注册上送 + `GET /api/hosts` 返回
- [x] `hub/src/e2ee-shim.ts`：浏览器 shim（fetch/WebSocket 包装 + Noise 发起方 + 帧编解码 + pin 读取）
- [ ] host 侧 `e2ee: true|false` 开关（`host.json`）：未实现 → defer（[TODO.md](TODO.md)）

### T3 gateway：Noise NK 响应方 + raw 处理
- [x] `gateway/src/e2ee.ts`：Noise NK（X25519 + HKDF-SHA256 + AES-256-GCM）握手/加密/解密/指纹/序列化（Node 端，直接实现、无第三方库）
- [x] `gateway/src/e2ee-key-store.ts`：`loadOrCreateE2eeKeyPair()` 持久化 `~/.rdsh/e2ee-key.json`
- [x] `gateway/src/join.ts`：`handleOpen` 加 `kind:"raw"` 分支 → Noise 响应方 → 解密后进内层分发器（复用隧道帧语义 OPEN http/ws + DATA）；注册上送 `e2eePublicKey`

### T4 portal：Noise 发起方 + pin（浏览器端）
- [x] `portal/src/e2ee.ts`：Noise NK 发起方（WebCrypto，与 gateway 线级兼容）
- [x] `portal/src/e2ee-frame.ts`：Uint8Array 帧编解码（镜像 rdsh-tunnel）
- [x] `portal/src/pages.tsx` + `api.ts`：指纹展示 + 首次信任/变更告警；pin 存 localStorage（`rdsh_e2ee_pins`）

> **实现说明（相对 solution 的偏离）**：数据面 E2EE 采用「hub 注入 shim 脚本包装 `window.fetch` + `window.WebSocket`」单页方案，替代原 SW + `ws-shim.js` 双文件方案（避免 SW scope/bundling/postMessage 复杂度，solution §6/§7 已记录决策）。HTML/JS 壳明文，仅 API(fetch) + WS 加密。

### T5 测试 + 构建（零缺陷门）
- [x] 单测：Noise NK 握手/AEAD roundtrip/篡改/防 MITM/序列化（`e2ee.test.ts`）、Node↔WebCrypto 互操作（`e2ee-interop.test.ts`）、帧字节互操作（`e2ee-frame-interop.test.ts`）、`e2ee` 配置归一化（`config.test.ts`）
- [x] `pnpm build`（tsc strict）+ `pnpm test` 全绿（hub 64/64，gateway 81/81）

## 3. 验收基准

- `hub 抓包 /h/ 密文、/portal/ 明文`（E2EE 开启时，数据面边界：API+WS 加密，HTML/JS 壳明文）
- 老 gateway/hub（bit=0）回归通过
- `e2ee` 三档（off/optional/required）行为正确（host 开关 defer，见 TODO）
- **升级兼容 / 滚动发布**（`e2ee.mode` 默认 `optional`）：
  - 老 host + 新 hub：老 gateway 注册不含 `e2eePublicKey` → hub 存 NULL → portal 无信任提示 → shim 早退（无 pin）→ 无 `/e2e` 原始流 → 全程明文，正常工作
  - 新 host + 老 hub：老 hub 忽略额外字段、从不发 `kind:"raw"` → 明文，正常工作
  - `required` 模式：老 host 被拒绝（预期行为）
  - 发布策略：`optional` 保持到 host 全部升级完成，再评估切 `required`

## 4. 本轮进度

**已完成并测试（hub 64/64、gateway 81/81、`pnpm build` 全绿）**：
- T1 协议：`PROTOCOL.md` raw stream（`flags` bit0 + OPEN `kind:"raw"`）+ `frame.ts` RequestOpen 加 raw ✅
- T2 hub：`config.ts` `e2ee`（off/optional/required）校验 + `tunnel.ts` `openRawStream`/`sendRawData`（FLAG_E2E）+ `relay.ts` `handleRawUpgrade` + `server.ts` `/e2e` 路由 + `db.ts`/`api.ts` 指纹存储上送 + `e2ee-shim.ts` shim 注入 ✅
- T3 gateway：`e2ee.ts` Noise NK（X25519 + HKDF-SHA256 + AES-256-GCM）+ `e2ee-key-store.ts` 密钥持久化 + `join.ts` raw 分支（内层复用隧道帧语义）+ 单测 4/4 ✅
- T4 portal：`e2ee.ts`（WebCrypto 镜像）+ `e2ee-frame.ts` 帧编解码 + `pages.tsx`/`api.ts` pin/信任 UI（线级兼容，类型检查通过）✅
- T5 测试：`e2ee.test.ts` + `e2ee-interop.test.ts`（Node↔WebCrypto）+ `e2ee-frame-interop.test.ts`（帧字节）+ `config.test.ts`（e2ee 归一化）✅

**已真实环境验证（2026-08-29）**：
- 新 host + 新 hub：raw 流 + Noise NK + PIN 固定 + 盾牌图标，端到端加密 ✅
- 老 host + 新 hub：明文降级，正常工作 ✅
- 生产 hub portal 已部署最新 E2EE 构建（pin/信任 UI + 盾牌图标）✅

**待办（见 [TODO.md](TODO.md)）**：host 侧 `e2ee` 开关（R5，defer）。

**生产前 watch-list（不阻塞，见 [verification.md](verification.md) §4）**：
- Noise 直实现对照 Noise 规范 / 成熟库交叉核对
- 指纹变更告警（TOFU）实测、`e2ee.mode` off/required 两档实测
