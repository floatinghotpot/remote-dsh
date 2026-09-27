# 内网直连优先（direct-first）— 验收（verification.md）

> **日期**: 2026-09-27
> **状态**: P1（host 侧）完成；P2（App 侧）/ P3（https 档位）标注 ⏭️ 后续
> **复核方式**: 需求↔任务↔代码三方核对 + `pnpm build`（tsc strict 全绿）+ `node --test`（gateway 154/154 全绿）

## 1. RTTM 复核（req → plan → 代码）

| 需求 | 任务 | 代码落点 | 状态 |
|---|---|---|---|
| R1 双通道并存（同一 dsh） | T2 | `packages/gateway/src/direct.ts`（`startDirect` 复用 `startGateway`，指向同一 `dshPort`）、`join.ts`（`join()` 起直连口） | ✅ |
| R2 两种 host 形态 | T2 | `join.ts`（CLI）+ `packages/web-remote/src/index.ts`（`syncDirect`） | ✅ |
| R3 候选下发不经 hub | T3 | `join.ts`（raw inner dispatcher 内 `/__rdsh/direct-candidates` 端点，走 E2EE） | ✅ |
| R4 一次性直连票 | T3 | `packages/gateway/src/direct-ticket.ts`（`createDirectTicketManager`）+ `server.ts`（`?ticket=` 消费 + 发门禁 cookie） | ✅ |
| R5 选路与自动回落 | — | ⏭️ P2（App 侧） | ⏭️ |
| R6 统一固定口令门禁（去 pair） | T1 | `gate.ts` + `config.ts`（`AuthMode` 去 `pair`）+ `server.ts`（accessCode gate） | ✅ |
| R7 raw 门禁（页面授权 token） | T4 | `join.ts`（raw dispatcher `rawGate` + `pageAuthorizeScript` 注入页面授权 token） | ❌ 首版缺注入 → ✅ 已修复（见 §6） |
| R8 直连链路认证 host（TLS+指纹） | — | ⏭️ P3 | ⏭️ |
| R9 口令设置入口 | T1/T6 | `cli/src/bin.ts`（`rdsh host gate set|clear|status`）+ 插件 `set-access-code`（已有） | ✅ |
| R10 迁移与首次口令 | T1 | `config.ts`（`loadConfig` 检测 `auth.mode:"pair"` → 生成 accessCode + 打印一次）、`bin.ts`（`setup lan` 生成） | ✅ |
| R11 状态与身份一致 | T2 | 同 dsh 实例（R1）；⏭️ P2 的"切直连不重确认" | ✅ / ⏭️ |
| R12 文档与测试 | T7 | `doc/overview/usage.md` 已更新；单测新增 `direct.test.ts`/`direct-ticket.test.ts`；**M1 博客改写 ⏭️** | ⚠️ 部分 |
| R13 clipboard polyfill | T5 | `secure-context-polyfill.ts`（`CLIPBOARD_POLYFILL`）并入 `server.ts` 的 `HTML_INJECT` | ✅ |
| R14 直连口开启条件（方案 B：始终监听） | T2 | `join.ts:1248-1259`（`opts.direct !== undefined` 即起直连口；门禁 = ticket，口令为可选增强层）、`web-remote`（`syncDirect`） | ✅ |
| R15 可观测性 | T2/T3 | `join.ts`（`rdsh join: direct on :port …`）、候选日志；⏭️ P2 的直连占比度量 | ✅ / ⏭️ |

## 2. 已验证的关键行为（自动化）

- **门禁统一**：`server.test.ts` 改写为 accessCode 门禁（challenge 页 / 错误口令 / 正确口令 302+`rdsh_gate` / 锁定 / loopback 补丁 / `noCode` / dshAuthCookie 透传）；`server-m2.test.ts`（password 模式）原样全绿。
- **直连口 + 直连票**：`direct.test.ts` —— accessCode 门禁 + `?ticket=` 一次性消费（重放被拒）。
- **直连票单测**：`direct-ticket.test.ts` —— 单次消费 / 篡改拒绝 / TTL 过期 / 换 secret 吊销。
- **配置迁移**：`config.test.ts` —— 旧 `auth.mode:"pair"` → `none`（供 loadConfig 迁移）。

## 3. 已知缺口（诚实列出）

