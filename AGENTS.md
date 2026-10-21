# Coding Agent Guidelines

本文件约束在此仓库工作的所有编码智能体，不绑定任何特定工具。

Vibe Coding 八荣八耻

以臆猜接口为耻，以查档求证为荣。
以模糊开工为耻，以对齐需求为荣。
以脑补业务为耻，以请示规则为荣。
以新增冗余为耻，以复用存量为荣。
以省略校验为耻，以完备测例为荣。
以乱改架构为耻，以恪守规范为荣。
以不懂装懂为耻，以坦诚存疑为荣。
以批量乱改为耻，以分步迭代为荣。

## 0. Thinking Discipline (MUST READ FIRST)

> "The models make wrong assumptions on your behalf and just run along with them without checking. They don't manage their confusion, don't seek clarifications, don't surface inconsistencies, don't present tradeoffs, don't push back when they should." — Andrej Karpathy

**Before answering any question about the codebase, ask yourself: "Did I read the code, or am I guessing?"** If you haven't read the relevant source file, DO NOT ANSWER. Run grep/read first. Naming conventions, prior experience, and "this is how it usually works" are NOT valid sources.

- **Manage confusion**: When something looks inconsistent or unclear, STOP. Name what's confusing. Ask. Do not silently pick an interpretation and proceed.
- **Push back**: If a simpler approach exists, say so. If the user's request contains scope creep, flag it. If a proposed change has hidden risks, surface them. Do not be a passive executor.
- **Present tradeoffs**: When multiple valid approaches exist, lay out the options before picking one. Let the user decide.
- **Recommend, don't just ask**: 提问时把推荐项放第一位，并说明理由（证据 / 取舍 / 风险）；不要只抛裸选项。

## 1. Communication & Language
- **User Correspondence**: ALWAYS respond to the user in **Chinese**.
- **Documentation**: 内部文档一律中文；对外文档（README、LICENSE、CONTRIBUTING 等）英文，README 双语（README.md + README.zh.md）。
- **Technical Content**: Code identifiers, comments, and Git commit messages must be in **English**.
- **Transparency**: For complex refactoring or destructive actions, describe the plan in `Thought` and obtain approval first.

## 2. Risk, Production Safety & Code Quality
- **Quality First**: Do not rush. If unsure about the quality of the code, ask for clarification.
- **Simplicity First**: 最小实现解决该问题；不加需求外功能，不为单次使用造抽象；若"资深工程师会说这是过度设计"就简化。
- **Surgical Changes**: 只动该动的；不改相邻代码/注释/格式；每行改动都对应需求；发现无关死代码只提不删。
- **Code Review**: 改后必查括号/语法，修到零问题——TS 跑 `pnpm build`（tsc strict，含 info 级）、纯 JS 跑 `node --check <file>`、Go 跑 `go build ./... && go test ./...`。
- **Defer Requires Proof**: 任何延期都必须给出具体阻塞（API 未提供、里程碑未开闸）；"严重度/工作量"不是理由。
- **Partial Formatting**: ONLY format new or modified code. Global reformatting is FORBIDDEN.
- **Environment Isolation**: No deployment scripts or external side effects (npm publish, `git push` to public remote, GitHub operations) without explicit user permission.

## 3. Pre-edit Check (Adaptive Gate)

改动前先做范围评估：

- **Micro-edit**（错字/单行）：给一句 `[Pre-edit OK] Scope trivial.` 即可。
- **Standard-edit**（逻辑/多行）：先列**计划清单**（不贴代码），逐项过：①括号对称 ②符号依赖（删/改名会否断链它处）③验证命令（`pnpm build` / `node --check` / `pnpm test`）④路径安全（只动目标目录）⑤契约变更（先 grep 全部调用点，确认每个 caller 兼容）⑥目标语言特性。

## 4. Task Splitting & Flow Control
- **Splitting Threshold**: If a task involves **>= 3 files** OR **> 50 lines of code changes**, a `Subtasks` list MUST be generated first.
- **Single Responsibility**: Each subtask must focus on a single file or a cohesive logic group.
- **Zero-Defect Gate**: If `pnpm build` / `pnpm test` / lint returns errors, the task is "Blocked" until fixed.

