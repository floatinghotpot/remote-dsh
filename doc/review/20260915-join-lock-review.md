# 审查记录：同机双隧道互踢（tunnel eviction loop）修复（2026-09-15）

> **范围**: 工作区未提交改动 = `packages/tunnel`（协议 + 常量）、`packages/hub`（顶替信号）、`packages/gateway`（状态机 + 锁）、`packages/web-remote`（面板映射）+ 3 个测试文件
> **方法**: ① 我逐行自审 ② 两个独立 reviewer 并行对抗性审查（无本会话上下文，只看仓库与 diff）③ 我**逐条复核** reviewer 结论后才采信（不直接转述）
> **关联**: [20260915-tunnel-eviction-loop](../fix/20260915-tunnel-eviction-loop/discussion.md)

## 0. 结论摘要

| 判定 | 内容 |
|---|---|
| 修复主线 | 成立：hub 顶替先发 4090、gateway 收到即停、锁原子化 + 进程内记账；反向证明（撤销守卫必失败）两条都过 |
| **必修（复核确认）** | **D1** 4090 后 gateway **不做收尾** → 僵尸隧道 + `stop()` 永久失效（P1，端到端复现）<br>**D2** 锁的 stale/损坏清理**非 CAS**（`readJoinLock` 无条件 `rmSync`；`clearDeadLock` 会删并发创建者的空文件）→ 仍可能双持锁（P1，确定性复现）<br>**D3** hub 兜底 timer 早于 4090 帧刷出 → 重背压下丢帧、互踢继续（P1/P2，stub 复现）<br>**D4** 构造期同步抛错 → 锁泄漏 + `heldPaths` 永久污染 + 误导报错（P2，复现） |
| 其余 | P2/nit 共 9 条（见 §2、§4.1、§4.2） |

## 1. 事实（带 file:line）

| # | 事实 | 证据 |
|---|---|---|
| F1 | `clearDeadLock` 对「0 字节 / 非法 JSON」的锁文件执行 compare-and-delete | `packages/gateway/src/lock.ts:70-88` |
| F2 | 锁文件由 `writeFileSync(path, data, { flag: "wx" })` 发布 ⇒ **open→write 之间存在"文件已存在但内容为空"的窗口** | `packages/gateway/src/lock.ts:104-105` |
| F3 | 改前代码**从不删除**非法内容的锁文件（只删 pid 已死的合法锁）⇒ 该窗口由本次改动引入 | `readJoinLock`（`lock.ts:35-52`）、`git show HEAD:packages/gateway/src/lock.ts` |
| F4 | `startJoin` 在 `acquireJoinLock`（`:378`）之后到返回 handle（`:1042`）之间的构造段若同步抛错，锁文件与 `heldPaths` 都不会释放 | `packages/gateway/src/join.ts:378,1042`；唯一自身 `throw` 在 CLI 包装 `join()`（`:1050`，不在 startJoin 内） |
| F5 | 收到 4090 后 gateway 只置 `shuttingDown` + 释放锁，不主动关自己的 socket（等 hub 关，hub 有 1s 兜底 terminate） | `packages/gateway/src/join.ts:899-902`；`packages/hub/src/tunnel.ts:173-174` |
| F6 | hub 每次 `register()` 后都推 `host.online`（顶替场景下 host 本已在线）；`host.offline` 已被 `isOnline` 抑制 | `packages/hub/src/server.ts:351-352`、`:345-349` |

## 2. 缺陷（按严重度）

### P1-① `clearDeadLock` 可偷走并发创建者的锁（本次改动引入）

- **场景**: 进程 A `wx` 创建锁文件成功、内容尚未写入（µs 级窗口）；进程 B 此刻 `wx` 失败 → `readJoinLock` 读到空内容 → 判为"损坏" → `clearDeadLock` 删除 A 的文件 → B 重试 `wx` 成功。**A、B 都认为自己持锁** → 同机双隧道 → 正是本次要修的现象。
- **复现（确定性，已跑）**: 用 `openSync(path, "wx")` 模拟"已创建未写入"，再调 `acquireJoinLock`：

  ```
  B acquire: {"ok":true}
  锁文件内容: {"pid":81102,"role":"plugin"}
  结论: ❌ B 抢到了锁 —— A 仍以为自己持有（双隧道）
  ```
