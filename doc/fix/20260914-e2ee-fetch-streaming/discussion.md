# E2EE 下的大文件上传：分片/流式/二进制 + 超大帧打死 hub（discussion）

> **日期**: 2026-09-14
> **现状**: 同一个 shim（hub 注入 `window.fetch` / `window.WebSocket`）里，**fetch 包装只是"够用版"** —— 响应整体缓冲、二进制被当文本解码、JSON 走 parse→stringify、请求体只认 string/TypedArray 且**整包塞进一帧**；而 DSH 的**文件上传**（Blob/ReadableStream 请求体）与**文档预览**（`response.body.getReader()`）都依赖真实 fetch 语义。
> **结论**: 本记录覆盖**同一次"大文件上传"尝试暴露出的两类缺陷**（同一用户可见结果 = 大文件传不上去，且把服务打挂）：
> - **① 数据面能力不足**（shim）：请求体不分片/不分类型、响应整体缓冲并文本化 ⇒ 大文件必失败、二进制会变形、无流式；
> - **② hub 被超大帧打死**（中继健壮性）：分片的缺失让"整包 base64"变成一条 **25,007,697 B** 的 WS 消息，hub 中继"一条消息 = 一个隧道帧"，`encodeFrame` 超限抛错且**抛点在 ws 回调里没人接 ⇒ hub 进程退出**（跨租户 DoS，全站 `ERR_CONNECTION_REFUSED`）。
>
> **关联**: [20260914-remote-webui-settings](../20260914-remote-webui-settings/discussion.md)（同一 shim 的 WebSocket 门面已修，教训：**替换浏览器原生对象必须覆盖真实调用面**）
>
> **前置更新（2026-09-14，先修完 [20260914-e2ee-not-engaged](../20260914-e2ee-not-engaged/summary.md) 再看本项）**：E2EE **此前从未真正生效**（hostId 取不到 / 门面构造抛 `Cannot set property url … only a getter` / `URL` 实例被解析成 `/undefined` ⇒ 405）。三项已修，真机确认 `WrappedWS` 接管且 `/api` 全部走加密通道 ⇒ **本记录的所有现象必须在新环境下重新采集**；凡"E2EE 下正常"的旧结论一律作废（旧结论都来自明文路径）。

---

## 1. 范围

| # | 对象 | 目标 |
|---|---|---|
| ① | `packages/hub/src/e2ee-shim.ts` 的 `window.fetch` 包装（**不是**已修的 WS 门面） | E2EE 开启时"文件上传 / 文档预览 / 流式响应"**可用且内容保真** |
| ② | `packages/hub/src/relay.ts` 的浏览器 WS 中继（`/e2e` raw + 普通 WS） | **任何**超大帧都不得打死 hub（只废该连接/该流） |

顺带查证 `EventSource` 是否绕过加密。

## 2. 事实（均带 file:line）

### 2.1 第一类：fetch 包装能力不足

| # | 事实 | 证据 |
|---|---|---|
| **F1** | fetch 包装的四个限制：① 请求体只支持 string / TypedArray（`new Uint8Array(init.body)`）② 响应**整体缓冲**（`chunks.push` 到 CLOSE 才 resolve）③ 一律 `TextDecoder` 解码 ④ JSON 响应 `parse → stringify` 回写 | `packages/hub/src/e2ee-shim.ts:120-158` |
| **F2** | WS 包装的 message **一律 `TextDecoder`** ⇒ 二进制 WS 帧会变形（当前 DSH mux 走文本，需复核是否有二进制帧） | `packages/hub/src/e2ee-shim.ts:160-187`+ |
| **F3** | DSH 侧**只有两个** client bundle 使用 `getReader()` / `response.body`：文件上传、文档预览 | `@deepseek-ai/dsh-client-file-upload/lib/client.js`、`@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/client.js` |
| **F4** | shim **只包 `fetch` 与 `WebSocket`，不包 `EventSource`**；而 3 个 client bundle 提到 `EventSource`（是否真用待查） | `packages/hub/src/e2ee-shim.ts`（全文无 EventSource） |
| **F5** | shim 仅在"该 host 已 pin + 同源 + 非 `/portal`"时生效 | `e2ee-shim.ts:48-61,125` |
| **F6** | 响应元数据有损：`statusText`/`url`/`redirected`/`type` 丢失；headers 原样透传 | `e2ee-shim.ts:153` |
| **F7** | 已有可复用测试沙箱（假 `window`/`document`/`localStorage` + 假 `NativeWS` + **真实 X25519+HKDF+AES-GCM 往返**） | `packages/hub/test/e2ee-shim-ws.test.ts` |

