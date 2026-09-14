# E2EE 大文件上传：分片 + 通道自愈（solution）

> **日期**: 2026-09-14 ｜ **上游**: [discussion.md](./discussion.md)（F1–F24）
> **目标**: 让"大文件上传"这一条用户可见结果彻底修好 —— ① 大请求体能送达（分片）；② 失败时**有错误、不静默挂起**；③ hub 不被大帧打死（已先行落地）。

---

## 1. Goal

| # | 目标行为 |
|---|---|
| G1 | E2EE 下请求体可分片发送，>16 MiB 上传不再撞单帧上限，字节一致 |
| G2 | 通道失效（对端关闭/超限拒绝）时：挂起请求**立刻 reject**，且**下次请求自动重新握手**（不静默挂起、不必刷新） |
| G3 | 任何超大中继帧都只废该连接/该流，hub 进程存活（跨租户可用性） |

## 2. Facts（查档确认，详见 discussion）

| # | 事实 | 位置 |
|---|---|---|
| F11 | 请求体整包进一帧，隧道上限 16 MiB | `packages/hub/src/e2ee-shim.ts`（改前 `if (body) await sendFrame(…, body)`）；`packages/tunnel/src/frame.ts:12,28-29` |
| F15 | 18 MiB 文件走 RPC + base64 ⇒ 25 MB 单帧 | `@deepseek-ai/dsh-client-file-upload/lib/client.js:177-196` |
| F17 | 通道失效后不复位、不 reject ⇒ 静默挂起 | `e2ee-shim.ts`（改前 `channel`/`handlers` 无失效处理） |
| F18–F21 | 超大帧未捕获 ⇒ hub 进程退出 | `packages/hub/src/relay.ts`（改前无 `maxPayload`、无 try/catch） |
| — | **gateway 对 http 流的每个 DATA 帧执行 `up.write()`** ⇒ 多帧请求体天然支持 | `packages/gateway/src/join.ts:621` |
| — | host 侧逐帧解密（一条 DATA 帧 = 一个 AES-GCM 包）⇒ **hub 不能拆帧** | `packages/gateway/src/join.ts:701-721` |

## 3. Gap

| 目标 | 现状 | 差距 |
|---|---|---|
| G1 | 整包一帧 | 缺"按 ≤1 MiB 分片发送"，且 handler 注册晚于发帧（快响应会丢） |
| G2 | 无失效处理 | 缺 `failChannel`（reject 挂起请求 + 复位 `channel`） |
| G3 | 无上限、异常外逃 | 缺 `maxPayload` + 中继回调 try/catch |

## 4. Call-site Audit

| 改动 | 影响面 | 兼容性 |
|---|---|---|
| 请求体分片（http 流多发 DATA） | gateway 内层分发 | ✅ `join.ts:621` 逐帧 `up.write()`，语义等价于流式 body |
| WS 消息**不分片**（保持一条消息 = 一帧） | DSH mux | ✅ 有意保留：WS 分片会破坏消息边界 |
| `sendFrame` 增加"通道已死则抛" | shim 内所有调用点（fetch/WS） | ✅ fetch 侧 reject；WS 侧 `.catch(shutdown)` |
| `wss.maxPayload` | 全部中继 WS（`/e2e` + 普通 WS） | ✅ 上限=协议上限，合法流量不受影响（AC8 覆盖） |

## 5. Tasks

| # | 任务 | 文件 | 状态 |
|---|---|---|---|
| T1 | 中继 `wss.maxPayload = MAX_PAYLOAD_LENGTH`（超限 ws 层 1009） | `packages/hub/src/relay.ts:17-24` | ✅ |
| T2 | 两个中继回调 try/catch：封装不了只废流（`close(1009)` + `abortStream`） | `packages/hub/src/relay.ts` | ✅ |
| T3 | 请求体按 1 MiB 分片（`CHUNK`）、**先挂 handler 再发帧**、发送失败即 reject | `packages/hub/src/e2ee-shim.ts`（fetch 包装） | ✅ |
| T4 | 通道失效处理 `failChannel`：reject 挂起请求、复位 `channel`（自愈）；WS 侧 `.catch(shutdown)` | `packages/hub/src/e2ee-shim.ts`（`ensureChannel`/门面） | ✅ |
| T5 | 回归测试：分片帧数与字节一致；通道关闭 ⇒ 必报错 + 重新握手；超限帧 ⇒ 1009 + hub 存活（含反证） | `packages/hub/test/e2ee-shim-ws.test.ts`、`packages/hub/test/relay-oversize-frame.test.ts` | ✅ |
| T6 | **响应**流式/二进制保真（AC2/AC3）、请求体类型扩充（AC4） | 同上 | ⏳ 待做 |

## 6. 非目标

- 不改 E2EE 协议/握手/密钥派生/Aead；
- 不改 DSH 前端源码；
- 不在 hub 拆帧（host 逐帧解密，拆了必坏）；
- 不在本项内改"后台上传走 Worker ⇒ 明文"（F13，需产品决策：Worker 无法被页面 shim 覆盖，要么接受明文、要么改 DSH 侧走 E2EE）。
