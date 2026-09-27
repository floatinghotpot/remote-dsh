# 内网直连优先（direct-first）— 解决方案（solution.md）

> **日期**: 2026-09-27
> **来源**: [req.md](req.md)（已批准）+ [discussion.md](discussion.md)（事实 F1–F65 / 决策 Q1–Q15）
> **状态**: 方案定稿（用户已授权按最佳实践收口 C2–C8，无需逐项请示；本节随附决策记录）
> **交付范围**: **P1（host 侧，rdsh 仓库）本仓实现**；P2（App 侧，`~/workspace/flutter-apps/garsync` 另一仓库）与 P3（https 档位）在 [plan.md](plan.md) 显式标注为后续阶段。

---

## 1. Goal（目标架构）

同一台 host 上，`rdsh host serve`（join 模式）在既有出站隧道之外，**额外监听一个内网端口**（直连口），两个入口指向**同一个 dsh 实例**：

- **隧道口**：hub 认证 + 固定口令门禁 + E2EE（现状）；
- **直连口**：固定口令门禁（P1 为 `http` 明文，P3 换 `https` 自签 + App 指纹固定），服务同内网客户端。

客户端经**既有 E2EE 通道**向 host 索取「候选（内网 IP:端口）+ 一次性直连票」，试连成功即走直连、失败回落隧道。**内网地址与直连票不经过 hub**（hub 零改动、层 2 冻结协议不动）。

## 2. Facts（代码审计，2026-09-27 复核；出处见 discussion.md 对应 F#）

| # | 事实 | 出处 |
|---|---|---|
| F1 | 运行模式是单值枚举 `"lan"|"cloud"|"join"`，join 只出站、不监听 | `packages/gateway/src/config.ts:13-14`、`join.ts:7` |
| F2 | `rdsh host serve` 按 mode 二选一：join → 只起隧道并 `return` | `packages/cli/src/bin.ts:328-333` |
| F3 | `startGateway(opts)` 是参数化的：`dshPort` / `dshAuthCookieHeader` 由调用方传入，内部只做 `target={127.0.0.1, dshPort}` ⇒ **可指向 join 已 spawn 的同一个 dsh**（`serve()` 才 spawn，`startGateway()` 不 spawn） | `packages/gateway/src/server.ts:35-69,108` |
| F4 | 门禁现状三套并存：`auth.mode:"pair"`（lan 直连，动态码）、`auth.mode:"password"+auth.users`（cloud，多用户+TLS）、`gateway.accessCode`（join 隧道，单一口令，仅插件面板可设） | `config.ts:196-204,260-270`、`bin.ts:230,238`、`web-remote/src/index.ts:362` |
| F5 | gate（accessCode）只挂在 join 的**明文分发器**上；E2EE raw 流内层分发器**不查 gate**（raw OPEN 无 headers、cookie 到不了 host）⇒ 绕过根因 | `join.ts:825` vs `join.ts:847-872`、`hub/src/tunnel.ts:109-113` |
| F6 | hub 不掌握内网拓扑：`hosts` 表无 IP 字段；隧道注册表 `Map<hostId,TunnelConn>`；relay 无路径白名单（新 host 端点直接透传） | `hub/src/db.ts:202-209`、`hub/src/tunnel.ts:252`、`hub/src/relay.ts` |
| F7 | E2EE 通道内层是完整 HTTP 语义、hub 只转字节不解析 ⇒ 候选/直连票可经其下发且 hub 不可见 | `hub/src/e2ee-shim.ts:112,284`、`PROTOCOL.md` raw stream |
| F8 | host 已有 HTML 注入槽（`htmlInject`）：明文路径注入 `RDSH_WEBVIEW_API`；HTML 在注入前已缓冲，可做 per-load 内容 | `join.ts:621-655,825`、`server.ts:35` |
| F9 | `Cookie` 是浏览器 forbidden header；`navigator.clipboard` 仅安全上下文可用（DSH 前端 3 处可选链调用） | 规范约束 + 实测扫描 |
| F10 | 一次性 token → 303 + Set-Cookie 的既有先例：dsh 自身 `GET /?token=` | `spawn-dsh.ts:143-170` |

## 3. Gap（目标 ↔ 现状的差距）

| 差距 | 现状 | 目标 |
|---|---|---|
| 双通道 | join 模式无内网监听口 | join 模式额外监听直连口，同一 dsh |
| 门禁统一 | 三套并存、pair 动态码、accessCode 仅隧道 | 全部统一到 `gateway.accessCode` 单一口令，去 pair |
| raw 门禁 | E2EE 通道绕过口令 | 页面授权 token 方案（fail-closed，仅设口令时启用） |
| 候选/直连票 | 无 | E2EE 通道下发候选 + 一次性直连票 |
| 直连口开启条件 | 无 | 未设口令不监听（默认安全） |
| 口令入口 | 仅插件面板 | CLI `gate` 命令 + 面板 |
| 迁移 | 无 | 旧 `auth.mode:"pair"` → 生成随机 accessCode + 打印一次 |
| 能力补齐 | http 下 clipboard 失效 | clipboard polyfill 注入 |

