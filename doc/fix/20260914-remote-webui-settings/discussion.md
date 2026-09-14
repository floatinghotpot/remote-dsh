# 远程 Web UI 无法进入设置 / 无法输入 API key（discussion）

> **日期**: 2026-09-14
> **用户可见结果（本 fix 的唯一验收对象）**：① 远程（经 hub + E2EE）打开 DSH 的**设置页**时 Models 报 `settings are unavailable in this browser`；② 因此**无法在 Web UI 里输入/保存 API key**；③ 局域网（`http://<LAN-IP>:8443`）同样进不去设置。
> **结论**: 同一结果由**三个阻碍因素**共同造成 —— ① 浏览器侧 E2EE shim 门面不完整（**已修**）② host 侧 loopback 补丁是否真落地（**曾误判为通过**：真实原因是 dsh 会 gzip 压缩 JS 导致补丁在压缩字节上必然 miss；**已修**）③ LAN 路径完全没有该补丁（**已实施，默认开启**）。修复过程中另发现两个"隐形杀手"：**gzip 使补丁静默失效**、**上游 `immutable` 缓存头把旧的未补丁 bundle 钉在浏览器里**。**AC1/AC2 已由用户在浏览器实测通过（2026-09-14）**，详见 §4.4 与 [verification.md](verification.md)。
> **归类**: **不是** 树莓派/Linux 问题 —— 任何 OS、任何 host，只要"经 hub + E2EE（或经 LAN 代理）远程访问"，都会遇到同两个问题。发现现场记在 [20260914-rasp-linux-install](../20260914-rasp-linux-install/discussion.md)，本文承接结论与修复。

---

## 1. 用户可见问题

| # | 问题 | 触发 |
|---|---|---|
| P1 | 设置 → Models 报 `Loading the provider directory failed: settings are unavailable in this browser`（General / Plugins 等同理不可用） | 远程（hub + E2EE）或 LAN |
| P2 | **改不了设置、配不了 API key** ⇒ 用户装好了也用不起来（而我们推荐的正是"key 交 DSH 自管、界面里粘贴"） | 同上 |
| P3 | 局域网访问（`http://<LAN-IP>:8443`）同样 P1/P2 | LAN 代理路径 |

## 2. 验收标准（AC —— 修复的判定依据）

| # | 标准 |
|---|---|
| **AC1** | 远程（hub + E2EE）Web UI：**设置页可打开**（不再报 `settings are unavailable in this browser`） |
| **AC2** | 远程 Web UI：**能输入并保存 API key**；保存后新会话可正常调用 LLM |
| **AC3** | LAN Web UI（`http://<LAN-IP>:8443`）：同样可打开设置并输入 key |
| **AC4** | E2EE 语义不变（hub 只见密文）；不改 DSH 前端源码（沿用注入/补丁方式） |

## 3. 阻碍因素（同一个 bug 的三半，缺一不可）

| 因素 | 由谁提供 | 现状 | 关键证据 |
|---|---|---|---|
| **① 浏览器侧 E2EE shim 门面不完整** | **hub**（页面与脚本由 hub 注入） | ✅ **已修**（`packages/hub/src/e2ee-shim.ts`，含回归测试 + 反证） | F1–F3、F9 |
| **② host 侧 loopback 补丁是否"落地到浏览器"** | gateway / CLI / 插件 | ✅ **已验证**：新增进程内集成测试（真实 `startJoin` + 假 hub + 假上游）证明"进入隧道的 JS 字节已被替换成 `true`，非 JS 不动" | F4–F6、F8；`packages/gateway/test/join-loopback-patch.test.ts` |
| **③ LAN 路径完全没有该补丁** | gateway（`server.ts` 的 LAN 转发） | ✅ **已实施**：`forwardHttp` 新增 `jsPatch` 选项 + LAN 两个分支接线 + 开关 `dshUiCompat.trustPairedAsLoopback`（默认 `on`，可关为严格模式） | F7、F8；`packages/gateway/test/proxy-js-patch.test.ts` |

> 关系说明：①坏 ⇒ 远端流通道建不起来，设置镜像没有 view；②坏 ⇒ 前端认为"我不是 loopback"，**设置控制器根本不创建**；③坏 ⇒ LAN 用户同样进不去。**只修任一半都不足以达成 AC1–AC3。**

## 4. 事实（均带 file:line；DSH 侧路径省略前缀 `/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/`）

### 4.1 浏览器侧（因素①）

| # | 事实 | 证据 |
|---|---|---|
| F1 | DSH 的 API 网关**远端流通道是一条 WebSocket**（`REMOTE_STREAM_MUX_PATH`，按 origin 切 `ws/wss`） | `@deepseek-ai/dsh-api-gateway/lib/client.js:541-547` |
| F2 | 它用 **`addEventListener`/`removeEventListener`** 订阅（`{ once: true }`），并用 `readyState === WebSocket.OPEN` 判定 | 同文件 `:402-432` |
| F3 | 修复前 shim 的 `WrappedWS` 只有 `onopen/onmessage/onclose/onerror`，**既没有 `addEventListener` 也没有静态常量** ⇒ 抛 `TypeError` | `packages/hub/src/e2ee-shim.ts:160-187`（修复前） |
| F9 | shim 由 **hub** 注入 DSH HTML（`e2ee.mode !== "off"`）⇒ 因素①只能靠**升级/部署 hub** 解决 | `packages/hub/src/relay.ts:14,108` |

