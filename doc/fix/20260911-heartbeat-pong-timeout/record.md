# 心跳（PING/PONG）超时判定缺失 —— 修复记录

> **日期**: 2026-09-11
> **类型**: 协议**实现与文档不一致**（存量缺口，非本次新增）
> **影响面**: `rdsh-tunnel` 连接存活判定 → hub 的"主机在线"状态 → 门户在线指示、`rdsh host` 重连、以及未来的 agent mesh 索引（feature 21 的 D7）
> **来源**: feature 21 discussion 的只读审计（§2.1）+ 代码复核
> **状态**: ✅ **已实施并验证（2026-09-11）**——协议文档已先行更新，两侧实现 + 测试全绿；真实时序实测 40.1s 判离线

---

## 1. 现象

协议文档规定了心跳超时判离线，但**两侧都没有实现该超时**，且 **hub 从不主动发 PING**。结果是半死连接（笔记本休眠、NAT 表项超时、拔网线）不会被察觉，只在 TCP/WS 真正 close 时才反应。

## 2. 事实（代码复核，均带 file:line）

| # | 事实 | 证据 |
|---|---|---|
| F1 | 帧类型已定义：`PING 0x04 {ts}` / `PONG 0x05 {ts}` | `packages/tunnel/PROTOCOL.md:37-38` |
| F2 | 文档规范：**PING 30s 间隔；对端 10s 未回 PONG → 判定离线，断开连接** | `packages/tunnel/PROTOCOL.md:73` |
| F3 | gateway **每 30s 主动发 PING** | `packages/gateway/src/join.ts:117`（`HEARTBEAT_MS = 30_000`）、`:752` |
| F4 | gateway 收到 PING → 回 PONG | `packages/gateway/src/join.ts:670-671` |
| F5 | gateway 收到 **PONG → 直接 return（不记录、无超时判定）** | `packages/gateway/src/join.ts:674` |
| F6 | hub 收到 PING → 回 PONG | `packages/hub/src/tunnel.ts:126-127` |
| F7 | hub 收到 **PONG → 直接 return**，注释写「心跳回显（gateway 侧维护超时）」 | `packages/hub/src/tunnel.ts:130` |
| F8 | **hub 从不发 PING**（只有 gateway 发） | 全仓 `packages/hub/src` 无 PING 发送点 |
| F9 | hub 的在线态 = 内存 `TunnelRegistry`（`Map<hostId, TunnelConn>`），DB **无 last_seen/online 字段** | `packages/hub/src/tunnel.ts:196-223` |
| F10 | gateway 重连由 401/403 fail-fast + 连接关闭驱动（1s→60s 退避 + 抖动） | `packages/gateway/src/join.ts:736-743,777-787,790-791` |

**F5+F7 合起来就是缺口**：注释以为「gateway 侧维护超时」，而 gateway 的 PONG 分支只有 `return`——**责任在两个实现之间掉地上了**。

## 3. 后果

1. **僵尸连接**：半死连接不被判定，双方都以为还在线；
2. **在线态撒谎**：门户显示"在线"、未来的 AgentCard 显示"在线"，但请求打过去没人应；用户看到的是卡住/超时，而不是干净的"主机离线"；
3. **不会主动重连**：gateway 只发 PING、不看 PONG，链路半死时不会触发退避重连；
4. **对 feature 21（agent mesh）是直接前置**：AgentCard 的"在线"是索引的核心字段（feature 21 §2.1 / D7）。

## 4. 修复方案（两侧对称实现文档已写的行为）

不改线协议格式（帧类型已存在），只补语义：

| 侧 | 改动 |
|---|---|
| **gateway** | 记录最近一次发出的 PING 时间；超 **10s** 未收到 PONG（或期间任何帧）→ 主动断开当前连接 → 交由既有退避逻辑重连 |
| **hub** | ① 也开始按 30s 发 PING；② 同样在 10s 未回时终止该连接并从 `TunnelRegistry` 移除（触发既有的 `host.offline` 推送） |
| 文档 | `PROTOCOL.md:73` 明确「**双方对称维护**」：任一侧都可发 PING，收到 PING 必须回 PONG，发方负责超时判定与断开 |

**顺带建议（不在本记录范围）**：给 hub 的 hosts 增加 `last_seen`（或在线历史）属于另一件事，只有需要"离线多久"这类展示时才做。

## 5. 实施结果（2026-09-11）