- **概率**: 需要 B 的 `open()` 落在 A 的 `open→write` 窗口内（µs 级）⇒ 单次并发启动约 1e-6~1e-4；但插件热重载/多实例同时启动正是"同一毫秒内并发"的场景，且**失败是静默的**（正好破坏本次要建立的不变量）。
- **建议修复（推荐 A）**:
  - **A. 原子发布"内容 + 文件"**：写临时文件 → `linkSync(tmp, path)`（目标存在则 `EEXIST`，且目标**一出现就带完整内容**，不存在空文件窗口）→ `finally rmSync(tmp)`。已在本机 APFS 实测：首次 link 成功、第二次 `EEXIST`、删 tmp 后锁仍在。
  - **B. 最小改动**：`clearDeadLock` 拒绝删除 0 字节文件（失败关闭，但极端情况下需人工删文件，且报错误导）。
- **附带收益**: 采用 A 后，"非法内容"只可能来自人工编辑/磁盘损坏，语义不再与"并发创建者"混淆。

### P1-⑨ 4090 之后不做收尾 → 僵尸隧道 + `stop()` 永久失效（**D1**，外部 reviewer ② 发现，我已端到端复现）

- **场景**: 对端发了 4090 但没（或没能）完成 WS close。此时 gateway 已 `shuttingDown = true`（`:899`），而 `stop()` 在 `shuttingDown` 时**直接 return**（`join.ts:1030`）⇒ 任何后续 `stop()`/`dispose()` 都无效；心跳 `setInterval`（`join.ts:945`，**未 unref**）与在途 http/ws 流（只在 close 回调里 `cleanupStreams()`）继续存活。web-remote 又把 handle 置 null（`index.ts:100`）⇒ 连"断开"按钮都救不回来。
- **复现（我的端到端脚本，WSS 发 4090 后故意不关连接）**:

  ```
  states: ["connecting","connected","replaced"]
  被顶替后仍收到的 PING 数: 5 ← 心跳仍在跑（僵尸）
  调用 stop() 后对端是否看到连接关闭: 否 ❌ stop() 未能收尾
  stop() 后是否还在发 PING: 是 ❌ 完全没停下来
  ```
- **可达性**: 仓内 hub 有 1s 兜底关连接（但该兜底本身在重背压下会丢帧，见 D3），代理/未来 Go hub 不保证；一旦发生即"不可停"。
- **建议修复**: 命中 4090 后由 gateway 自己收尾——`cleanupStreams(); try { (from ?? currentClient)?.close(4090,"replaced") } catch { currentClient?.terminate() }`；并让 `stop()` 在 `shuttingDown` 为真时仍 `terminate()` 连接。

### P1-⑩ 锁的清理不是 CAS（**D2**，外部 reviewer ② 发现，与我 P1-① 同族）

- **场景 A（stale 误删，来自既有 `readJoinLock`）**: 存在 stale 锁（崩溃/重启后启动，正是两个守护进程同时抢锁的时刻）：A、B 都 `wx`→EEXIST；B `readJoinLock` 读到 stale 内容后**被抢占**；A 删 stale → `clearDeadLock` ENOENT → 第 2 次 `wx` 成功；B 恢复后执行 `rmSync`（`lock.ts:41-46`，**无二次校验**）删掉了 A 刚建立的锁 → B 第 2 次 `wx` 也成功 ⇒ **双持锁**；第三个进程也能趁文件缺失抢进来。
- **场景 B（空文件窗口）**: 我的 P1-①（`writeFileSync(wx)` 的 open→write 窗口 + `clearDeadLock` 把 `""` 当可删）——同一族的另一半。
- **建议修复（一次解决 A+B）**: ① `readJoinLock` 改为**纯读**（不再 `rmSync`；面板只需要 `null`），删除统一由 `clearDeadLock` 的 compare-and-delete 负责（它已能处理 "dead pid" 与 "非法内容" 两类）；② 锁文件用**临时文件 + `linkSync`** 原子发布"文件+内容"（`EEXIST` = 未获取），彻底消除空文件窗口。
- **残余**: `clearDeadLock` 的 "读→比对→unlink" 仍有一个 syscall 宽度的窗口（无 `flock` 时无法完全消除），记录在案。