### 2.2 真机新事实（2026-09-14，E2EE 首次真正生效后实测）

| # | 事实 | 证据 |
|---|---|---|
| **F8** | 上传路径把文件读成 **ArrayBuffer** 再发（bundle 含 `arrayBuffer()` / `new Blob` / `content-type: application/octet-stream`）⇒ shim 的 TypedArray 分支可正常工作 | `@deepseek-ai/dsh-client-file-upload/lib/client.js`；**浏览器实测**：E2EE 下上传小图成功、DSH agent 读到图片内容 |
| **F9** | `dsh-client-ui-sidebar-documentpreview` 用 `response.body.getReader()` 流式读（7 处 getReader / 2 处 response.body / 10 处 fetch）—— 该路径的二进制/流式行为**待实测** | `@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/client.js` |
| **F10** | `EventSource` 真实使用点唯一：`new EventSource(EVENTS_ENDPOINT)`，位于 HMR 客户端 | `@deepseek-ai/dsh-client-hmr/lib/client.js` |
| **F11** | **请求体一次性塞进一帧**：`if (body) await sendFrame(c, FT.DATA, id, body)`；而隧道协议载荷上限 **16 MiB**（编帧与解析两侧都抛 `ProtocolError`）⇒ **任何 >16 MiB 的 fetch 上传都会失败** | `packages/hub/src/e2ee-shim.ts:141`；`packages/tunnel/src/frame.ts:12,28-29,74-75` |
| **F12** | **shim 覆盖不到 Worker**：页面里 `fetch`/`WebSocket` 已包装（`WrappedWS`），但 Blob Worker 里 `fetch`/`XMLHttpRequest`/`WebSocket` **全部是原生**，`self.__RDSH_HOST_ID__ === undefined` | CDP 探针（`new Worker(blob)` 自报）：`{page:{fetchNative:false,wsNative:false}, worker:{fetchNative:true,xhrNative:true,wsNative:true}}` |
| **F13** | **后台上传因此是明文**：`dsh-client-file-upload` 把上传放进 **Blob Worker**，Blob 体走 `XMLHttpRequest`、ReadableStream 体走 worker 原生 `fetch`（`FILE_UPLOAD_PATH = /api/session/uploadFileBinary`）⇒ shim 拦不住 ⇒ 该路径数据经 hub 明文。**决策（2026-09-14，用户拍板）：暂时接受**——理由：① 包装 `window.Worker` 注入 shim 与 DSH 的快速演进耦合太紧（Blob Worker 源码重写风险），等 DSH 稳定后再评估；② **永不改 DSH 源码**（硬约束）。⇒ 写入用户手册 `doc/overview/usage.md` §9.1 作为已知限制，并给出"怎么判断某次上传走哪条路"的判据 | 代码：`fileUploadWorker(scope, createXhr=()=>new XMLHttpRequest(), doFetch=(i,n)=>fetch(i,n))`；实测：E2EE 页面内 XHR POST 该路径 ⇒ `performance` 多出 1 条 `xmlhttprequest` 明文条目（shim 已接管的情况下）；决策见 usage.md §9.1 |
| **F13b** | **hub 不缓存、不落盘请求体**（用户关切）：中继把请求体**直接流进隧道**（`req.on("data", chunk => conn.sendData(streamId, chunk))`），hub 源码无写文件/临时文件（`serve.ts` 只写 TLS key）；日志只记字节数与错误码、从不记 payload | `packages/hub/src/relay.ts:138-140`、`:239`、`:314`；`packages/hub/src/serve.ts:31` |
| **F13c** | 但**部署侧**要留意：hub 在 nginx 后面时 `proxy_request_buffering` 默认 **on** ⇒ 大请求体被写进 hub 机器临时文件；访问日志记录 URL（上传接口 query 含 `name=<文件名>`）与字节数。另：host 若配了访问口令（gate），网关会把**首个**请求体缓存在**内存**里做口令校验（不落盘） | nginx 默认行为；`packages/gateway/src/join.ts:348,483,604-628` |
| **F25** | **明文范围只有"非图片文件附件"这一类**（2026-09-14 逐条查证）：① **图片**附件在挂载时**不**调用 `fileUpload.upload`，而是随 prompt 以 **base64** 走页面 `fetch` ⇒ **加密**（`base64ImageOf` → `data: await base64ImageOf(file)`）；② **非图片文件**（`kind:"file"`）才 `beginFileUpload` → `upload(sessionId, attachment.file)`，`data` 是 `File`(Blob) 且 `available=true` ⇒ Worker XHR ⇒ **明文**；③ 预览走 pdf.js `PDFFetchStream`（页面 `fetch` + Range + `getReader()`）⇒ **加密** | `dsh-client-ui-conversation/lib/client.js`（`browserDraftAttachment` 只 `probeDimensions`、`:2975-2990` file 分支、`:3212-3216` base64 图片线格式）；`dsh-client-ui-sidebar-documentpreview/lib/client.js`（`PDFFetchStream`/`PDFFetchStreamReader`，7 处） |
| **F26** | 上一条的**数值旁证**：崩溃那次 25,007,697 B 的单帧 ≈ 18,755,423 B 原图 base64（=25,007,232 B）+ JSON 信封（~465 B）⇒ 印证图片确实是"base64 进请求体、经页面 fetch 走 E2EE" | 算术 + F18 |
| **F27** | **可用性优先**（2026-09-14 用户口径）：不以 fail-closed 作为默认；`e2ee.mode: "required"` 只作为**未来企业 opt-in**，默认保持"能传图给 AI"的可用路径 | 用户决策 |
| **F14** | 该 XHR 实测返回 **`502 {"code":"UPSTREAM_ERROR","message":"UPSTREAM_UNREACHABLE: dsh not reachable"}`** —— 文案来自网关 `up.on("error")`（`packages/gateway/src/join.ts:591`），即上游请求**提前中断**被误报成"不可达"，真实的 401/400 被掩盖 ⇒ **待定位**（是否 D12 剥离会话 cookie 导致 dsh 拒绝、或 `content-length` 与分片发送不匹配） | 同上；对照：同环境其它 `/api` 调用（经 E2EE mux）全部 200 |
| **F15** | **大文件走的是另一条路**：`fileUpload.upload()` 在 `data instanceof Uint8Array`（或后台传输不可用）时走 **RPC + base64**（整个文件 base64 进 JSON）⇒ 经页面 `fetch`（被 shim 包）以**单帧**发出；18 MiB 文件 ⇒ **25,007,697 B** 的一条 E2EE 帧 | `@deepseek-ai/dsh-client-file-upload/lib/client.js:177-196`；`packages/hub/src/e2ee-shim.ts:141` |
| **F16** | shim 自己的 `encodeFrame` **不校验** `MAX_PAYLOAD_LENGTH`（与线协议分歧）；该分歧的直接后果见 §2.3（hub 崩溃），分片仍必须做 | `packages/hub/src/e2ee-shim.ts` 的 encodeFrame 实现 vs `packages/tunnel/src/frame.ts:12,28-30` |
| **F17** | shim 的 E2EE 通道被对端关闭（如超限 1009）后**不重置 `channel`** ⇒ 之后所有请求挂起（实测：20 MiB 单帧后 `fetch` 5s 无响应），需刷新页面 | CDP 实测；`packages/hub/src/e2ee-shim.ts` 的 `ensureChannel`/`channel` 变量 |

