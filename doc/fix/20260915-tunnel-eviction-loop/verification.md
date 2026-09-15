# 同机双隧道互踢（tunnel eviction loop）：验证（verification）

> **日期**: 2026-09-15 ｜ 关联: [discussion.md](./discussion.md) · [solution.md](./solution.md) · 审查: [doc/review/20260915-join-lock-review.md](../../review/20260915-join-lock-review.md)

## 1. 测例（`packages/gateway/test/lock.test.ts`，9 例）

| 测例 | 覆盖的不变量 |
|---|---|
| acquire → read 往返 → release 清空 | 基本契约（含 release 后文件消失） |
| 他人活锁（pid 1）→ 拒绝且不覆盖 | 拒绝他人活锁 |
| stale 锁（已死 pid）→ read 视为无锁、**不删文件**；acquire 接管 | `readJoinLock` **纯读**（T2）+ compare-and-delete 接管 |
| 损坏 / 非法 role → read 返回 null | 纯读 + 解析健壮性 |
| **残锁：新鲜的不回收；过期的才回收** | 新鲜度保护（防误删并发写入者的半成品）+ 残锁回收不卡死 |
| release 不误删他人锁；重复 release 不抛 | release 幂等 + 不误删 |
| 同进程重复获取 → 拒绝；**锁文件被删后仍拒绝**；释放后可再获取 | `heldPaths` 记账（T4）——含"文件层已无从发现"的真案例 |
| **跨进程互斥：4 个进程同时抢同一把锁 → 恰好 1 个成功** | 原子发布 + 拒绝活锁的端到端保证（T1/T2） |
| **构造期抛错（`ftp://` 非法 WS 协议）→ 锁被释放、同进程可再获取** | `releaseLockAndRethrow`（T6）与 `heldPaths` 清理 |

## 2. 反向证明（去掉守卫必须失败）

| 守卫 | 撤销方式 | 结果 |
|---|---|---|
| `heldPaths` 进程内记账 | 删掉 `if (heldPaths.has(path)) …` | ❌「同进程重复获取…锁文件被删后仍拒绝」失败 |
| `readJoinLock` 纯读 | 恢复"读到 stale 就 `rmSync`" | ❌「stale 锁…read 不得有副作用」失败 |
| 残锁**新鲜度保护** | 删掉 `if (held === null && Date.now() - first.mtimeMs < FRESH_LOCK_MS) return;` | ❌「残锁：新鲜的不回收…」失败 |
| 原子发布（temp + `linkSync`） | 换回 `writeFileSync(path, data, {flag:"wx"})` | ⚠️ **无测例能抓**（见 §4 G1） |
| compare-and-delete 的 inode 比对 | 只比内容 | ⚠️ 无测例（需要 pid 复用 + 字节相同的 ABA，无法确定性构造，见 G8） |
| 不支持硬链接时的 `wx` 回退 | —— | ⚠️ 无测例（本机 APFS 支持硬链接，无法触发 EPERM/ENOTSUP，见 G9） |

## 3. 回归

- `pnpm build`：tsc strict **零 issue**（tunnel / hub / gateway / web-remote / cli / portal / agent-mesh）。
- `pnpm test`（并发跑各包，含满负载场景）：**278 通过 / 0 失败**
  （tunnel 12 · hub 120 · gateway 129 · web-remote 16 · agent-mesh 1）。
- 跨进程用例连跑多次稳定通过（607ms/次）；此前在满负载下抖动过一次，原因是**测试编排**（赢家打印后立刻退出 → 锁变 stale → 后续子进程合法接管，数到多个 OK），已改为"赢家持锁直到所有子进程尝试完"，并加了 `try/finally`（任何子进程失败都会 `SIGKILL` + 关 stdin + 清目录，不会把测试进程挂住）。

## 4. 未覆盖 / 已知缺口

| # | 项 | 说明 |
|---|---|---|
| G1 | 原子发布（temp + `link`）**无自动化测例** | 差异只在"我方写入者 vs 我方读取者"的微秒级交错中体现；依据：① 该窗口已用 `openSync(path,"wx")` + `acquireJoinLock` 复现（旧实现会把空文件当残锁删掉）；② 新实现结构性保证"目标一出现即带完整内容"；③ 撤销后 9 个测例仍全绿（已用 trace 确认） |
| G2 | 插件侧「锁冲突原因显示」无单测 | `packages/web-remote` 无 Ctx 测试宿主（既有缺口，非本次引入） |
| G3 | 真机端到端未复测 | 包**已发布**（gateway 0.8.5 / web-remote 0.5.4 / cli 0.10.6，双源与内容已核对，见 [summary.md](./summary.md) §发布）；仍需**重装插件**后在真机确认"第二个实例不再建隧道、面板显示原因" |
| G4 | 跨机同 token 场景不修 | 见 [discussion.md](./discussion.md) §4「残留」 |
| G5 | ~~新旧版本混跑 + 旧版正处于 `wx` 创建窗口~~ | **已由残锁新鲜度保护覆盖**：新鲜的非解析内容不再回收；残余代价：真正的"新鲜半截残锁"需要等过 1s 后重试才会被清掉 |
| G6 | `reapDeadLock` 的"比对 → unlink"仍有 1 个 syscall 宽度窗口 | 无 `flock` 时无法完全消除；inode 比对已消除同内容 ABA，窗口本身仍在 |
| G7 | `startJoin` 的「同进程」报错措辞无测例 | 需要 startJoin 级别的用例；若守卫回归，该用例会因遗留重连计时器**挂住**而不是干净失败（审查 R15 指出），故不加，只测锁层（`heldBy.pid === 自己`） |
| G8 | inode 比对（ABA）无测例 | 需要"pid 复用 + 内容字节相同"的构造，无法确定性复现 |
| G9 | 硬链接回退（`wx`）无测例 | 需要不支持 `link` 的文件系统（SMB/FUSE/exFAT）；本机无法触发 |

## 5. 真机现状（止血，非本修复的验证）

现场 3 个 `dsh web` 实例中 76005 / 63439 **交替**持隧道（源端口每 ~1.2s 递增），63408 从未建隧道（= 锁的正常路径赢家之外的那个）。
停掉 63439 / 63408 后：12s × 1s 采样 76005 源端口恒为 `57720`，互踢停止 ⇒ 证实"两条隧道互踢"的机理，但不能替代 G3。
