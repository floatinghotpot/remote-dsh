# Bug 报告：显式 `--token` 被拒时静默无限重连（应 fail-fast）

> **日期**: 2026-08-24
> **严重度**: P3（体验/可观测性缺陷，非安全漏洞）
> **影响组件**: rdsh-gateway（`packages/gateway/src/join.ts`）
> **发现环境**: 代码走查（`fix(join): persist host token` 提交后）
> **来源**: 评审发现：`rdsh join --token <bad>` 被 hub 拒绝后进程一直重试、无明确报错、不退出

---

## 1. 现象（症状）

- `rdsh join <hub-url> --token <失效/被吊销的 token>`：hub 返回 401，进程**不退出**，反复打印
  `rdsh join: tunnel lost — reconnecting in Ns...`，指数退避到 60s 后无限循环；
- 日志误导：报的是 "tunnel lost"（网络断），实为 **token 被拒**（401），操作者无法区分；
- 脚本化/systemd 场景下表现为「进程看起来在跑、其实早已失效」，无任何可观测的失败信号。

## 2. 复现步骤

1. `rdsh hub host revoke <hostId>` 吊销某 host（或随手编一个不存在的 token）；
2. `rdsh join <hub-url> --token <该 token> --insecure`；
3. 观察：打印若干次 `tunnel lost — reconnecting...`，进程常驻不退出。

## 3. 根因（代码事实）

- `join.ts` 的 `connect()` close 处理器：仅当 `tokenRejected && opts.token === undefined`
  才回退重配对；**显式 `--token`（`opts.token !== undefined`）落到普通重连分支**：
  `console.log("tunnel lost ...")` + `setTimeout(connect, delay)` → 无限重连同一个死 token。
- **token 被拒是永久失败**：hub `handleBind` 每次 `randomToken()` 新建 token（`api.ts:335`），
  被吊销的旧 token 永远不可能再通过 `findHostByTokenHash`（`server.ts:230`）——重试无意义。
- 对比：网络错误（ECONNREFUSED/TLS/超时）是**瞬时失败**，无限退避重连是正确行为。

## 4. 影响

| 项 | 影响 |
|---|---|
| 可观测性 | 脚本化/自动化拿不到失败信号（进程常驻、日志误导），故障被静默掩盖 |
| 运维 | systemd `Restart=always` 下无感知；人工排查时无法快速判断是 token 失效还是网络问题 |
| 安全 | **无安全漏洞**：行为变化仅限「失败时退出」，不涉及 token 处理边界 |

## 5. 修复方案（推荐 + 已采用）

- **区分失败类型**：`unexpected-response` 401/403 = token 被拒（永久）→ **fail-fast**；
  其余（网络/TLS）仍走原有指数退避重连（瞬时）。
- close 处理器改为：
  - `tokenRejected && opts.token === undefined`（持久化 token）→ 删旧文件 + 回退配对码（保持不变）；
  - `tokenRejected && opts.token !== undefined`（显式 `--token`）→ 打印明确错误 + 停 dsh + `process.exit(1)`。
- `shutdown(signal, code = 0)` 增加退出码参数，供 fail-fast 以非零码退出。

## 6. 验收标准

1. `rdsh join --token <坏 token>` → 打印 `host token rejected by hub (revoked or removed)`，进程**非零退出**（不再无限重连）；
2. 正常（有效）`--token` 不受影响：隧道建立、断网（网络错误）仍指数退避重连；
3. 持久化 token 被吊销仍**自动回退配对码**（回归上一 bugfix，`spike/e2e-join-persist.sh`）；
4. 回归：`pnpm test` 全绿。

## 7. 参考

- 相关代码：`packages/gateway/src/join.ts`（`connect()` close 处理器、`shutdown()`）、`packages/hub/src/server.ts`（`handleTunnelUpgrade` 401）、`packages/hub/src/api.ts`（`handleBind` randomToken）
- 关联修复：`doc/fix/20260824-join-token-persist/`（host token 持久化，本 bug 为其评审后续）