| 文件 | 改动 |
|---|---|
| `packages/tunnel/PROTOCOL.md` | 「心跳与重连」改写为**双方对称**：两侧都发 PING、都应答；**发送方负责超时判定**（发出 PING 后 10s 内未收到对端任何帧 → 主动断开）；并明确「不得假设对端会维护超时」 |
| `packages/gateway/src/join.ts` | 新增 `PONG_TIMEOUT_MS = 10s`；发 PING 后武装死线，收到**任何**入站帧即撤销；超时 `terminate()` → 走既有退避重连。`heartbeatMs`/`pongTimeoutMs` 可注入（测试用） |
| `packages/hub/src/tunnel.ts` | `TunnelConn` 新增**对称心跳**：30s 发 PING + 10s 死线；超时 `terminate()` → `close` → `onClose`（摘除注册表 + 推 `host.offline`）；关闭/出错时清理定时器。新增可注入的 `TunnelTimings` |
| `packages/hub/src/server.ts`、`api.ts` | 新增 `tunnelTimings` 透传（**仅供测试注入**，生产不传）；close 回调改为**身份校验摘除**（见 §9 R1） |
| `packages/gateway/test/join-heartbeat.test.ts`（新） | 3 例：对端静默 → `reconnecting`；对端**恢复**后重连并保持在线；对端回 PONG → 保持 `connected` |
| `packages/hub/test/tunnel-heartbeat.test.ts`（新） | 2 例：客户端静默 → hub `onClose` 触发；客户端回 PONG → 不误判 |
| `packages/hub/test/tunnel-heartbeat-e2e.test.ts`（新） | 2 例（**真实 hub 服务端到端**）：静默 → 注册表摘除 + 推 `host.offline`；回 PONG → 保持在线且不推 offline |
| `packages/hub/src/tunnel.ts` | `TunnelRegistry.unregister(hostId, conn?)` 增加**身份校验**（重连竞态修复，见 §9 R1） |
| `packages/hub/test/tunnel-reconnect.test.ts`（新） | 1 例（**真实 hub 服务端到端**）：同 token 重连后旧连接 close **不得**摘除新连接（回归锁） |

**实现要点（一处容易写错）**：死线必须「**只在没有未决死线时武装**」。若每发一次 PING 就重置死线，则当 `heartbeatMs < pongTimeoutMs`（测试注入小值时常见）死线会被无限推迟、**永不判死**——首版实现正是踩了这个坑，被探针与测试抓到后修正。

## 6. 验证证据

| 项 | 结果 |
|---|---|
| `pnpm build`（tsc strict，全 workspace） | ✅ 退出码 0，零 error |
| `pnpm test` | ✅ **tunnel 12 / hub 96 / gateway 113 / web-remote 16**，0 fail（hub +5、gateway +3 为本项新增；无回归） |
| gateway 侧超时（毫秒级注入） | ✅ 100ms/250ms 时序下进入 `reconnecting`（实测 386ms） |
| gateway 侧正常应答 | ✅ 600ms（跨多个心跳周期）保持 `connected`，无误判 |
| gateway 侧对端恢复 | ✅ 判死 → 退避重连 → 恢复在线，状态序列 `connecting→connected→reconnecting→connecting→connected`（实测 2.45s） |
| hub 侧超时（毫秒级注入） | ✅ 367ms 触发 `onClose` |
| 端到端：静默对端（真实 hub 服务 + 真实 WS） | ✅ 372ms 从 `TunnelRegistry` 摘除并推送 `host.offline` |
| 端到端：正常应答对端 | ✅ 600ms 保持在线，未推 `host.offline` |
| 端到端：同 token 重连（真实 hub 服务 + 真实 WS） | ✅ 442ms：新连接保持在线、`get()` 非 null、未推 `host.offline`；**回退修复后该测试失败**（3023ms `waitFor timeout`） |
| **真实时序（默认 30s 心跳 / 10s 超时）** | ✅ 连接后 **40.1s** 判定离线并推送 `host.offline`（= 30s 首 PING + 10s 超时，符合预期） |

### 验收标准对照

| # | 标准 | 状态 |
|---|---|---|
| 1 | 对端静默后 ≤40s 判离线（hub 摘除 + gateway 退避） | ✅ hub 侧实测 **40.1s**；gateway 侧由 `reconnecting` 状态验证 |
| 2 | 恢复网络后自动重连、门户恢复在线 | ✅ 新增用例覆盖：判死 → 退避重连 → 恢复在线并持续保持（状态序列见上表）；门户在线态由 hub 的 `host.online/offline` 推送驱动 |
| 3 | 长时间无假阳性 | ⏳ 未做 10 分钟长跑；正例已覆盖连续 4–6 个心跳周期（生产前建议真机长跑一次） |
| 4 | 线协议字节级不变（无新帧类型） | ✅ 仅复用既有 PING/PONG（0x04/0x05） |
| 5 | `pnpm test` 全绿、无回归 | ✅ 见上表 |

