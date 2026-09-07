# Solution — dsh 0.1.2-rc.1 认证适配 + 版本兼容管理

> **日期**: 2026-09-07
> **来源**: [discussion.md](discussion.md)（D1–D10 决策）、`doc/review/20260907-dsh-0.1.2-rc.1-auth-gate-compat.md`（复核事实）
> **状态**: 待用户批准

---

## 1. Goal

1. **适配 dsh 0.1.2-rc.1**：rdsh 宿主（CLI serve/join + web-remote 插件）代持浏览器会话 cookie，穿透 0.1.2 新增认证层；同时保持 0.1.1 线可用（就绪行无 token → 不换发）。一个适配覆盖共享转发内核的三条路径。
2. **版本提示（零文档导向）**：系统替用户判断版本——正常静默；真不兼容（运行时探测）或未实测版本（版本号 warn）才提示，且给动作指令（升级 rdsh / 暂用某 dsh 版本）。用户不查表。
3. **README 兼容表**（双语）：CLI + 插件两行 + hub 无关行。
4. **CI dsh 版本矩阵冒烟** + 失败自动开 issue（去重）。

**非目标**：支持未来未实测 dsh 的硬承诺（用 warn 兜底）；hub portal 显示 host 版本（gateway 上报，另行立项）；插件冒烟（第二阶段）。

## 2. Facts（代码事实，2026-09-07 已核实）

### 2.1 dsh 0.1.2-rc.1 认证模型（全局安装源码）

| 事实 | 出处 |
|---|---|
| `requestRejection` = Host/Origin 围栏(403) + `browserAuth.isAuthenticated`(401，无 cookie 即失败) | `dsh-client-connection/lib/index.js` L530-533 |
| cookie 名 `dsh-auth-<base64url(sha256(authority))>`，payload 嵌 authority，HttpOnly/SameSite=Strict/30d | L200/L257-258/L269-271 |
| 唯一签发入口 `GET /?token=` → 303 + Set-Cookie（authority = 请求 Host 头） | L363-402 |
| `/api` 前缀路由、RPC channel、WS upgrade `/api/remote.mux` 全部先过 `requestRejection` | L705-714 / L579-587 / `dsh-api-gateway/lib/index.js` L461-468 |
| `/` index 文档经 `authorizeIndex`（无 token 无 cookie → 401）；非 index 静态资源公开 | `dsh-host-frontend-static/lib/index.js` L59-66/L95 |
| 实测（本机 0.1.2-rc.1）：无 cookie 的 `GET /`、`POST /api/…`、WS upgrade 全 401；换发后带 cookie `GET /` → 200 | review 文档 §2.2 |

### 2.2 remote-dsh 现状

| 事实 | 出处 |
|---|---|
| 就绪行 0.1.2 起带 `?token=`；`URL_LINE_RE` 不锚定行尾 → 端口可解析、**token 被丢弃** | `packages/gateway/src/spawn-dsh.ts` L12-13/L52-88 |
| 转发出站头统一走 `rewriteHeadersForDsh`（Host→127.0.0.1:port、Origin 同步改写），**无 cookie 注入** | `packages/gateway/src/proxy.ts` L32-42 |
| 生产出站点共 4 处：serve HTTP `forwardHttp`（proxy.ts L45-101 内 L51）、serve WS `createUpgradeProxy`（L114-176 内 L117）、join/插件 WS `openWsStream`（join.ts L400-425 内 L401）、join/插件 HTTP（join.ts L476-483） | 逐一核对 |
| CLI serve：`serve.ts` L47 spawnDsh → `startGateway({dshPort})` → server.ts 经 ctx.target 调 forwardHttp/createUpgradeProxy | serve.ts / server.ts L93/L228/L236/L163 |
| CLI join 与 web-remote 插件共用 `startJoin`（join.ts L285-826）；插件 target=`127.0.0.1:ctx.webServer.port` 进程内回环 | web-remote/src/index.ts L155-165 |
| `patchLoopbackJs` 为导出纯函数，fail-open（未命中返回 null 原样透传） | join.ts L229-234 |
| 访问口令 gate 从 `cookie` 头取 `rdsh_gate`——**注入 dsh cookie 不能整体覆盖 cookie 头** | join.ts L327-337 |
| `StartJoinOptions` 现有 role/dshUiCompat/gateway/name/hooks/target；handle 有 setUiCompat/setAccessCode/stop | join.ts L42-88/L800-826 |
| 已有单测：`spawn-dsh.test.ts`（fake dsh 打印 URL 行）、`proxy.test.ts`（host/origin 断言）、`loopback-compat.test.ts`（patch 目标串防漂移） | packages/gateway/test/ |
| CLI 入口：`cli/bin.ts` `host join`/`host serve` → gateway `join()`/`serve()` | bin.ts L195-198 |
| CI 仅 build+test；registry `latest=0.1.2-rc.1`（0.1.1 线只有 rc.1/rc.2） | .github/workflows/ci.yml / npm |

