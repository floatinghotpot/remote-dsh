# 09-e2e-encryption — 需求讨论记录（discussion.md）

> **日期**: 2026-08-28
> **状态**: 讨论中（仅讨论，未立项、未实现）
> **来源**: `proposal.md` §10 Q5（E2E 加密预留）+ 2026-08-28 讨论
> **性质**: 端到端加密——hub 中转流量但**无法读取内容**（浏览器 ↔ host，hub 不可读）。**社区 + SaaS 双版本通用**（社区多租户：hub 管理员 ≠ host 持有者；SaaS：运营方不可读）。
>
> **术语**：本文「E2E」= **端到端加密（End-to-End Encryption, E2EE）**，与仓库的 `e2e/`（TS↔Go conformance **端到端测试**）不同——一个是加密、一个是测试。下文统一称「E2EE」或「端到端加密」。

## 0. 背景与动机

现状数据面有两段 TLS，但 **hub 是两段的终点，能看到明文**：

```
浏览器 ──HTTPS(TLS)──► hub ──WSS(TLS)──► gateway ──127.0.0.1──► DSH
        (hub 终止)         (hub 终止)
```

目标：hub 仍负责**路由 / 可用性 / 认证**，但看不到**内容**（prompt、代码、文件、API key、会话结果）。

## 1. 现状事实（代码审计）

| 事实 | 出处 |
|---|---|
| 帧头 `flags` bit0 = E2E 加密位（预留）；实现须**忽略未知位并原样透传** | `packages/tunnel/PROTOCOL.md` |
| 帧类型：OPEN（JSON：method/path/headers 明文）/ DATA（body 原始字节）/ CLOSE / PING·PONG / ERROR | `PROTOCOL.md` |
| WS 内容按**文本帧**转发（DSH `/api/events.mux` 是 text/JSON） | `PROTOCOL.md` |
| hub relay 能看到 OPEN 的 method/path/headers + DATA 的 body + WS 文本 | `packages/hub/src/relay.ts` |
| 流式分片 + 背压，payload 上限 16 MiB（300MB 上传流式） | `PROTOCOL.md` / `relay.ts` |

## 2. 威胁模型

- **不可信**：hub（中转）——不得读内容，但负责路由/可用性/认证（持有 JWT、host token）。
- **可信**：浏览器（用户）+ host（用户自有机器）。
- **元数据**（hostId、method、path、大小、时序）对 hub 仍可见（除非 padding）。
- **威胁边界（web 版固有）**：E2EE 防「**被动/好奇**」hub（读中转流量），**不防「主动/恶意」hub**（改 portal JS 偷内容）；承诺止于「hub 读不到中转内容」。

## 3. 方案对比

### 方案 A —— 内层加密通道（raw stream + Noise）✅ 已定（2026-08-28）

浏览器与 host 在 hub 之上再建一条**内层加密通道**（hub 只当透明字节通道，不解析 HTTP）。**内层协议用 Noise**（X25519 + AES-256-GCM），而非 TLS——浏览器端 WebCrypto 只有原语、无 TLS 握手；Noise 轻、字节流友好，且 WebCrypto 原生支持 X25519 / AES-GCM / HKDF（注：ChaCha20-Poly1305 在 WebCrypto 支持不普及，故用 AES-GCM）。

- ✅ 不自造密码学：Noise 是 WireGuard / WhatsApp 底层，成熟被审计；安全等价 TLS（前向保密 + AEAD + 防重放）
- ✅ 彻底：连 header、path、body 一起加密，hub 只看到「某 host 的一条密文流」
- ✅ 字节流友好：HTTP/WS/SSE 多路复用自然适配，跑在现有隧道的 raw stream 上，**零新增基建**（无 TURN / NAT 穿透）
- ❌ 要加「raw stream 透传模式」（`flags` bit0 标记）+ 每 host 密钥/指纹管理

**实现要点**：
- hub 加 **raw stream 模式**（`flags` bit0 标记，纯字节双向转发，不解析 HTTP）；
- 浏览器侧透明拦截：**service worker** 拦 `fetch`/SSE；**注入 `window.WebSocket` 包装脚本** 拦 WS（SW 拦不住 WS，须注入包装）；
- 内层 Noise 由浏览器（WebCrypto + 被审计的 JS Noise 库）与 gateway（Node Noise 库）两端终止；
- **返回条注入从 hub 移到 gateway**（E2E 后 hub 看不到 HTML，gateway 终止内层加密后注入）；
- 老 gateway/hub 走现有 HTTP 感知转发（bit=0），向后兼容。

### 方案 B —— 应用层帧级 AEAD

