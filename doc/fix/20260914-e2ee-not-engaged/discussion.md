# E2EE 数据面从未启用：shim 不仅取不到 hostId，而且**一构造就抛错**（discussion）

> **日期**: 2026-09-14
> **现象**: 远程页面里 `window.WebSocket.name === 'WebSocket'`（原生，不是 shim 的 `WrappedWS`）⇒ **E2EE 未生效**；浏览器↔主机数据经 hub 明文传输
> **结论**: **根因已实测确认，且是三个独立缺陷叠加**（同一用户可见结果，故同一份 fix 记录）：
> **① hostId 取不到** —— hub 用 `HttpOnly` 种 `rdsh_host`，shim 只读 `document.cookie` ⇒ 拿不到 pin ⇒ `if (!hostPub) return;` 整段退出（静默失效）；
> **② 门面构造必抛** —— `WrappedWS.prototype = Object.create(NativeWS.prototype)` 让实例继承 native 上**只有 getter** 的 `url`，而脚本是严格模式 ⇒ `this.url = …` 抛
> `Cannot set property url of #<WebSocket> which has only a getter`（真机表现为 DSH 插件 loader entry 应用失败）；
> **③ 请求路径错** —— DSH 的 HTTP carrier 传 **URL 实例**，shim 只认 `input.url` ⇒ 路径解析成 `/undefined` ⇒ E2EE 下所有 `/api` 请求 405。
> 三者合起来说明：**这套 shim 从未在真机上跑通过一次**。
> **关联**: [20260914-remote-webui-settings](../20260914-remote-webui-settings/summary.md)（同域：设置页问题**并非** shim 引起，而是 loopback 补丁 + gzip；但那份修复的浏览器验证是在"E2EE 根本没生效"的明文路径上做的）、[20260914-e2ee-fetch-streaming](../20260914-e2ee-fetch-streaming/discussion.md)（流式/二进制/大请求体，属下一项）

---

## 1. 事实链（均带 file:line / 实测）

| # | 事实 | 证据 |
|---|---|---|
| **F1** | hub 种 host cookie 时带 **`HttpOnly`** | `packages/hub/src/server.ts:89`：`rdsh_host=<token>; HttpOnly; SameSite=Lax; Path=/; Max-Age=…`（`clearHostCookie` 同，`:93`） |
| **F2** | shim **只从 `document.cookie` 取 hostId** | `packages/hub/src/e2ee-shim.ts:48-51`（`getHostId()` 正则匹配 `document.cookie`） |
| **F3** | 取不到 pin 就**整段退出**（不包装 fetch/WS） | `e2ee-shim.ts:60-61`：`var hostPub = getPinnedKey(); if (!hostPub) return;` |
| **F4** | **实测**：JS 读不到该 cookie | 浏览器 Console：`document.cookie.includes("rdsh_host")` → **`false`** |
| **F5** | **实测**：门户 pin 表**按 hostId 做键** | `Object.keys(pins)` → `['e2e-host-1']` |
| **F6** | **实测**：页面上 `window.WebSocket.name === "WebSocket"`（原生）⇒ shim 未接管 | 同一环境 Console |
| **F7** | 推论：**所有部署都如此**（同一代码路径），E2EE 一直静默关闭 | F1+F2+F3 |

### 1.1 真机验证（Chrome 153，CDP 驱动，本地 E2EE 环境 `http://e2e.localhost:8799`）暴露的**后续两个缺陷**