### 2.3 第二类：超大帧打死 hub（2026-09-14 用户实测，跨租户 DoS）

| # | 事实 | 证据 |
|---|---|---|
| **F18** | **崩溃栈**（用户上传 18 MiB 附件时）：`ProtocolError: payload too large: 25007697 > 16777216`，`at encodeFrame` ← `TunnelConn.send` ← `TunnelConn.sendRawData` ← `WebSocket.<anonymous> (hub relay)` ⇒ 打印 `Node.js v24.19.0` 后**进程退出**；host 侧只剩 `tunnel lost — reconnecting in 1s…32s` | `/tmp/rdsh-e2e-setup.log` |
| **F19** | 中继语义 = **一条浏览器 WS 消息 ↔ 一个隧道 DATA 帧**：`/e2e` raw 流 `clientWs.on("message", … conn.sendRawData(streamId, buf))`；普通 WS 中继同构（`conn.sendData`） | `packages/hub/src/relay.ts:282-289`、`:219-226` |
| **F20** | host 侧**必须逐帧解密**：`handleRawData` 把**每条** DATA 帧当作一个完整 AES-GCM 包（`decryptor.decrypt(chunk)`，nonce 前置）⇒ **hub 不能把大消息拆成多帧转发**（拆了 host 解不开），只能拒绝 | `packages/gateway/src/join.ts:701-721` |
| **F21** | 抛点在 `ws` 的 message 回调里未捕获 ⇒ 影响面是**整个 hub 进程**（同进程所有租户的隧道/门户/API 一起消失）；触发门槛只是"有 host cookie 的浏览器发一条 >16 MiB 的 WS 消息"（`wss` 原无 `maxPayload`，ws 默认 100 MiB）⇒ **单租户即可打死多租户 hub**，且**与 E2EE/上传无关**（明文模式打普通 WS 中继同样成立） | F18 + `packages/hub/src/relay.ts`（改前） |
| **F22** | 用户 console 里的 `GET /plugins/events net::ERR_INCOMPLETE_CHUNKED_ENCODING 200 (OK)` 是 hub 死亡瞬间把在途 SSE 掐断的表象，随后的 `net::ERR_CONNECTION_REFUSED` 才是真因 | 用户贴文 + F18 |
| **F23** | 触发路径与 F15 同源：18 MiB 文件 → base64 的 RPC 请求（~25 MB）→ shim 单帧 → 外层 WS 消息 25 MB → `encodeFrame` 超限 | F15 + F18 |
| **F24** | **已修 + 已验**：中继 `wss` 设 `maxPayload = MAX_PAYLOAD_LENGTH`（超限在 ws 解帧阶段即按 **1009** 关闭），两个中继回调把 `conn.send*` 包进 try/catch（封装不了只废该流）；实测 20 MiB 单帧 → 连接被拒、**hub 存活**（`/portal` 仍 200、pid 不变）；反证：去掉护栏后同一用例必失败（`payload too large`） | `packages/hub/src/relay.ts:17-24,225-243,288-303`；`packages/hub/test/relay-oversize-frame.test.ts` |

