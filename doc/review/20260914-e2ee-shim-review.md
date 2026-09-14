# E2EE 数据面修复复审（e2ee-shim / 中继护栏 / 上游失败分类）

> **日期**: 2026-09-14（复审）
> **对象**: `9a8d6bb..260b3ab` 共 4 个提交（E2EE shim 生效、流式/二进制、manifest 兜底、请求体类型 + 上游失败分类）
> **结论**: **方向正确、修复真实、验证充分（单测 + 真机双证据），可发布**。但复审发现 **1 个 P1 遗留**（host 侧"单帧 >16 MiB 打死进程"的镜像风险）与若干 P2/P3 健壮性项，建议发布前评估 P1、其余排期跟进。
> **关联**: [fix/20260914-e2ee-not-engaged](../fix/20260914-e2ee-not-engaged/summary.md)、[fix/20260914-e2ee-fetch-streaming](../fix/20260914-e2ee-fetch-streaming/summary.md)

---

## 1. 复审范围

| 文件 | 变更 | 复审方式 |
|---|---|---|
| `packages/hub/src/e2ee-shim.ts` | +232：hostId 注入、WS 门面自有属性、`fetch` 输入归一化、请求体分片/类型、通道失效自愈、响应 `ReadableStream`（流式 + 字节保真 + 取消 + 204） | 逐行读 + 单测 + 真机 |
| `packages/hub/src/relay.ts` | `wss.maxPayload=16MiB` + 两个中继回调 try/catch（只废流） | 逐行读 + 单测（含反证） |
| `packages/hub/src/server.ts` | 无 host 上下文时 `*.webmanifest` 返回合法 manifest | 逐行读 + 单测 |
| `packages/gateway/src/join.ts` | `classifyUpstreamFailure()` + `responded` 标记接入 `up.on("error")` | 逐行读 + 单测 + 真机 |
| 测试 | `e2ee-shim-ws.test.ts`(18)、`relay-oversize-frame.test.ts`(2)、`manifest-fallback.test.ts`(2)、`upstream-failure.test.ts`(4) | 跑通 `pnpm test` 全绿 |

## 2. 总体结论

四件事——E2EE 真正生效、大文件上传、预览二进制/流式、hub 不被超大帧打死——**都修在根子上且有双证据**（单元：真实 X25519+HKDF+AES-GCM 沙箱逐字节断言；真机：无头 Chrome + CDP，18,755,423 B PNG sha256 一致、287 块流式、20 MiB 请求体全量送达、hub 同 pid 存活）。**没有发现"修错了/修偏了"的问题**，也没有回归迹象。下面只列**残留与观察**。

## 3. 发现的问题

### P1（已修 ✅ 2026-09-14 第二审后）

- **【镜像 DoS】host 侧把 >16 MiB 的响应体打包成单帧，可打死 host 进程** —— **已修**：`join.ts` 新增 `sendChunkedBody()`（`DATA_FRAME_CHUNK = 1 MiB`），补丁路径与 `sendSyntheticHttp` 的响应体一律按 ≤1 MiB 分片发送（多 DATA 帧在 hub/浏览器侧天然拼回同一个 body）。1 MiB 远低于隧道 16 MiB 上限，且给 E2EE 方向（密文 = 内层帧 + 28 B nonce/tag）留足余量。回归测试 `join-loopback-patch.test.ts`「>16 MiB 的 JS 响应：按 ≤1 MiB 分片发送、字节一致、补丁仍生效」。

### P2（健壮性，建议近期）

- **【通道去重】`ensureChannel()` 非重入**：`if (channel) return channel`（`e2ee-shim.ts:110`）到 `channel = ch`（`:134`）之间隔着 `handshake()` 与 WS `open` 两个 await。DSH 启动时会并发发起多条 `/api` fetch ⇒ 首次握手窗口内可能**建立多条 `/e2e` 通道**（N 次 Noise 握手 + N 条 WS）。功能上各自独立、能自愈，但资源浪费、且给 host 侧多开 raw 流。建议加 in-flight promise 去重（`var pending; return pending ?? (pending = …)`，finally 清空）。
- **【Request 输入不完整】`fetch(Request, init)` 只取 `input.url`**（`e2ee-shim.ts:152`），忽略 `input.method/headers/body`。当前 DSH 传的是 URL 实例（未触发），但按 fetch 语义 `Request` 字段应优先于 `init`。若未来有调用方 `fetch(new Request(...))`，会静默退化成"GET + 无头 + 无体"。建议 `input instanceof Request` 时合并 `method/headers/body`。