### P2-⑪ 构造期抛错 → 锁泄漏 + 后续报错误导（**D4**，本次改动放大）

- **场景**: `acquireJoinLock` 成功后、`startJoin` 返回前同步抛错 → 锁文件残留、`heldPaths` 残留 → 同进程再次 `startJoin` 一律得到 `another tunnel is already running in this process`（**改前**同 pid 会放行、可重试恢复）。
- **复现（已跑）**:

  ```
  round 1: throw → Invalid URL: ws:// bad-url with spaces/tunnel
    锁文件: {"pid":81555,"role":"plugin"}
  round 2: throw → another tunnel is already running in this process
  ```
- **可达性（诚实评估）**: 我用的是"HTTP 也会拒"的 URL，实际调用方通常会先在 `registerJoin` 失败，所以**今天很难触发**；reviewer ② 补充了另一条真实抛点——`loadOrCreateE2eeKeyPair()` 里的 `generateKeyPair()`/`serializeKeyPair()` 在其内部 try **之外**（`e2ee-key-store.ts:34-35`），故并非"绝不抛"。定级 P2 的理由是"不变量缺口"而非当下可复现。
- **建议修复**: 把 `acquire` 之后到 `return` 的构造段包进 `try { … } catch (err) { releaseJoinLock(opts.lockPath); throw err; }`（4 行），或把 `acquireJoinLock` 挪到 `connect()` 之前最后一步。

### P2-③ 被顶替后不自关连接（并入 **D1**）

- 与 P1-⑨ 同因：命中 4090 后不 `cleanupStreams()`、不关 socket。

### P2-④ 测试标题与覆盖不符

- `packages/hub/test/tunnel-replaced.test.ts` 第二个用例名为「旧连接已断开时注册不应抛错（快照竞态）」，实际只覆盖"硬断 → 重新注册"；真正的 register × close 竞态由 `tunnel-reconnect.test.ts` 覆盖。建议改名，或补真正的竞态用例。

### nit-⑤ 文档行号偏差（自查发现，记录自身准确性）

- `discussion.md` F2 引用 `join.ts:935` → 实际 `:941`；`solution.md` T7 引用 `:979` → 实际 `:985`。

### nit-⑥ hub 顶替路径重复推 `host.online`

- 每次 `register()` 都推 `host.online`（`server.ts:351-352`），顶替时 host 已在线 ⇒ 门户收到重复 online（offline 已被抑制，幂等，无功能影响）。**非本次引入**。

### nit-⑦ `replaced()` 的 1s 兜底 timer 从不 clear —— **已被 R1 推翻，见 §4.1**

- 原判断"无功能影响"**错误**：兜底不只是在握手完成后空跑，它在**入口**就武装，重背压下会先 `terminate()` 把 4090 帧丢掉（§4.1 R1，已独立复现）。

### nit-⑧ CLI 对 `replaced` 的呈现弱于 `rejected`

- `join()` 的 `onState` 只打印 `rejected`；`replaced` 仅通过 `onLog` 输出一行、进程不退出（都有输出，不影响可用性）。

## 3. 已验证正确（重点项）

| 项 | 证据 |
|---|---|
| 顶替信号顺序：先帧后关 | `hub/src/tunnel.ts:150-174`（`ws.send(frame, cb)` 的 cb 里才 `close`）+ `tunnel-replaced.test.ts` 断言帧先到 |
| 旧 host 兼容（不会崩） | 旧 `handleFrame` CLOSE/ERROR → `plainDispatcher` → `closeStream(0)` → 两个 map 均 undefined ⇒ no-op（改前 `join.ts:697-702` + `467-483`） |
| 旧 hub 兼容 | 旧 hub 只发 `streamId 0` 的 `ERROR`（`tunnel.ts:205`）→ 新端 ERROR 分支只记日志 |
| `streamId 0` 无其它发送者 | 全仓 grep：仅 hub 协议错误路径；hub 收到未知 stream 的 CLOSE/ERROR 也是 no-op（`hub/src/tunnel.ts:245-261`） |
| 不误伤新隧道 | `unregister(hostId, conn)` 身份校验 + `isOnline` 抑制 offline（`server.ts:342-349`），`tunnel-reconnect.test.ts` 覆盖 |
| 来源连接守卫不会误杀合法 4090 | `currentClient = client` 在 `connect()` 起始赋值（`join.ts:919-920`），活动 socket 上的帧必然 `from === currentClient` |
| 锁对"不同路径字符串指向同一文件"仍安全 | 文件层检查现在拒绝**任何**活锁（含同 pid）⇒ 不依赖 `heldPaths` 的字符串相等 |
| 未知隧道级 CLOSE code 前向兼容 | `join-replaced.test.ts` 第二例（保持连接、不置 replaced、仍持锁） |
| 反向证明 | 撤销 `existing.replaced()` → hub 用例超时失败；撤销 `shuttingDown = true` → gateway 用例 `2 !== 1`（复现互踢） |

