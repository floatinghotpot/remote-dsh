# E2EE 数据面从未启用 —— solution

> **日期**: 2026-09-14
> **上游**: [discussion.md](./discussion.md)（F1–F14）
> **目标**: 让 E2EE **真正生效且可用** —— 页面里 shim 接管 `fetch`/`WebSocket`（AC1），不写 pin 时安全回退（AC3），E2EE 下 DSH 前端与 `/api` 正常工作（AC4/AC4b）

---

## 1. Goal

把 `packages/hub/src/e2ee-shim.ts`（hub 注入到 DSH HTML 的 E2EE 数据面脚本）从"**从未真正运行过**"修到"**真机可运行**"：

- shim 能取到 hostId ⇒ 能查到 TOFU pin ⇒ 才会包装 `fetch`/`WebSocket`；
- 包装后的 `WebSocket` 门面**能被构造**（否则 DSH 插件加载直接失败）；
- 包装后的 `fetch` 能**把 `input` 归一化成正确的 URL**（否则所有 `/api` 打到 `/undefined`）。

## 2. Facts（全部经查档/实测确认）

| # | 事实 | 位置 |
|---|---|---|
| F1 | hub 种 `rdsh_host` 时带 `HttpOnly` | `packages/hub/src/server.ts:89`（`clearHostCookie` `:93` 同） |
| F2 | shim 原来只从 `document.cookie` 取 hostId | `packages/hub/src/e2ee-shim.ts:48`（改前） |
| F3 | 取不到 pin 就整段退出 | `e2ee-shim.ts:64-65`（`if (!hostPub) return;`） |
| F8 | 修好取 hostId 后，门面构造抛 `Cannot set property url of #<WebSocket> which has only a getter`，DSH 报 `failed to apply loader entry (@deepseek-ai/dsh-api-gateway)` | CDP 真机（F8/F9） |
| F9 | `WrappedWS.prototype = Object.create(NativeWS.prototype)` + 脚本 `"use strict"` ⇒ `this.url = …` 必抛 | `e2ee-shim.ts:260`（改前 `:242`）、`:12`、`:175`（改前） |
| F12 | DSH 的 HTTP carrier 传 `URL` 实例；shim 只认 `input.url` ⇒ `new URL(undefined, base)` = `/undefined` ⇒ 全部 `/api` 405 | `e2ee-shim.ts:127`（改前） |
| F13 | 同一环境下 E2EE 关闭时 14 条 `/api` 全 200；E2EE 开启（修 F12 前）全 405 | CDP |
| F14 | hub 注入**不**受 gzip 影响：网关对文档导航剥离 `accept-encoding` | `packages/gateway/src/proxy.ts:58-60` |
| — | hub 注入点在 `handleRelay` 内，能拿到 `hostId` | `packages/hub/src/relay.ts:49-54, 102-114` |

## 3. Gap

| 目标 | 现状 | 差距 |
|---|---|---|
| shim 取到 hostId | 只能读 `document.cookie`，而该 cookie 是 HttpOnly | ① 注入 hostId |
| 门面可构造 | 给继承来的只读访问器赋值，严格模式下抛错 | ② 自有属性定义 |
| fetch 路径正确 | 只认 `input.url`，DSH 传 `URL` | ③ 输入归一化 |

## 4. Call-site Audit

| 改动 | 调用点 | 兼容性 |
|---|---|---|
| 新增 `injectE2eeShim(html, hostId)`（导出） | `packages/hub/src/relay.ts:109`（唯一调用点；原为 `html.replace(/<head([^>]*)>/i, …E2EE_SHIM_HTML)`） | ✅ 兼容：仍返回 HTML 字符串，注入位置不变（`<head>` 最前）；无其它调用点（`grep -rn "E2EE_SHIM_HTML" --include=*.ts packages/*/src` 仅命中 `e2ee-shim.ts` 自身） |
| `getHostId()` 增加 `window.__RDSH_HOST_ID__` 优先 | shim 内部（`getPinnedKey`） | ✅ 纯新增分支；无注入变量时行为与改前完全一致（回退 cookie） |
| `WrappedWS` 字段改为 `own()` 定义 | shim 内部 | ✅ 对外语义不变（`url`/`protocol`/`readyState`/`on*` 仍可读写），且是**修 bug** |
| fetch 的 `input` 归一化 | shim 内部 | ✅ 三种形态（string/Request/URL）都支持 |

## 5. Tasks

| # | 任务 | 文件 | 状态 |
|---|---|---|---|
| T1 | 注入 hostId bootstrap（先 hostId 再 shim），shim 优先读它、缺失回退 cookie；无 `<head>` 时退化为文档最前注入 | `packages/hub/src/e2ee-shim.ts:278-284`、`packages/hub/src/relay.ts:109` | ✅ |
| T2 | 门面实例字段用 `Object.defineProperty` 定义自有可写属性（`url`/`protocol`/`extensions`/`binaryType`/`bufferedAmount`/`readyState`/`on*`） | `packages/hub/src/e2ee-shim.ts:182-200` | ✅ |
| T3 | fetch 的 `input` 归一化：string / Request(`.url`) / URL(`.href`) | `packages/hub/src/e2ee-shim.ts:130` | ✅ |
| T4 | 单测：HttpOnly 场景（cookie 空 + 注入 hostId）必须接管；无 hostId 且无 cookie 必须不接管；`injectE2eeShim` 顺序/转义/无 `<head>` | `packages/hub/test/e2ee-shim-ws.test.ts:145-175` | ✅ |
| T5 | 单测：门面构造不得给继承来的只读访问器赋值（原生形态 prototype） | 同上 `:179-226` | ✅ |
| T6 | 单测：`input` 为 `URL` 实例时 OPEN 帧路径正确（解密后断言） | 同上 `:279-316` | ✅ |
| T7 | 真机验证（无头 Chrome + CDP）：AC1/AC3/AC4/AC4b | `/tmp/rdsh-e2e-cdp.mjs`（一次性脚手架，不入仓） | ✅ |

## 6. 非目标

- 不改 E2EE 协议/握手/密钥派生（仍 X25519 + HKDF-SHA256 + AES-256-GCM，TOFU pin 语义不变）；
- 不做 fetch 的流式响应 / 二进制保真 / 请求体分片（>16 MiB）—— 属 [20260914-e2ee-fetch-streaming](../20260914-e2ee-fetch-streaming/discussion.md)；
- 不改 `rdsh_host` 的 HttpOnly 属性（方案 B 已否决）。