### 2.3 版本边界事实

- 插件宿主 shape（`rpc.call`/`rpc.handle(…,{authority})`/信封）在 **0.1.1-rc.2 已存在** → 无插件版本门，认证适配一处修好全部（discussion Q4 验证）；
- dsh 0.1.1 无 launchToken/browserAuth（grep=0）→ 0.1.1 就绪行无 token、转发无需 cookie。

## 3. Gap

0.1.2+ 下 rdsh 转发到 dsh web 的所有请求缺认证 cookie → `/`、`/api`、WS 全 401，三种访问模式不可用。rdsh 无 token 捕获、无换发、无注入；且无版本探测/提示、无 CI 冒烟门。

## 4. 设计（含决策要点，供批准）

### 4.1 cookie 换发与持有

- `spawn-dsh.ts`：
  - `URL_LINE_RE` 扩展捕获可选 `/ ?token=<t>`，`SpawnedDsh` 增 `authToken?: string`（0.1.1 无 → undefined）；
  - 新增 `exchangeDshSessionCookie(port: number, token: string): Promise<string | null>`：`node:http` `GET /?token=`（`redirect:"manual"` 读 `set-cookie`，fetch 拿不到 opaque-redirect 的 cookie），失败/无 cookie → null + log（不阻塞启动，降级后流量将 401 由用户按提示处理）；
  - 新增 `detectDshVersion(dshPath): Promise<string | null>`（`spawn` 跑 `dsh --version`）与 `compareDshVersions(a,b)`（semver + `-rc.N`/`-beta.N` 比较，语义对齐 dsh4vscode `compareVersions`；不可解析排序为旧）。
- 调用方（serve.ts / join.ts / web-remote）在 spawn/apply 后、对外服务前完成换发，cookie 随 context 传递（见 4.2）；**dsh 崩溃重启不在本期范围**（现状无自动重启，保持一致）。

### 4.2 cookie 注入（共享转发层，覆盖三条路径）

- `rewriteHeadersForDsh(headers, target, dshAuthCookie?)`：第 3 参存在时**合并**进 `cookie` 头（保留原 `rdsh_gate` 等：`[existing, dshAuthCookie].filter(Boolean).join("; ")`），不整体覆盖；
- `forwardHttp(req,res,target,opts?)` 与 `createUpgradeProxy(target, opts?)` 增可选 `opts.authCookie` 透传（内部两处 `rewriteHeadersForDsh` 调用带上）；
- `server.ts`：`GatewayOptions` 增 `dshAuthCookieHeader?: string | null`，进 `ctx`，转发/升级处传入；
- `join.ts`：`StartJoinOptions` 增 `dshAuthCookieHeader?: string | null`，`makeInnerDispatcher` 闭包捕获，`openWsStream` 与 HTTP `httpRequest` 两处 `rewriteHeadersForDsh(…, dshAuthCookieHeader)`。

**注入策略**：以宿主换发的 cookie 无条件合并（远端浏览器经 hub/网关访问时不可能持有 `127.0.0.1:<port>` authority 的合法 dsh cookie，合并无冲突风险；保留既有头避免误伤 rdsh_gate）。

### 4.3 插件（web-remote）取 token（进程内，无 spawn 行）

- `web-remote/src/index.ts`：本地 `Ctx.connection` 类型扩展（真实 0.1.2 `HostConnectionService` 暴露 `authenticatedUrl(baseUrl)`——**2026-09-07 真实宿主打点已实证**）；`apply` 内能力探测 `typeof (ctx.connection as { authenticatedUrl?: unknown }).authenticatedUrl === "function"`：
  - 有 → `const url = authenticatedUrl(\`http://127.0.0.1:\${webServer.port}\`)` → 解析 token → 复用 `exchangeDshSessionCookie` 换发 → `startJoin` 传 cookie；
  - 无（0.1.1）→ cookie null，不换发；
- 面板 message（现有 `lastMessage` 机制）：换发失败 → 记 error message（"0.1.2 认证换发失败，远程访问将不可用"）。

### 4.4 版本提示（零文档导向，两层兜底，D2/D3/D9）

