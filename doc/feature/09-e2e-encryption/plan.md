# 09-e2e-encryption — 计划（plan.md）

> **日期**: 2026-08-28
> **状态**: 实施中（本轮自主推进）
> **来源**: [req.md](req.md)（R1–R8）+ [solution.md](solution.md)（T1–T5）

## 1. RTTM（req → task 追溯矩阵）

| 需求 | 任务 | 状态 |
|---|---|---|
| R1 协议先行（raw stream） | T1 | ⏭️ |
| R2 内层 Noise NK | T3 / T4 | ⏭️ |
| R3 透明拦截（DSH 零改动） | T4 | ⏭️ |
| R4 密钥与 pinning | T3 / T4 | ⏭️ |
| R5 配置开关（hub + host） | T2 | ⏭️ |
| R6 数据面边界 | T2 / T4 | ⏭️ |
| R7 返回条注入迁移 | T3 | ⏭️ |
| R8 兼容性 | T1 / T2 / T3 | ⏭️ |

## 2. 任务清单

### T1 协议先行（tunnel）
- [ ] `tunnel/PROTOCOL.md`：定义 raw stream（`flags` bit0 语义 + OPEN `kind:"raw"` + DATA 透传 + E2E 握手字节流）
- [ ] `tunnel/src/frame.ts`：`RequestOpen.kind` 加 `"raw"`（`constants.ts` 已含 `FLAG_E2E`）

### T2 hub：e2ee 配置 + raw 透传
- [ ] `hub/src/config.ts`：`E2eeConfig` + `normalizeE2ee`（`mode: off|optional|required`，默认 optional）
- [ ] `hub/src/tunnel.ts`：`openStream` 支持 `kind:"raw"`；raw 流 DATA 双向透传（`flags` bit0）
- [ ] `hub/src/relay.ts` + `server.ts`：`/e2e/<hostId>` 路由（WS upgrade → raw 字节双向互转）

### T3 gateway：Noise NK 响应方 + raw 处理
- [ ] `gateway/src/e2ee.ts`（新）：Noise NK（X25519 + HKDF-SHA256 + AES-256-GCM）握手/加密/解密（Node 端）
- [ ] `gateway/src/join.ts`：`handleOpen` 加 `kind:"raw"` 分支 → Noise 响应方 → 解密后转发（复用 `proxy.ts`）
- [ ] `gateway/src/proxy.ts`：返回条注入迁移（复用已有 `htmlInject`）

### T4 portal：SW + WS 包装 + Noise 发起方 + pin
- [ ] `portal/public/sw.js`（新）：拦 `/h/` 的 fetch → E2E 通道
- [ ] `portal/public/ws-shim.js`（新）：`window.WebSocket` 包装 → E2E 通道
- [ ] `portal/src/e2ee.ts`（新）：Noise NK 发起方（WebCrypto）+ 内层多路复用
- [ ] `portal/src/pages.tsx` + `api.ts`：指纹展示 + 首次信任/变更告警；pin 存 localStorage

### T5 测试 + 构建（零缺陷门）
- [ ] 单测：Noise NK 握手/AEAD roundtrip/篡改（`e2ee.test.ts`）、raw stream 帧、`e2ee` 配置归一化
- [ ] `pnpm build`（tsc strict）+ `pnpm test` 全绿

## 3. 验收基准

- `hub 抓包 /h/ 密文、/portal/ 明文`（E2EE 开启时）
- 老 gateway/hub（bit=0）回归通过
- `e2ee` 三档 × host 开关行为正确

## 4. 本轮进度（2026-08-28 自主实现）

**已完成并测试（hub 64 / gateway 78 / tunnel + portal 构建全绿）**：
- T1 协议：`PROTOCOL.md` raw stream（`flags` bit0 + OPEN `kind:"raw"`）+ `frame.ts` RequestOpen 加 raw ✅
- T2 hub：`config.ts` `e2ee`（off/optional/required）校验 + `tunnel.ts` `openRawStream`/`sendRawData`（FLAG_E2E）+ `relay.ts` `handleRawUpgrade` + `server.ts` `/e2e` 路由 ✅
- T3 核心：`gateway/src/e2ee.ts` Noise NK（X25519 + HKDF-SHA256 + AES-256-GCM，握手/AEAD/指纹/序列化）+ 单测 4/4（roundtrip/篡改/防 MITM/序列化）✅
- T4 核心：`portal/src/e2ee.ts` WebCrypto 镜像（与 gateway 线级兼容，类型检查通过）✅
- T5 测试：`e2ee.test.ts` + `config.test.ts`（e2ee 归一化）✅

**下一阶段（待定/待浏览器测试）**：
- 内层多路复用格式（solution §6 待选型）：建议复用 tunnel 帧语义（OPEN http/ws + DATA）跑在 Noise 通道内
- `join.ts` raw 分支：Noise 响应方握手 + 内层帧→DSH 转发（需上面格式定案）
- portal SW / WS 包装 / 指纹 pin UI（需浏览器集成测试）
- host 密钥对持久化 + join 时指纹上送 + hub 存指纹 + portal 展示