### P3（防御性 / 记录）

- **【settle 前不 try】`settle()` 先置 `settled=true` 再 `new Response(...)`**（`e2ee-shim.ts:215-223`）：非法 status（<200 或 >599；101/103 即使走 null-body 分支也非法）会让 `new Response` 抛 RangeError，逃逸到 `ws.onmessage` 的 `.catch` → `ws.close()`，而 fetch promise 已被标 settled ⇒ **再次"静默挂起"**。dsh 正常不会发这类 status，但建议 try/catch 后 reject。
- **【204+body】`onData` 对已 close 的 controller `enqueue`**（`e2ee-shim.ts:233`）会抛 TypeError，同样逃逸到 `.catch` → 关整条通道。仅畸形响应触发；加 `try` 或先判 `ctrl` 状态即可。
- **【F14 未完全】`upRes.on("error")` 仍是泛化文案**（`join.ts:558,612`，`CLOSE(502, "upstream error")`）：响应中途断开（ECONNRESET）会走这里而非 `up.on("error")`，仍不带 errno。方向没错（已不再误报"不可达"），但"具体性"只补了请求前那一半。
- **【背压未实现】** 响应流 `ctrl.enqueue` 不 respect `desiredSize`，消费者不读时整包滞留内存（"流式"在慢消费下退化）。已知简化，可后续加 `desiredSize` 阈值节流。
- **【格式】** `join.ts` 曾出现 `*/export function isJsContentType` 粘连一行（本次引入），复审中已修（未提交）。

## 4. 已确认无问题的关键点（正面核验）

- **AES-GCM nonce 不重放**：nonce 嵌入每个包、`Aead` 计数器在 `encrypt` 内同步自增，并发 `sendFrame` 乱序到达也能各自解密（对端按包内 nonce 解密，不依赖全局顺序）。
- **请求体分片正确**：1 MiB 远低于"内层帧 + AES-GCM(12+16) + 隧道 16 MiB"上限；gateway 对 http 流逐帧 `up.write()`（多 DATA 拼成一个请求体）⇒ 语义正确。
- **WS 消息不分片是对的**：分片会破坏 host 侧的消息边界（一条 DATA = 一条 WS 消息）。
- **`wss.maxPayload=16MiB` 只影响浏览器→hub 入向**；hub→浏览器出向无限制，11 MB JS bundle 正常（不受误伤）。
- **pdf.js 的 `response.url` origin 校验**：shim 构造的 `Response.url === ""`，pdf.js `getResponseOrigin` 用 `URL.parse("")?.origin ?? null` ⇒ 两侧 null 相等，预览不因此报错。
- **WS 门面 `own()` 遮蔽原生只读 getter** 正确，`Object.create(NativeWS.prototype)` 保留了 `instanceof` 兼容。
- **manifest 分支位置正确**：有 host 上下文仍转发 DSH 自己的 manifest，无上下文才兜底。

## 5. 验证充分性评估

| 维度 | 评估 |
|---|---|
| 单元 | 强：真实密码学往返、逐字节断言、反证（去掉护栏必失败）、原生形态 prototype 反证 |
| 真机 | 强：无头 Chrome + CDP，覆盖 AC1（`WrappedWS`）、AC2（sha256 一致）、AC3（287 块/首块 206ms）、AC4（Blob/流式体 rpcId 回显、不支持类型抛错）、AC7–AC10（hub 存活）、F14（文案变化） |
| 缺口 | 并发首连（P2#1）、>16 MiB JS bundle（P1）、畸形响应（P3）——均无覆盖，建议随修复补测 |

## 6. 建议

1. **发布前**：P1（host 侧单帧护栏）已修。其余 P2/P3 不阻塞发布。
2. **近期**：补 `ensureChannel` 去重 + `fetch(Request)` 字段合并，各补一条单测。
3. **发布清单**（三包一起）：`rdsh-hub`（shim/中继/manifest）+ `rdsh-gateway`（F14 + 若做 P1 的护栏）+ `remote-dsh`（依赖版本）。
4. 顺带把 §3 的 P1 与 `upRes.on("error")`（P3#F14）归入同一个"上游失败/超限"处理函数，避免以后 hub/host 两侧语义再分叉。

## 7. 参考

- fix 记录：[20260914-e2ee-not-engaged](../fix/20260914-e2ee-not-engaged/summary.md)、[20260914-e2ee-fetch-streaming](../fix/20260914-e2ee-fetch-streaming/summary.md)
- 线协议上限：`packages/tunnel/src/frame.ts:12`（`MAX_PAYLOAD_LENGTH = 16 MiB`）

