# dsh 0.1.5-rc.2：dsh-web-remote 插件树加载失败（plan）

> **日期**: 2026-09-11
> **状态**: 已实施并验证（见 [verification.md](verification.md)）
> **方案**: [solution.md](solution.md)

---

## RTTM（需求 → 任务追溯）

| # | 需求 | 来源 | 任务 | 状态 |
|---|---|---|---|---|
| R1 | 装有插件时 `dsh web@0.1.5-rc.2` 能启动 | 用户现象 | T1–T4、T9 | ✅ |
| R2 | 同一份代码继续兼容 `0.1.2-rc.1` | 存量承诺（CHANGELOG 兼容矩阵） | T2–T4、T10 | ✅ |
| R3 | 浏览器半零改动（线协议不变） | 用户确认方案 A | T3–T4 | ✅ |
| R4 | 安全围栏不降级（Host/Origin + 会话校验） | discussion §3.5 | T4、T10 | ✅ |
| R5 | 构建/测试零 issue | CLAUDE.md §2 | T9 | ✅ |
| R6 | 文档与变更日志 | CLAUDE.md §7 | T7、T8 | ✅ |
| R7 | 网关侧 dsh 兼容窗口（`DSH_COMPAT_MAX`）扩展 | spawn-dsh.ts 注释要求 + 用户追加要求 | T11 | ✅ |
| R8 | `dsh-web-remote@0.5.1` 发布 npm | 用户确认范围 | — | ⏭️ |

## 任务清单

| # | 任务 | 状态 |
|---|---|---|
| T1 | `src/index.ts` 头部注释（回归说明 + 围栏/协议不变） | ✅ |
| T2 | 类型与常量：`RpcDispatch` / `WebServerService` / `ConnectionService` / `Ctx.effect` / `RPC_CHANNEL` / `MAX_REQUEST_BODY_BYTES` | ✅ |
| T3 | 注册改为 `ctx.effect(() => ctx.webServer.register({kind:"prefix", …}))`；switch 提为 `dispatch` | ✅ |
| T4 | 协议路由独立为 `src/rpc-route.ts`：`handleRpcRoute()`（官方围栏 → 404/415/413/400 → envelope → dispatch → `server-response`）+ `readBody()` / `endpointFromPath()` / `envelopeFailure()`；语义逐条对齐官方 `rpcFetchHandler` | ✅ |
| T4b | `index.ts` 只留隧道业务 + `Ctx`；从 `rpc-route.ts` 导入路由与类型 | ✅ |
| T4c | 新增 `test/rpc-route.test.ts`（16 例）+ `package.json` test 脚本 | ✅ |
| T5 | `authConn` 去掉冗余类型断言 | ✅ |
| T6 | 版本 `0.5.0` → `0.5.1` | ✅ |
| T7 | `doc/review/20260911-dsh-0.1.5-rc.2-plugin-compat.md` | ✅ |
| T8 | `CHANGELOG.md` / `CHANGELOG.zh.md` | ✅ |
| T9 | `pnpm build`（tsc strict）+ `pnpm test`（gateway 109 / hub 91 / web-remote 16） | ✅ |
| T10 | 双版本端到端实测（0.1.5-rc.2、0.1.2-rc.1） | ✅ |
| T11 | 网关 `DSH_COMPAT_MAX` 扩到 `0.1.5-rc.2` + `dshVersionWarning` 窗口边界单测 | ✅ |
| T12 | npm 发布 0.5.1 | ⏭️ 同 R8 |

## 状态说明

- **R7 / T11 ✅（2026-09-11 已完成）**：按 `spawn-dsh.ts` 注释要求先做**真机实测**（真实 `dsh@0.1.5-rc.2` + `rdsh host serve`：spawn/ready token/cookie 换发/`/api` 转发/HTML 注入/WS `/api/remote.mux` 桥接，以及 join 的 `patchLoopbackJs` 命中），通过后把 `DSH_COMPAT_MAX` 扩到 `0.1.5-rc.2`。证据见 [doc/review/20260911-dsh-0.1.5-rc.2-plugin-compat.md](../../review/20260911-dsh-0.1.5-rc.2-plugin-compat.md) §5（G1–G7）。
- **R8 / T12 ⏭️ 原因**：用户明确本次「暂不发 npm」（公开发布需单独授权）。
