# portal 类型检查缺口与 97 条错误的清理（discussion）

> **日期**: 2026-09-21（问题由测试环境在 2026-09-18 前后发现并反馈）
> **现象**: `node_modules/.bin/tsc --noEmit -p packages/portal/tsconfig.json` 报 **97 条**错误；`packages/portal` 的 build 只跑 esbuild（**剥离类型但不检查**），所以这些错误长期无人发现、也从不阻塞发布。
> **结论**: 97 = **75 条配置缺口**（tsconfig 没声明 DOM lib）+ **22 条真问题**（i18n 重复键 9、LEGAL 类型 4、`portalInfo` 空指针 1、E2EE TypedArray 8）。只补 lib 会让 tsc 从"从不运行"变成"97 条红"，所以 **lib + 清 22 条必须同一轮做完，之后才能把 tsc 纳入关卡**。

---

## 1. 事实（均在本仓树核实）

| # | 事实 | 证据 |
|---|---|---|
| **F1** | base 的 `lib` 只有 `["ES2023"]`，portal 是浏览器应用却没补 DOM ⇒ `window`/`document`/`HTMLInputElement` 全不认识 | `tsconfig.base.json:4`；`packages/portal/tsconfig.json`（改前无 `lib`） |
| **F2** | portal 的 build 不含 tsc，类型错误永不阻塞 | `packages/portal/package.json`（改前 `"build": "node scripts/build-legal.mjs && vite build"`） |
| **F3** | 错误分布：TS2304×44、TS2339×24、TS2584×15（=75 配置）＋ TS1117×9、TS2322×4、TS18047×1（=14）＋ 补 DOM lib 后才出现的 E2EE 8 条 = **22 真问题** | `tsc` 两次运行（带/不带 DOM）对比，见 [verification.md](./verification.md) |
| **F4** | i18n 重复键 9 条，其中 `"渠道单号"` 两次取值不同（`:78` "Channel order id" vs `:152` "Channel order"）⇒ 后者覆盖前者，英文界面实际显示 "Channel order" | `packages/portal/src/i18n.ts:78,152`；渲染处 `pages.tsx:2170,2707`（字段 `p.channelOrderId`） |
| **F5** | `LEGAL: Record<string, string>` + base 的 `noUncheckedIndexedAccess` ⇒ `LEGAL.terms` 是 `string \| undefined`，4 处调用报 TS2322 | `packages/portal/scripts/build-legal.mjs:62`（改前）；`tsconfig.base.json:8`；`legal.tsx:39,43,56`、`pages.tsx:458` |
| **F6** | E2EE 8 条只在 DOM lib 存在时出现：TS 5.9 起 `BufferSource` 要求 `ArrayBufferView<ArrayBuffer>`，裸 `Uint8Array` 默认泛型是 `ArrayBufferLike` | 已装 TypeScript **5.9.3**；`packages/portal/src/e2ee.ts:37,48,71,87,96,100` |
| **F7** | **对"P0 空指针"的重要修正**：`portalInfo` 为 `null` 在本仓链路里**不可达** —— hub 的 `/api/account` 未认证直接 401（走 `.catch` 跳登录），认证后返回完整对象；`probe` 是**客户端策略标志**（`jsonFetch` 用它决定 401 时是否自动跳登录，不发给服务端） | `packages/hub/src/api.ts`（`handleAccountInfo`）；`packages/portal/src/api.ts`（`jsonFetch` 的 `opts?.probe`，URL 无参数）。独立 reviewer ① 另有更强证据：`jsonFetch` 唯一无值返回是 204（该路由不返回 204）；`handleAccountInfo` 只有 401/404/200+对象三种出口；路由上 `/api/*` 只由它响应；用编译器 API 重放 HEAD 的 pages.tsx 得到**恰好 2 条**诊断（TS18047 + fromBase64url 的 TS2345）⇒ 错误来源是**状态类型声明**，不是任何运行路径 |
| **F8** | 既有构建顺序缺陷（非本次引入）：`packages/hub` 不依赖 `rdsh-portal`，而 hub 的 build 里有 `copy-portal.mjs` ⇒ `pnpm -r build` 顺序不定，hub 可能复制**上一轮**的 portal 产物（本次实测发生） | `packages/hub/package.json`（`build: tsc -p … && node scripts/copy-portal.mjs`，无 portal 依赖）；根 build = `pnpm -r build` |
| **F9** | portal 当前**没有任何测例**（`vitest run` 输出 "No test files found"，脚本靠 `--passWithNoTests` 兜） | `packages/portal/package.json` 的 `test` 脚本 |
| **F10** | **构建顺序竞态（HIGH）**：`packages/hub` 不依赖 `rdsh-portal`，`pnpm -r build` 并行调度 ⇒ hub 的 `copy-portal.mjs` 可能先于 portal 的 vite build 运行。干净 clone 上 `packages/portal/dist` **不存在**（dist 不入库），旧实现先 `rm -rf packages/hub/portal` 再 `cp` ⇒ **ENOENT 失败 + 入库产物被删**（CI 红；本地留删除态，而 `publish.sh` 无 build + `--no-git-checks` ⇒ 可能发出没有 portal 的 hub）。本地 3 次全量构建里 2 次顺序错误 | `packages/hub/package.json`（build 无 portal 依赖）、`packages/hub/scripts/copy-portal.mjs`（改前 11-13 行）、根 `package.json`、`.github/workflows/ci.yml` |
| **F11** | **关卡挡不住 Node 类型**：portal 未声明 `types`，根目录 `@types/node` 自动入程序 ⇒ 浏览器代码写 `Buffer`/`process` 也能过 tsc。真凶查证：**`@types/qrcode` 的 dependencies 含 `@types/node`**，把整张 Node 类型图带进 portal 程序（实测 68 个 node 类型文件；`types:["vite/client"]` 与 `types:[]` 都挡不住） | `packages/portal/tsconfig.json`（改前无 `types`）；`@types/qrcode/package.json` |
| **F12** | 没有任何环节校验「入库产物 = 新构建产物」，而 `publish.sh` 不构建、`--no-git-checks` ⇒ 可能把旧 SPA 发到 npm | `scripts/publish.sh`、`.github/workflows/ci.yml`（build 后不检查工作区是否变脏） |
| **F13** | `typecheck` 与 `build` 可能不一致：`generated.ts` 入库、只由 build 重新生成 | `packages/portal/package.json` 的两个脚本 |

## 2. Gap

1. **配置**：portal 需要 DOM lib（且只加在 portal —— 共用 base 还被 hub/gateway/cli 这些 Node 包复用，加了 DOM 等于放行服务端误用 `window`/`document`）。
2. **关卡**：`tsc --noEmit` 必须进 portal 的 build；否则这类问题会再次堆积（CI 跑 `pnpm build`，进了 build 就等于进了 CI）。
3. **真问题**：重复 i18n 键（1 条已在影响英文文案）、LEGAL 的 `string | undefined`、E2EE 的 TypedArray 类型收窄；以及 `portalInfo` 的类型洞（防御性修，今天行为零变化）。
4. **构建顺序**：hub 复制 portal 产物这一步需要确定性（否则"改了 portal 但 hub 里是旧产物"会静默发生）。