**原则：系统替用户判断版本，用户不查表。** 正常工作（版本在实测范围、行为探测通过）→ 全程静默；只有真出问题或未实测版本才提示，且提示一律给动作指令（升级 rdsh / 暂用某 dsh 版本）。

- **第 1 层（运行时探测，为主）**：换发失败 / 带 cookie 首请求非 200 → 明确报错 + 动作：
  `rdsh: 检测到 dsh <v> 与当前 remote-dsh 不兼容（无法建立安全会话）。请升级：npm i -g remote-dsh@latest（若仍失败，暂用 dsh@0.1.2-rc.1）。`
- **第 2 层（版本号 warn，兜底）**：`serve.ts`/`join.ts` spawn 前 `detectDshVersion`，比较常量 `KNOWN_GOOD_DESH = { min: "0.1.1-rc.2", max: "0.1.2-rc.1" }`（以 registry 实存版本定界，注释说明适配后随实测扩展）：
  - 范围外 → `console.warn`（**warn 继续，不硬拒**，D2），文案同上（新 → 升 rdsh / 暂用旧 dsh；旧 → 升 dsh）；
  - 探测失败（不可解析/取不到）→ 不提示（第 1 层已兜底）；
  - 未来适配扩大 max 后，此 warn 自动成为通用"未验证新版本"提示（不需移除，天然覆盖 0.1.3/0.2.0）。
- **第 3 层（CI 防线）**：latest rdsh ↔ latest dsh 由 §4.6 矩阵保证——"升级到最新"永远是安全动作。

两层互补：运行时探测抓"真坏了"，版本 warn 抓"未实测但还没坏"；第二层成本极低（一次 `dsh --version` + 字符串比较），且是行为探测失灵时的最后显性防线。

### 4.5 版本兼容记录（README 极简一行 + CHANGELOG 完整记录）

**README 不再放兼容表**（避免用户查表负担；表随版本积累会膨胀且无读者）——只保留极简一行：

> 当前 remote-dsh 实测兼容 dsh ≤ 0.1.2-rc.1；版本不匹配时命令行会提示并给出升级命令，完整逐版记录见 CHANGELOG。

**CHANGELOG（随每次发布追加，无限历史该待的地方）**记录完整逐版表——同一 rdsh 版本可实测通过多个 dsh 版本，每组件一行、实测版本单元格内逐个包裹（不用区间记号，避免暗示未实测 alpha 被覆盖）：

| remote-dsh 组件 | 版本 | 兼容 dsh（逐个实测） | 机制 |
|---|---|---|---|
| remote-dsh CLI（host serve/join） | 下一发布版 | dsh `0.1.1-rc.2` ✅<br>dsh `0.1.2-rc.1` ✅ | 就绪行行为探测，自适应两端 |
| dsh-web-remote 插件 | 随本 fix | dsh `0.1.2-rc.1` ✅<br>（0.1.1 线待实证） | 宿主 API shape 两版相同，无版本门 |
| rdsh-hub | 任意 | 与 dsh 版本无关 | 纯中继不解析业务流量 |

注：未列入 = 未实测（如 `0.1.2-alpha.*`、`0.1.3-alpha.2`）——可能能用（行为探测通常照常工作），运行时 warn 兜底，不静默承诺。

### 4.6 CI：dsh 版本矩阵冒烟 + 失败自动 issue

- 新建 `.github/workflows/dsh-compat.yml`：
  - `on: workflow_dispatch + schedule(cron 每日) + pull_request`（PR 用 current latest 快速冒烟，schedule 检测 dist-tag 变化跑全矩阵）；
  - job `matrix: dsh = [0.1.1-rc.2, 0.1.2-rc.1, latest]`（`latest` 从 `npm view` 解析）；每版本隔离 `npm i -g` + 隔离 `DSH_HOME`；
  - 冒烟脚本 `scripts/smoke-dsh-compat.mjs <dshPath>`：实现 S1–S7 断言（见 discussion §6），S7（patch 命中）对真实浏览器 JS 资源执行 `patchLoopbackJs`（URL 从带 cookie `GET /` 的 index/boot 结构解析，实证后定具体抓取方式），退出码非 0 = 失败；
  - 失败处理（D8 去重）：`actions/github-script` —— key=dsh 版本；查 open issues（label `compat-ci` + 标题前缀 `[compat-ci] dsh <v>`）；无则创建（标题/正文含版本+断言+运行链接），有则跳过；job 转绿时 close 匹配 issue。
- 失败信息需可读：断言名 + 期望/实际 + dsh 版本 + Actions run URL。