## 4. 外部 reviewer 结论与我的复核

### 4.1 hub / 协议半场（独立 reviewer ①，只读；我逐条复核）

| # | reviewer 结论 | 我的复核 | 判定 |
|---|---|---|---|
| R1 | **P2 真缺陷**：`replaced()` 的 1s 兜底 timer 在**入口**武装，而非 4090 帧刷出之后 ⇒ 写缓冲持续 >1s（大 body 上传 + 对端读得慢）时先 `terminate()`，**帧被丢弃** → 旧实例只看到断线并重连 → 互踢继续 | **独立复现**（stub ws，send 回调延迟 1500ms）：`send@+0ms → terminate@+1002ms → flush-cb@+1501ms → close(4090)@+1501ms` ⇒ 帧确实丢 | **采纳，P2**（推翻我原 nit-⑦ 的"无功能影响"，也削弱 P2-③ 所依赖的"hub 有 1s 兜底"） |
| R2 | **P2 测试质量**：`tunnel-replaced.test.ts` 第二例 `replaced()` 调用 **0 次**（`:136` 先等到 `!isOnline` 才连第二个 ⇒ `register()` 永远看到 `existing === undefined`），撤销修复照样通过 ⇒ 零回归价值；`:113` 注释称"不推 offline"但无 `pushToUser` 断言 | 复核测试自身时序：`waitFor(!isOnline)` 决定性地保证注册表已空 ⇒ `replaced()` 不可能被调用；因此它必然在 `terminate()` 版本下也通过 | **采纳，P2**（与我 P2-④ 同源，reviewer 证据更强） |
| R3 | **P2**：`assignStreamId()` 在 uint32 环绕后返回 0，与 `PROTOCOL.md` 新增的"数据流从 1 起"冲突；该流 `CLOSE 0` 会被新 gateway 当隧道级 CLOSE 吞掉 ⇒ 流不关闭（upstream 泄漏 + 响应挂死） | 复核代码 + 算术：`(0xFFFFFFFF+1)>>>0 === 0`（已跑）；gateway `join.ts:851-856` 先判 `streamId === 0` 即吞；OPEN/DATA 0 仍正常 ⇒ 只有 CLOSE 被吞 | **采纳，P2**（2^32 流才触发，修 1 行） |
| R4 | nit：`register()` 注释仍写"返回 conn"，签名是 `void`（本次 diff 恰好改的就是这行） | 复核：确为 `void` + 注释未修 | 采纳 |
| R5 | nit（latent）：`register()` 若以**同一个 conn** 再注册会自我顶替（关掉正在注册的连接、注册表留死连接）。今天不可达（唯一调用方 `server.ts:351` 恒为新 conn） | 复核代码：无 `existing !== conn` 守卫 | 采纳（免费兜住） |
| R6 | nit（协议）：hub 早在发 `streamId 0` 的**连接级 ERROR**（`tunnel.ts:205`），新 gateway 也留了分支，但帧表 ERROR 行仍写"关闭对应流"，文档未定义 ERROR-0 | 复核：发送点与帧表文字确实不符 | 采纳 |
| R7 | nit（协议完整性）：(a) 随帧的 **WS close code 4090** 未文档化；(b) "未知 code 忽略并保持连接"与"先发包后关闭"不自洽；(c) 变更记录无条件写"修复双实例互踢"，而旧 gateway 对 CLOSE-0 是 no-op、照样重连 ⇒ 需两端同步升级；(d) protocol-first 要求的 `e2e/` conformance 无宿主（记录不计缺陷） | 复核四条均成立（(c) 与 solution.md「兼容性」一致，但 PROTOCOL.md 那行没写限定） | 采纳 |

