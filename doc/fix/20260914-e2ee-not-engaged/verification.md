# 验证：E2EE 数据面从未启用（verification）

> **日期**: 2026-09-14 ｜ **对应**: [solution.md](solution.md) ｜ **状态**: **✅ 三个因素全部修复；AC1/AC3/AC4/AC4b 已由真机（无头 Chrome + CDP）+ 用户浏览器双确认**

> **用户浏览器实测确认（2026-09-14，用户在自己会话的 DSH 页面 Console 执行自检脚本）**：
> `WS 门面='WrappedWS'`、`fetch='已包装'`、`注入的 hostId='e2e-host-1'`、`已 pin 主机='e2e-host-1'`、
> `E2EE 内取数='ok 200（经加密通道取回）'`、`新增明文 /api 请求=0` ⇒ **E2EE 首次在真实浏览器里生效**（AC1/AC2 客户端视角同时成立）。
>
> **线上帧侧证（同一次会话，CDP 抓 `Network.webSocket*`）**：只有一条 WS 连接 `ws://e2e.localhost:8799/e2e`，出向帧全部 `opcode=2`（Binary/Ciphertext），首帧 44 字符 = 32 字节临时公钥；后续帧以 12 字节全零 nonce 开头（`AAAAAAAAAAAAAAAA…`）+ AES-GCM 密文，**无任何可读 JSON**。

---

## 1. AC 对照

| AC | 状态 | 证据 |
|---|---|---|
| **AC1 shim 接管**（`window.WebSocket.name === "WrappedWS"` 且 `fetch` 非原生） | ✅ **真机实测** | 无头 Chrome 153 + CDP，`http://e2e.localhost:8799/`（非 loopback + 安全上下文），pin 有效：`wsName: "WrappedWS"`, `fetchPatched: true`, `hostIdInjected: "e2e-host-1"` |
| **AC2 数据面仍为密文** | ✅ 代码 + 单测 + 网络层 | ① `e2ee-shim-ws.test.ts`「真实密码学往返」：用主机私钥推出 i2r/r2i 才能解开帧（AES-GCM），即线上帧是密文；② E2EE 场景下浏览器 **0 条** `/api/*` HTTP 请求（`Network.requestWillBeSent` 计数 = 0）⇒ API 流量全在加密 WS 里；③ 抓帧日志（临时插桩）显示 shim 只经 `sendFrame` → `enc.encrypt` 出网 |
| **AC3 TOFU pin 仍生效** | ✅ **真机实测** | 清空 `localStorage["rdsh_e2ee_pins"]` 后重载：`wsName: "WebSocket"`, `fetchPatched: false`, `pins: []`（**不猜想、不误连**）；重新写 pin 后回到 AC1 状态 |
| **AC4 无回归（设置/凭证路径）** | ✅ | E2EE 下 DSH 自身启动调用（`settings/describe`、`credentials/describe`、`session/list`、`modelCatalog` …）无一条报错；页面 console 仅剩 2 条与 E2EE 无关的 `manifest.webmanifest` 抱怨（见 §4） |
| **AC4b E2EE 下前端可正常启动** | ✅ **真机实测** | 修复前：`failed to apply loader entry (@deepseek-ai/dsh-api-gateway): Cannot set property url of #<WebSocket>…` + `HTTP 405` 刷屏；修复后：**两条均消失**，`#root` 已挂载（`rootChildren: 1`），`/api/settings/describe` 与 `/api/credentials/describe` 经 E2EE 返回 **200** |
| **AC5 重跑延期验证**（预览/18 MiB 上传） | ⏭️ 移交 | 现已在**真 E2EE** 下可复现，交接给 [20260914-e2ee-fetch-streaming](../20260914-e2ee-fetch-streaming/discussion.md)（本项非目标） |

## 2. 改动与验证清单