## 4. Call-site Audit（共享契约变更点）

> 本方案会改动多个**导出符号/配置字段**的契约，需逐处核对调用点（下为完整清单，实现时逐条验证）。

### 4.1 配置契约（`packages/gateway/src/config.ts`）

| 变更 | 类型 | 调用点 | 兼容性 |
|---|---|---|---|
| `AuthMode` 去掉 `"pair"`（`"password"|"none"`） | 类型收窄 | `server.ts`（`authMode` 参数）、`serve.ts`、`cli/bin.ts`（`setup lan`）、`config.ts` 自身校验、测试 | **破坏**，同仓一起改 |
| `AuthConfig.pairCode` 删除 | 字段删除 | `config.ts:27-28,201-204`、`bin.ts:230`（`--pair-code`）、`server.ts` | **破坏** |
| `DEFAULT_AUTH.mode` 由 `"pair"` 改为 `"none"`（无口令默认 = 现状 join 行为） | 默认值变化 | `config.ts:77` | 需迁移（§4.4） |
| `GatewayConfig` 增加 `direct?: { enabled?: boolean }`（可选，P1 用 `accessCode` 是否存在作为开关，不强制） | 新增字段 | 无既有调用点 | 兼容 |

### 4.2 网关公共 API（`packages/gateway/src/index.ts`）

| 变更 | 类型 | 调用点 | 兼容性 |
|---|---|---|---|
| 删除 `PairManager` 导出与 `pair.ts`/`pair-page.ts` | 导出删除 | `index.ts`、`cli`（未直接用）、`server.ts`、测试 | **破坏**（对外 API） |
| `GatewayOptions` 删 `pairCode`、增 `accessCode?: string|null` | 参数变更 | `server.ts`（定义+实现）、`serve.ts`（构造 startGateway）、`cli/bin.ts` | **破坏** |
| 新增 `startDirect(...)`（或等价于给 `startGateway` 加 accessCode gate） | 新增导出 | `join.ts`（CLI join）、`web-remote`（插件） | 兼容（新增） |
| 新增 `gate.ts`（抽出的 accessCode 挑战/校验公共组件） | 新增 | `join.ts`、`server.ts` 共用 | 兼容 |

### 4.3 行为契约

| 变更 | 影响面 | 兼容性 |
|---|---|---|
| `setup lan` 由"pair 码"改为"生成固定口令（accessCode）+ 打印一次" | 存量 lan 用户 | **破坏**，配迁移 |
| `rdsh host serve`（join）额外监听直连口（条件：已设 accessCode） | 存量 join 用户：无口令 → 行为不变；设口令 → 多一个监听口 | 兼容（无口令者零变化） |
| raw 流在"设口令"时改为需页面授权 token（fail-closed） | 设口令的 host：E2EE 若注入脚本失效会断 | **风险项**（B4），需 kill-switch |
| `rdsh host gate set|clear|status`（新增命令） | 无冲突（与 `rdsh host user passwd` 语义区分） | 兼容 |

### 4.4 迁移（`loadConfig` / `normalizeConfig`）

- `normalizeConfig`：`auth.mode` 命中 `"pair"` 时**不再抛错**，而是把 `auth.mode` 规整为 `"none"`，并置 `_needsAccessCodeMigration = true` 标记。
- `loadConfig`：若标记为真且 `gateway.accessCode` 为空 → 生成随机口令（`crypto.randomBytes` 8 字节 → base64url，≥8 位）、写回 host.json（0600）、`console.log` 打印一次（"已为 LAN 直连生成访问口令，请记录：…"）。幂等（写回后下次不再迁移）。
- 语义对齐：迁移只在**默认路径**（`~/.rdsh/host.json`）执行，`--config` 指向的临时文件同样处理（复用 loadConfig）。

## 5. 决策收口（用户授权按最佳实践定，2026-09-27）

| # | 决策 | 说明 |
|---|---|---|
| C2 | CLI 命令 = `rdsh host gate set|clear|status` | 与 `rdsh host user passwd`（cloud 多用户）语义区分；写 `gateway.accessCode` |
| C3 | 首次口令 = 随机生成 + 打印一次 | `setup lan` 与迁移路径同用此策略 |
| C4 | E2EE 未激活（未 pin / `e2ee.mode=off`）→ 禁用直连优先 | 客户端取不到候选即回落隧道；host 侧不额外判断 |
| C5 | 候选仅 owner 可见 | 共享成员不发放（直连口本身仍受口令保护） |
| C6 | 选路 = 并行试连 + 短超时（≤3s）+ 简单测速择快；网络变化重探测；候选不持久化 | 参数在 P2（App 侧）落地 |
| C7 | 直连页返回入口 = host 注入绝对 URL 指向 hub 门户 `/portal/hosts` | 悬浮条样式另行讨论 |
| C8 | 证书 = 纯 JS `selfsigned`（P3），身份绑定 host 不绑 IP，共享 `~/.rdsh`，复用 `host.json.tls`，不自动轮换 | P3 落地 |
| 附加 | 直连口默认监听 `0.0.0.0`（复用 config `host`），但候选**只下发 RFC1918/link-local 私网地址**，公网地址不下发 | 防把客户端引到公网口；P1 已声明明文限制 |