| # | 事实 | 证据 |
|---|---|---|
| **F8** | 修好 F1–F3 后 shim 确实接管（`window.WebSocket.name === "WrappedWS"`、`fetch` 非原生），但页面立刻报：`failed to apply loader entry (@deepseek-ai/dsh-api-gateway): Cannot set property url of #<WebSocket> which has only a getter` | CDP `Runtime.exceptionThrown` + 栈顶 `at new WrappedWS` |
| **F9** | **根因②**：`WrappedWS.prototype = Object.create(NativeWS.prototype)`（`e2ee-shim.ts:242`）⇒ 实例原型链上有 native 的**只有 getter** 的 `url`/`protocol`/`readyState`/`on*`；脚本首行就是 `"use strict"`（`e2ee-shim.ts:12`）⇒ 构造函数里 `this.url = u.href`（`:175`）**必然抛 TypeError** | 用 `Page.addScriptToEvaluateOnNewDocument` 给 `WebSocket.prototype.url` 装日志 setter：日志显示赋值来自 `at new WrappedWS (…:168)`，调用方 `RemoteStreamMuxClient.connect`（`@deepseek-ai/dsh-api-gateway/client.js`）|
| **F10** | **回归可复现**：拿 `HEAD` 版 shim（未修）+ 原生形态 prototype 跑同一路径 → 抛 `Cannot set property url … which has only a getter` | `node /tmp/rdsh-oldshim-check.mjs`（一次性脚本）|
| **F11** | 修好 F9 后再验：插件能加载了，但 `/api/dynamicCordisRunner/*` 等全部 `HTTP 405`（E2EE 下） | 页面 console：`transport failure for /api/…: HTTP 405` ×N |
| **F12** | **根因③**：DSH 的 HTTP carrier 传的是 **`URL` 实例**（不是 string）；shim `e2ee-shim.ts:127` 只认 `input.url`（`URL` 上是 `href`）⇒ `url=undefined` ⇒ `new URL(undefined, base)` = **`/undefined`** ⇒ 所有 `/api` 打到错误路径 | 在构建产物里临时插桩（后已还原）：`SHIM-HTTP POST /undefined init=method\|headers\|body\|signal isString=false` |
| **F13** | **对照**：同一环境**不写 pin**（E2EE 关闭）时 14 条 `/api` 调用全部 `200`（含 `settings/describe`、`credentials/describe`）；写 pin 后在修 F12 前全部 `405` ⇒ 405 由 shim 引起，**不是** hub/网关问题 | CDP：`Network.requestWillBeSent/responseReceived` |
| **F14** | **否证**（避免重复排查）：曾怀疑"hub 中继注入被 gzip 跳过"。**不成立** —— 网关对**文档导航**（`Accept: text/html`）剥离 `accept-encoding`（`proxy.ts:58-60`），浏览器式请求实测 `content-encoding: null`、注入顺序 `hostId(56) → shim(362) → assets(38497)` 正常。之前测到 gzip 是因为探针没带 `Accept` 头 | `doc/fix/20260907-dsh-0.1.2-rc1-auth/verification.md:38` 同款结论；本次 curl/fetch 实测 |

## 2. 影响

1. **机密性承诺失效**：浏览器↔主机的 fetch/WS 数据经 hub **明文**（仅有 TLS 到 hub），多租户 hub 运营方可读；
2. **连带解释**：18 MiB 上传、文档预览在"E2EE 环境"下表现正常 ⇒ 因为走的是明文路径；这些测试**在 E2EE 真正启用前都不作数**；
3. **上一轮修的两处变成前置条件**：shim 的 WS 门面（`addEventListener`）与 fetch 包装的流式/二进制/分帧问题，只有在 shim 真正接管后才会被触发 ⇒ 本项修完后必须重跑那批验证；
4. **"E2EE 生效"与"E2EE 可用"是两步**：F9/F12 说明只把开关打开还不够——门面构造失败会让 DSH 插件加载失败，请求路径错会让所有 `/api` 405。**只修 F1–F3 会把系统从"静默明文"变成"页面报错"**，比不修更糟；三项必须一起修。

## 3. 修法选项