## 5. Documentation SOP

### Directory Convention

> ⚠️ **公开仓 / 私有仓文档边界（2026-10-21 起）**
> 本仓**只放公开文档**：`doc/blog/`、`doc/overview/`（脱敏版）、`packages/*/README.md`、`packages/tunnel/PROTOCOL.md`、`packages/hub/API.md`、`e2e/`。
> **实施过程 / 内部文档一律在私有仓 `whalelink`**：`doc/feature/`、`doc/fix/`、`doc/review/`、`doc/ops/`、`doc/saas/`、`doc/daily/`、`doc/task/`。
> **本仓不建 `doc/feature|fix|review|ops|saas`**；CI 会检查，出现即 fail。

- **Feature Pipeline（私有仓）**: Follow `discussion → req → solution → plan → code-review → verification → summary + TODO` in `whalelink/doc/feature/{NN-name}/`，特性目录以两位数字编号作索引（如 `01-xxx`、`02-xxx`）。**本仓不复制该管线。**
- **架构/概览/提案文档**: 公开仓放 `doc/overview/`（脱敏版：`architecture.md`、`roadmap.md`、`proposal.md`）；完整版/内部版在私有仓。
- **博客**: 场景化教程/传播文章放 `doc/blog/`，按语言分子目录 `doc/blog/zh/`（中文，`NN-name.md`）与 `doc/blog/en/`（英文，`NN-name.md`），两版互链；README 双语各自链接对应语言版本。**博客一律不用 Markdown 表格**——结构信息用加粗引导条目（`- **标题**：说明`）表达，保证手机/微信内浏览器阅读体验。
- **市场/营销**: 市场分析、定位、定价对标**不入本仓**（属内部活文档）；对外只发布脱敏后的 `doc/blog/` 文章。基于事实带来源，查不到标"待查证"。
- **Bugfix Pipeline（私有仓）**: complex fixes go to `whalelink/doc/fix/{name}/`; simple public fixes are recorded in `CHANGELOG` only.
- **Consistency（私有仓）**: Keep `whalelink/doc/daily/YYYYMMDD.md` updated at the end of task series upon user request.

### Feature Pipeline（私有仓，MANDATORY）

> 本仓**不执行**这套流程；它只在私有仓 `whalelink` 落地。公开仓出现 `doc/feature/` 会被 CI 拒绝。

```
discussion.md → req.md → solution.md → plan.md → (implementation) → code-review.md → verification.md → plan.md review → summary.md + TODO.md
```

| Stage | Gate | 职责 |
|---|---|---|
| `discussion.md` | — | 原始记录（讨论/会议/审计）；`req.md` 出现后只读，新需求直接进 req.md |
| `req.md` | 用户批准 | 做什么：需求清单 + 验收标准，不含实现 |
| `solution.md` | 用户批准 | 怎么做：架构、改文件清单、数据契约；新需求先补 req.md，不静默扩范围 |
| `plan.md` | 用户批准 | RTTM（需求→任务矩阵）+ 任务清单，逐条标 `✅`/`❌`/`⏭️` |
| *(实现)* | 自动 | 写代码；每 2–3 个任务对照 req.md 自查一次 |
| `code-review.md` | 独立评审 | 对照 req/plan 审 diff：正确性/安全/边界/契约变更；P0/P1 修完才进下一步 |
| `verification.md` | 自动 | 收尾审计：RTTM 覆盖、代码存在**且被调用**、列出每个 gap 与建议 |
| `plan.md` 复查 | 自动 | 按 verification 结果更新任务状态 |
| `summary.md` | 自动 | 结果记录 |
| `TODO.md` | 自动 | 机械抽取 `❌`+`⏭️`，**禁止手写** |

状态：`✅` 完成 · `❌` 受阻（记原因）· `⏭️` 跳过（记决策）。`TODO.md` 非空 = 特性未完成，由人决定关闭/延期/放弃。

### Solution 文档结构（必守）