| # | 缺口 | 严重度 | 建议 |
|---|---|---|---|
| G1 | ~~运行中 live 设置口令时 raw 门禁/候选端点需下次连接才生效~~ → **已随方案 B 修复**：raw 门禁的 `gate.accessCode` 改为动态判定；插件 `syncDirect` 在口令变化时重启直连口 | 已修复（2026-09-28） |
| G2 | ~~M1 博客 `doc/blog/zh/01-01-lan-access.md` 仍是配对码流程，未改写~~ → **已改写（2026-09-28）**：博客 01-01（中英）重写为访问口令流程；01-02、02-01/02/03、03-01 与 blog README 同步；README.md/zh、features.md/zh、architecture.md 一并扫掉配对码表述与 host 侧 8443 | 已修复（2026-09-28） |
| G3 | raw 门禁采用「首个内层请求必须是 authorize」模型，无缓冲（依赖注入脚本早于 DSH 应用脚本执行） | 低 | 已在 solution/req 记录该依赖；若 DSH 升级改变脚本执行顺序需回归。**补记**：该模型曾因 raw 通道缺注入而完全不可用，见 §6 |
| G4 | P2（App 切换/选路/指纹固定）与 P3（https 自签）未实现 | 计划内后续 | 见 plan.md 阶段划分 |

## 4. 结论

P1 全部需求（R1/R2/R3/R4/R6/R7/R9/R10/R13/R14）已实现并测试通过；`pnpm build` 全绿；gateway 测试 154/154。P2/P3 按 plan 标注为后续阶段，不本仓交付。

## 5. 边界说明（云服务器场景，2026-09-28 用户提示）

- 云服务器（如阿里云 ECS）通常也有 **VPC 私网 IP（172.x / 10.x / 192.168.x）**，但该地址只在云厂商内网可达，**从用户家庭网/手机连不通**。
- 因此对「家里客户端 → 云服务器」这种用法，候选探测会失败 → **恒回落隧道**，direct-first 不产生直连收益——这是**预期行为**，不是 bug。
- 客户端**也在同一 VPC 内**（VPN 进 VPC、同 VPC 另一实例）时，172.x 候选才可达，direct-first 才会真正走直连。
- 「从公网直连」= 公网 IP + 固定端口 + 防火墙放行 + TLS = 既有 **cloud 模式（M2）**，**不在本特性范围**（req §2 非目标已排除）。

## 6. 复审修正（2026-09-28，生产实测发现）

**现象**：`gateway.accessCode` 已设置（`"aliyun"`）+ 浏览器经 hub + **E2EE（raw）** 访问时，host 侧**零报错**、隧道稳定（`tunnel established`，`tunnel lost`/`reconnect` 均为 0），但 DSH UI **一直 connecting**；同一客户端把 host 换回 pre-24 构建后立刻恢复。

**根因**：raw 门禁（`join.ts` 的 `rawGate`）是 **fail-closed**——`accessCode !== null` 时，raw 通道上除 `/__rdsh/authorize` 之外的**任何**请求都被立即 `CLOSE 403 raw stream not authorized`。而解锁所需的 `pageToken` **只能**由注入脚本 `directBootstrapScript()` 带进页面，首版**只在 plain dispatcher 注入**（`htmlInject`），raw dispatcher 仅挂了 `rawGate`；raw 流按设计又不向 host 转发任何 cookie（discussion F44）⇒ 页面**永远拿不到 token**、无任何自救路径 ⇒ E2EE 客户端确定性死锁。触发条件"设了口令 + 客户端走 raw"在生产是常态，故属**必现缺陷**（原表 R7 的 ✅ 为误判：只核对了门禁存在与 plain 侧注入，未核对 raw 侧）。

**修复**：
- `join.ts` 新增 `pageAuthorizeScript(accessCode)` 作为**唯一来源**（口令非空 → 内联合法 token；为空 → 只取候选、不做 raw 授权，符合 R7），plain 与 raw 两条 dispatcher 共用，消除"两处各写一份"的漂移根因；
- raw dispatcher 补上 `htmlInject: () => pageAuthorizeScript(gate.accessCode)`。

**测试**：新增 `packages/gateway/test/join-authorize-inject.test.ts`，守卫两条不变量——①无口令时脚本不触发 authorize（R7）；②有口令时内联 token 能通过 `verifyGateCookie` 且绑定当前口令。`pnpm build` 全绿；**gateway 159/159**、hub 138/138、tunnel 12/12、web-remote 27/27、agent-mesh 1/1、portal 5/5。

**端到端验证**：修复后重启 host，同一浏览器经 hub + E2EE **首次即成功进入**（GUI 端口 41301）；直连口无 cookie 时仍只返回门禁挑战页（无绕过）；启动后 0 条错误/403。

**同时修正**：
- `packages/cli/src/bin.ts` 的 `host gate clear|status` 文案——原文"无口令不监听 / 直连口关闭"是旧 C9 表述，与方案 B（始终监听、门禁 = ticket、无票 403）矛盾；
- 本表 R14 的同一处旧表述。

**遗留缺口（未补）**：raw 通道目前只有 helper 级单测，尚无"真实 E2EE 握手 + raw 流"的集成测试（可复用 `e2ee-interop.test.ts` 的 initiator 侧握手补齐）；G3 记录的时序依赖（授权脚本须早于 DSH 应用脚本执行）仍未加固。
