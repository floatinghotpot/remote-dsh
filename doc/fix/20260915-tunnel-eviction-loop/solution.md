# 同机双隧道互踢（tunnel eviction loop）：方案（solution）

> **日期**: 2026-09-15 ｜ 关联: [discussion.md](./discussion.md) ｜ 审查: [doc/review/20260915-join-lock-review.md](../../review/20260915-join-lock-review.md)

## Goal

**只改 host（`rdsh-gateway`）与插件（`dsh-web-remote`）**：保证同一台机器上最多只有一条 join 隧道。
不动 `rdsh-tunnel` 线协议、不动 hub、不升 tunnel 版本 ⇒ 兼容风险最低、发布面最小。

## Facts（改前代码，逐条核对）

| # | 事实 | 位置 |
|---|---|---|
| 1 | `acquireJoinLock` = `readJoinLock` → 判断 → `writeFileSync`（**非原子**），且 `held.pid === process.pid` 时直接放行 | `lock.ts:60-68` |
| 2 | `readJoinLock` 读到 stale 就**无条件 `rmSync`**（读与删之间无校验） | `lock.ts:40-47` |
| 3 | `writeFileSync(..., {flag:"wx"})` 会让锁路径出现"**存在但内容为空**"的瞬间 | `lock.ts:66` |
| 4 | 面板 `autoConnect` 只对 `role === "cli"` 让位；锁冲突时静默失败（面板只显示 disconnected） | `web-remote/src/index.ts:197-198`、`:207-209` |
| 5 | `lock.ts` 导出面：`acquireJoinLock` / `releaseJoinLock` / `readJoinLock` / `JOIN_LOCK_PATH`；调用方只有 `join.ts`（acquire/release）与 `web-remote`（read，用于「外部托管」显示） | 全仓 grep |

## Gap

1. 锁必须**原子发布**（文件与内容同时可见）、**拒绝任何活锁**（含本进程自己的 pid）、**清理走 compare-and-delete**；
2. 锁被占用时，面板必须给出原因（否则和修复前的"反复掉线"一样无法自查）；
3. 构造期抛错必须把锁还回去（否则该进程再也起不来隧道，还会谎报"本进程已有隧道"）。

## Tasks

| # | 文件 | 改动 |
|---|---|---|
| T1 | `packages/gateway/src/lock.ts` | `acquireJoinLock` 改**原子发布**：内容写临时文件 → `linkSync(tmp, path)`（`EEXIST` = 未获取，且目标一出现就带完整内容）→ `finally` 清理临时名；每次 `EEXIST` 后 `readJoinLock` 判活锁（**含自己 pid**）→ 拒绝；否则 `reapDeadLock()` 后重试，最多 3 次。文件系统不支持硬链接（EPERM/ENOSYS/ENOTSUP/EOPNOTSUPP）时**回退 `wx` 创建**（否则这些文件系统上隧道永远起不来） |
| T2 | 同上 | `readJoinLock` 改**纯读**（不再 `rmSync`；不存在/损坏/pid 已死 → `null`），清理统一交给 `reapDeadLock()`：读快照（内容 + `ino` + `mtimeMs`）→ 判活锁 → **纯内容解析不出来的、且很新（<1s）的不回收**（可能是并发写入者的半成品）→ compare-and-delete（内容 + **inode** 都没变才删，顺带消除同内容 ABA） |
| T3 | 同上 | `AcquireResult` 增 `{ok:false, contended:true}`：连续被抢占时**不伪造** `heldBy:{pid:自己}` |
| T4 | 同上 | `heldPaths: Set<string>` 进程内记账（同进程重复获取必须拦住；`releaseJoinLock` 同时清记账） |
| T5 | `packages/gateway/src/join.ts` | 锁冲突报错三分支：`contended` / 同进程（`another tunnel is already running in this process`）/ 他人（`join lock held by <role> (pid N); stop it first`） |
| T6 | 同上 | `releaseLockAndRethrow()`：构造期同步抛点（`loadOrCreateE2eeKeyPair`、`connect()`）失败时释放锁再抛 |
| T7 | `packages/web-remote/src/index.ts` | `autoConnect` 捕获到锁冲突（消息含 `join lock`）时写入 `lastMessage`，面板可见原因；其余失败仍静默 |
| T8 | `packages/gateway/test/lock.test.ts` | 测例：纯读无副作用（stale/损坏文件保留）、acquire 接管 stale、坏/空残锁可清理、同进程重复获取（含"锁文件被删后仍拒绝"= `heldPaths` 真案例）、`release` 幂等不误删、**跨进程互斥（4 进程抢锁恰好 1 个成功）** |

