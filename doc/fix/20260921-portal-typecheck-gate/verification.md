# portal 类型检查缺口与 97 条错误的清理（verification）

> **日期**: 2026-09-21 ｜ 关联: [discussion.md](./discussion.md) · [solution.md](./solution.md)

## 1. 错误数：97 → 0

| 阶段 | TS2304 | TS2339 | TS2584 | TS1117 | TS2322 | TS18047 | TS2345/TS2769 | 合计 |
|---|---|---|---|---|---|---|---|---|
| 改前（无 DOM lib） | 44 | 24 | 15 | 9 | 4 | 1 | — | **97** |
| 补 DOM lib 后 | 0 | 0 | 0 | 9 | 4 | 1 | 8 | **22** |
| 清理后 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | **0** ✓ |

（补 DOM lib 后新增的 8 条是 E2EE 的 `Uint8Array`/`BufferSource`，只在 lib.dom 存在时才暴露；14 + 8 = 22，与"22 条真问题"一致。`TS18047` 由 T6 修掉。）

命令：`node_modules/.bin/tsc --noEmit -p packages/portal/tsconfig.json`。

## 2. 关卡是真的（本轮实测拦下一次）

- `packages/portal/node_modules/.bin/tsc` 存在（pnpm 不 hoist 二进制，故 T2 必须把 `typescript` 写进 portal 的 devDependencies）。
- `pnpm --filter ./packages/portal build` 退出码 0；根 `pnpm build` 会连带跑 portal 的 tsc 并把产物同步进 hub。
- **反证（非构造，真实发生）**：拆分提交时漏恢复 `fromBase64url` 的返回类型标注，`pnpm build` 立即以
  `packages/portal/src/pages.tsx(1241,36): error TS2345: Argument of type 'Uint8Array<ArrayBufferLike>' is not assignable to parameter of type 'Bytes'` **失败** ⇒ 关卡确实在拦，而不是摆设。
- CI：`.github/workflows/ci.yml` 跑 `pnpm build` + `pnpm test`；关卡进 build 即进 CI，无需改 workflow。

## 3. 其它验证

| 项 | 结果 |
|---|---|
| 全量测试 | `pnpm test` → **300 通过 / 0 失败**（tunnel 12 · hub 120 · gateway 142 · web-remote 25 · agent-mesh 1；portal 无测例，`--passWithNoTests` 空跑） |
| 生成器可重复 | `build-legal.mjs` 连跑两次，`src/legal/generated.ts` 字节一致（sha256 前 16 位相同） |
| 生成顺序 | build 脚本顺序为 `build-legal → tsc → vite`，生成物先于类型检查 ✓ |
| 产物一致性 | `packages/hub/portal/assets/index-CHbF90bm.js` 与 `packages/portal/dist` 同 hash；产物内含新译文 `Channel order id`（旧值 `"Channel order"` 已消失） |
| 运行时零变化 | `e2ee.ts` diff 只有类型标注（`new Uint8Array(...)` 与全部运行时语句未动）；`Bytes` 别名不进 JS 产物 |
| i18n 键完整性 | 9 个被删键现各**恰好 1 处**定义；全文件无重复键（脚本统计） |
| lockfile | 只新增 portal 的 `typescript: ^5.7.0 → 5.9.3`，无其它改动 |

## 4. 未覆盖 / 已知缺口

| # | 项 | 说明 |
|---|---|---|
| G1 | `vite.config.ts` 仍不被检查 | `tsconfig.json` 的 `include` 只有 `src`；纳入需 Node types |
| G2 | portal 无测例 | `vitest run` 输出 "No test files found"；本轮的"测试通过"是空跑 |
| G3 | 未做浏览器真机验证 | 英文界面 `渠道单号` → "Channel order id"、管理台登录的 null 分支（不可达）都只有静态证据 |
| G4 | 其余 `api.accountInfo(...)` 调用点的 null 防御未评估 | `pages.tsx:138`（`a.name`）等；当前不可达，评估需先决定 API 返回类型是否改可空 |

## 5. 审查

- **自审**（本轮）：发现并修正了对"P0 崩溃"的定级（F7：`null` 不可达 ⇒ 类型层缺陷）；发现构建顺序缺陷 F8；确认 i18n / e2ee / 生成器 / 关卡各项如 §2–§3。
### 5.1 reviewer ①（行为 / 文案侧，只读）

