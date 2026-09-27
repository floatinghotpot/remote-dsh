# 内网直连优先（direct-first）— 结果记录（summary.md）

> **日期**: 2026-09-27
> **范围**: P1（host 侧，rdsh 仓库）已完成；P2（App 侧 garsync）/ P3（https 档位）为后续阶段

## 1. 做了什么

为 remote-dsh 实现「内网直连优先（direct-first）」的 host 侧能力：host 在 join 隧道之外额外监听内网直连口，与隧道指向同一个 dsh；两条通道统一用可设定的固定口令门禁；内网候选 + 一次性直连票经 E2EE 通道下发（hub 不可见）；补齐 E2EE 通道上的口令门禁（修 raw 流绕过）。

## 2. 变更文件

**新增**：
- `packages/gateway/src/gate.ts` —— accessCode 门禁公共组件（challenge 页 + cookie 校验 + 限流）
- `packages/gateway/src/direct.ts` —— 直连口（复用 `startGateway`）+ 私网候选收集 + bootstrap 脚本
- `packages/gateway/src/direct-ticket.ts` —— 一次性直连票管理器（HMAC + 单次消费 + TTL）
- `packages/gateway/test/direct.test.ts`、`direct-ticket.test.ts`
- `doc/feature/24-direct-first/{discussion,req,solution,plan,verification,summary,TODO}.md`

**修改**：
- `packages/gateway/src/config.ts` —— `AuthMode` 去 `pair`；删 `pairCode`；`generateAccessCode`；`loadConfig` 迁移旧 pair 配置
- `packages/gateway/src/server.ts` —— 去 PairManager/pair 路由；accessCode 门禁；`?ticket=` 一次性直连票；剪贴板 polyfill 注入
- `packages/gateway/src/serve.ts` —— 去 `pairCode`；接入 accessCode 门禁
- `packages/gateway/src/join.ts` —— 直连口接线 + raw 门禁（页面授权 token）+ 候选/直连票端点
- `packages/gateway/src/index.ts` —— 导出调整（去 `PairManager`，增 `startDirect`/`createDirectTicketManager`/`generateAccessCode` 等）
- `packages/gateway/src/secure-context-polyfill.ts` —— 新增 `CLIPBOARD_POLYFILL`
- `packages/cli/src/bin.ts` —— `rdsh host gate set|clear|status`；`setup lan` 去 `--pair-code`、生成访问口令
- `packages/web-remote/src/index.ts` —— 插件直连口 + 直连票接线
- `packages/gateway/test/{server,config}.test.ts` —— 改写/新增用例
- `doc/overview/usage.md` —— 配对码 → 访问口令

**删除**：
- `packages/gateway/src/pair.ts`、`packages/gateway/src/pair-page.ts`
- `packages/gateway/test/pair.test.ts`

## 3. 质量门

- `pnpm build`（tsc strict，全包）✅
- `node --test`（gateway 154/154）✅
- 未改 hub 与 tunnel 层 2 协议（`packages/hub`、`packages/tunnel` 零改动，符合「hub 零改动」约束）

## 4. 后续（见 TODO.md）

P2（App 侧切换/选路/指纹固定）、P3（https 自签）、M1 博客改写、运行中 live 设置口令的 raw 门禁即时生效。

## 5. 边界说明（云服务器场景）

云服务器（ECS 等）的 VPC 私网 IP 只在云厂商内网可达，从用户家庭网连不通 → direct-first 对这类 host 恒回落隧道（预期行为）；「从公网直连」属既有 cloud 模式（M2），不在本特性范围。详见 [verification.md](verification.md) §5。

## 6. 方案 B 修订（2026-09-28）

直连口门禁从「未设口令不监听（C9 原案）」改为 **B 案**：join 模式**始终监听**，门禁 = **ticket**（per-host 随机密钥 `~/.rdsh/direct-secret` 签名），口令（accessCode）为**可选增强层**。动机：默认无口令时直连不生效，大多数用户不会手动设口令 → 享受不到直连红利。改动：新增 `direct-secret.ts`；`server.ts` 门禁密钥与 ticket 密钥解耦（`gateSecret = directSecret ?? accessCode`）；`join.ts`/插件改为始终起直连口 + ticket 门禁；无口令直连无票 = 403。构建全绿，gateway 157/157。