保留现有「HTTP 感知」转发（路由不变），只加密敏感部分：**DATA 帧（body）+ 敏感头（Authorization/Cookie）+ WS 消息**，用每会话对称密钥 AEAD（AES-256-GCM / ChaCha20-Poly1305）。`method/path` 等路由信息保持明文。

- ✅ 改动小，贴合现有 OPEN/DATA 结构
- ❌ 手写密钥交换 + 分层加密（body/header/WS 分开）+ nonce/防重放/轮换，**密码学出错风险高**
- ❌ header 加密是脏活：路由头（method/path）明文 + 敏感头密文，字段级拆分

## 4. 密钥与信任（两方案共用）

- host 生成**长期密钥对**（X25519）；公钥指纹 **join 时 pinning**（portal「添加主机」展示，类 SSH host key / Signal 安全号）。
- 会话密钥 = 浏览器临时密钥 × host 公钥 **ECDH → HKDF → AEAD**，每会话/重连轮换，前向保密。
- **pinning UX（已定）**：**portal 展示指纹 + 用户首次信任（TOFU）**——host 可能是 DSH 插件（无 CLI），故不做 CLI 比对。加分项（后置）：DSH 插件面板也显示指纹，作「第二屏核对」。
- **指纹变更（已定）**：拒绝 + 手动重信任——展示新旧指纹 + 说明原因（重装 vs 被劫持）+ 二次确认；**pin 存浏览器本地（localStorage），绝不存 hub**（hub 是潜在敌手）。
- **诚实提醒**：无额外带外信道时，pinning 本质是 **TOFU（首次信任）**——hub 若在 join 那一刻 MITM 也能得逞；portal 展示指纹 + 插件第二屏可缓解但非根除。

## 5. 性能

| 维度 | 影响 |
|---|---|
| 吞吐 | AES-256-GCM 有 AES-NI 硬件加速（GB/s/core）；DSH 流量瓶颈在网络非密码学；外+内双层 ≈ 2× 对称运算，毫秒级以下 |
| 延迟 | 方案 A：建流 +1 RTT（Noise NK 握手）后持续复用；方案 B：密钥预协商 +1 ECDH 往返或 0 |
| 内存/背压 | 流式分片（沿用 300MB 背压）；AEAD 每块 +16B tag +12B nonce，帧开销 ~28B，可忽略 |
| 元数据泄漏 | hostId/method/path/大小/时序仍可见（方案 B 更明显）；防大小/时序侧信道需 padding（加开销） |

## 6. WS text/binary 坑

DSH 的 `/api/events.mux` 是 text/JSON 协议，协议明确「WS 内容按文本帧转发」。E2E 加密后 WS 载荷变 **binary**，破坏这条规则。二选一：

1. ciphertext 做 base64 塞回 text 帧（+33% 体积）；
2. 扩展协议允许 binary WS 内容（`PROTOCOL.md` 已预留「未来若需二进制 WS 再扩展」）。

## 7. 已定与待定

**已定（2026-08-28）**：
1. **方案 A**：内层加密通道（raw stream + Noise，X25519 + AES-256-GCM，**NK 握手**：host 静态 + 浏览器临时）——不自造密码学、字节流、零新增基建、对 DSH 透明；
2. **pinning UX**：portal 展示指纹 + 用户首次信任（TOFU）；host 可能是 DSH 插件无 CLI，不做 CLI 比对；
3. **配置默认**：`e2ee: { mode: "off" | "optional" | "required" }`，**默认 `optional`**（兼容老 host；SaaS 宣称 E2EE 时覆盖为 required）；
4. **时机**：**现在实现、SaaS 上线前完成**（与备案/微信商户号并行），以「带 E2EE」为上线卖点；
5. **数据面边界**：只加密 DSH 流量（`/h/<hostId>/`），portal（`/portal/`）不加密（hub 即 portal 服务端）；
6. **WS text/binary**：方案 A 的 raw stream（原始字节）天然解决。

**待定（不阻塞，solution 阶段定）**：
- 是否 padding 防大小/时序侧信道（MVP 大概率不做）；
- 内层 Noise 库**具体选型与审计**（可行性已查证，见 §9；浏览器 JS 库 + gateway Node 库，实现前确认最新版）。
- （注入 WS 包装的 CSP / Web Worker 兼容已查证无阻塞，见 §9，不再列入待定。）

## 8. 对 DSH 的影响与兼容性

