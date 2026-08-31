# 06-dsh-plugin — 验收（verification.md）

> **日期**: 2026-08-24
> **范围**: M4 —— gateway `startJoin` 重构 + pid 锁 + `dsh-web-remote` 插件包
> **依据**: [req.md](req.md)（R1–R9）、[plan.md](plan.md)（T1–T12）

---

## 1. RTTM 复核（req → plan 覆盖）

| 需求 | 任务 | 状态 | 证据 |
|---|---|---|---|
| R1 分发形态（npm 插件） | T5 | ✅ | `packages/web-remote/package.json`（`dsh.bundle.patch` + `dsh.client`）、`cordis.patch.yml`、`exports["./client"]` |
| R2 内嵌 join 核心 | T1、T3 | ✅ | `gateway/src/join.ts` `startJoin()` + `join()` 封装；`index.ts` 导出；`test/join-core.test.ts`（2 例） |
| R3 面板四态 + 外部托管 | T6、T7 | ⚠️ 代码齐，未真机 | server 六态状态机 + client `lib/client.js`（React 面板） |
| R4 配置记忆 | T6 | ✅ | `connect` → `registerJoin` + `saveConfig`（host.json join 字段）；token 只进 `token-store` |
| R5 进程托管 | T1、T6 | ✅ | `startJoin().stop()` + `ctx.on("dispose")` → `handle.stop()` |
| R6 CLI 共存 | T2、T6 | ✅ | `lock.ts` 单测（5 例）；`connect` 的 `mode-conflict`（档1）+ `lock-busy`（档2） |
| R7 断开/注销语义 | T6 | ✅ | `disconnect`（停隧道留配置）、`revoke`（停+selfRevoke+清 token+清 join 字段） |
| R8 安全 | T1、T6、T8 | ✅ | token 仅 `registerJoin` 落 `~/.rdsh/join-*.token`（0600）；host.json 无 token |
| R9 文档/发布纪律 | T9、T10 | ✅ | CHANGELOG（en/zh）已加；README/roadmap 未泄全名 |

## 2. 代码存在且被调用

- `startJoin` 被 `join()`（CLI 封装，`cli/src/bin.ts:326` 经 `join` 调用）与 `web-remote/src/index.ts`（插件 connect）两处调用。
- `acquireJoinLock`/`releaseJoinLock` 在 `startJoin` 内调用；`readJoinLock` 被插件 `state`/`connect` 调用。
- 全量构建 `pnpm build`（tsc strict）绿；全量测试 `pnpm test` **114 通过 / 0 失败**（gateway 74、hub 28、tunnel 12）。

## 3. 差距清单（gap）

| # | 差距 | 严重度 | 处置 |
|---|---|---|---|
| G1 | client.js + server 半的 DSH 集成冒烟（`dsh plugin add` → 面板 → 接入/断开/注销） | ~~P1~~ ✅ | **已解决**：2026-08-24 用户本机 DSH 实测通过（面板出现 + 接入 hub.example.com「已连接」+ 断开/注销 + i18n/DSH 主题对齐） |
| G2 | `rdsh-gateway@0.4.0` + `dsh-web-remote@0.1.0` 发布 | ~~P1~~ ✅ | **已解决**：2026-08-24 发布到 npm；`dsh plugin --profile web add dsh-web-remote` 验证通过 |
| G3 | pid 存活探测（`process.kill(pid,0)`）未在 Windows 实测 | P3 | Linux/macOS 已测；Windows 语义待补 |
| G4 | `@deepseek-ai/cordis` 未作运行时依赖（server 半用函数插件形态规避）——若将来要 `Service` 子类需补 peerDep | P3 | 已在 solution §2.4 记录 |
| G5 | 注销后 host.json 回退为 `mode:"lan"`（清 hub/name/insecure），与 CLI `leave`（删文件）略有差异 | P3 | 已在 solution §7 记录，按选择实现 |

## 4. 结论

- 核心（gateway `startJoin` + pid 锁）已实现、构建/单测全绿、CLI 零回归 —— **达标**。
- 插件包（server + client 半）已实现、**真实 DSH 冒烟通过 + 发布**（2026-08-24，`rdsh-gateway@0.4.0` + `dsh-web-remote@0.1.0`）—— 无剩余 P1 差距。

## 5. 追加验收（2026-09-01：R10 兼容模式开关 + R11 启动自动接入）

### RTTM 复核（追加）

| 需求 | 任务 | 状态 | 证据 |
|---|---|---|---|
| R10 兼容模式开关 | T13 | ✅ | `config.ts` `DshUiCompat`（默认 true）+ `join.ts` `patchLoopbackJs`/`isJsContentType`（fail-open）+ `bin.ts` 透传；`web-remote/src/index.ts` `set-ui-compat`/`state.uiCompat`/`uiCompatEnabled`；`client.js` 复选框（zh「端到端加密时，信任为本地访问（兼容模式）」/en） |
| R11 启动自动接入 | T14 | ✅ | `web-remote/src/index.ts` `autoConnect()` + 共用 `startTunnel()`；启动日志 `reusing persisted host token` → `state()` 返回 `connected` |

### 真实环境验证（lmxie 主机 ↔ hub rdsh.cn，2026-09-01）

- **兼容模式**：经隧道访问 DSH 设置 → Models 页 key 输入框出现（patch 生效）→ 保存 key → 聊天回复正常（完整链路 A 通过）；复选框勾选/取消即时生效（`set-ui-compat` → host.json + 运行中隧道内存 flag）。
- **自动接入**：停 CLI `rdsh host serve` → 直接 `dsh web --port 3180` → 日志 `rdsh join: reusing persisted host token` → RPC `state()` 返回 `{"status":"connected","name":"lmxie-dsh",...}`；dsh web 进程到 `rdsh.cn:443` ESTAB 连接确认；CLI 托管时（外部锁）自动接入跳过，面板保持 external 只读。
- **依赖链修复（环境性）**：DSH profile 的 pnpm 无法解析 `workspace:*` → 插件 tgz 依赖改写为 `file:` 指向 gateway/tunnel 打包 tgz；服务器访问 npmjs 只解析 IPv6 导致 Node fetch 挂起 → `~/.npmrc` 指向 npmmirror + `NODE_OPTIONS=--dns-result-order=ipv4first`。

### 新增差距

| # | 差距 | 严重度 | 处置 |
|---|---|---|---|
| G6 | 插件托管模式下 dsh web 为裸进程（非 systemd 服务），重启后需手动拉起 | P2 | 后置：做成 `rdsh-host` 同款 user service |
| G7 | `trustE2EEAsLoopback` 为 host 级开关（非按浏览器 E2EE 门控）——默认 true 时所有经隧道访问者获得 loopback 兼容 | P2 | 语义记录于内部 fix 文档（20260831-api-key-systemd-env）§5.4；共享 host 关闭该开关 |
| G8 | `patchLoopbackJs` 无函数级单测（真实环境已验证） | P3 | 随发布批次补单测 |

*关联文档：req.md | solution.md | plan.md*