| 因素 | 改动 | 验证 |
|---|---|---|
| ① hostId 注入 | `packages/hub/src/e2ee-shim.ts`：`injectE2eeShim(html, hostId)`（先 hostId bootstrap、再 shim；无 `<head>` 时退化为文档最前）；`getHostId()` 优先读 `window.__RDSH_HOST_ID__`，缺失回退 cookie；`packages/hub/src/relay.ts:109` 改用之 | `e2ee-shim-ws.test.ts` 5 例：HttpOnly（cookie 空 + 注入 hostId）必须接管；无 hostId 且无 cookie **不得**接管；bootstrap 顺序在 shim 之前；hostId JSON 转义；无 `<head>` 仍注入 |
| ② 门面可构造 | `e2ee-shim.ts:182-200`：`own()` 用 `Object.defineProperty` 定义 `url`/`protocol`/`extensions`/`binaryType`/`bufferedAmount`/`readyState`/`on*` 为**自有可写**属性 | `e2ee-shim-ws.test.ts:209`：用"原生形态 prototype（`url`/`protocol`/… 只有 getter）"构造门面 → 必须成功且字段是自有可写属性。**反证**：`HEAD` 版 shim 跑同一路径抛 `Cannot set property url … which has only a getter`（`/tmp/rdsh-oldshim-check.mjs`） |
| ③ 请求路径 | `e2ee-shim.ts:130`：`input` 归一化 string / `Request.url` / `URL.href` | `e2ee-shim-ws.test.ts:294`：`fetch(new URL("http://rdsh.local/api/settings/describe"), {method:"POST"})` → 解密 shim 首个加密包 → `OPEN` 帧 `{kind:"http", method:"POST", path:"/api/settings/describe"}`（回归：曾为 `/undefined`） |

## 3. 真机证据（CDP，`/tmp/rdsh-e2e-cdp.mjs`）

```
=== 场景 1：pin 有效 → 进入主机 ===
{ "url": "http://e2e.localhost:8799/", "hostIdInjected": "e2e-host-1",
  "wsName": "WrappedWS", "fetchPatched": true, "pins": ["e2e-host-1"],
  "rootChildren": 1, "title": "DeepSeek Harness" }
AC1（shim 接管）: ✅      AC4（DSH 前端已挂载）: ✅      hostId 注入: ✅
E2EE 下设置/凭证 API: /api/settings/describe → 200（DSH 网关信封）, /api/credentials/describe → 200
场景 1 的 /api/ 调用（0 条 HTTP）: 全在加密 WS 内
控制台告警/错误 2 条: 仅 manifest.webmanifest 解析抱怨（见 §4）

=== 场景 2：清空 pin → 重新加载 ===
{ "wsName": "WebSocket", "fetchPatched": false, "pins": [], "rootChildren": 1 }
AC3（清 pin 后不接管）: ✅
```

**修复前对照（同一环境、同一脚本）**：`failed to apply loader entry (@deepseek-ai/dsh-api-gateway): Cannot set property url/protocol of #<WebSocket> which has only a getter`，以及 `transport failure for /api/dynamicCordisRunner/*: HTTP 405`；不写 pin（E2EE 关闭）时同样 14 条 `/api` 调用全是 **200** ⇒ 405 由 shim 引起（F13）。

## 4. 已知但不阻塞（登记）

- `manifest.webmanifest` 在 Chrome 里报 `Manifest: Line: 1, column: 1, Syntax error.`：**E2EE 开/关都出现**。直连抓取该 URL 返回 `200 application/manifest+json` 且 JSON 合法（267 B）⇒ 与 shim/E2EE 无关，另行排查（见 TODO）。
- 控制台 `[patch] miss: /plugins/ … content-encoding=gzip`：网关 JS 补丁的既有日志（补丁只针对特定字面量），不影响功能。

## 5. 质量门

- `pnpm build` exit 0（0 TS error；含 portal 既有的 i18n duplicate-key 警告，与本次改动无关）；
- `pnpm test` exit 0，7 个包全绿；`packages/hub/test/e2ee-shim-ws.test.ts` **9/9 pass**（修复前 7 例）。

## 6. 尚未完成

见 [TODO.md](TODO.md)（发布/部署、范围外交接、manifest 排查）。