Goal（目标）→ Facts（先读代码确认现状，列共享组件的**影响面**）→ Gap（目标与事实之差 = 要解决的问题）→ Call-site Audit（改共享函数契约时**必做**：grep 全部调用点，逐个判 compatible/conflict，有 conflict 先改设计）→ Tasks（精确文件路径 + 行号）。

**规则**：每个"改为 xxx"都必须有 Facts 步骤的代码事实背书，无核查即无方案。

plan.md 的强制格式见 **附录 E**。

## 6. Version Control - Git（Zero Global Commit）

本仓用 git；为防污染，只按显式路径提交：

1. **Status Review**：先 `git status` 列全量变更。
2. **Batch Plan**：给待提交文件的**显式完整路径**（禁 `git add .`/`*`）+ 英文 Conventional Commits message。
3. **Execution Lock**：等用户明确确认（如 "Go"）才 `git commit`。
4. **Push Policy**：`git push` 需单独确认（公开仓推送即发布）。
5. **No Auto Footer**：不加 `Co-Authored-By` 等自动脚注。
6. **.gitignore 已覆盖**：`node_modules/`、`dist/`、`.dart_tool/`、`.DS_Store` 等（见仓库 `.gitignore`）。

## 7. 协议先行纪律（PROTOCOL-FIRST）

凡跨语言、跨进程的线协议与对外 API 都是**契约**，不是实现细节：

- **文档先行**：任何帧格式 / 消息类型 / API 变更，先更新协议文档，再改实现。
- **变更必须补 conformance 测试**：契约变了，除了改实现，还要有能验证双方一致性的测试。
- **实现服从契约**：不得在实现里私自扩展协议；有歧义回到协议文档解决，而不是就近兼容。
- 破坏以上任一条 = 破坏"客户端与下游组件永不需要改动"的承诺。

本项目具体的协议文档、对外 API 文档与 conformance 测试路径，见 **附录 B**。

## Appendix A: 环境与目录结构

### A.1 项目速览

- **产品**：`remote-dsh`（代码名 `rdsh`）—— 为 DeepSeek Harness 构建安全远程访问层：`rdsh serve` / `rdsh join <hub>`（用户侧）与 `rdsh-hub`（服务端）。里程碑见 `doc/overview/roadmap.md`，不在本文件维护。
- **技术栈**：TypeScript monorepo（`packages/*`，pnpm workspace）。Go 规模化组件（relay / Bay Controller / Scheduler）在**私有仓 `rdsh-cloud`**，不在本仓；本仓只保留 Node 单机自托管系统 + 公开协议。未来若用 Go 实现 hub，也进私有仓（**当前未排期**）。

### A.2 工具链与命令

- **Runtime**: Node.js ≥ 22（`.nvmrc` 固定 22），pnpm ≥ 9（workspace 根 `pnpm-workspace.yaml`）。
- **语言与编译**: TypeScript（`tsc` strict，`tsconfig.base.json`，`outDir: dist`）。
- **构建**: `pnpm build`（先构建 `packages/portal`，再构建其余包）、`pnpm test`（`node --test`）。
- **测试**: 内置 `node:test` + `node:assert`（零依赖）；测试文件放各包 `test/`。
- **npm 发布**: npm 包名 **`remote-dsh`**（CLI 命令仍是 `rdsh`）；`rdsh` 裸名被 npm 的 typo-squatting 防护拒绝，不能作为包名。子包名：`rdsh-tunnel` / `rdsh-hub` / `rdsh-portal` / `rdsh-hub-cli`（服务端 CLI）。**发布即对外**，必须先得到用户显式确认；版本号与发布记录写入 `CHANGELOG`，不写进本文件。
- **MVP 节奏**: 实现严格按私有仓的 `doc/feature/01-remote-access/plan.md`（归档：`whalelink/doc/archive/remote-dsh/feature/01-remote-access/plan.md`）推进；未列入 plan 的功能不得顺手实现。**本仓不复制该 plan。**
- **依赖纪律**: 依赖最小化——能用 Node 内置（`node:http`、`node:sqlite` ≥22.5、`node:crypto`、`node:test`）就不加包；必须新增依赖时先说明理由。
- **项目布局**（内容会变，改动时按实际目录核对，勿凭记忆）:
  - `packages/tunnel` — `rdsh-tunnel`：线协议（零依赖；`PROTOCOL.md` 是跨语言契约）
  - `packages/gateway` — `rdsh-gateway`：认证网关 + 隧道客户端（spawn `dsh web`）
  - `packages/hub` — `rdsh-hub`：服务器，控制面 + 数据面（含内置 relay；生产期 Go 版属商业版，私有仓）
  - `packages/portal` — `rdsh-portal`：Web 门户（Vite + React 18，与 DSH 前端同构）
  - `packages/cli` — `remote-dsh`：`rdsh` 用户侧 bin（setup/join/serve/service/leave/user/gate，短形式为主、`host` 兼容别名；不含 hub）
  - `packages/hub-cli` — `rdsh-hub-cli`：`rdsh-hub` 服务端 bin（serve/user/audit/host/service）；其余 `packages/*`（`web-remote` / `agent-mesh` / `whale-link` 等）见目录本身
  - **私有仓 `rdsh-cloud`（不在本仓）** — Go 规模化组件：`cmd/rdsh-relay` 中继节点、`cmd/rdsh-bay`、`cmd/rdsh-cloud-scheduler`、`internal/tunnel` 的 Go 实现
  - `e2e/` — 公开 conformance fixtures 与最小 TS harness；Go 实现在私有仓跑同一套 fixtures
  - `media/` — logo 资产（品牌，不随 MIT，见 NOTICE）；`doc/` — **公开文档**（`blog/`、`overview/`；实施过程与内部文档在私有仓，见 §5）