| 方案 | 做法 | 取舍 |
|---|---|---|
| **A（推荐）** | hub 注入 shim 时**同时把 hostId 注入页面**（如 `window.__RDSH_HOST_ID__="<hostId>"`，在 shim 之前），shim 优先用它查 pin、缺失时回退 cookie | ✅ cookie 保持 `HttpOnly`（不把宿主凭证交给 JS）；✅ pin 的 TOFU 语义不变（公钥仍来自浏览器本地 pin 表，hub 不参与）；hostId 本身不是凭证（URL 里本来就有） |
| B | 把 `rdsh_host` 改成**非 HttpOnly** | ❌ 任何 XSS 都能读走宿主访问凭证；且 pin 键将变成一长串 cookie 值（与 F5 的 hostId 键不一致），语义更绕 |
| C | hub 直接把公钥随 shim 注入（不查 pin） | ❌ 等于废掉 TOFU：恶意/被攻破的 hub 可随时换钥匙而不被发现 |

**F9 的修法（无选项，必须）**：门面的实例字段一律用 `Object.defineProperty` 定义**自有可写**数据属性，遮蔽从 native 继承来的只读访问器；**保留** `Object.create(NativeWS.prototype)`（`instanceof` 兼容性不变）。
**F12 的修法（无选项，必须）**：`input` 归一化为 string / `input.url`（Request）/ `input.href`（URL）三种形态。

## 4. 验收标准（AC）

| # | 标准 |
|---|---|
| **AC1** | 远程页面里 `window.WebSocket.name === "WrappedWS"` **且** `window.fetch` 非原生（shim 已接管）—— 这是"E2EE 生效"的唯一判据，写进所有后续测试的前置检查 |
| **AC2** | 数据面仍为密文：hub 侧抓包/日志只见密文（`/e2e` 通道 + 内层加密帧），无明文 payload |
| **AC3** | **TOFU pin 仍生效**：清掉 localStorage 的 pin 后 E2EE **不启用**（回落明文或明确提示），重新 pin 后启用；pin 与 F5 的 hostId 键一致 |
| **AC4** | 无回归：设置页/API key（已修路径）仍正常；LAN 路径不受影响 |
| **AC4b** | **E2EE 下 DSH 前端可正常启动**：无插件 loader 报错（F8）、无 API 405（F11）；DSH 自身的 `/api/settings/describe`、`/api/credentials/describe` 等调用成功 |
| **AC5** | **修完后重跑**延期验证：预览二进制、18 MiB 上传（预期分别暴露"响应被文本化/整体缓冲"与"16 MiB 单帧上限"——那是 [20260914-e2ee-fetch-streaming](../20260914-e2ee-fetch-streaming/discussion.md) 的范围） |

## 5. 验证计划

1. **静态**：确认注入点能拿到 hostId —— hub 的 HTML 注入处（`packages/hub/src/relay.ts:100-113` 的 `onClose` 注入分支）位于 `handleRelay` 内，而 hostId 来自 `authorizeHost(req, runtime)`（`relay.ts:22-34`）⇒ **可注入**；
2. **本地 E2E**（现成环境：`http://e2e.localhost:8799`，非 loopback + 安全上下文）：改完 hub 后重载页面 → 用 AC1 判据确认 shim 接管；再验 AC2/AC3/AC4b；
3. **回归**：重跑设置页/API key；同时把延期两项（预览、18 MiB 上传）在**真 E2EE** 下记录现象，作为 fetch-streaming 修复的验收输入；
4. **真浏览器自动化**（无头 Chrome + CDP，`/tmp/rdsh-e2e-cdp.mjs`）：AC1/AC3/AC4b 的判据、console 报错、`/api` 调用状态全部机器可读，避免"靠人眼看 console"。**任何 E2EE 结论都必须先过 AC1 判据**。

## 6. 非目标

- 不改 E2EE 协议/握手/密钥派生；
- 不在本项内修 fetch 包装的流式/二进制/分帧（那属 [20260914-e2ee-fetch-streaming](../20260914-e2ee-fetch-streaming/discussion.md)）。
