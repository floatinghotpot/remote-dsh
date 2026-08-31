# 06-dsh-plugin — 总结（summary.md）

> **日期**: 2026-08-24
> **范围**: M4 —— DSH 插件形态的远程访问（`dsh-web-remote`）+ gateway join 核心重构

---

## 完成内容

### gateway（`rdsh-gateway@0.3.0 → 0.4.0`）

- **`join.ts` 重构**：拆出 `startJoin(target, opts, hooks) → JoinHandle`（no-spawn、外部 target、`stop()` 句柄、`onState`/`onLog` 钩子）；`join()` 保留为 CLI 薄封装（spawn dsh + 信号退出 + `startJoin(role:"cli")`）。CLI 唯一调用点 `bin.ts:326` 签名不变，**零回归**。
- **新增 `lock.ts`**：pid 锁 `~/.rdsh/join.lock`（`{pid, role}`，stale 自动清除）——`acquireJoinLock`/`releaseJoinLock`/`readJoinLock`，强制 CLI 与插件同机单隧道（D5 档2）。
- **导出**：`startJoin`/`JoinState`/`JoinHooks`/`StartJoinOptions`/`JoinHandle` + lock API，全部从 `index.ts` 导出。

### 插件包 `packages/web-remote`（npm `dsh-web-remote@0.1.0`）

- `package.json`（`dsh.bundle.patch` + `dsh.client`）、`cordis.patch.yml`（服务端行既是 server 挂载、也让 client 被扫描）。
- **server 半** `src/index.ts`：Cordis 函数插件（`inject=["connection","webServer"]`），`connection.rpc.handle("/remote-access", …)` 挂 `connect/disconnect/revoke/state`；`webServer.port` 取端口转发到本进程 dsh；含 D5 档1（mode-conflict）+ 档2（lock-busy）检测。
- **client 半** `client.js`：module-loader 工厂格式，`ctx.slots.inject("settings.section", …)` 挂 React 面板（状态点 + 表单 + 接入/断开/注销，1s 轮询 `state`）。
- **UI 打磨**（冒烟期反馈迭代）：DSH locale i18n（zh/en，`ctx.locale.bind/register`）、DSH 设计令牌对齐（`--dsw-alias-*` 胶囊按钮/输入框）、每状态提示文案（connected 态带可点击 hub URL）、已保存令牌 `••••••••` 遮罩（断开态留空即复用）。

### 测试 / 文档

- 新增单测：`test/lock.test.ts`（5 例）+ `test/join-core.test.ts`（2 例）。全量 `pnpm build` 绿、`pnpm test` **114/0**。
- **真实 DSH 冒烟通过**（2026-08-24，用户本机）：`dsh plugin add` → 面板出现 → 接入 `hub.example.com`「已连接」→ 断开/注销；i18n/主题对齐。
- CHANGELOG（en/zh）加 `[Unreleased]` 条目；roadmap/README 遵守命名纪律（实现前不泄全名）。
- Feature Pipeline：discussion → req（已批准）→ solution（已批准）→ plan → verification → summary → TODO 齐全。

## 状态

全部完成并发布（2026-08-24）：`rdsh-gateway@0.4.0` + `dsh-web-remote@0.1.0` 上线 npm；`dsh plugin --profile web add dsh-web-remote` 验证通过。[TODO.md](TODO.md) 为空。

## 追加（2026-09-01：R10/R11，未发布）

### gateway（`rdsh-gateway@0.5.0`，未发布）

- **`config.ts`**：`DshUiCompat { trustE2EEAsLoopback?: boolean }`（默认 true）+ 校验；`RdshConfig.dshUiCompat`。
- **`join.ts`**：`makeInnerDispatcher` 增 `jsPatch` 钩子 —— plain 流 JS 响应经 `patchLoopbackJs`（`isLoopbackHostname(pageLocation.hostname)` → `true`，fail-open）；`startJoin` 读 `dshUiCompat`；`JoinHandle.setUiCompat()` 运行中即时切换。**实现偏差**：patch 落 plain 流（JS bundle 明文）而非 E2EE raw 流（设计见内部 fix 文档 20260831 §5.4）。
- **`cli/src/bin.ts`**：join 模式透传 `dshUiCompat`。

### 插件包 `dsh-web-remote@0.2.0`（未发布）

- **server 半**：`set-ui-compat` RPC（写 host.json + 内存 flag + 运行中隧道即时生效）；`state().uiCompat`；**启动自动接入** `autoConnect()`（join 模式 + 持久化 token + 无 CLI 锁 → 复用 token 自动建隧道）；`connect`/`autoConnect` 共用 `startTunnel`。
- **client 半**：复选框「端到端加密时，信任为本地访问（兼容模式）」（默认开；external 态隐藏）；i18n zh/en。
- **真实环境验证通过**（lmxie ↔ rdsh.cn，2026-09-01）：Models key 流程 + 自动接入开机即连。

*关联文档：discussion.md | req.md | solution.md | plan.md | verification.md*
