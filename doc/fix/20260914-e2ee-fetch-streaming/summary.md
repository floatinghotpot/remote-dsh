# E2EE 大文件上传：分片 + 通道自愈（summary）

> **日期**: 2026-09-14 ｜ **对应**: [discussion.md](./discussion.md) · [solution.md](./solution.md) · [verification.md](./verification.md)
> **一句话**: "大文件上传 + 预览"这条线全部打通 —— **大请求体能送达**（1 MiB 分片）、**失败时报错不再静默挂起**、**超大帧不再打死 hub**、**响应二进制逐字节保真且流式**（真机 17.9 MB PNG sha256 一致、287 块、首块 206 ms）、**请求体类型齐全且不支持类型明确报错**、**上游失败不再被误报成"不可达"**。

---

## 1. 做了什么

| # | 问题 | 修法 | 文件 |
|---|---|---|---|
| ① | 请求体整包一帧（>16 MiB 必失败；18 MiB 文件 ⇒ 25 MB 单帧） | 按 **1 MiB** 分片发送（http 流天然支持多 DATA；WS 消息**不分片**以保消息边界）；**先挂 handler 再发帧**（快响应不再丢）；发送失败即 reject | `packages/hub/src/e2ee-shim.ts` |
| ② | 通道失效后请求**静默挂起**（"no error and no reply"），且必须刷新页面 | `failChannel`：reject 全部挂起请求 + 复位 `channel`（下次请求自动重新握手）；WS 侧 `.catch(shutdown)` | 同上 |
| ③ | 超大中继帧**打死 hub**（跨租户 DoS，用户实测全站 `ERR_CONNECTION_REFUSED`） | `wss.maxPayload = 16 MiB`（超限 ws 层 **1009**）+ 两个中继回调 try/catch（封装不了只废该流） | `packages/hub/src/relay.ts` |
| ④ | 响应被**整体缓冲 + 强制 UTF-8 解码** ⇒ 预览二进制损坏、无流式（AC2/AC3） | 响应体改为**按字节的 `ReadableStream`**（头到即 resolve，DATA 帧逐块 enqueue）；JSON 交给原生 `.json()`（删掉 parse→stringify）；`cancel()`/`AbortSignal` 会向 host 发 `CLOSE(code 1)` 中止上游；204/205/304 走无 body 构造 | `packages/hub/src/e2ee-shim.ts` |
| ⑤ | 请求体只认 string/TypedArray（Blob→0 字节、FormData→1 垃圾字节，**静默**） | Blob/File、ReadableStream（边读边发）、FormData（multipart）、URLSearchParams 按字节发送，未设 content-type 时按 `blob.type`/multipart 自动补；**不支持的类型抛 `TypeError`**（开流前失败） | `packages/hub/src/e2ee-shim.ts` |
| ⑥ | 上游失败一律报 `UPSTREAM_UNREACHABLE: dsh not reachable`（掩盖真实 401/413） | `classifyUpstreamFailure()`：只有在**连不上**时才报不可达；已连上但提前断开报 `UPSTREAM_ABORTED`（带真实 errno）；已发出响应头 ⇒ 用 `CLOSE(502)` 表示截断 | `packages/gateway/src/join.ts` |

## 2. 关键证据

- **真机**：E2EE 下 **20 MiB 请求体全量送达**，`HTTP 400 · body is not JSON`、**448 ms** 完成（修复前：单帧 20 MiB ⇒ 通道被 1009 关闭 + 永久挂起）；
- **真机（AC2/AC3）**：18,755,423 B PNG 经 E2EE 取回，**sha256 与本地文件一致**、**287 块流式**、首块 206 ms；同一响应在修复前会被文本化 + 整体缓冲；
- **真机（AC4）**：Blob 体（`type: application/json`）与 2 块 ReadableStream 体均返回 200 且 **rpcId 原样回显**（证明字节到达并解析成功）；`{not:'a body'}` ⇒ `TypeError: unsupported request body type`；
- **真机（F14）**：同一请求的报错由 `UPSTREAM_UNREACHABLE: dsh not reachable` 变为 `UPSTREAM_ABORTED: upstream closed before responding (ECONNRESET)`；
- **单测**：`e2ee-shim-ws.test.ts` **18/18**（分片帧数/每帧上限/字节一致；通道关闭 ⇒ 必报错 + 重新握手；二进制+流式+204+取消；Blob/流式/FormData/不支持类型）、`relay-oversize-frame.test.ts` **2/2**、`upstream-failure.test.ts` **4/4**；
- **反证**：移除中继护栏后同一用例失败（`payload too large`）；
- **用户实测**：上传大文件后 hub **未崩溃、未重启**（日志无 `ProtocolError`/`tunnel lost`），console 由"连接被拒"变为"无错误但无响应" ⇒ 定位到 ② 并修复。

## 3. 影响面

- **可用性**：单个租户再也无法用一个超大帧打死多租户 hub（此前触发门槛仅"有 host cookie 的浏览器"）；
- **体验**：通道失效从"静默挂起 + 必须刷新"变为"明确报错 + 自动恢复"；
- **能力**：E2EE 下请求体不再受 16 MiB 单帧限制（仍受 4 亿字节级内存与 DSH 自身配额约束）；
- **未变**：E2EE 协议/握手/密钥派生/Aead 零改动；DSH 前端源码零改动。

## 4. 质量门

`pnpm build` 0 error；`pnpm test` 全绿（7 包）。

## 5. 遗留

代码项已清空，见 [TODO.md](./TODO.md)（发布/运维/复测）、**后台上传走 Worker ⇒ 明文**（F13，**已决策：暂时接受并文档化**；hub 不缓存/不落盘请求体，反代缓冲见 F13c）、上传路径 502 文案（F14）、发布 `rdsh-hub`。