## 5. Call-site Audit（契约变更面）

| 变更符号 | 调用方 | 兼容性 |
|---|---|---|
| `rewriteHeadersForDsh` 加可选第 3 参 | proxy.ts L51/L117（forwardHttp/createUpgradeProxy 内部）、join.ts L402/L482 | 兼容：可选参，缺省行为不变 |
| `forwardHttp`/`createUpgradeProxy` 加可选 opts.authCookie | server.ts L228/L236/L163 | 兼容：可选 |
| `SpawnedDsh` 加可选 `authToken` | serve.ts L47、join.ts L834、spawn-dsh.test.ts | 兼容：可选字段 |
| `StartJoinOptions` 加可选 `dshAuthCookieHeader` | join.ts join()、web-remote startTunnel | 兼容：可选 |
| `GatewayOptions`/`HttpContext` 加可选 cookie | serve.ts startGateway 调用、server.ts | 兼容：可选 |
| 单测更新 | spawn-dsh.test.ts（补 token 行用例）、proxy.test.ts（补合并断言）、新增 version/exchange 单测 | 需更新 |

**冲突面**：无（全部新增可选参数，缺省行为 = 现状）。gate 语义（rdsh_gate cookie 保留）经合并策略保护。

## 6. Tasks

| # | 文件 | 内容 | 验收 |
|---|---|---|---|
| T1 | `packages/gateway/src/spawn-dsh.ts` | URL_LINE_RE 捕获 token；`SpawnedDsh.authToken`；`exchangeDshSessionCookie`；`detectDshVersion`；`compareDshVersions` | 单测：0.1.1/0.1.2 两形态就绪行解析、rc 比较、换发 303/401/失败 |
| T2 | `packages/gateway/src/proxy.ts` | `rewriteHeadersForDsh` 第 3 参合并 cookie；forwardHttp/createUpgradeProxy opts.authCookie | proxy.test.ts 补合并断言（保留 rdsh_gate、注入 dsh-auth） |
| T3 | `packages/gateway/src/server.ts` | GatewayOptions/ctx 透传 authCookie → 转发/升级 | server.test.ts 补透传断言 |
| T4 | `packages/gateway/src/serve.ts` | spawn 后换发；detectDshVersion + 范围外 warn（命令建议） | 实测 0.1.2：serve 后 `GET /` 200；0.1.1：无 token 不换发仍 200 |
| T5 | `packages/gateway/src/join.ts` | StartJoinOptions.authCookieHeader → dispatcher 两出站点注入；join() spawn 后换发 + warn | join-core 单测 + E2EE raw 路径不回归 |
| T6 | `packages/web-remote/src/index.ts` | Ctx 扩展；能力探测 authenticatedUrl → 换发 → startJoin 传 cookie | 0.1.2 宿主插件隧道后转发 200；0.1.1 分支不换发 |
| T7 | `README.md` + `README.zh.md` + `CHANGELOG.md`/`CHANGELOG.zh.md` | README 极简一行（§4.5 文案）+ 完整逐版兼容表进 CHANGELOG | 双语同步 |
| T8 | `.github/workflows/dsh-compat.yml` + `scripts/smoke-dsh-compat.mjs` | 矩阵冒烟（S1–S7）+ schedule/dist-tag 检测 + 失败 issue（去重/自动 close） | 本地脚本对 0.1.2 红、0.1.1 绿；issue 无重复 |
| T9 | 验证 | `pnpm build`（tsc strict 零 issue）+ `pnpm -r test` + 三种模式 × 双 dsh 版本真机冒烟 | 见 verification.md |

## 7. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 插件 `ctx.connection.authenticatedUrl` 可用性 | ✅ **已实证**（2026-09-07 真实 dsh 0.1.2-rc.1 宿主打点）：`ctx.connection` = `HostConnectionService`，`authenticatedUrl(http://127.0.0.1:<port>)` 返回带 `?token=` 的 URL。0.1.1 线无该方法 → 能力探测分支正确走"不换发" |
| 未来 dsh 再改认证/就绪行 → 行为探测失败但版本在范围内 | warn 是软提示；CI 矩阵冒烟在发版前抓（D9） |
| S7 真实 JS 资源抓取依赖 DSH 前端结构 | 冒烟脚本对 0.1.2 实证后固定抓取逻辑；结构变化本身即 S7 想抓的信号（fail 而非误报） |

*关联：discussion.md ｜ doc/review/20260907-dsh-0.1.2-rc.1-auth-gate-compat.md*
