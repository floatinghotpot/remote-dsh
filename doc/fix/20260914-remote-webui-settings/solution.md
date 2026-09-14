# 修复：让用户在远程 Web UI 里能进设置、能输入 API key（solution）

> **日期**: 2026-09-14 ｜ **目标**: 达成 [discussion.md](discussion.md) §2 的 **AC1–AC3**，且不破坏 **AC4**
> **原则**: 这是**一个结果**（用户能改设置/配 key），因此**一个 fix** —— 三个因素在同一记录内一并处理，不拆成多个 fix

---

## 1. 目标行为

| AC | 行为 | 依赖因素 |
|---|---|---|
| AC1 | 远程（hub + E2EE）设置页可打开 | ① ＋ ② |
| AC2 | 远程 Web UI 能输入并保存 API key，保存后会话可用 | ① ＋ ② |
| AC3 | LAN（`http://<LAN-IP>:8443`）同样可打开设置并输入 key | ③ |
| AC4 | E2EE 语义不变、不改 DSH 前端源码 | 全部改动都不触碰协议与 DSH |

## 2. Gap

用户拿到的是"设置页进不去 / 配不了 key"，而链路上有**三处**都会单独导致这一结果（见 discussion §3）：① hub 侧 E2EE shim 门面缺 API；② host 侧 loopback 补丁未证明落地；③ LAN 路径完全没打补丁。

## 3. 任务

### T1｜hub：补全 E2EE shim 的 WebSocket 门面 —— ✅ **已实施**

`packages/hub/src/e2ee-shim.ts`（唯一生产代码改动，+64/−8）：

1. `addEventListener(type, fn, { once })` / `removeEventListener`（重复注册去重）；
2. 静态常量 `WrappedWS.CONNECTING/OPEN/CLOSING/CLOSED = NativeWS.*`；
3. 实例属性 `url`/`protocol`/`extensions`/`binaryType`/`bufferedAmount`；
4. `close()` 落到 CLOSED 并派发 close（幂等）；`on*` 与 `addEventListener` **双通道派发**；
5. handlers **前移到派发 open 之前**（消除开门丢帧窗口）；
6. `send()` 保留"连接建立前入队"，已关闭时静默丢弃。

**不动**：协议、握手、密钥派生、Aead、非 `/api` 直通语义。

### T2｜host：让 loopback 补丁**真正落地**—— ✅ **已修并端到端验证**

**关键事实（曾有测试盲区）**：dsh 会按 `accept-encoding` **gzip 压缩 JS**，而补丁是在字节里做字面量替换 ⇒ 在压缩体上必然 miss（fail-open 静默）⇒ 前端 `isLoopback` 从未被改写。上一轮的集成测试用"不压缩的假上游"，因此误判为已通过。

修复（`packages/gateway/src/join.ts`）：

1. **编码感知**：新增 `http-encoding.ts`（identity/gzip/deflate/br 解码与按原编码重压；未知编码 → 放弃并原样透传）；
2. **OPEN 帧后移**：命中 JS 补丁时，**先缓冲 → 解码 → patch → 重压 → 再发 OPEN**（并把 `content-length` 改为新长度）——原先 OPEN 在读到 body 之前就发了，长度会对不上；
3. **缓存头**：补丁命中时把上游的 `immutable`/一年 max-age 改为 `public, max-age=300`（否则浏览器长期复用旧的未补丁 bundle）；
4. **留痕**：未命中时每个路径打一条 `[patch] miss` 日志（fail-open 不再无信号；`RDSH_DEBUG_PATCH=1` 时另打 hit 日志）。

**测试**（`join-loopback-patch.test.ts`）：identity/gzip/deflate/br 均命中且 `content-length` 正确；`zstd`（未知编码）**字节级原样透传**；非 JS 不动。
**端到端复验**：同一真实 combo URL（11 MB）在 `gzip` 与 `identity` 下**都已补丁**（11 MB → 补丁 → 3.9 MB，带宽反而略优）。

### T3｜LAN：给转发路径加 JS 补丁 + 显式信任开关 —— ✅ **已实施**

| 文件 | 改动 |
|---|---|
| `packages/gateway/src/proxy.ts` | `ForwardOptions` 新增 `jsPatch?: (body: Buffer) => Buffer \| null`；命中 `content-type` 含 `javascript` 时缓冲后替换，未命中/无编码信息时原样透传（fail-open）；带 `content-length` 重写与编码头清理 |
| `packages/gateway/src/server.ts` | `GatewayOptions` 新增 `dshUiCompat`；ctx 解析 `trustPairedAsLoopback !== false`；LAN 两个分支（`auth.mode === "none"` 与会话分支）均传 `jsPatch: ctx.trustPairedAsLoopback ? patchLoopbackJs : undefined` |
| `packages/gateway/src/serve.ts` | 把 `config.dshUiCompat` 透传给 `startGateway` |
| `packages/gateway/src/config.ts` | `DshUiCompat` 新增 `trustPairedAsLoopback`（默认 `true`，`false` = 严格模式）；解析器同时校验两个开关 |
| `doc/overview/usage.md` | §8.5：写明 loopback 门禁与两个开关；同时修正原先误导的 `EnvironmentFile` 说法（CLI 不生成该行，需 drop-in；且 **API key 不要放环境**） |

> **默认值取舍（可一行翻转）**：默认 `on` —— 与隧道路径保持一致（"网关自身是认证层"，已通过配对/登录的会话视同 loopback），否则 LAN 用户仍配不了 key（AC3 不达成）。若你要更保守：`dshUiCompat.trustPairedAsLoopback: false` 即回到"LAN 不能改设置"的原状。

### T4｜测试

- ✅ `packages/hub/test/e2ee-shim-ws.test.ts`（3 例：未 pin 直通 / 门面契约 / 真实 X25519+HKDF+AES-GCM 往返；已用"回退旧版 ⇒ 报 `ws.addEventListener is not a function`"反证）；
- ✅ `packages/gateway/test/join-loopback-patch.test.ts`（1 例：隧道侧补丁落地 + 非 JS 不动）；
- ✅ `packages/gateway/test/proxy-js-patch.test.ts`（2 例：LAN 开关 on = 替换 / off = 原样透传；HTML 注入不受影响）。

## 4. Call-site Audit

| 调用点 | 用法 | 兼容性 |
|---|---|---|
| `dsh-api-gateway/lib/client.js:402-432` | `addEventListener`/`removeEventListener` 订阅远端流 | ✅ T1 后 |
| 同文件 `waitForSocket` | `readyState === WebSocket.OPEN` | ✅ T1 补静态常量后 |
| 同文件 `receive(socket, event.data)` | 只读 `event.data` | ✅ 派发 `{ type, data }` |
| 我们仓内浏览器侧 | 无其它 `new WebSocket`；portal 被 shim 跳过 | ✅ |
| LAN 转发（`server.ts` → `forwardHttp`） | 目前仅 HTML 注入 | T3 后支持 JS 补丁 |

## 5. 风险

1. **T1 在加密路径上改动** ⇒ 必须成对复核"密文/握手语义不变 + 设置页恢复"（AC4）；
2. **T3 的信任模型决定**：默认 `on` 会放宽 LAN 会话权限（能改设置、能存凭据）；默认 `off` 则 LAN 用户仍需手动配置 key（AC3 不自动达成）；
3. **T2 若需要改 host**：改动落在 `rdsh-gateway`，需配测试（复用 `patchLoopbackJs` 单测 + 集成用例）；
4. **回归盲区**：这类"伪对象缺 API"只在运行期炸 —— T4 的契约测试即为防止再次静默漏出。
