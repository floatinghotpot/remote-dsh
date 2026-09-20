# portal 类型检查缺口与 97 条错误的清理（solution）

> **日期**: 2026-09-21 ｜ 关联: [discussion.md](./discussion.md)

## Goal

1. `packages/portal` 的 tsc 从 97 条降到 **0 条**（不带额外 `--lib` 参数）。
2. `tsc --noEmit` 进 portal 的 build ⇒ 随根 `pnpm build` 与 CI（`.github/workflows/ci.yml` 跑 `pnpm build`）自动把关。
3. 顺带修掉这轮暴露的真问题（含 1 条会误导英文用户文案的重复键），并把"hub 里 portal 产物"同步到与源码一致。

## Facts（改前，逐条核对）

见 [discussion.md](./discussion.md) §1：F1 lib 缺 DOM、F2 build 无 tsc、F4 i18n 重复键、F5 LEGAL 类型、F6 TS 5.9 TypedArray、F7 `null` 在仓内不可达、F8 构建顺序、F9 无测例。

## Tasks

| # | 文件 | 改动 |
|---|---|---|
| T1 | `packages/portal/tsconfig.json` | `compilerOptions.lib = ["ES2023","DOM","DOM.Iterable"]`（**只加在 portal**，不动 `tsconfig.base.json`） |
| T2 | `packages/portal/package.json` | devDependencies 加 `typescript ^5.7.0`；新增 `typecheck` 脚本；`build` 改为 `build-legal → tsc --noEmit → vite build` |
| T3 | `packages/portal/src/i18n.ts` | 删 9 个重复键；`渠道单号` 保留 `:78` 的 **"Channel order id"**（与 `p.channelOrderId`、相邻表头 Channel / Order 一致） |
| T4 | `packages/portal/scripts/build-legal.mjs` | 键表提为 `KEYS` 单一来源，生成 `{ terms: string; privacy: string; product: string }` 取代 `Record<string, string>`；`src/legal/generated.ts` 重新生成 |
| T5 | `packages/portal/src/e2ee.ts`、`src/pages.tsx` | `type Bytes = Uint8Array<ArrayBuffer>`，把模块内**类型标注**换成 `Bytes`（运行时零变化）；`fromBase64url` 返回类型同步收窄 |
| T6 | `packages/portal/src/pages.tsx` | `AdminLogin`：状态类型改为诚实的 `AccountInfo \| undefined`（去掉不可达的 `null`），第二 effect 与渲染守卫随之只判 `undefined`；保留对**入参**的防御性 null 检查（`(info: AccountInfo \| null)` → 跳 `/portal/login`），注释写明真实前提（本仓 hub 不会返回 200+null，自托管 hub/反代可能不合规） |
| T8 | 根 `package.json` | `build` 改为 `pnpm --filter ./packages/portal build && pnpm -r --filter "!rdsh-portal" build`：先确定性构建 portal，消除 hub 复制产物的竞态（F10） |
| T9 | `packages/hub/scripts/copy-portal.mjs` | 复制前**先校验**：`dist/index.html` 必须存在且不旧于 portal 源码；不满足则报错退出（**绝不先删入库产物**、绝不复制陈旧产物）；直接 `pnpm --filter ./packages/hub build` 也受保护 |
| T10 | `packages/portal/tsconfig.json`、`src/vite-env.d.ts`、`src/qrcode.d.ts`、`package.json` | 真正的浏览器类型围栏：`types: []`；资源类型本地声明（**不引 `vite/client`**：vite 的类型图会带回 `@types/node`）；移除 `@types/qrcode` 改本地最小声明（签名照抄上游 d.ts） |
| T11 | `packages/portal/package.json` | `typecheck` 也先跑 `build-legal.mjs`，与 `build` 一致（F13） |
| T7 | `pnpm-lock.yaml` + `packages/hub/portal/**` | 安装后更新锁文件；重建 portal 并同步入库产物（`node packages/hub/scripts/copy-portal.mjs`） |

## 定级说明（T6）

测试环境原报"P0 崩溃风险"。核实后**修正为类型层缺陷 / 防御性修复**（独立 reviewer ① 用编译器回放确认：HEAD 的 pages.tsx 恰好 2 条诊断，均源于类型声明而非运行路径）：`null` 在本仓链路不可达（hub 未认证返回 401，走既有 `.catch` 跳登录），所以**今天行为零变化、零回归风险**；保留修复是因为 tsc 报的是真实类型洞，且能容忍不合规的 hub/代理返回 200+null。最终形态：**状态类型诚实**（`AccountInfo | undefined`，删掉类型层面的死分支）+ **只对入参保留防御性 null 检查**（防不合规 hub/反代，注释写明前提）。若完全信任不变量，可再删掉那个入参检查并让 effect 回到 HEAD 的两行版（reviewer ① 的替代建议，未采纳：自托管 hub 是真实部署形态）。

## 不做（本轮）

| 项 | 理由 |
|---|---|
| 把 `vite.config.ts` / `test/` 纳入类型检查（审查 ② F5） | **与 T10 的类型围栏冲突**：一旦 import `vite`，其类型图会把 `@types/node` 带回程序（实测 68 个文件），围栏即失效。要兼得需拆第二个 tsconfig（`tsconfig.node.json`），记 TODO |
| 给 portal 补测例（F9） | 需要设计（组件/路由/i18n），另立任务 |
| 其余 `api.accountInfo(...)` 调用点的 null 防御评估（`pages.tsx:138` 等） | 与 T6 同源但当前不可达；如需"全线防御"应先决定是否把 API 返回类型改可空，记 TODO |
