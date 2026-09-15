# 同机双隧道互踢（tunnel eviction loop）：TODO

> 机械提取自 [solution.md](./solution.md)「不做」/「已知残留」与 [verification.md](./verification.md)「未覆盖」。
> **本文件非空 = 本次修复未完全收口**，由人决定关闭 / 延期 / 放弃。

## 本轮不做（solution.md）

| # | 项 | 理由 |
|---|---|---|
| ⏭️ | hub 顶替前发「被接管」信号（隧道级 CLOSE 4090）+ 协议文档 + `rdsh-tunnel` 常量 | 只服务"跨机同 token"罕见场景；代价含协议变更、tunnel 版本、hub 部署、发布脚本，且引入启动崩溃风险。实现与审查记录保留在 [doc/review/20260915-join-lock-review.md](../../review/20260915-join-lock-review.md) |
| ⏭️ | gateway `"replaced"` 状态 / 插件状态映射 | 随上一项回退 |
| ⏭️ | `autoConnect` 对他人 role 的统一让位、同机双实例「自动择一」 | 需求未定；原子锁已保证不双隧道 |
| ⏭️ | CLI 锁冲突时的退出语义（systemd 假 active） | 与本次因果无关，单独议 |

## 已知残留（solution.md）

| # | 项 | 说明 |
|---|---|---|
| ⏭️ | 跨机同 token（复制/共享整份 `~/.rdsh`）仍会互相顶替 | 本次明确接受 |
| ⏭️ | 新旧版本混跑 + 旧版正处于 `wx` 创建窗口的微秒级交错 | 原子发布只保证自己不再产生该窗口 |
| ⏭️ | `reapDeadLock` 比对→unlink 的 syscall 宽度窗口 | 无 `flock` 无法完全消除 |
| ⏭️ | `~/.rdsh` 跨主机共享（NFS/同步 home）时 pid 存活判定无意义 | 修法：锁里记 `hostname`，本轮不做 |
| ⏭️ | 崩溃可能残留 `join.lock.<pid>.tmp`；临时名可预测、用覆盖 flag（复审 N7） | 利用前提是"已能写 `~/.rdsh`"；正常路径由 `finally` 清除 |
| ⏭️ | `heldPaths` 以原始路径字符串为键，两种写法可绕过进程内记账（复审 N9） | 文件层仍会拒绝 ⇒ 不会双隧道；仓内调用方都传同一常量，当前不可达 |
| ⏭️ | 新鲜（<1s）半截残锁不立即回收 ⇒ 表现为一次 `contended` 提示 | **有意的失败关闭**（换取不误删并发创建者的锁） |

## 未覆盖（verification.md）

| # | 项 | 说明 |
|---|---|---|
| ⏭️ | G1 原子发布无自动化测例 | 无法确定性构造微秒级交错；不写会抖的测试 |
| ⏭️ | G2 插件侧「锁冲突原因显示」无单测 | `packages/web-remote` 无 Ctx 测试宿主 |
| ❌ | G3 真机端到端复测 | **阻塞**：需重装插件（新版本发布后）才能复现同一场景 |
| ⏭️ | G8 inode 比对（ABA）无测例 | 需"pid 复用 + 内容字节相同"的构造，无法确定性复现 |
| ⏭️ | G9 硬链接回退（`wx`）无测例 | 需不支持 `link` 的文件系统（SMB/FUSE/exFAT），本机无法触发 |