| # | 结论 | 我的处置 |
|---|---|---|
| F1 | **P2**：新加/沿用的 null 分支前提为假（`api.accountInfo` 不可能 resolve 成 `null`）⇒ 死代码 + 注释误导；但 TS 错误真实存在，源于状态类型声明 | ✅ **已按建议重构**：状态改为 `AccountInfo \| undefined`，第二 effect 与渲染守卫只判 `undefined`；**保留**入参防御性 null 检查并把注释改成真实前提（不声称"修好白屏"）。未采纳"完全删掉 null 检查"（自托管 hub/反代可能不合规） |
| F2 | **P2/nit**（既有）：跳转 `assign("/portal/login")` 丢 `?next=`，登录后回不到管理台；`api.ts` 已有带 `?next=` 的 `redirectToLogin()` 但未导出 | ⏭️ 记 [TODO.md](./TODO.md)（属既有行为，改它是一次独立的 UX 变更，不塞进本次类型清理） |
| F3 | **P1 打包陷阱**：新产物 `packages/hub/portal/assets/index-*.js` **未跟踪**，若只提交 `index.html` + 删除旧文件，clone/npm 包里 index.html 指向不存在资源 ⇒ SPA 兜底回 HTML（`text/html`）⇒ **portal 白屏** | ✅ **提交计划里显式列该文件**（CLAUDE.md §6 禁 `git add .` 正是这条的坑）；另一选项（把 `packages/hub/portal/` 改为构建期生成 + gitignore）记 TODO |

reviewer ① 同时独立确认：i18n 340 条/331 唯一 → 331/331，恰好 9 个重复键各少一次、每键仍有唯一定义且仍被 `t()` 引用；整本字典**生效值只有一处变化**（`渠道单号` "Channel order" → "Channel order id"，且与列上下文、`p.channelOrderId` 语义相符）；`pages.tsx` diff 仅 3 个 hunk（类型标注 + P0 + 守卫）；**其余 `accountInfo` 调用点全部 null 容忍**，无需改动；无跳转循环、无 unmount 后 setState、`(info: AccountInfo | null)` 标注类型合法。

### 5.2 reviewer ②（构建配置 / 类型卫生侧，只读）

| # | 结论 | 我的处置 |
|---|---|---|
| F1 | **HIGH**：`pnpm -r build` 真有竞态 —— hub 可能在 portal 的 vite build 之前/之中复制产物；干净 clone 上 dist 不存在 ⇒ 旧实现先 `rm -rf` 后 `cp` **ENOENT 失败并删掉入库产物**（CI 红；本地删态 + publish 不构建 ⇒ 可能发出无 portal 的 hub） | ✅ **已修**：T8（根 build 先确定性构建 portal）+ T9（copy-portal 先校验后删除，缺失/陈旧都报错退出） |
| F2 | **MEDIUM**：未声明 `types` ⇒ `@types/node` 自动入程序，浏览器代码写 `Buffer`/`process` 也能过 tsc（关卡形同虚设） | ✅ **已闭环**：T10。两次试错值得记录 —— ① `types:["vite/client"]` 无效（vite 的类型图带回 node）；② `types:[]` 仍无效，**真凶是 `@types/qrcode` 依赖 `@types/node`**；移除它 + 本地最小声明后：程序内 node 类型文件 **68 → 0**，写 `Buffer`/`process` 报 **TS2591** |
| F3 | **MEDIUM**：无人校验「入库产物 = 新构建产物」，publish 不构建 ⇒ 可能发旧 SPA | ⏭️ 记 TODO：CI 加 `git diff --exit-code -- packages/hub/portal packages/portal/src/legal/generated.ts`；**未直接采纳**：跨平台确定性仅在 macOS 验证（4 次一致），硬门可能造成 CI 抖动 |
| F4 | LOW：`typecheck` 不重新生成 `generated.ts`，结论可能与 `build` 不一致 | ✅ **已修**：T11 |
| F5 | LOW：`src/` 之外（`vite.config.ts`、未来 `test/`）不被检查；朴素纳入会撞 TS6059 | ⏭️ 记 TODO：**与 T10 冲突**（见 solution「不做」），需拆 `tsconfig.node.json` |

reviewer ② 同时独立确认：关卡真在跑且非空转（去掉 DOM lib 报 84 条）、lib 作用域正确（只有 portal 有 DOM）、`tsc` 在 portal build 里可解析（单实例 5.9.3，无漂移）、lockfile 与 package.json 一致、**`Bytes` 是纯类型（esbuild 输出与 HEAD 字节一致）**、生成器确定（4 次字节一致）、产物与 `portal/dist` 字节一致、`rm -rf dest` 能避免旧 hash 残留。

### 5.2bis fresh reviewer（第三轮，行为/文案侧，只读、不看本记录）

| # | 结论 | 我的处置 |
|---|---|---|
| F1 | P2：`info === null` 防御检查不对称 —— 漏了 `jsonFetch` 的另一哨兵 `undefined`（204），rogue 204 会落到永久"加载中…" | ✅ 已改为宽松 `info == null` + 入参标注 `AccountInfo \| null \| undefined`（一次性覆盖两个哨兵） |
| F2 | nit（既有）：`.catch` 对**任何**错误都硬跳登录（含 REFRESH_FAILED 网络抖动），且丢 `?next=` | ⏭️ 记 TODO（既有行为，独立 UX 变更） |
| F3 | nit（潜伏）：`Bytes` 收窄使 `packages/gateway/test/e2ee-interop.test.ts` 的 `Buffer` 实参类型不兼容；今天 gateway tsc 的 `include` 不含 test/，故未被查 | ⏭️ 记 TODO：将来 gateway test 纳入类型检查时，需在 e2ee 互操作边界放宽入参（`Uint8Array`/`BufferSource`） |
| F4 | nit：首个 effect 无 `alive` 清理（setState after unmount），第二个 effect 有 | ⏭️ 记 TODO（React 18 无告警，纯一致性） |
| F5 | nit：`typescript: ^5.7.0` 比注释里的"TS 5.9"宽松（`Uint8Array<ArrayBuffer>` 语法只需 5.7） | ⏭️ 记 TODO（不破坏；根包同为 `^5.7.0`） |

