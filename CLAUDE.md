# CLAUDE.md

Vibe Coding 八荣八耻

以臆猜接口为耻，以查档求证为荣。
以模糊开工为耻，以对齐需求为荣。
以脑补业务为耻，以请示规则为荣。
以新增冗余为耻，以复用存量为荣。
以省略校验为耻，以完备测例为荣。
以乱改架构为耻，以恪守规范为荣。
以不懂装懂为耻，以坦诚存疑为荣。
以批量乱改为耻，以分步迭代为荣。

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **项目速览**（2026-08-22）：
> - 产品：**remote-dsh（代码名 rdsh）** —— 为 DeepSeek Harness（DSH）构建"安全远程访问层"：`rdsh serve`（局域网认证网关，MVP）/ 云服务器直连 / `rdsh join <hub>`（公网隧道）/ 多租户 + 移动端。**里程碑进度见 `doc/overview/roadmap.md`，不在本文件维护。**
> - 技术栈：TypeScript monorepo（`packages/*`，pnpm workspace）；rdsh-app 用 Flutter（`apps/app`）；rdsh-weapp 原生微信小程序（`apps/weapp`）；未来 rdsh-hub 用 Go 重写（`go/`）。详见 `doc/overview/proposal.md`。
> - 当前阶段：局域网网关（`rdsh serve`）已实现并验收（见 `doc/feature/01-remote-access/`）；后续里程碑见 `doc/overview/roadmap.md`。

## 0. Thinking Discipline (MUST READ FIRST)

> "The models make wrong assumptions on your behalf and just run along with them without checking. They don't manage their confusion, don't seek clarifications, don't surface inconsistencies, don't present tradeoffs, don't push back when they should." — Andrej Karpathy

**Before answering any question about the codebase, ask yourself: "Did I read the code, or am I guessing?"** If you haven't read the relevant source file, DO NOT ANSWER. Run grep/read first. Naming conventions, prior experience, and "this is how it usually works" are NOT valid sources.

- **Manage confusion**: When something looks inconsistent or unclear, STOP. Name what's confusing. Ask. Do not silently pick an interpretation and proceed.
- **Push back**: If a simpler approach exists, say so. If the user's request contains scope creep, flag it. If a proposed change has hidden risks, surface them. Do not be a passive executor.
- **Present tradeoffs**: When multiple valid approaches exist, lay out the options before picking one. Let the user decide.

## 1. Communication & Language
- **User Correspondence**: ALWAYS respond to the user in **Chinese**.
- **Documentation**: `doc/` 内部文档一律中文；仓库对外文档（README、LICENSE、CONTRIBUTING 等）英文，README 双语（README.md + README.zh.md）。
- **Technical Content**: Code identifiers, comments, and Git commit messages must be in **English**.
- **Transparency**: For complex refactoring or destructive actions, describe the plan in `Thought` and obtain approval first.

## 2. Risk, Production Safety & Code Quality
- **Quality First**: Do not rush. If unsure about the quality of the code, ask for clarification.
- **Simplicity First**: Minimum code that solves the problem. No features beyond what was asked. No abstractions for single-use code. Ask: "Would a senior engineer say this is overcomplicated?" If yes, simplify.
- **Surgical Changes**: Touch only what you must. Don't "improve" adjacent code, comments, or formatting. Every changed line should trace directly to the user's request. If you notice unrelated dead code, mention it — don't delete it.
- **Code Review**: after any code changes, always check for bracket balance and syntax errors. if TypeScript changed, run `pnpm build` (tsc strict) and fix **ALL** issues — including `info` level. if plain JS changed, run `node --check <file>`. The target is zero issues.
- **Defer Requires Proof**: Every deferred issue MUST cite a concrete blocker (unavailable API, milestone gate not yet open). Severity or effort are NOT valid reasons to defer.
- **Partial Formatting**: ONLY format new or modified code. Global reformatting is FORBIDDEN.
- **Environment Isolation**: No deployment scripts or external side effects (npm publish, `git push` to public remote, GitHub operations) without explicit user permission.

## 3. Pre-edit Check (Adaptive Gate)
**Before invoking ANY write/modify tools, conduct a scope assessment:**
- **Micro-edit** (typo fix, single-line change): Output brief: `[Pre-edit OK] Scope trivial.`
- **Standard-edit** (logic change, multi-line change): **MUST** output the full checklist (Note: Show the plan/checklist only; do not output proposed code in the chat):
  1. **Bracket Balance**: Are all `{}` `[]` `()` symmetric for this edit?
  2. **Symbol Dependencies**: Will any deleted/renamed symbols break other files?
  3. **Validation Plan**: What analysis/test command will run immediately after the edit? (`pnpm build` / `node --check` / `pnpm test`)
  4. **Path Safety**: Is the operation restricted to the target directory?
  5. **Contract Change**: Does the edit change a function's contract? If yes, grep all call sites and verify every caller is compatible **before** editing.
  6. **Language Switch**: TS vs JS vs Go vs Dart — verify each construct against the target language.

