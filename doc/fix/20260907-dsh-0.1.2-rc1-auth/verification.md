# Verification — dsh 0.1.2-rc.1 认证适配 + 版本兼容管理

**日期**: 2026-09-07
**来源**: [plan.md](plan.md) · [solution.md](solution.md)

## 1. 结论

核心修复（cookie 换发 + 注入，T1–T6）**已实现、已编译、已真机冒烟通过**；版本提示（warn）、兼容记录、CI 冒烟与失败 issue 就位。三模式中 serve 模式端到端真机验证通过，join 与插件模式靠单测 + 共享内核覆盖（真机待 hub 环境，见 §5 gap）。

## 2. RTTM 复查

| 需求 | 任务 | 状态 |
|---|---|---|
| R1 适配 0.1.2 认证（三路径） | T1–T6 | ✅ 代码 + 单测 + serve 真机 |
| R2 版本提示（两层兜底） | T1、T4、T5 | ✅ `dshVersionWarning` 已接 serve/join |
| R3 兼容记录（README + CHANGELOG） | T7 | ✅ 双语 |
| R4 CI 矩阵冒烟 + 失败 issue | T8 | ✅ 脚本 + workflow |
| R5 全量验证 | T9 | ✅ 见 §4 |

## 3. 代码存在且被调用（存在性 + 调用点）

| 符号 | 定义 | 调用点 |
|---|---|---|
| `exchangeDshSessionCookie` | `spawn-dsh.ts` | `serve.ts`、`join.ts`（CLI join）、`web-remote/src/index.ts`（插件） |
| `detectDshVersion` / `compareDshVersions` / `dshVersionWarning` | `spawn-dsh.ts` | `serve.ts`、`join.ts` |
| `rewriteHeadersForDsh(…, dshAuthCookie)` | `proxy.ts` | `proxy.ts` `forwardHttp`/`createUpgradeProxy`、`join.ts` `openWsStream`/HTTP 转发 |
| `dshAuthCookieHeader` 透传 | `server.ts` ctx、`join.ts` `startJoin` | `serve.ts`/`join.ts`/`web-remote` 三入口注入 |
| 插件 `authenticatedUrl` 换发 | `web-remote/src/index.ts` `apply` | 能力探测（0.1.2 有 / 0.1.1 跳过），实证见 discussion |

## 4. 测试结果

- `pnpm build`：全包 tsc strict 零 issue（含 portal vite 构建）；
- `pnpm test`：**211 通过 / 0 失败**（tunnel 12、hub 91、gateway 108；cli 无测试）；
- 新增单测 12 项（spawn-dsh 9、proxy 3、server 1）全绿；
- 冒烟脚本 `scripts/smoke-dsh-compat.mjs` 对真实 dsh 0.1.2-rc.1：**S1–S7 全 PASS + 对照组**（无 cookie `GET /` 401 / WS 401，证明认证层真实生效）；
- serve 端到端真机（gateway `startGateway` + 换发）：经网关 `GET /` = **200**（返回 dsh 前端 HTML），对照组直连无 cookie = 401；
- **join 模式端到端真机（真实 hub，2026-09-07）**：`rdsh host join https://rdsh.cn` 注册成功（host=iMacPro）→ `rdsh host serve` 常驻：spawn dsh 0.1.2、cookie 换发成功、隧道 `tunnel established`。**远端浏览器经 hub 打开该 host，DSH UI 正常加载、可操作** —— join + hub 隧道 + 远端浏览器 + cookie 注入完整闭环 ✅；
- **破坏面 D 修复真机（2026-09-07）**：0.1.2 index 默认 gzip 曾使 hub 返回条 + E2EE shim 注入失效（`relay.ts` canInject 因 `content-encoding` 跳过）。修复（`rewriteHeadersForDsh` 对文档请求剥离 `accept-encoding`）后：dsh 返回明文（无 content-encoding）、body 含 `</head>`；重启 join，**远端浏览器确认返回按钮恢复** ✅；
- **0.1.1-rc.2 真机冒烟（2026-09-07）**：`pnpm add` 隔离安装 0.1.1-rc.2，冒烟脚本 **S1–S7 全 PASS**（S2 token=absent → 不换发分支正确；S3 GET / 200 无认证层；S5 WS upgrade `/api/events.mux` 101；S7 patch 命中，pnpm 布局支持）。新 rdsh 代码对 0.1.1 线完全兼容 ✅；
- **插件模式本地装载验证（2026-09-07）**：symlink 注入 profile + `cordis.patch.yml`（不发布 npm），新版 `dsh-web-remote`（含 T6 换发）在真实 dsh 0.1.2-rc.1 宿主装载成功——`autoConnect` 跑起（`reusing persisted host token`）、`startJoin` 隧道核心 `acquireJoinLock`（role=plugin）成功。插件装载/宿主 API/进程内换发链已本地验证 ✅（远端浏览器端到端见 G1）。

## 5. Gap 清单

| # | 缺口 | 严重度 | 建议 |
|---|---|---|---|
| G1 | 插件模式**远端浏览器端到端**未验（本地装载/隧道启动/换发链已验） | P1 | 发布前在真实 hub 用浏览器经插件隧道访问一次（与 join 模式同构，join 已验 200） |
| G2 | CI `dsh-compat.yml` 尚未在 GitHub 实跑（本地脚本已验） | P1 | push 后由 PR/每日 schedule 首次运行验证 |

*关联文档：discussion.md · solution.md · plan.md*
