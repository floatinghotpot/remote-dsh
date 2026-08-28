# 09-e2e-encryption — 方案（solution.md）

> **日期**: 2026-08-28
> **状态**: 草稿，**待用户批准**
> **来源**: [req.md](req.md)（R1–R8）+ [discussion.md](discussion.md)（方案 A：raw stream + Noise NK + 可行性查证）

## 1. Goal（目标架构）

在现有两段 TLS 之上，加一条**内层 E2EE 通道**，使 hub 对 DSH 数据面只做「路由/可用性/认证」但**读不到内容**：

```
浏览器 ──外TLS──► hub ──外TLS──► gateway ──127.0.0.1──► DSH
  │   (SW 拦 fetch + WS 包装)        │   (Noise 终止 + 转发)
  └────── 内层 Noise NK（raw stream 透传，hub 只转发密文）──────┘
```

- **浏览器侧**：service worker 拦 `fetch`/SSE；注入 `window.WebSocket` 包装拦 WS；二者把 HTTP/WS 多路复用到内层 Noise 通道（Noise **NK** 发起方，X25519 + AES-256-GCM）。
- **hub 侧**：新增 **raw stream 模式**（`flags` bit0 = E2E 标记），对 E2EE 流纯字节双向转发、不解析 HTTP。
- **gateway 侧**：Noise **NK 响应方**；解密后重建 HTTP 请求 → 照旧 `rewriteHeadersForDsh` + 转发 DSH；**返回条注入从 hub 移到 gateway**。

## 2. Facts（代码审计，全部已读确认）

| 事实 | 出处 |
|---|---|
| 帧头 `magic(4)+version(1)+flags(1)+type(1)+streamId(4)+length(4)+payload`；`flags` bit0 = `FLAG_E2E(0x01)` 已预留 | `tunnel/src/constants.ts` / `frame.ts` / `PROTOCOL.md` |
| `FRAME_TYPE` = OPEN/DATA/CLOSE/PING/PONG/ERROR；OPEN payload `kind: "http"\|"ws"` | `tunnel/src/constants.ts` / `frame.ts` |
| `encodeFrame(type, streamId, payload, flags=0)` 已带 flags 参数；FrameParser 未知 flags 位原样保留 | `tunnel/src/frame.ts` |
| hub relay：`handleRelay`（HTTP）`handleRelayUpgrade`（WS），`conn.openStream(kind, path, method, headers)` → OPEN + DATA；返回条注入在 hub（`injectBackBar`） | `hub/src/relay.ts` |
| hub 路由：`/portal*`→portal；`/h/<hostId>/*`→进入校验→302 根路径；根路径有 host 上下文→`handleRelay`；WS upgrade→`handleRelayUpgrade` | `hub/src/server.ts` |
| hub 隧道：`TunnelConn.openStream/sendData/endRequest/abortStream`；`handleFrame` 分发 OPEN/DATA/CLOSE/ERROR | `hub/src/tunnel.ts` |
| gateway 隧道客户端：`handleFrame`（OPEN http/ws→`handleOpen`→本地 DSH；DATA→http/ws 流；WS DATA 固定 `binary:false` 文本帧） | `gateway/src/join.ts` |
| `rewriteHeadersForDsh`（Host→127.0.0.1:port、Origin→http://127.0.0.1:port）+ `forwardHttp`/`createUpgradeProxy`（M1 内核） | `gateway/src/proxy.ts` |
| `HubConfig` 有 email/sms/captcha/billing/…，**无 e2ee**；`normalizeBilling` 等校验 | `hub/src/config.ts` |
| portal 单文件 React（`pages.tsx` 路由），**无 SW、无 WS 包装、无 pin UI** | `portal/src/*` |
| host 配置 `~/.rdsh/host.json`（3 模式 lan/cloud/join） | `cli`/`gateway`（04） |
| 可行性：DSH 浏览器用 WS（非 SSE）跑 events；无 Web Worker、无 CSP、拒绝 binary 帧 | `discussion.md` §9 |