## 6. Tasks（文件变更清单，P1）

### T1 门禁统一（去 pair + accessCode 抽公共组件）

| 文件 | 变更 |
|---|---|
| `packages/gateway/src/gate.ts`（新） | 抽出 accessCode 挑战流：`gateChallengeHtml`、`verifyGateCookie/verifyGateCode/signGateCookie`（re-export 自 access-gate.ts）+ HTTP 层 gate 判定（供 join 与 server 共用） |
| `packages/gateway/src/access-gate.ts` | 保持原样（被 gate.ts 复用），不改契约 |
| `packages/gateway/src/pair.ts`、`pair-page.ts` | 删除 |
| `packages/gateway/src/config.ts` | `AuthMode` 去 `"pair"`；删 `pairCode`；`DEFAULT_AUTH.mode="none"`；`normalizeConfig` 迁移（§4.4） |
| `packages/gateway/src/server.ts` | `GatewayOptions` 删 `pairCode`、增 `accessCode`；删除 `PairManager` 路径；在 HTTP 层用 gate.ts 做 accessCode 挑战（未设口令则等同现状） |
| `packages/gateway/src/index.ts` | 删 `PairManager` 导出；增 `startDirect` / `gate` 导出 |

### T2 join 进程加直连口（A 案）

| 文件 | 变更 |
|---|---|
| `packages/gateway/src/direct.ts`（新） | `startDirect({ dshPort, dshAuthCookieHeader, accessCode, host, port, tlsMaterial? })` → 调 `startGateway`（accessCode gate）并返回句柄 + 实际端口 + 候选列表 |
| `packages/gateway/src/join.ts` | `join()`：spawn dsh 后，若 `opts.gateway?.accessCode` 非空 → 起直连口（`startDirect`），与隧道同生命周期（`shutdown` 时一并 `stop()`）；候选（私网 IP + 实际端口）注入到候选端点 |
| `packages/web-remote/src/index.ts` | 插件 `connect`：`startJoin` 之外，同样按 `config.gateway.accessCode` 起直连口（用 `ctx.webServer.port`） |

### T3 候选 + 一次性直连票

| 文件 | 变更 |
|---|---|
| `packages/gateway/src/direct.ts` 或 `candidate.ts`（新） | host 端候选端点：返回 `{ candidates:[{host,port}], ticket }`；ticket = 一次性 + TTL≤30s + 绑定会话，校验后在直连口 303 换 cookie（复用 dsh `/?token=` 先例） |
| `packages/gateway/src/join.ts` | 隧道明文路径挂候选端点（仅 owner；经 E2EE 由客户端 fetch） |

### T4 raw 门禁（页面授权 token，fail-closed，仅设口令时启用）

| 文件 | 变更 |
|---|---|
| `packages/gateway/src/join.ts` | 明文注入槽每次页面加载注入一次性「页面授权 token」；raw 分发器：设口令时开启"授权前不服务"（缓冲 ≤1MiB + 宽限 ≤3s），无 token 关流；无口令零变化 |

### T5 clipboard polyfill（R13）

| 文件 | 变更 |
|---|---|
| `packages/gateway/src/secure-context-polyfill.ts` 或新文件 | 增 clipboard `writeText` polyfill（`execCommand('copy')`），并入 `HTML_INJECT`（server.ts:35 与 join 直连注入） |

### T6 CLI

| 文件 | 变更 |
|---|---|
| `packages/cli/src/bin.ts` | 新增 `rdsh host gate set|clear|status`；`setup lan` 去 `--pair-code`、改为生成随机 accessCode + 打印一次；帮助文案 |

### T7 测试与文档

| 文件 | 变更 |
|---|---|
| `packages/gateway/test/`、`packages/cli/test/` | gate 单测、config 迁移单测、直连口/候选/直连票单测、raw 门禁单测、clipboard 注入断言 |
| `e2e/` | 同内网直连、跨网段回退、两条通道门禁、raw 绕过拒绝 |
| `doc/overview/usage.md`、README 双语、`doc/blog/zh/01-01-lan-access.md` | 配对码流程 → 固定口令流程 |

## 7. 验收（对 req.md R1–R15 的映射）

实现完成后按 `req.md` §3 逐条打 ✅/❌，并运行 `pnpm build`（tsc strict，含 info 级 0 问题）与 `node --test`。P2（App）/P3（https）标注 ⏭️ 与原因。
