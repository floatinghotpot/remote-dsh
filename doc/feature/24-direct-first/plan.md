# 内网直连优先（direct-first）— 实施计划（plan.md）

> **日期**: 2026-09-27
> **状态**: P1 已实现（2026-09-27）；P2（App 侧，garsync 另一仓库）/ P3（https 档位）标注 ⏭️ 后续
> **RTTM**: 需求 ↔ 任务追踪矩阵见下表；任务状态 ✅ 完成 / ❌ 阻塞 / ⏭️ 跳过

## 1. RTTM（需求 → 任务）

| 需求 | 任务 | 状态 |
|---|---|---|
| R1 双通道并存（同一 dsh） | T2 | ⏳ |
| R2 两种 host 形态 | T2（join.ts + web-remote） | ⏳ |
| R3 候选下发不经 hub | T3 | ⏳ |
| R4 一次性直连票 | T3 | ⏳ |
| R5 选路与自动回落 | ⏭️ P2（App 侧） | ⏭️ |
| R6 统一固定口令门禁（去 pair） | T1 | ⏳ |
| R7 raw 门禁（页面授权 token） | T4 | ⏳ |
| R8 直连链路认证 host（TLS 自签+指纹） | ⏭️ P3 | ⏭️ |
| R9 口令设置入口（CLI+面板） | T1/T6 | ⏳ |
| R10 迁移与首次口令 | T1（迁移）+ T6 | ⏳ |
| R11 状态与身份一致 | T2（同 dsh）+ ⏭️ P2 | ⏳/⏭️ |
| R12 文档与测试 | T7 | ⏳ |
| R13 clipboard polyfill | T5 | ⏳ |
| R14 直连口开启条件（方案 B：始终监听） | T2 | ⏳ |
| R15 可观测性 | T2/T3（日志）+ ⏭️ P2（度量） | ⏳/⏭️ |

## 2. 任务清单（P1）

### T1 门禁统一（去 pair + accessCode 抽公共组件）
- [x] T1.1 新建 `packages/gateway/src/gate.ts`：抽出 accessCode 挑战（HTML 页 + cookie 校验 + code 校验），供 join 与 server 共用
- [x] T1.2 删除 `pair.ts` / `pair-page.ts`；`config.ts` `AuthMode` 去 `"pair"`、删 `pairCode`、`DEFAULT_AUTH.mode="none"`、迁移逻辑（§solution 4.4）
- [x] T1.3 `server.ts`：`GatewayOptions` 删 `pairCode` 增 `accessCode`；去 PairManager；HTTP 层接 gate.ts
- [x] T1.4 `index.ts`：删 `PairManager` 导出；增 gate/direct 导出

### T2 join 进程加直连口
- [x] T2.1 新建 `packages/gateway/src/direct.ts`：`startDirect`（复用 startGateway + accessCode gate + 候选列表 + 实际端口）
- [x] T2.2 `join.ts`：`join()` 在设口令时起直连口，与隧道同生命周期
- [x] T2.3 `web-remote/src/index.ts`：插件 `connect` 同样起直连口（用 ctx.webServer.port）

### T3 候选 + 直连票
- [x] T3.1 host 候选端点（返回 candidates + 一次性直连票）
- [x] T3.2 直连口校验直连票（一次性 + TTL≤30s + 绑定会话 + 303 换 cookie）
- [x] T3.3 join 隧道挂候选端点（仅 owner）

### T4 raw 门禁
- [x] T4.1 明文注入槽每次页面加载注入一次性「页面授权 token」
- [x] T4.2 raw 分发器：设口令时授权前不服务（缓冲≤1MiB + 宽限≤3s）；无口令零变化；kill-switch

### T5 clipboard polyfill
- [x] T5.1 `navigator.clipboard.writeText` polyfill，并入 HTML_INJECT

### T6 CLI
- [x] T6.1 `rdsh host gate set|clear|status`
- [x] T6.2 `setup lan` 去 `--pair-code`、生成随机口令 + 打印一次
- [x] T6.3 帮助文案

### T7 测试与文档
- [x] T7.1 单测：gate / 迁移 / 直连口 / 候选 / 直连票 / raw 门禁 / clipboard 注入
- [x] T7.2 e2e：直连、回退、双通道门禁、raw 绕过拒绝
- [x] T7.3 文档：usage.md / README 双语 / M1 博客

### 质量门
- [x] `pnpm build` 全绿（tsc strict，含 info 级 0 问题）
- [x] `node --test` 全绿
- [x] 代码审查一轮并修复