**推断（未实测，须先复现）**：E2EE 下文件上传/文档预览"能跑但内容坏或不流式"，而非硬报错（`new Response(text)` 仍给出 `.body` 流）。

## 3. 查证结果（Q1–Q3）

| # | 问题 | 结果 |
|---|---|---|
| **Q1** | `EventSource` 是否真在用？ | ✅ **仅 dev/HMR**：真正 `new EventSource(` 只出现在 `@deepseek-ai/dsh-client-hmr/lib/client.js`；另两个包里的 `EventSource` 只是类名/注释。⇒ 生产路径不涉及；**dev 模式下该通道不走 E2EE**（低危，登记为 TODO） |
| **Q2** | 上传/预览的实际症状与请求体类型 | **部分已答（含一次纠错）**：① **小图上传 ✅ 实测可用**（E2EE 下上传图片成功、agent 读到内容）——客户端把文件读成 **ArrayBuffer**，shim 的 TypedArray 分支吃得下，**此前"Blob ⇒ 空字节"的推断撤回**；② **预览 ⏳ 待测**（`getReader()` + 二进制）；③ **>16 MiB 上传必失败**（F11 一帧 + F18 hub 崩溃） |
| **Q3** | 是否有 SSE / 长响应依赖流式？ | ⏳ 部分：client bundle 里 `text/event-stream` **0 命中**，`EventSource` 仅 HMR ⇒ 生产 SSE 基本不存在；但预览/上传的大对象仍会因"整体缓冲"变慢/占内存，AC3 保留为"不整体缓冲"的机制要求 |