## 7. 版本兼容（混合部署安全）

| 组合 | 行为 |
|---|---|
| 新 gateway + 旧 hub | 旧 hub 一直会应答 PING ⇒ 新 gateway 死线被满足，不误判 ✅ |
| 旧 gateway + 新 hub | 旧 gateway 也会应答 PING（`case PING → PONG`）⇒ 新 hub 不误判 ✅ |
| 两侧都是新版 | 双方都发 PING、都判定超时（目标状态）✅ |

⇒ **可灰度升级**：先升任一侧都不会造成误判离线。

## 8. 关联

- feature 21（agent mesh）discussion 的 §2.1 与 **D7**（本项作为独立修复排在 P0 之前，已完成）
- 协议契约：`packages/tunnel/PROTOCOL.md`（**协议先行**：本次先改文档措辞，再改实现）
- 在线态现状：portal 的在线/离线推送（`packages/hub/src/events.ts`、`server.ts` 的 host 上线/下线事件）
- 测试：`packages/gateway/test/join-heartbeat.test.ts`、`packages/hub/test/tunnel-heartbeat.test.ts`、`packages/hub/test/tunnel-heartbeat-e2e.test.ts`、`packages/hub/test/tunnel-reconnect.test.ts`

## 9. 代码审查（改动复检，2026-09-11）

对 §5 的改动逐行复检：发现并修复 **1 个真缺陷**（同域、且被本改动放大）+ 3 处质量项；1 个怀疑项经核实**不成立**。

| # | 级别 | 发现 | 结论 |
|---|---|---|---|
| R1 | **高（真缺陷）** | **重连竞态**：`register` 会 terminate 旧连接，而旧连接的 close 回调**晚于**新连接注册才触发；`unregister(hostId)` 无条件 delete ⇒ 把刚接手的新连接一并摘掉 | **已修**（见下）。心跳判死会**主动触发重连**，等于放大该缺陷：判死→重连→新隧道被旧 close 摘掉→host 假离线 |
| R2 | 中（曾怀疑） | 10s 死线在**背压**下是否会误杀大流量传输？ | **不成立（已核实）**：relay 三条数据面路径（`relay.ts:100`、`:199`、`:277`）均丢弃 `res.write`/`ws.send` 返回值、从不 pause 隧道读侧 ⇒ 双方始终在读，数据帧本身就是存活证据。已在 PROTOCOL.md 记下该**前置假设**（Go 重写若引入读侧背压必须重新评估） |
| R3 | 低 | 日志由 `heartbeat 30s` 退化成 `heartbeat 30000ms`（可读性回退） | **已修**：`%1000===0` 时按秒显示，测试注入值原样显示 |
| R4 | 低 | 新测试超时取 40ms/60ms，裕度仅 1.5×，CI 负载下可能"应答及时却被判死"假失败 | **已修**：统一 100ms/250ms（裕度 2.5×），等待窗口同步放宽到 600ms |
| R5 | 低（覆盖缺口） | 验收标准 2（恢复后重连）无测试 | **已补**：新增"对端恢复后重连并保持在线"用例，断言状态序列 `connecting→connected→reconnecting→connecting→connected` |
| R6 | 提示（**未改**） | `error` 与 `close` 都走 `onClose`，`revokeHost` 又额外显式推一次 ⇒ 个别路径重复推 `host.offline` | 仅记录：门户侧幂等（置离线），无功能影响；不在本次范围改动 |

### R1 修复内容

- `TunnelRegistry.unregister(hostId, conn?)`（`packages/hub/src/tunnel.ts`）：**身份校验**——仅当注册表当前持有的正是该连接才摘除，并返回是否真的摘除；
- `packages/hub/src/server.ts` close 回调：改为 `unregister(hostId, conn)`，且**仅当 `!isOnline(hostId)`** 时才推 `host.offline`（保持 `api.ts` 三处显式 `unregister` 路径的离线通知语义不变）；
- 回归测试 `packages/hub/test/tunnel-reconnect.test.ts`（新）。

### R1 证据（修复前 → 修复后）

修复前（真实 hub 服务 + 两条同 token 连接，探针实测）：事件序列 `host.online, host.online, host.offline`，`isOnline = false`、`get(hostId) = null` ⇒ 新隧道活着，但门户显示离线、relay 取不到 conn（503）。

反证（测试是否真能锁住该缺陷）：临时回退 `server.ts` 的修复 → 新测试**失败**（`waitFor timeout`，3023ms）；恢复后通过。