---

---

## 9. 第三审（结构性地收口"任何发送路径都不抛未捕获异常"）

测试环境侧复审指出：分片护栏只盖了 4 个 DATA 发送点中的 2 个，还有两处可能打死 host。已收口：

| 发送点 | 处置 |
|---|---|
| 补丁路径 + `sendSyntheticHttp`（HTTP） | `sendChunkedBody()` 分片（第二轮已修） |
| 非补丁 HTTP 流式路径（`upRes.on("data"）` | 改走 `sendChunkedBody()`（每个 chunk 通常 ≤64 KiB，结构上不再裸调 `encodeFrame`） |
| **WS 流（`openWsStream` 上游消息）** | 新增 `sendWsData()`：超 16 MiB 不发 DATA、改发 `CLOSE(1009)` 并关上游；**WS 消息不能分片**（保消息边界），超限即废流 |
| 微观 nit：`onClose` JSON 解析失败按"干净结束" | 已改为**解析失败按失败处理**（`MALFORMED_CLOSE`） |

回归：`join-ws-oversize.test.ts`（WS 上游 >16 MiB ⇒ `CLOSE(1009)`、无 DATA 帧、上游被关 1009、进程不死）；`join-loopback-patch.test.ts`（17 MiB HTTP 分片）保持。`pnpm build` 0 error、`pnpm test` 全绿。

至此，host 侧**所有 DATA 发送路径都有界**：HTTP 超限分片、WS 超限废流；`encodeFrame` 不再可能因超限把 `ProtocolError` 抛进回调。


## 8. 第二审（测试环境侧反馈）→ 处理结果

> 第二审（另一侧在测试环境读 diff）反馈 6 条，逐条处置如下。

| # | 反馈 | 判定 | 处理 |
|---|---|---|---|
| 1【高】`packages/gateway/src/server.ts` 会话分支漏传 `jsPatch`（LAN 配对/登录模式下 loopback 补丁不生效，设置/API key 打不开） | **属实，已修** | 会话分支 `forwardHttp` 补上 `jsPatch: ctx.trustPairedAsLoopback ? patchLoopbackJs : undefined`（`server.ts:253`）；新增回归用例 `server.test.ts`「配对/会话分支也必须打 loopback 补丁」 |
| 2【高】4 个修复全部未发布 | 属实（发布项） | 见 §6 发布清单，需单独 Go |
| 3【中】verification.md §4 编号重复 + 「F14 待定位」与 TODO「已完成」矛盾；LIMITATION 用 `- [ ]` 会被机械提取当未完成 | **已修** | §4 改为无编号列表、删掉「待定位」；两记录 TODO 的 LIMITATION/范围外段落 `- [ ]` → `- [x]`（已决策不修/已移交）；AC1 状态由 🟡 改 ✅（用户已端到端实测） |
| 4【中·产品决策】E2EE 仍是 optional 静默回退，用户无「本次明文」提示 | 属实（产品取舍，非 bug） | 保持现状（可用性优先）；已在 TODO 记为企业 opt-in / 产品待办 |
| 5【低→实为中】`responded===true` 时发 `CLOSE(code=UPSTREAM_ABORTED)`，但 shim 的 `onClose` 不区分 code ⇒ chunked 响应把截断当成功；且 ERROR 帧与 CLOSE 同路 ⇒ 上游不可达时 fetch 得到「200 空 body」 | **属实，已修（且牵出更早的 ERROR 同路 bug）** | shim 分发器：`ERROR` 帧 → `onError`（带 payload 文案）；`CLOSE` → `onClose(payload)`；fetch 的 `onClose` 解析 code，非 0 即 `ctrl.error/reject`。新增 2 例：`CLOSE(code!=0)` 读流报错、`ERROR` 帧 ⇒ fetch reject（`e2ee-shim-ws.test.ts` 现 **20/20**） |
| 6【低·格式】`join.ts` `*/export function` 粘连一行 | 属实（本次引入） | 已修（换行），待提交 |

**本轮新增代码改动**：`packages/gateway/src/server.ts`（jsPatch 会话分支）、`packages/hub/src/e2ee-shim.ts`（ERROR/CLOSE code 语义）、`packages/gateway/test/server.test.ts`、`packages/hub/test/e2ee-shim-ws.test.ts`（20/20）。`pnpm build` 0 error、`pnpm test` 全绿。