reviewer ① 同时独立确认了我 §3 的各条（先发后关、不推 offline / 不摘新连接、旧 hub 兼容、`streamId 0` 全仓审计、常量导出链路、反向证明有效），并实测 `packages/hub` 122/122 通过。

### 4.2 gateway / 插件半场（独立 reviewer ②，只读；我逐条复核）

| # | reviewer ② 结论 | 我的复核 | 判定 |
|---|---|---|---|
| R8 | **P1**：4090 后不 `cleanupStreams()`、不关 socket；`stop()` 因 `shuttingDown` 早退而永久失效 ⇒ 僵尸隧道（心跳未 unref + 在途流 + web-remote 已丢弃 handle） | **端到端复现**：WSS 发 4090 但不关连接 → `states=[connecting,connected,replaced]`、被顶替后仍收到 5 个 PING、调 `stop()` 后对端**未**看到关闭且 PING 继续 | **采纳，P1**（= D1） |
| R9 | **P1**：`readJoinLock` 的 stale 清理是 read→`rmSync` 非 CAS ⇒ B 可删掉 A 刚建立的锁，两进程都持锁；与 `wx`+write 的空文件窗口同族 | 复核代码：`lock.ts:41-46` 确无二次校验；结合我 P1-① 的复现（空文件被删）⇒ 同族两半 | **采纳，P1**（= D2） |
| R10 | **P2**：构造期同步抛错 → 锁 + `heldPaths` 泄漏；补充 `loadOrCreateE2eeKeyPair` 内 `generateKeyPair/serializeKeyPair` 在 try 之外，且 `new WebSocket(非法 URL)` 同步抛 | 我已先自行复现同一现象（P2-⑪）；reviewer 补充的抛点复核代码属实（`e2ee-key-store.ts:34-35`） | 采纳（= D4） |
| R11 | **P2**：3 次争抢失败后伪造 `heldBy:{pid: 自己}` → 面板显示"本进程已有隧道"（其实没有） | 复核 `lock.ts:115-116` + `join.ts:381` + `index.ts:213` 链路属实 | 采纳 |
| R12 | **P2**：web-remote `handle = null` 不 `stop()` ⇒ `dispose`/`disconnect` 无法收尾 | 属实；随 D1 修复后建议改 `void handle?.stop(); handle = null;` | 采纳（随 D1） |
| R13 | **P2**：CLI `onState` 只处理 `rejected`，`replaced` 只打一行 warn、不退出 ⇒ systemd 单元"active (running)"但无隧道 | 复核 `join.ts:1090-1094` 属实 | 采纳（需决策：退出非 0 或文档化语义） |
| R14 | **P2**：`~/.rdsh` 跨主机共享（NFS/同步 home/共享卷）时 pid 存活判定无意义 ⇒ 可能回收活锁；建议锁里存 `hostname()` 且仅同名才按 pid 回收 | 复核判定与 reap 逻辑属实；概率低，但与"跨机同 hostId"场景叠加会变互踢 | 采纳（可选加固） |
| R15 | **P2 测试**：`heldPaths` 真案例（文件被删后同进程再获取）无测例；`wx` 原子性无测例（去掉 `{flag:"wx"}` 9 个测例仍全绿）；跨进程竞争无测例；`lock.test.ts:85-99` 依赖提前抛错，回归时会**挂住**而非干净失败 | 逐条复核成立（含"删掉 `heldPaths` 后第二次仍因文件检查被拒"这一点） | 采纳 |
| R16 | **P2 测试**：`join-replaced.test.ts` 服务端 20ms 后就关连接 ⇒ 掩盖 D1；应加"发 4090 但不关连接"的变体并断言客户端确实关闭 | 与我的僵尸复现一致 | 采纳 |
| R17 | nit：`from !== currentClient` 守卫今天不可达（与我的 G1 一致）；建议让忽略路径变响或关掉旧连接 | 复核赋值时序属实 | 采纳 |
| R18 | nit：老插件 + 新 gateway → 旧 `mapState` 无 `default` 返回 `undefined`，旧 `onState` 不释放 handle ⇒ 面板卡住；建议 `default: return "disconnected"` | 复核类型跨包边界、旧 dist 无 default 属实 | 采纳（廉价保险） |