### 4.2 门禁与 host 侧（因素②③）

| # | 事实 | 证据 |
|---|---|---|
| F4 | DSH 的设置控制器**只在 loopback 时创建**：`ctx.remote.$host.isLoopback ? new SettingsDocumentStore(...) : void 0` ⇒ 非 loopback 直接回落到报错串 | `@deepseek-ai/dsh-client-ui-settings-general/lib/client.js:540`；报错串出自 `dsh-client-ui-settings-models/lib/client.js:1006` |
| F5 | `isLoopback` = `transport?.ownsHost === true \|\| pageLocation === void 0 \|\| isLoopbackHostname(pageLocation.hostname)`；而 `isLoopbackHostname` **只认** `localhost` / `[::1]` / `127.x.x.x` ⇒ **LAN IP 与 hub 域名都不算** | `dsh-client-connection/lib/client.js:6344`；`dsh-client-connection/lib/index.js:117-121` |
| F6 | 我们的 host 侧补丁：把 JS 响应里的字面量 `isLoopbackHostname(pageLocation.hostname)` 替换成 `true`（fail-open）；接线在 plain（`:624`）与 E2EE raw（`:649`）两条路径，默认开启 | `packages/gateway/src/join.ts:243-248`、`:232-236`（`/javascript/i` 判定）、`:624`、`:649`；`packages/gateway/src/config.ts:80` |
| F7 | **LAN 路径没有该补丁**：两个分支只注入 `htmlInject: SECURE_CONTEXT_POLYFILL`；`ForwardOptions` 也没有 JS 补丁入口 ⇒ `server.ts` 从未被补丁相关提交碰过（属遗漏） | `packages/gateway/src/server.ts:232,240`；`packages/gateway/src/proxy.ts:17-29`、`:87-107` |
| F8 | 当前环境实测：`host.json → dshUiCompat.trustE2EEAsLoopback: true`；插件侧无该项（走默认 true）；运行中 DSH 的 client bundle 含补丁目标串且**未压缩** | `~/.rdsh/host.json`；`packages/web-remote/src/index.ts:170,291,334`；本机 dsh 0.1.5-rc.2 |

### 4.3 已排除的猜测

- "补丁目标串变了 / 被压缩 / content-type 不匹配"：**均排除**（F8；client 插件经 combo 路由 `/plugins/??<id>/client.js…&rev=` 下发，content-type `text/javascript`；静态 dist 不压缩）。
- "shim 根本没注入"：不成立 —— 现场确实是 E2EE 开启后才坏，且 F3 的门面缺陷已被反证测试证实会产生同一条 `TypeError`。

### 4.4 修复过程中追加发现（2026-09-14，两个"隐形杀手"）

| # | 事实 | 证据 / 影响 |
|---|---|---|
| **F27** | **dsh 会按 `accept-encoding` gzip 压缩 JS**，而 `patchLoopbackJs()` 是在字节里做字面量替换 ⇒ **在压缩体上必然 miss**，fail-open 静默透传 ⇒ 前端 `isLoopback` 未被改写 ⇒ 设置页/API key 不可用 | 同一真实 combo URL（11 MB，含 `dsh-client-connection`）：`accept-encoding: gzip` → **仍含原始判定（未补丁）**；`identity` → 已补丁。插桩日志：`[patch] … 6432B → miss`（浏览器实收 18649B） |
| **F28** | 上游给该 bundle 的响应头是 `cache-control: public, max-age=31536000, immutable`，而绕过它的 `rev=` URL 由**上游内容**决定 ⇒ 我们改了 body 却改不了 URL ⇒ 浏览器长期复用**旧的未补丁** bundle（"代码修好但用户端不生效"） | 实测响应头；补丁命中后已改为 `public, max-age=300` |
| **F29** | 上一轮的集成测试用**不压缩的假上游**，因此"补丁落地"通过 —— 属**测试盲区**（测试设计必须模拟真实编码） | 新用例覆盖 identity/gzip/deflate/br + 未知编码原样透传 + `content-length` 正确性 |

**对应修复**（详见 [solution.md](solution.md) T2/T3）：编码感知补丁（解压 → patch → 按原编码重压）、**OPEN 帧后移到补丁之后**（否则 `content-length` 与实际字节不一致）、补丁命中时改写 `cache-control`、未命中留一条 `[patch] miss` 日志（fail-open 不再静默）。

## 5. 范围与非目标

**在范围内**：让 AC1–AC3 成立所需的全部改动（hub shim 门面、host 补丁落地、LAN 补丁 + 信任开关）与端到端验证。

**非目标**：改 DSH 源码；改 E2EE 协议 / 密钥派生；fetch 包装的流式与二进制放行（登记 [TODO.md](TODO.md)）。

## 6. 验证计划（AC 驱动）

1. **端到端（剩余唯一待办）**：本地起一份带修复的 hub（或部署 rdsh.cn）→ 浏览器验证 AC1 / AC2 / AC4；LAN 模式验证 AC3；
2. **补丁落地（已完成）**：`packages/gateway/test/join-loopback-patch.test.ts` 断言"进入隧道的 JS 已被替换、非 JS 不动"；
3. **LAN 补丁（已完成）**：`packages/gateway/test/proxy-js-patch.test.ts`（开关 on = 替换；off = 原样透传）+ `packages/hub/test/e2ee-shim-ws.test.ts`（门面契约 + 真实加解密往返 + 反证）。
