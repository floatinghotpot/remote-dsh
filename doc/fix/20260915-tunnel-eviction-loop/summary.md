# 同机双隧道互踢（tunnel eviction loop）：结果（summary）

> **日期**: 2026-09-15 ｜ 关联: [discussion.md](./discussion.md) · [solution.md](./solution.md) · [verification.md](./verification.md)

## 做了什么

**一次修复、一个用户可见结果**：同一台机器上只允许一条 join 隧道，`dsh-web-remote` 面板不再反复掉线/连线。

| 文件 | 改动 |
|---|---|
| `packages/gateway/src/lock.ts` | 锁**原子发布**（临时文件 + `linkSync`，消除"存在但内容为空"的窗口）；`readJoinLock` 改**纯读**；残锁清理走 **compare-and-delete（内容 + inode）**，且**新鲜（<1s）的半截文件不回收**；不支持硬链接的文件系统回退 `wx`；拒绝任何活锁（**含本进程自己的 pid**）+ `heldPaths` 进程内记账；连续被抢占时报 `contended`（不伪造持有者） |
| `packages/gateway/src/join.ts` | 锁冲突报错三分支（contended / 同进程 / 他人）；`releaseLockAndRethrow()` 保证构造期抛错时把锁还回去 |
| `packages/web-remote/src/index.ts` | `autoConnect` 遇锁冲突时把原因写进面板消息（否则只会显示"一直 disconnected"） |
| `packages/gateway/test/lock.test.ts` | 9 例，含**跨进程互斥**（4 进程抢锁恰好 1 个成功）、`readJoinLock` 纯读断言、残锁新鲜度、构造期抛错后锁释放 |

**范围**：只动 host + 插件。线协议零变化，**不升 `rdsh-tunnel`、不改发布脚本、不重新部署 hub**（理由与放弃的方案见 [discussion.md](./discussion.md) §4）。

## 结果

- `pnpm build`：零 issue；`pnpm test`：**278 通过 / 0 失败**（gateway 129，含新增 9 例锁测例）。
- 反向证明：删掉 `heldPaths` 守卫 → 同进程用例失败；恢复"读到 stale 就删" → 纯读断言失败；删掉残锁新鲜度保护 → 新用例失败。
- **两轮独立对抗性审查**（含针对重写实现的第二轮复审）发现的缺陷已逐条处置；未覆盖项与"接受不修"的 nit 均记入 [TODO.md](./TODO.md) 与审查记录。
- 真机证据（改前）：两个 `dsh web` 交替连 rdsh.cn，源端口每 ~1.2s 递增；锁文件只记一个 pid 却有两条隧道。

## 生效方式

重装插件即可（`dsh-web-remote` 精确锁定 `rdsh-gateway`，插件升级会带上新 gateway）：**不需要**部署 hub、不需要动 tunnel。

## 遗留

见 [TODO.md](./TODO.md)。
