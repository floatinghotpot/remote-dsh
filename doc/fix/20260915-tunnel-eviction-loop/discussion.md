# 同机双隧道互踢（tunnel eviction loop）：根因（discussion）

> **日期**: 2026-09-15
> **现象**: `dsh-web-remote` 面板（VS Code 里的 DSH 设置 → Remote Access）状态**反复** `disconnected → connecting → connected → disconnected`，停不下来。
> **结论**: **同机两条隧道在互相顶替**。两个 `dsh web` 实例（76005 / 63439）都跑着本插件、都为同一个 host（`iMacPro`）连着 rdsh.cn；hub 的隧道注册表按 hostId 只留一条，新连接注册时**静默 `terminate()` 旧连接** ⇒ 旧连接把它当普通掉线、退避重连、再把新的顶掉 ⇒ 无限互踢。
> **为什么锁没拦住**: `~/.rdsh/join.lock` 是「同机单隧道」的唯一闸门，但它有三个洞：① `exists → write` **非原子**（两实例同时启动都能通过检查）② **同 pid 重复获取被放行**（插件热重载 = 同进程二次 startJoin）③ 清理旧锁时**读→删之间无二次校验**，以及"已创建未写入"的空文件会被当成坏锁删掉。
> **范围决定**: 只修 host（gateway）+ 插件 —— 见 §4。

---

## 1. 现场证据（真机实测，2026-09-15 10:20）

| # | 事实 | 证据 |
|---|---|---|
| **E1** | 两个 `dsh web` 实例同时持有到 rdsh.cn 的隧道，且**源端口每 ~1.2s 换一次** | `lsof -a -p <pid> -nP -iTCP` 采样：`node 63439 → :57212`、`node 76005 → :57213`、`:57214`、`:57215`… 交替出现（0.4s × 10s） |
| **E2** | 锁文件只记一个持有者，而隧道有两条 | `~/.rdsh/join.lock` = `{"pid":76005,"role":"plugin"}`（写于 09:38:44），但 63439 也在建隧道（E1）⇒ 锁被覆盖 |
| **E3** | 触发点：插件 09:34 重装（`patchReload: "live"`）让多个运行中的实例同时重载插件、同时 `autoConnect()` | `~/.dsh/profiles/web/package.json`（安装时间 09:34:04） |

采样片段（同一时刻两个 pid 都在 ESTABLISHED）：

```
10:20:51.473  node 63439 :57214->114.55.237.83:443 (ESTABLISHED)
10:20:51.473  node 76005 :57213->114.55.237.83:443 (ESTABLISHED)
```

**止血（已执行）**: 停掉多余的 63439 / 63408，保留 76005；12s 采样源端口恒为 `57720`，互踢停止。

## 2. 代码事实

| # | 事实 | 证据 |
|---|---|---|
| **F1** | hub 顶替旧连接 = **静默 `terminate()`**，不给任何"被接管"信号 | `packages/hub/src/tunnel.ts:255-261`（本次**不改**，见 §4） |
| **F2** | gateway 把**任何**断开都当可恢复：退避重连，且 `open` 时把退避**重置**回 1s ⇒ 互踢永不收敛 | `packages/gateway/src/join.ts:993-1000`、`:935` |
| **F3** | 锁是**读-判断-写**三步，非原子；同 pid 直接放行 | `packages/gateway/src/lock.ts:60-68`（改前） |
| **F4** | 清理 stale 锁时**读→`rmSync` 之间无二次校验** ⇒ 可能删掉别人刚建立的新锁 | `packages/gateway/src/lock.ts:40-47`（改前） |
| **F5** | `writeFileSync(path, data, { flag: "wx" })` 存在"文件已存在但内容为空"的窗口 ⇒ 并发清理者会把它当坏锁删掉 | `packages/gateway/src/lock.ts:66`（改前） |
| **F6** | 插件自动接入只对 `role === "cli"` 让位，另一个**插件实例**持有锁时照样起隧道 | `packages/web-remote/src/index.ts:197-198` |

## 3. 为什么"只改 host/plugin"就够

**互相顶替的前提是 hostId 相同**。hostId 由 hub 在注册时 `randomUUID()` 生成（`packages/hub/src/api.ts:1468`），`name` 只是展示字段、不参与任何键（`db.ts:202-209` 里唯一的唯一键是 `token_hash`）。所以：

- 两台机器各用自己的 join token 注册 → **两个不同 hostId，永不互相顶替**（哪怕都叫 `iMacPro`）；
- 能撞成同一 hostId 的只有"**同一个 host token 被两处使用**"：同一台机器上的多个 `dsh web`（共享 `~/.rdsh`，**本次真机问题**），或把整份 `~/.rdsh` 复制/共享到第二台机器（罕见，见 §4 残留）。

而"同机最多一条隧道"这件事，完全由 host 侧的锁决定 —— 锁一旦成立，第二个实例**根本不会建立隧道**，hub 也就永远不会触发顶替。⇒ **修锁即可，不需要动协议、hub 或 tunnel 包。**

## 4. 范围决定：不做协议/ hub / tunnel 改动

初版方案曾扩展为"hub 顶替前先发隧道级 CLOSE 4090，接收方停止重连"（见 [doc/review/20260915-join-lock-review.md](../../review/20260915-join-lock-review.md) §4）。**已放弃**，理由：

1. 它只为"跨机同 token"这一罕见场景服务，而该场景不覆盖本机的真实问题；
2. 代价是协议变更 + `rdsh-tunnel` 版本升级 + hub 重新部署 + 发布脚本调整，还引入了一个**依赖 tunnel 新常量的启动崩溃风险**（发布耦合）；
3. 审查中它自身又暴露了两个缺陷（底 timer 丢帧、被顶替后不收尾），收益/成本明显不划算。

**残留（明确接受）**: 若把 `~/.rdsh`（host.json + `join-<hub>.token` + join.lock）复制/共享到第二台机器，两台会同 hostId、互相顶替，且本方案不做"被顶替即停"。此场景需要人为复制/共享，罕见；要处理时应作为独立改动重新评估（设计细节留在上述 review 记录里）。