## Appendix B: 协议与契约路径

- **隧道协议**（gateway ↔ hub 的线协议）：`packages/tunnel/PROTOCOL.md` —— 跨语言契约；Go 实现（relay / 未来 hub）在私有仓 `rdsh-cloud`，必须与本文一致。
- **对外 API**（客户端 ↔ hub 的 REST + WSS）：`packages/hub/API.md`；消费方是客户端 App 与未来第三方接入。
- **跨语言 conformance**：公开 fixtures 在 `e2e/`；私有仓的 Go 实现在 CI 里跑同一套 fixtures（私有仓不得反向要求本仓依赖它）。
- **"gateway 永不需要改动"的承诺出处**：`doc/overview/proposal.md` §7（技术栈建议）。

## Appendix C: DSH 事实速查

只记**不随版本变化的前提**，具体数值不入库：

- **DSH 没有 HTTP 认证层**：安全靠 Host 围栏，源码注释原话是 "this fence is not an auth layer"。因此**任何远程暴露都必须自带认证**——这是 rdsh 存在的前提。
- **`/api/*` 承载全部 RPC，并带 WebSocket 通道**：网关/隧道必须全双工转发（HTTP + SSE + WS upgrade）。这条变了即 breaking。
- **具体值一律查档**：端口、默认绑定地址、`--host` 取值、新增开关（如 `--trusted-host`）、前端包名等，先看 `dsh web --help` 与安装的 `@deepseek-ai/dsh` 包源码；**不要把具体值写进本文件**。

## Appendix D: 品牌与开源

- 产品名 **remote-dsh**，代码名 **rdsh**；组件清单见 **附录 A.2**。
- MIT 只覆盖代码；**logo 与名称是品牌资产**（NOTICE），不得用于派生产品的品牌化。
- 对外文档（README/LICENSE/CONTRIBUTING）英文；`doc/` 内部中文；README 双语同步。

## Appendix E: plan.md 格式（强制）

自包含，执行者无需回读 solution.md：

| Section | Rule |
|---|---|
| Title | `# <Name> — 实施计划` |
| Header | `**日期**: YYYY-MM-DD` + `**来源**: [discussion.md](...), [req.md](...), [solution.md](...)` |
| RTTM | `\| 需求 \| 任务 \| 验证方式 \|` |
| Tasks | `### T# — 描述`，含 file path + line numbers + `- [ ]` 子任务 + code snippet + `**完成标准**: ...` |
| Status | `✅` done / `❌` blocked / `⏭️` skipped / `⏳` pending |
| Order | ASCII 依赖图 |
| Footer | `*关联文档：discussion.md \| req.md \| solution.md*` |
