# 总结：E2EE 数据面从未启用（summary）

> **日期**: 2026-09-14 ｜ **对应**: [discussion.md](discussion.md) · [solution.md](solution.md) · [verification.md](verification.md)
> **一句话**: 远程 Web UI 的 E2EE **从来没生效过**——不是"某个开关没开"，而是 **三个独立缺陷**：取不到 hostId、门面一构造就抛错、请求路径解析成 `/undefined`。三项修完，真机（无头 Chrome）首次确认 `window.WebSocket.name === "WrappedWS"` 且 `/api` 全部走加密通道。

---

## 1. 做了什么

| # | 缺陷 | 修法 | 文件 |
|---|---|---|---|
| ① | `rdsh_host` 是 **HttpOnly**，shim 只读 `document.cookie` ⇒ 取不到 hostId ⇒ 拿不到 pin ⇒ **整个 shim 静默退出** | hub 注入 shim 时**顺带注入 hostId**（`window.__RDSH_HOST_ID__`，在 shim 之前），shim 优先用它、缺失回退 cookie；cookie 保持 HttpOnly、TOFU 语义不变 | `packages/hub/src/e2ee-shim.ts`（`injectE2eeShim` / `getHostId`）、`packages/hub/src/relay.ts:109` |
| ② | `WrappedWS.prototype = Object.create(NativeWS.prototype)` + `"use strict"` ⇒ `this.url = …` 抛 `Cannot set property url of #<WebSocket> which has only a getter` ⇒ **门面从未构造成功**，DSH 插件 loader entry 报错 | 实例字段改用 `Object.defineProperty` 定义**自有可写**属性，遮蔽 native 的只读访问器 | `packages/hub/src/e2ee-shim.ts:182-200` |
| ③ | DSH 的 HTTP carrier 传 **`URL` 实例**，shim 只认 `input.url` ⇒ `new URL(undefined, base)` = `/undefined` ⇒ **所有 `/api` 405** | `input` 归一化 string / `Request.url` / `URL.href` | `packages/hub/src/e2ee-shim.ts:130` |

**为什么三项必须一起修**：只修 ① 会把系统从"静默明文"变成"页面报错"（② 让插件加载失败），只修 ①② 则所有 API 405（③）——**比不修更糟**。

## 2. 关键证据

- **真机**（无头 Chrome 153 + CDP，`http://e2e.localhost:8799`，非 loopback + 安全上下文）：
  - pin 有效 → `wsName: "WrappedWS"`、`fetchPatched: true`、`hostIdInjected: "e2e-host-1"`、DSH 前端挂载、设置/凭证 API 经 E2EE 返回 **200**、console 无相关报错（AC1/AC4/AC4b）；
  - 清空 pin → `wsName: "WebSocket"`、`fetchPatched: false`（AC3，安全回退不误连）；
  - E2EE 场景下浏览器 **0 条** `/api` HTTP 请求 ⇒ 全在加密 WS 内（AC2）。
- **用户浏览器亲验**（2026-09-14）：用户在页面 Console 执行自检脚本，六项全绿（`WrappedWS` / 已包装 / hostId 注入 / pin 命中 / E2EE 内取数 200 / 新增明文 `/api` 请求 **0**）⇒ E2EE 首次在真实浏览器里生效；CDP 侧证线上只有一条 `/e2e` WS 且出向帧全为 Binary 密文。
- **反证**：`HEAD` 版 shim + 原生形态 prototype ⇒ 抛 F9 的那个 TypeError（证明新测试不是"假回归测试"）。
- **对照**：不写 pin 时 14 条 `/api` 全 200；写 pin 且未修 ③ 时全 405 ⇒ 405 由 shim 引起。
- **否证**：曾怀疑"hub 注入被 gzip 跳过"→ 不成立（网关对文档导航剥离 `accept-encoding`，实测注入顺序正常）。

## 3. 影响面

- **安全性**：修复前，所有远程部署的浏览器↔主机数据面都是**明文**经 hub（多租户 hub 运营方可读），与 README 的 E2EE 承诺不符；修复后密文通道建立；
- **连带解释**：此前"E2EE 环境下上传/预览正常"的结论无效（走的是明文）；[20260914-remote-webui-settings](../20260914-remote-webui-settings/summary.md) 的浏览器验证也是在明文路径上做的 ⇒ 该记录的结论需在真 E2EE 下复核（本次已确认设置/凭证 API 在 E2EE 下可用）；
- **协议/兼容**：未改线协议、握手、密钥派生、`rdsh_host` 属性；`instanceof` 兼容性保留。

## 4. 质量门

`pnpm build` exit 0；`pnpm test` exit 0（7 包全绿）；`e2ee-shim-ws.test.ts` **9/9 pass**（新增 3 例回归）。

## 5. 遗留

见 [TODO.md](TODO.md)：发布/部署（hub 不发则线上不变）、fetch 流式/二进制/大请求体（下一项 fix）、`manifest.webmanifest` 排查。