## 3. Gap（Goal − Facts）

1. 无 **raw stream 模式**（OPEN 只有 http/ws，无 E2E 字节流）；
2. 无 **内层 Noise**（浏览器 + gateway 两端都没有）；
3. 无 **SW / WS 包装**（浏览器透明拦截缺失）；
4. 无 **pin UI / 指纹上送**（host 密钥对 + join 上送 + portal 信任）；
5. 无 **`e2ee` 配置**（hub.json + host.json）；
6. **返回条注入在 hub**（需迁 gateway，E2E 后 hub 不可读 HTML）。

## 4. Call-site Audit（共享契约变更）

| 变更 | 调用点 | 分类 |
|---|---|---|
| `flags` bit0 语义定为「E2EE raw stream」 | `tunnel/constants.ts`（已定义 `FLAG_E2E`）；`frame.ts` encode/parse；hub `tunnel.ts` handleFrame；gateway `join.ts` handleFrame | 兼容：bit0 未实现前恒 0，老代码原样透传 |
| OPEN `kind` 加 `"raw"` | `tunnel/frame.ts` `RequestOpen`；hub `relay.ts`/`tunnel.ts` `openStream` 签名；gateway `join.ts` `handleOpen` 分发 | 需改：新增 kind 分支 |
| hub 新增 `/e2e/<hostId>` raw 路由 | `hub/server.ts`（HTTP + WS upgrade 都接 raw）；`hub/relay.ts` 加 `handleRaw` | 新增路由，不影响现有 `/h/` |
| `e2ee` 配置（hub `e2ee.mode` + host `e2ee` 布尔） | `hub/config.ts` 加 `normalizeE2ee`；`cli`/`gateway` 的 host.json 归一化 | 新增可选字段，缺省 optional/true，旧配置不受影响 |
| 返回条注入迁移 hub→gateway | `hub/relay.ts`（移除 `injectBackBar`）；`gateway/proxy.ts`（复用已有 `htmlInject`） | 需改：注入点迁移 |

## 5. Tasks（文件改动清单）

### T1 协议先行
- `tunnel/PROTOCOL.md`：定义 raw stream（`flags` bit0 语义 + OPEN `kind:"raw"` + DATA 透传 + E2E 握手字节流）；
- `tunnel/src/frame.ts`：`RequestOpen.kind` 加 `"raw"`；`constants.ts` 已有 `FLAG_E2E` 复用。

### T2 hub：raw stream 透传 + 配置
- `hub/src/config.ts`：加 `E2eeConfig` + `normalizeE2ee`（`mode: off|optional|required`，默认 optional）；
- `hub/src/tunnel.ts`：`openStream` 支持 `kind:"raw"`；raw 流 DATA 双向透传（不解析）；
- `hub/src/relay.ts` + `server.ts`：新增 `/e2e/<hostId>` 路由（HTTP upgrade 到 WS raw），`handleRaw` 把浏览器 WS ↔ 隧道 raw 流字节互转（含 `flags` bit0）。

### T3 gateway：Noise 响应方 + 内层 HTTP/WS
- `gateway/src/join.ts`：`handleOpen` 加 `kind:"raw"` 分支 → Noise NK 响应方握手 → 握手后解密 DATA、解析内层多路复用（HTTP/WS）→ 复用 `proxy.ts` `forwardHttp`/`createUpgradeProxy` 转发 DSH → 加密回写；
- `gateway/src/e2ee.ts`（新，已实现）：Noise NK（X25519 + AES-256-GCM）握手/加密/解密（直接实现，无第三方库）；
- `gateway/src/proxy.ts`：返回条注入迁移（`htmlInject` 已存在，复用）。