reviewer ② 同时独立确认：`wx` + 拒绝同 pid 活锁确实堵住了原 TOCTOU（**真正修好热重载双隧道的是它，不是 `heldPaths`**）、`streamId 0` 不与数据流冲突、旧 hub 兼容、`releaseJoinLock` 不误删、`heldPaths` 路径键一致、插件锁冲突提示链路可用、出站字节未变；`pnpm build` 干净、130/130 通过。

## 5. 处置（2026-09-15 更新：范围已缩小为"只改 host/plugin"）

**范围决定**：放弃"hub 顶替发 4090 + 协议变更"，只修 host 侧锁与插件提示（理由见 [doc/fix/20260915-tunnel-eviction-loop/discussion.md](../fix/20260915-tunnel-eviction-loop/discussion.md) §4）。相关代码已整体回退，因此下列缺陷的处置状态随之变化：

| ID | 缺陷 | 原级别 | 处置 |
|---|---|---|---|
| **D1** | 4090 后无收尾、`stop()` 永久失效 | P1 | ✅ **消失**（`handleTunnelLevelClose` / `"replaced"` 状态整体回退，不再存在"声明死亡却不收尾"的路径） |
| **D3** | hub 兜底 timer 早于帧刷出 → 重背压丢帧 | P1 | ✅ **消失**（`replaced()` 整体回退，hub 恢复原 `terminate()`） |
| **D2** | 锁清理非 CAS + 空文件窗口 | P1 | ✅ **已修**：`readJoinLock` 改纯读、清理走 compare-and-delete、锁用临时文件 + `linkSync` 原子发布；反向证明两条（`heldPaths`、纯读）已跑 |
| **D4** | 构造期抛错泄漏锁 | P2 | ✅ **已修**：`releaseLockAndRethrow()` 包住 `loadOrCreateE2eeKeyPair()` 与 `connect()` |
| R3 | `assignStreamId` uint32 环绕返回 0 | P2 | ⏭️ 与本次无关的既有问题（协议里"数据流从 1 起"的保证被环绕破坏）；未修，留待单独处理 |
| R4/R5/R6/R7 | hub 注释、同 conn 重复注册守卫、`ERROR-0` 未文档化、协议文档完整性 | nit | ⏭️ 随 hub/tunnel 改动一并回退，不再适用 |
| R11 | 争抢失败伪造 `heldBy=自己` | P2 | ✅ **已修**：`{ok:false, contended:true}` + join.ts 独立报错文案 |
| R12 | 插件 `handle = null` 不 `stop()` | P2 | ✅ **消失**（不再有 `replaced` 分支；`rejected` 分支保持原样，其 socket 已被对端关闭） |
| R13 | CLI `replaced` 不退出 | P2 | ⏭️ 随 4090 回退而不再适用；CLI 的锁冲突退出语义仍未定（记入 fix TODO） |
| R14 | 跨主机共享 `~/.rdsh` 时按 pid 回收活锁 | P2 | ⏭️ 未修，记入 [solution.md](../fix/20260915-tunnel-eviction-loop/solution.md)「已知残留」4 |
| R15 | 锁测例缺口（`heldPaths` 真案例、原子性、跨进程、startJoin 用例可能挂住） | P2 | ✅ **部分已修**：新增 `heldPaths` 真案例（锁文件被删后仍拒绝）、跨进程互斥用例；原子发布仍无测例（原因见 fix verification G1）；未再加会挂住的 startJoin 用例 |
| R16 | `join-replaced` 掩盖收尾缺口 | P2 | ✅ **消失**（该测试文件随 4090 一并删除） |
| R17 | `from !== currentClient` 守卫不可达 | nit | ✅ **消失**（随 4090 回退） |
| R18 | 老插件 + 新 gateway → `status: undefined` | nit | ✅ **消失**（不再新增 `JoinState` 取值，`mapState` 无需扩展） |
| 发布耦合 | `rdsh-tunnel` 版本 + `publish.sh` 不含 tunnel | P0（发布前） | ✅ **消失**（不引入新常量，发布面只剩 gateway + web-remote） |

**结论**：审查发现的 4 处必修缺陷中，D1/D3 通过"缩小范围、回退代码"消除，D2/D4 已在新锁实现中修复并有反向证明；其余 P2/nit 或随回退失效，或记入 fix TODO 作为既有问题。

