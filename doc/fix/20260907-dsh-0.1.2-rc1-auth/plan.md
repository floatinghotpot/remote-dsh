# dsh 0.1.2-rc.1 认证适配 — 实施计划

**日期**: 2026-09-07
**来源**: [discussion.md](discussion.md) · [solution.md](solution.md) · `doc/review/20260907-dsh-0.1.2-rc.1-auth-gate-compat.md`

## RTTM（需求 → 任务 → 验证）

| 需求 | 任务 | 验证方式 |
|---|---|---|
| R1 适配 dsh 0.1.2 认证（换发+注入，三路径） | T1–T6 | 单测 + 0.1.1/0.1.2 真机冒烟（S1–S7） |
| R2 版本提示（零文档，两层兜底） | T1、T4、T5 | spawn 前 warn 文案单测 + 手动 |
| R3 兼容记录（README 极简 + CHANGELOG 表） | T7 | 双语同步 |
| R4 CI 矩阵冒烟 + 失败 issue | T8 | 本地脚本红/绿 + GitHub 运行 |
| R5 全量验证 | T9 | `pnpm build` 零 issue + `pnpm -r test` 全绿 + 三模式 × 双版本真机 |

## 依赖序

```
T1 → T2 → T3/T5（并行，各自依赖 T1/T2 产物）
     T4/T6（依赖 T1 换发 + T2 注入，各自接线）
T7（独立，随时）  T8（依赖 T2/T3/T5 后冒烟脚本可测）  T9（所有实现后）
```

## Tasks

### T1 — `spawn-dsh.ts`：就绪行 token 捕获 + 换发 + 版本探测/比较 ✅
- `URL_LINE_RE` 扩展捕获可选 `/?token=<t>`；`SpawnedDsh.authToken?: string`
- 新增 `exchangeDshSessionCookie(port, token): Promise<string|null>`（node:http，redirect 读 set-cookie 提取 `dsh-auth-*`）
- 新增 `detectDshVersion(dshPath): Promise<string|null>`（`execFile` 跑 `dsh --version`）
- 新增 `compareDshVersions(a,b): number`（semver + `-rc.N`/`-beta.N`，不可解析排旧）
- **完成标准**：spawn-dsh.test.ts 新增：0.1.1/0.1.2 两形态就绪行解析、换发 303/401/失败、版本比较 rc 语义

### T2 — `proxy.ts`：转发层 cookie 注入 ✅
- `rewriteHeadersForDsh(headers, target, dshAuthCookie?)`：第 3 参存在时**合并**进 `cookie` 头（保留既有 `rdsh_gate` 等，不覆盖）
- `forwardHttp(..., opts?)`/`createUpgradeProxy(target, opts?)` 增可选 `opts.authCookie` 透传（内部两处 rewrite 调用带上）
- **完成标准**：proxy.test.ts 新增合并断言（无原 cookie → 设；有 `rdsh_gate` → 保留并追加 dsh-auth）

### T3 — `server.ts`：serve 路径 cookie 透传 ✅
- `GatewayOptions` 增 `dshAuthCookieHeader?: string|null`；进 `ctx`；`forwardHttp`/升级两处传入
- **完成标准**：server.test.ts 补透传断言（带 cookie 转发时上游收到 dsh-auth 头）

### T4 — `serve.ts`：换发 + 版本 warn ✅
- spawn 后若有 `authToken` → `exchangeDshSessionCookie` → `startGateway` 传 cookie（失败降级 + log）
- spawn 前 `detectDshVersion` + `KNOWN_GOOD_DESH=[0.1.1-rc.2, 0.1.2-rc.1]` 范围外 `console.warn`（命令建议）
- **完成标准**：0.1.2 实测 serve 后 `GET /` 200；0.1.1 无 token 不换发仍 200；范围外版本打 warn

### T5 — `join.ts`：隧道/插件共享内核注入 + CLI join 接线 ✅
- `StartJoinOptions` 增 `dshAuthCookieHeader?: string|null`；`makeInnerDispatcher` 闭包捕获，`openWsStream`(L401) 与 HTTP `httpRequest`(L482) 两处 `rewriteHeadersForDsh(..., dshAuthCookieHeader)`
- `join()` spawn 后换发 + 版本 warn（同 T4）
- **完成标准**：join-core 单测 + E2EE raw 路径不回归；0.1.2 join 隧道后转发 200

### T6 — `web-remote/src/index.ts`：插件进程内换发 ✅
- `Ctx.connection` 类型扩展；`apply` 能力探测 `authenticatedUrl` → 换发 → `startJoin` 传 cookie；失败记 error message
- **完成标准**：0.1.2 宿主插件隧道转发 200；0.1.1 分支不换发（authenticatedUrl 缺失 → null）

### T7 — README/CHANGELOG 兼容记录 ✅
- README(.zh) 极简一行 + 指向 CHANGELOG；CHANGELOG(.zh) 完整逐版表（solution §4.5）
- **完成标准**：双语同步，表结构同 §4.5

### T8 — CI 冒烟 + 失败 issue ✅
- `scripts/smoke-dsh-compat.mjs`（S1–S7，无 key）
- `.github/workflows/dsh-compat.yml`（matrix + schedule dist-tag 检测 + PR latest 快速冒烟）
- `actions/github-script` 失败开 issue（key=dsh 版本去重、`compat-ci` 标签、转绿自动 close）
- **完成标准**：本地脚本对 0.1.2 红/0.1.1 绿；issue 无重复

### T9 — 验证 ⏭️（deferred：插件远端浏览器端到端；join 真机 + 0.1.1 真机 + 破坏面 D + 插件本地装载 已于 2026-09-07 验证 ✅，见 verification.md §4）
- `pnpm build`（tsc strict 零 issue）+ `pnpm -r test` 全绿
- 三模式（serve / join+E2EE / 插件）× 双版本（0.1.1-rc.2 / 0.1.2-rc.1）真机冒烟
- **完成标准**：见 verification.md

*关联文档：discussion.md · solution.md · doc/review/20260907-dsh-0.1.2-rc.1-auth-gate-compat.md*
