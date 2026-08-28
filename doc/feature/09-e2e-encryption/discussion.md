# 09-e2e-encryption — 需求讨论记录（discussion.md）

> **日期**: 2026-08-28
> **状态**: 讨论中（仅讨论，未立项、未实现）
> **来源**: `proposal.md` §10 Q5（E2E 加密预留）+ 2026-08-28 讨论
> **性质**: 端到端加密——hub 中转流量但**无法读取内容**（浏览器 ↔ host，hub 不可读）。**社区 + SaaS 双版本通用**（社区多租户：hub 管理员 ≠ host 持有者；SaaS：运营方不可读）。

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

## 3. 方案对比

### 方案 A —— 内层 TLS（TLS-in-TLS，原始流透传）

浏览器与 host 在 hub 之上再建一条**内层 TLS**（hub 只当透明字节通道，不解析 HTTP）；host 用**自签证书 + join 时指纹 pinning** 完成内层握手。

- ✅ 最强、最标准：直接复用 TLS 1.3 握手 / 密钥调度 / AEAD / 防重放，**不自造密码学**
- ✅ 彻底：连 header、path、body 一起加密，hub 只看到「某 host 的一条密文流」
- ❌ 要加「raw stream 透传模式」（hub 不解析 HTTP、纯字节双向转发，`flags` bit0 标记）+ 每 host 证书/指纹管理

### 方案 B —— 应用层帧级 AEAD

保留现有「HTTP 感知」转发（路由不变），只加密敏感部分：**DATA 帧（body）+ 敏感头（Authorization/Cookie）+ WS 消息**，用每会话对称密钥 AEAD（AES-256-GCM / ChaCha20-Poly1305）。`method/path` 等路由信息保持明文。

- ✅ 改动小，贴合现有 OPEN/DATA 结构
- ❌ 手写密钥交换 + 分层加密（body/header/WS 分开）+ nonce/防重放/轮换，**密码学出错风险高**
- ❌ header 加密是脏活：路由头（method/path）明文 + 敏感头密文，字段级拆分

## 4. 密钥与信任（两方案共用）

- host 生成**长期密钥对**（X25519 / Ed25519）；公钥指纹 **join 时 pinning**（portal「添加主机」展示，类 SSH host key / Signal 安全号）。
- 会话密钥 = 浏览器临时密钥 × host 公钥 **ECDH → HKDF → AEAD**，每会话/重连轮换，前向保密。
- **诚实提醒**：无额外带外信道时，pinning 本质是 **TOFU（首次信任）**——hub 若在 join 那一刻 MITM 也能得逞。更强做法：host 侧 CLI 打印指纹、用户在 portal 比对（类 SSH）。

## 5. 性能

| 维度 | 影响 |
|---|---|
| 吞吐 | AES-GCM / ChaCha20 有 AES-NI 硬件加速（GB/s/core）；DSH 流量瓶颈在网络非密码学；外+内双层 ≈ 2× 对称运算，毫秒级以下 |
| 延迟 | 方案 A：建流 +1 RTT（TLS1.3 握手）后持续复用；方案 B：密钥预协商 +1 ECDH 往返或 0 |
| 内存/背压 | 流式分片（沿用 300MB 背压）；AEAD 每块 +16B tag +12B nonce，帧开销 ~28B，可忽略 |
| 元数据泄漏 | hostId/method/path/大小/时序仍可见（方案 B 更明显）；防大小/时序侧信道需 padding（加开销） |

## 6. WS text/binary 坑

DSH 的 `/api/events.mux` 是 text/JSON 协议，协议明确「WS 内容按文本帧转发」。E2E 加密后 WS 载荷变 **binary**，破坏这条规则。二选一：

1. ciphertext 做 base64 塞回 text 帧（+33% 体积）；
2. 扩展协议允许 binary WS 内容（`PROTOCOL.md` 已预留「未来若需二进制 WS 再扩展」）。

## 7. 倾向与待定

- **倾向**：长期 = 方案 A（TLS-in-TLS）；快速最小可用 = 方案 B 先加密 body + WS 内容（暂不管 header）。
- **待定**：
  1. A / B 选型；
  2. 指纹 pinning 的 UX（TOFU vs CLI 比对）；
  3. WS text/binary（base64 vs 协议扩展）；
  4. 是否 padding 防侧信道；
  5. 是否每 host 开关（社区自托管默认关、SaaS 默认开）。

## 变更记录

| 日期 | 变更 |
|---|---|
| 2026-08-28 | 建立；方案 A/B + 性能 + 密钥信任 + WS 坑 初步讨论 |