## 6. 第二轮复审（同一 reviewer，针对**重写后的**新实现）

范围缩小并重写后，请原 reviewer 复审新实现（只读）。结论：**上一轮 4 条全部确认已修**（#2 CAS 清理、#3 构造期释放锁、#4 contended、#8 测试缺口；`heldPaths` 真案例与跨进程用例均已补），并新提 9 条。逐条处置：

| # | 复审结论 | 我的复核 | 处置 |
|---|---|---|---|
| N1 | `reapDeadLock` 残留窗口 + **纯内容 CAS 的 ABA**（pid 复用后字节相同的新锁会被当残锁删） | 复核代码：确为内容比对，无身份比对 | ✅ **已修**：快照加 `ino`/`mtimeMs`，compare-and-delete 要求**内容 + inode**都没变 |
| N2 | **新鲜的空/半截锁文件会被立即回收** ⇒ 新旧混跑时可能双持锁（旧版正处于 `wx` 的 open→write 窗口） | 复核：`parseLock("")→null` ⇒ 判"非活锁" ⇒ 直接删 | ✅ **已修**：内容解析不出来且 `mtime` 很新（<1s）→ 不回收（题述 G5 因此关闭）；测试同步改为"新鲜的不回收、过期的才回收"并做了反向证明。代价：真正的"新鲜半截残锁"需过保护期后重试 |
| N3 | `releaseLockAndRethrow` 无测例 | 先自行复现：`ftp://` 在锁发布**之后**同步抛，抛后锁文件已不存在、可再获取 | ✅ **已加测例**（`ftp://` + 断言"锁已释放/可再获取"） |
| N4 | `setState("connecting")` 夹在 `new WebSocket` 与监听器挂载之间 ⇒ embedder 钩子抛错会留下无 `error` 监听的半成品 socket（未捕获 error 崩进程） | 复核代码：确在 901 与 908 之间 | ✅ **已修**：`setState` 移到所有监听器挂完之后（`connecting` 仍先于 `connected`，既有状态顺序测试不受影响） |
| N5 | 跨进程用例无 `try/finally`：任一子进程失败会让等 stdin 的赢家把测试进程**挂住** | 复核：确无 finally | ✅ **已修**：`finally` 里关 stdin + `SIGKILL` + 清目录 |
| N6 | `linkSync` 在不支持硬链接的文件系统上（SMB/FUSE/exFAT）被原样抛出 ⇒ **这些文件系统上隧道永远起不来**（旧实现可用），且报错文案不含 `join lock`，面板静默 | 复核：回退缺失属实；errno 集合合理 | ✅ **已修**：EPERM/ENOSYS/ENOTSUP/EOPNOTSUPP → 回退 `wx` 创建（该窗口由 N2 的新鲜度保护兜住） |
| N7 | 临时文件名可预测、用覆盖 flag、崩溃会留残渣 | 复核成立，但利用前提是"已能写 `~/.rdsh`" | ⏭️ **接受**：记入 solution「已知残留」5 |
| N8 | `assert.notEqual(readJoinLock(path)?.pid, process.pid)` 在文件已消失时**空过** | 复核：赢家一收到 stdin end 就退出，断言时机确有问题 | ✅ **已修**：改为在释放**之前**断言持锁者存在且是某个子进程 |
| N9 | `heldPaths` 以原始路径字符串为键，两种写法可绕过 | 复核成立；文件层仍拒绝 ⇒ 不会双隧道；仓内调用方都传 `undefined` | ⏭️ **接受**：记入 solution「已知残留」6 |

复审同时独立确认（证据充分）：原子发布/`finally` 语义、`heldPaths` 生命周期、`readJoinLock` 纯读不破坏任何消费者、`contended` 全调用点处理、`releaseLockAndRethrow` 自身不抛且 `never` 保证确定性赋值、跨进程用例编排无死锁/无空过（空闲 3 次 + 6 路 CPU 负载 1 次，均稳定），以及 `verification.md` 的 G1/G5/G6/G7 描述与实现一致。

**新增未覆盖项**（已记入 fix verification）：G8（inode 比对的 ABA 无测例）、G9（硬链接回退无测例，本机无法触发）。