## 不做（本轮，明确理由）

| 项 | 理由 |
|---|---|
| hub 顶替前发"被接管"信号（隧道级 CLOSE 4090）+ 协议文档 + `rdsh-tunnel` 常量 | 只服务"跨机同 token"罕见场景；代价含协议变更、tunnel 版本升级、hub 部署、发布脚本调整，且引入"依赖新常量的启动崩溃"风险；已实现并审查后**主动放弃**（见 discussion §4） |
| gateway 新增 `"replaced"` 状态 / 插件状态映射 | 随上一项一并去掉 |
| `autoConnect` 对他人 role 的统一让位策略、同机双实例"自动择一" | 需求未定；原子锁已保证不双隧道 |
| CLI `rdsh host join` 在锁冲突时的退出语义（systemd 假 active） | 与本次因果无关，单独议 |

## 兼容性

| 维度 | 结论 |
|---|---|
| 线协议 | **零变化**（不新增/修改任何帧；gateway→hub、hub→gateway 字节都不变） |
| 旧 hub / 旧 host | 无感；新旧混跑时，新旧双方都拒绝"他人 pid 的活锁"，只是旧版的原子性差一些（窗口更小但仍存在） |
| 发布面 | 只需 `rdsh-gateway` + `dsh-web-remote`；**不需要**升 `rdsh-tunnel`、**不需要**改 `scripts/publish.sh`、**不需要**重新部署 hub |
| 锁文件格式 | 不变（`{pid, role}`）；新增的临时文件 `${path}.<pid>.tmp` 在 `finally` 中清除 |
| 平台前提 | 依赖 `linkSync`（硬链接）；本地 home（APFS/ext4/NTFS）均支持。不支持硬链接的文件系统会**快速失败**并报错（不静默降级到有竞态的写法） |

## 已知残留

1. **跨机同 token**（复制/共享整份 `~/.rdsh`）：两台机器会同 hostId 互相顶替，本方案不处理（discussion §4）。
2. `reapDeadLock` 的"比对 → unlink"仍有 1 个 syscall 宽度的窗口（无 `flock` 时无法完全消除；同内容 ABA 已由 inode 比对消除）。
3. 真正的"新鲜半截残锁"（<1s）不会被立即回收：要等过了保护期再重试才清掉 ⇒ 表现为一次 `contended` 提示，而不是静默接管（**有意的失败关闭**；换来的是不误删并发创建者的锁）。
4. pid 存活判定在"`~/.rdsh` 跨主机共享"（NFS/同步 home）时无意义：可能回收他机的活锁。修法是锁里记 `hostname`，本轮不做。
5. 崩溃可能在 `~/.rdsh/` 留下 `join.lock.<pid>.tmp`（正常路径由 `finally` 清除；同 pid 复用同名，不会无界增长）；临时文件名可预测、写入用覆盖 flag —— 能写 `~/.rdsh` 的人本来就能改锁，故不额外加固（审查 N7）。
6. `heldPaths` 以**原始路径字符串**为键：同一文件的两种写法（相对/绝对、符号链接目录）会绕过进程内记账，但文件层仍会拒绝（`link` EEXIST → 活锁是自己 pid）⇒ 不会双隧道。仓内两个调用方都传 `undefined`（同一常量），当前不可达（审查 N9）。