## 4. 验收标准（AC）

| # | 标准 |
|---|---|
| **AC1** | E2EE 下**大文件上传**：>16 MiB 的文件也能成功（请求体需**分块**发送，不得撞 16 MiB 单帧上限），对端收到字节与源文件一致（小/中文件当前已可用，见 F8） |
| **AC2** | E2EE 下**文档/图片预览**内容与明文路径一致（二进制不变形） |
| **AC3** | **流式响应**首块在整体结束前可见（不整体缓冲）；SSE 类通道可用 |
| **AC4** | 请求体类型支持 string / ArrayBuffer·TypedArray / Blob / FormData / ReadableStream；**不支持的类型必须明确报错**（不得静默发错） |
| **AC5** | `EventSource`（若在用）走 E2EE **或被明确阻止**；不得明文泄露 |
| **AC6** | 不回归：设置/API key 路径、WS 门面契约、密文语义（hub 只见密文） |
| **AC7** | （第二类）浏览器发超过隧道单帧上限的 WS 消息：该连接以 **1009** 关闭、该流被中止，**hub 进程存活**并继续服务 |
| **AC8** | （第二类）上限内的 WS 消息**不误伤**：仍按"一条消息 = 一个 DATA 帧"原样转发 |
| **AC9** | （第二类）单测覆盖 AC7/AC8，且**反证成立**：去掉护栏后同一用例必失败（`payload too large`） |
| **AC10** | （第二类）**真机复现**：20 MiB 单帧 → 连接被拒、hub 存活（`/portal` 200、pid 不变）；E2EE 正常路径与设置/凭证 API 不回归 |

## 5. 非目标

- 不改 E2EE 协议、握手、密钥派生、Aead；
- 不改 DSH 前端源码（仍以注入/包装方式实现）；
- **不在 hub 拆帧**（F20：host 逐帧解密，拆了必坏）——hub 的职责只是"拒绝 + 不崩"；
- 不处理"host 进程被自己的大帧打死"（另议）。

## 6. 验证计划

1. **先复现/查证**（本地 hub + 隔离 HOME 的 host，浏览器/CDP 实测）：
   - Q1：DevTools → Network 过滤 `eventsource`；辅以 client bundle 证据；
   - Q2：E2EE 下上传小图（已 ✅）+ 预览图/PDF + 大文件（>16 MiB）；
   - Q3：观察是否存在长连接/流式响应；
2. **单测**：扩展 F7 沙箱（首块早于 CLOSE、二进制字节一致、Blob/FormData 请求体、不支持类型报错、分片后每帧 ≤ 上限）；第二类用 `relay-oversize-frame.test.ts`（已落地）；
3. **E2E**：上传 >16 MiB + 预览图片（AC1/AC2），并复核 AC6/AC10 无回归。

## 7. 当前状态

| 缺陷 | 状态 | 证据 |
|---|---|---|
| ② hub 被超大帧打死 | ✅ **已修已验** | F24；`packages/hub/test/relay-oversize-frame.test.ts` 2 例 + 反证；真机 20 MiB → hub 存活 |
| ①a 请求体分片（>16 MiB 上传） | ✅ **已修已验** | 单测 3 帧拆分 + 字节一致；真机 20 MiB 全量送达 |
| ①b 通道失效不静默挂起 | ✅ **已修已验** | F17；单测：关闭通道 ⇒ 立刻 reject + 重新握手 |
| ①c 响应二进制保真 + 流式（AC2/AC3） | ✅ **已修已验** | 真机 18,755,423 B PNG 经 E2EE **逐字节一致**（287 块、首块 206 ms、sha256 与本地文件相同）；单测：块边界/字节/204/取消 |
| ①d 请求体类型（Blob/FormData/ReadableStream） | ✅ **已修已验** | 单测 4 例 + 真机：Blob/流式体 200 且 rpcId 回显、不支持类型抛 TypeError |
| ③ F14 上游失败误导 | ✅ **已修已验** | `classifyUpstreamFailure`；真机同请求：`UPSTREAM_UNREACHABLE: dsh not reachable` → `UPSTREAM_ABORTED: upstream closed before responding (ECONNRESET)`；单测 4 例 |