### T4 浏览器：SW + WS 包装 + pin
- `portal/public/sw.js`（新）：拦 `/h/<hostId>/` 的 `fetch`/SSE → 走内层 Noise 通道；
- `portal/public/ws-shim.js`（新）：注入 `window.WebSocket` 包装 → 走内层 Noise 通道；
- `portal/src/e2ee.ts`（新，已实现）：Noise NK 发起方（WebCrypto 直接实现）+ 内层 HTTP/WS 多路复用；
- `portal/src/pages.tsx` + `api.ts`：host 指纹展示 + 首次信任/变更告警 UI；pin 存 `localStorage`；
- host 密钥对生成 + join 时指纹上送（gateway join 流程 + hub 存指纹 + `/api` 返回指纹）。

### T5 测试 + 构建（零缺陷门）
- 单测：Noise 握手/AEAD（`noise.test.ts`）、raw stream 帧（`tunnel` 扩展）、`e2ee` 配置归一化（`config.test.ts`）、join 指纹上送；
- conformance：raw stream 帧 TS↔Go（Go 侧待 M7 后补，先 TS 单测）；
- 端到端：`hub 抓包 /h/ 为密文、/portal/ 明文`；
- `pnpm build` + `pnpm test` 全绿。

## 6. 待选型 / 待查证（已部分定案）

- **~~Noise 库~~ → 已定**：不引第三方库，直接实现 Noise NK——`gateway/src/e2ee.ts`（node:crypto）+ `portal/src/e2ee.ts`（WebCrypto）；**wire 互操作测试已通过**（`e2ee-interop.test.ts`：两端密钥一致 + 双向 AEAD）。上线前仍建议与 Noise 规范 / 被审计库交叉复核。
- **~~内层多路复用格式~~ → 已定（2026-08-28 拍板）**：复用 tunnel 帧语义（OPEN http/ws + DATA + CLOSE）跑在 Noise 通道内，网关解密后喂回现有 `handleOpen`/`handleFrame` 转发 DSH。
- **SW 与 WS 包装的交互协议**（SW 拦 fetch、包装拦 WS，二者如何共享同一条 Noise 通道——如 SW 通过 `postMessage`/`BroadcastChannel` 桥接）—— 仍待定，实现 portal 时定。

## 7. 持续观察项（外部依赖风险，DSH 演进可能影响本方案）

可行性结论是对**当前 DSH 版本（0.1.1-rc.2）的快照**；DSH 独立演进，以下行为若变化会影响 rdsh（含 E2E 与现有 relay）：

| 观察项 | 当前（0.1.1-rc.2） | 触发条件 / 影响 |
|---|---|---|
| DSH 事件传输（WS/SSE/WebTransport） | 浏览器用 `new WebSocket` | 换传输 → SW/WS 包装策略需改 |
| DSH WS 二进制帧 | 拒绝 binary（text-only） | 引入 binary → 非 E2E 路径「文本帧转发」假设破 |
| DSH Web Worker 网络 | 无 | 网络进 worker → 主线程 WS 包装拦不到 |
| DSH CSP | 无 | 加严格 CSP → 内联注入脚本被拦，改外链 `<script src>` |
| DSH Host/Origin 围栏 | `isTrustedApiRequest` 要求 loopback | 改逻辑 → `rewriteHeadersForDsh` 单点跟改 |
| Noise 实现复核 | 直接实现（无第三方库） | 上线前与 Noise 规范 / 被审计库交叉复核 |
| WebCrypto 支持矩阵（X25519/AES-GCM） | 现代浏览器 OK | 老浏览器缺 X25519 → 降级策略 |

**应对**：
1. **DSH 升级回归检查**：升级 DSH 时 grep `new WebSocket` / `readSse` / `new Worker` / CSP / `isTrustedApiRequest`，确认传输行为未变（可做成 CI 或手工 checklist）。
2. **版本兼容矩阵**：记录 rdsh 实测通过的 DSH 版本（当前 0.1.1-rc.2）；新版本（如 0.1.2-alpha.1）发布时先查传输行为再升级。