fresh reviewer 同时独立确认：无跳转循环/无双重跳转；9 个被删键各仍有唯一定义、0 重复键；"Channel order id" 是**正确**终值（绑定 `p.channelOrderId`）；`Bytes` 是纯类型且唯一调用链仍通过类型检查；`legal/generated.ts` 是纯类型且与 `build-legal.mjs` 一致；并额外核对了 `qrcode.d.ts`/`vite-env.d.ts`/`tsconfig`/`build-legal.mjs`/hub 侧构建资产。

### 5.2ter fresh reviewer ②（构建配置/类型卫生，只读、不看记录）

| # | 结论 | 我的处置 |
|---|---|---|
| F1 | P2：freshness 守卫**过扫** —— 把非 node_modules/dist 的任何文件当输入，`.DS_Store`/coverage/杂散文件更新就误报（已用 fixture 复现） | ✅ **已修**：改输入白名单（src/scripts/public + index.html/vite.config/tsconfig/package.json），递归时跳过 dotfiles、node_modules、以及 `legal/generated.ts`（生成物，真源是 doc/saas） |
| F2 | P2：**LEGAL 真源盲区** —— `doc/saas/*.md` 在 portal 包之外，原守卫扫不到 ⇒ 只改 md 也能复制陈旧 HTML（假阴性） | ✅ **已修**：把 `doc/saas` 纳入输入扫描 |
| F3 | P2/nit：只查 `dist/index.html` 存在，不查它引用的 `assets/*.js|css` ⇒ 半成品也能过 | ✅ **已修**：解析 index.html 的 `src/href`，逐个断言 asset 存在 |
| F4 | nit：mtime 是启发式（`touch dist` 可绕过） | ⏭️ 接受：注释明确"mtime 是 DX 兜底，非安全边界" |
| F5 | nit/P2：`typecheck`/`build` 会写入库的 `generated.ts` | ⏭️ 接受：字节幂等（md 不变时无 churn）；且 generated.ts 已从新鲜度扫描里排除，不再引起误报。备选（emit 到 gitignored 路径）记 TODO |

fresh reviewer ② 同时独立确认：`types:[]` 围栏扎实（程序内 0 个 `@types/node` 文件，`Buffer`/`process`/`node:fs` 探针全部报错）；`@types/qrcode` 移除安全（只有 pages.tsx 用 qrcode，且运行时包不带类型，本地声明必需且匹配两处调用）；根 build 排除 portal 正确、无双构建、只有 hub 消费 portal dist；`process.exit(1)` 两种失败模式都不动入库产物；`KEYS↔类型` 单源不会漂移；lockfile 一致（0 处 `@types/qrcode`、`typescript@5.9.3` 就位）。

### 5.3 本轮新增的反证（copy-portal 守卫，fresh reviewer ② 后重写）

| 守卫 | 触发方式 | 结果 |
|---|---|---|
| Node 类型围栏（T10） | 在 `src/` 写 `Buffer.from(...)` / `process.env` | ❌ TS2591 —— 围栏生效；程序内 `@types/node` 文件数 **68 → 0** |
| copy-portal ① dist 缺失 | 删掉 `packages/portal/dist` 后运行 | ❌ 明确报错退出 1，**入库产物一字未动** |
| copy-portal ② 真源陈旧 | `touch doc/saas/terms.md` | ❌ 报「dist 比源码旧」退出 1 |
| copy-portal ③ `.DS_Store` 新于 dist | `touch src/.DS_Store` | ✅ 不误报（退出 0） |
| copy-portal ④ 仅重生成 generated.ts | 跑 `build-legal` | ✅ 不误报（退出 0） |
| 构建顺序（T8） | 根 `pnpm build` 日志 | ✅ portal 先构建，hub 复制新产物 |

| 守卫 | 触发方式 | 结果 |
|---|---|---|
| Node 类型围栏（T10） | 在 `src/` 写 `Buffer.from(...)` / `process.env` | ❌ TS2591（Cannot find name）—— 围栏生效；程序内 `@types/node` 文件数 **68 → 0** |
| copy-portal 守卫（T9）① | 删掉 `packages/portal/dist` 后运行 | ❌ 明确报错退出 1，且**入库产物一字未动**（守卫在 `rm` 之前） |
| copy-portal 守卫（T9）② | `touch` 一个 portal 源文件使 dist 变旧 | ❌ 报「dist 比源码旧」退出 1，拒绝复制 |
| 构建顺序（T8） | 根 `pnpm build` 日志 | ✅ 先 `pnpm --filter ./packages/portal build`，再并行其余包；hub 复制到的是新产物 |