- **DSH 代码零改动**：rdsh 只在网络层透明拦截（SW 拦 `fetch`/SSE + 注入 WS 包装），DSH 的 `fetch`/`WebSocket` 调用原样工作。
- **返回条注入迁移**：hub → gateway（E2E 后 hub 不可读 HTML）。
- **Host/Origin 重写**（DSH 围栏，**既存必要兼容层，非 E2E 引入**）：`gateway/src/proxy.ts` `rewriteHeadersForDsh` 把 `Host → 127.0.0.1:<port>`、`Origin → http://127.0.0.1:<port>`——因为 DSH 的 `isTrustedApiRequest` 要求 Host/Origin 一致且 loopback，否则 `/api` 一律 403。透明（浏览器侧仍见 hub 域名、rewrite 在 gateway 服务端）、单点隔离（DSH 未来改围栏只改这一处）。**E2E 不改变它**：gateway 解密内层 Noise → 重建 HTTP 请求 → 照旧 rewrite → 转发 DSH。
- **未来 DSH 版本**：只要 DSH 用标准 `fetch`/`WebSocket`/SSE（浏览器原语，几乎必然），rdsh 透明兼容；Plan A 是原始字节通道、不解析 DSH 应用协议，比「文本帧 WS」更未来友好（二进制 WS 也不再是问题）。唯一耦合 = 注入的 WS 包装（DSH 未来若用 WebTransport 等新原语，rdsh 补 wrapper，rdsh 侧更新）。

## 9. 可行性查证（2026-08-28，实现前核验，结论：可行、无阻塞）

对 §7 两个待定项做了权威查证（DSH 源码 + 库调研）：

**① 注入 WS 包装脚本（CSP / Web Worker）—— 可行**

| 事实 | 出处（DSH 源码） |
|---|---|
| 浏览器客户端**用 WebSocket**（非 SSE）跑 `events.mux`/`events.host` | `dsh-client-connection/lib/client.js`（`WebApiClient.openMux → readWebSocket → new WebSocket`） |
| DSH 前端**无浏览器 Web Worker**（`new Worker` grep 为空） | `dsh-web-frontend` |
| DSH **无 CSP 头**（grep 为空） | `dsh-web-app` / `dsh-host-webserver` / `dsh-web` |
| DSH WS 明确**拒绝 binary 帧** | `client.js`（`throw new Error("binary WebSocket frame")`） |

结论：WS 包装是**必需**的（浏览器用 WS 而非 SSE）；主线程 `window.WebSocket` 包装覆盖全部（无 worker）；注入不被 CSP 拦（无 CSP）；WS text/binary 约束由 raw stream 天然解决（gateway 重建 text 帧给 DSH）。

**② Noise 库选型 —— 可行，一个关键修正**

- 有维护的 JS Noise 实现（浏览器 + Node 双端）：`@chainsafe/libp2p-noise`、`noise-protocol`、`@noble/ciphers`（原语）。选型需实现前确认最新版 + 审计/维护状态（历史 CVE 选已修复版本）。
- ⚠️ **关键修正**：WebCrypto 的 **ChaCha20-Poly1305 支持不普及**，而 **AES-256-GCM 全浏览器原生支持** → 内层 AEAD 定为 **AES-256-GCM**（已同步修正 §3/§5/§7 与 req.md）。

**总结**：两个待定项可行性确认，无阻塞 issue；设计唯一修正 = AEAD 用 AES-256-GCM（非 ChaCha20）。

## 变更记录

| 日期 | 变更 |
|---|---|
| 2026-08-28 | 建立；方案 A/B + 性能 + 密钥信任 + WS 坑 初步讨论 |
| 2026-08-28 | **定案 A（TLS-in-TLS）**：成本可忽略、向后兼容、三层开关；补实现要点（raw stream + SW + WS 包装 + 注入迁移 gateway）+ §8 对 DSH 影响与兼容性 |
| 2026-08-28 | **方案定稿**：内层从 TLS 改为 **Noise**（浏览器无原生 TLS、Noise 轻且被审计）；5 项决策已定（pinning=portal TOFU、默认 optional、SaaS 上线时实现、只加密 DSH 流量）；待定收窄为 padding / 注入兼容 / Noise 库选型 |
| 2026-08-28 | **可行性查证**：DSH 浏览器客户端确认用 WebSocket（非 SSE）、无 Web Worker、无 CSP → WS 包装可行；Noise 库可行，AEAD 修正为 AES-256-GCM（WebCrypto ChaCha20 支持不普及） |
| 2026-08-28 | **握手/指纹/开关定稿**：Noise NK 握手（host 静态 + 浏览器临时）；指纹变更=拒绝+手动重信任（pin 存浏览器本地）；host 侧 e2ee 开关（默认 true）；威胁边界（防被动 hub、不防主动改 JS） |