## 4. Task Splitting & Flow Control
- **Splitting Threshold**: If a task involves **>= 3 files** OR **> 50 lines of code changes**, a `Subtasks` list MUST be generated first.
- **Single Responsibility**: Each subtask must focus on a single file or a cohesive logic group.
- **Zero-Defect Gate**: If `pnpm build` / `pnpm test` / lint returns errors, the task is "Blocked" until fixed.
- **MVP 节奏**: 实现严格按 `doc/feature/01-remote-access/plan.md` 推进；未列入 plan 的功能不得顺手实现。

## 5. 协议先行纪律（PROTOCOL-FIRST，本仓库特有）

`rdsh-tunnel` 线协议（层 2）与 hub 对外 API（层 1）是**跨语言契约**：
- 层 2 是未来 Go 重写 rdsh-hub 的唯一依据（`packages/tunnel/PROTOCOL.md`）；
- 层 1 是 rdsh-app / rdsh-weapp / 未来第三方接入的依据。
- **任何帧格式/消息类型/API 变更：必须先更新协议文档，再改实现，并补 conformance 测试**（`e2e/`）。
- 违反此纪律 = 破坏"gateway 永不需要改动"的承诺（proposal.md §7）。

## 6. Version Control - Git（Zero Global Commit Policy）

**本仓库使用 git。为防工作区污染，遵循显式路径提交流程：**
1. **Status Review**: 提交请求时，先运行 `git status` 列出全部变更。
2. **Batch Plan (Explicit Only)**: 提交前必须给出 **Batch Plan** 供评审，包含：
   - 全部待提交文件的**显式完整路径**（禁止 `git add .`、`git add *` 等通配符）；
   - 拟定的 **Commit Message**（英文，遵循 Conventional Commits 风格，如 `feat(scaffold): add monorepo skeleton and open-source docs`）。
3. **Execution Lock**: 等待用户显式确认（如 "Go"）后才可 `git commit`。未经确认的提交 FORBIDDEN。
4. **Push Policy**: `git push` 同样需要显式确认（公共仓库推送即发布）。
5. **No Auto Footer**: 不得在 commit message 中追加 `Co-Authored-By` 或任何自动生成的脚注。
6. **.gitignore 已覆盖**：`node_modules/`、`dist/`、`.dart_tool/`、`.DS_Store`、`.rdsh/` 等（见仓库 `.gitignore`）。

## 7. Documentation SOP

### Directory Convention
- **Feature Pipeline**: Follow `discussion → req → solution → plan → verification → summary + TODO` in `doc/feature/{NN-name}/`，特性目录以两位数字编号作索引（如 `01-remote-access`、`02-xxx`）。
- **架构/概览/提案文档**: 跨项目的架构、概览、提案类文档放 `doc/overview/`（如 `architecture.md`、`roadmap.md`、`proposal.md`），**不进 `doc/feature/`**。
- **博客**: 场景化教程/传播文章放 `doc/blog/`，按语言分子目录 `doc/blog/zh/`（中文，`NN-name.md`）与 `doc/blog/en/`（英文，`NN-name.md`），两版互链；README 双语各自链接对应语言版本。
- **Bugfix Pipeline**: Record complex fixes in `doc/fix/{name}/`; simple fixes go to Daily Summary only.
- **Consistency**: Keep `doc/daily/YYYYMMDD.md` updated at the end of task series upon user request.

### Feature Pipeline (MANDATORY)

```
discussion.md → req.md → solution.md → plan.md → (implementation) → verification.md → plan.md review → summary.md + TODO.md
```

| Stage | Gate | Purpose |
|---|---|---|
| `discussion.md` | — | Raw record: brainstorms, meetings, code audit facts. Once `req.md` exists, discussion.md is READ-ONLY as a requirement source. New requirements go directly to req.md. |
| `req.md` | **User must approve** | What to do: requirements list + acceptance criteria. No implementation details. |
| `solution.md` | **User must approve** | How to do it: architecture, file change list, data contracts. If new requirements are discovered during solution writing, add them to req.md first — do NOT silently expand scope. |
| `plan.md` | **User must approve** | RTTM (req→task traceability matrix) + task checklist. Each task marked `✅` / `❌` / `⏭️`. |
| *(implementation)* | **Auto** | Write code. Every 2-3 completed tasks: lightweight self-audit against req.md, note any gaps. |
| `verification.md` | **Auto** | Close-out audit: re-check req→plan coverage via RTTM; confirm code exists AND is called; list every gap with severity and suggested action. |
| `plan.md` review | **Auto** | Update task statuses based on verification results. |
| `summary.md` | **Auto** | Result record: what was done, what changed. |
| `TODO.md` | **Auto** | Mechanical extraction of `❌` + `⏭️` items from plan.md. Manual authoring FORBIDDEN. |

#### Plan Item States

- `✅` done — implemented and verified
- `❌` not done — attempted but blocked (carries block reason)
- `⏭️` skipped — explicitly deferred this round (carries decision reason)

`TODO.md` non-empty = Feature NOT complete. Human reviews TODO.md and decides: close, defer, or abandon.

### Solution Document Structure (MANDATORY)
1. **Goal** — target architecture / desired behavior (from proposal)
2. **Facts** — audit the actual code to confirm current state; never assume; list the blast radius of shared components
3. **Gap** — diff between Goal and Facts; THIS is the problem to solve
4. **Call-site Audit** (CONDITIONAL) — when a Task changes a shared function's contract, list every call site and classify compatible/conflict
5. **Tasks** — concrete code changes with exact file paths and line ranges

**Rule**: Every "改为 xxx" statement in a solution MUST be backed by a code fact verified in step 2. No fact-check = no solution.

## 8. Execution Environment & Tooling

- **Runtime**: Node.js ≥ 22（`.nvmrc` 固定 22），pnpm ≥ 9（workspace 根 `pnpm-workspace.yaml`）。
- **语言与编译**: TypeScript（`tsc` strict，`tsconfig.base.json`，`outDir: dist`）。
- **构建**: `pnpm build`（`pnpm -r build`，tsc across packages）、`pnpm test`（`node --test`）。
- **测试**: 内置 `node:test` + `node:assert`（零依赖）；测试文件放各包 `test/`。
- **npm 发布**: npm 包名 **`remote-dsh`**（CLI 命令仍是 `rdsh`；`rdsh` 裸名被 npm typo-squatting 防护拒绝，2026-08-22 已实测）。子包 `rdsh-tunnel` / `rdsh-hub` / `rdsh-portal` 待发。发布需用户显式确认；`rdsh-gateway@0.1.0` + `remote-dsh@0.2.0` 已发布（2026-08-23，含真实 `rdsh serve`）。
- **依赖纪律**: 依赖最小化——能用 Node 内置（`node:http`、`node:sqlite` ≥22.5、`node:crypto`、`node:test`）就不加包；必须新增依赖时先说明理由。
- **项目布局**:
  - `packages/tunnel` — 线协议（零依赖；PROTOCOL.md 是跨语言契约）
  - `packages/gateway` — rdsh-gateway：认证网关 + 隧道客户端（spawn `dsh web`）
  - `packages/hub` — rdsh-hub：服务器（原型期 TS；生产期 Go 见 `go/`）
  - `packages/cli` — `rdsh` 统一 bin（serve/join/hub）
  - `packages/portal` — rdsh-portal（Vite + React 18，与 DSH 前端同构）
  - `apps/app` — rdsh-app（Flutter）
  - `apps/weapp` — rdsh-weapp（微信小程序）
  - `go/` — 生产期 rdsh-hub Go 实现
  - `e2e/` — TS↔Go conformance 互操作测试宿主
  - `media/` — logo 资产（品牌，不随 MIT，见 NOTICE）
  - `doc/` — 文档（Feature Pipeline 见 §7；**组件对应的里程碑见 `doc/overview/roadmap.md`**）

## Appendix A: DSH 事实速查（以查档为准，勿凭记忆）

- `dsh web` 默认绑 `127.0.0.1:3080`（`--host` 仅接受 `127.0.0.1`/`0.0.0.0`；`--port 0` OS 分配）。
- **DSH 无 HTTP 认证层**；安全靠 Host 围栏（防 DNS rebinding / 跨站），注释明确 "this fence is not an auth layer"。任何远程暴露都必须自带认证。
- `/api/*` 承载全部 RPC；`/api/events.mux`、`/api/events.host` 两条 WebSocket 通道 —— 网关/隧道必须全双工转发（HTTP + SSE + WS upgrade）。
- 前端 `@deepseek-ai/dsh-web-frontend`（Vite + React 18）可整体复用；`/api` 契约类型 browser-safe。
- 事实核查源：安装的 `@deepseek-ai/dsh` 包源码；重要论断须在 `doc/feature/01-remote-access/discussion.md` 记录出处。

## Appendix B: 品牌与开源

- 产品名 **remote-dsh**，代码名 **rdsh**；组件：rdsh-hub / rdsh-gateway / rdsh-tunnel / rdsh-portal / rdsh-app / rdsh-weapp。
- MIT 只覆盖代码；**logo 与名称是品牌资产**（NOTICE），不得用于派生产品的品牌化。
- 对外文档（README/LICENSE/CONTRIBUTING）英文；`doc/` 内部中文；README 双语同步。
