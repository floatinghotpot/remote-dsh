# raw 门禁授权被做成 per-raw-stream：新建流必然 403（discussion）

> **日期**: 2026-10-04
> **现象**: 手机经**服务器转发**（hub 中继）访问主机时，app 内发消息 / 语音输入报
> `client api: session/prompt failed: raw stream not authorized (gateway/internal)`；
> 切 DSH UI 语言（zh-CN ↔ en）后**概率性**出现；**内网直连路径不复现**。
> **结论**: **根因已实测确认。** `rawAuthorized` 声明在 `makeInnerDispatcher()` 内部（该函数每调用一次就重置），
> 而它**每条 raw（E2EE）流都会被调用一次**（`startRawStream`）。于是"页面 authorize 一次"只能解锁
> **承载该请求的那一条流**；此后任何**新建**的 raw 流都是未授权态，命中 raw 门禁的
> **fail-closed** 分支，被 `CLOSE 403 raw stream not authorized`。
> **热修已在真机验证通过**（§4）。
> **关联**: [20260917-jspatch-miss](../20260917-jspatch-miss/) —— 同一次真机排查中一度被当作"第二个缺陷"的 `patchLoopbackJs` 失效，**后续已证伪（§7.1）**：它是**僵尸代码**而非缺陷。该目录仍为空，待按"维护项"补记，不按缺陷处理。

---

## 1. 事实链（均带 `file:line` / 实测）

| # | 事实 | 证据 |
|---|---|---|
| **F1** | raw 门禁在未授权时 **fail-closed**：除 `/__rdsh/authorize` 外一律 `CLOSE 403` | `packages/gateway/src/join.ts:613-626` |
| **F2** | `rawAuthorized` 声明在 **`makeInnerDispatcher()` 函数体内** | `join.ts:486` |
| **F3** | `makeInnerDispatcher()` **每条 raw 流新建一次**；plain 只建一次 | `join.ts:918-919`（`startRawStream` 内）vs `join.ts:890`（`plainDispatcher`） |
| **F4** | 页面解锁脚本**每页只跑一次**（一次性守卫） | `packages/gateway/src/direct.ts:102-103`（`window.__rdshDirectBootstrapped`）|
| **F5** | 该脚本发的 `/__rdsh/authorize` **自己也是一条独立 raw 流** ⇒ 它解锁的是"它自己那条" | `direct.ts:100` + F1 |
| **F6** | 该门禁**只作用于 E2EE raw 流**；plain 路径走 cookie gate（`gate: true`） | `join.ts:613`（`dio?.rawGate !== undefined`）/ `join.ts:890-897` |
| **F7** | **实测**：服务器转发路径复现，内网直连不复现；切 DSH UI 语言（触发前端重连 / 新建流）后概率出现 | 真机（树莓派 5；`remote-dsh 0.14.0` / `rdsh-gateway 0.11.0` / `dsh 0.1.7-rc.2`）|
| **F8** | raw 门禁的 403 分支 **没有任何日志**（网关日志里看不到） | `join.ts:615-625`：直接 `send(CLOSE…)`，无 `log()` |
| **F9** | 仓库 `packages/gateway` 版本 = 真机实装版本（**0.11.0**）⇒ 仓库即部署代码之源 | `packages/gateway/package.json` vs 真机 `require('rdsh-gateway/package.json').version` |

### 1.1 为什么"语言"是误导性变量

代码侧已排除语言相关：**DSH 前端资源不按 UI 语言分 chunk**（`assets/langs/*.js` 是语法高亮语言，主 bundle 只有一个），
UI 语言是运行时 i18n。真正的变量是**"首次页面加载之后有没有新建 raw 流"**：

```
首次加载  → 注入脚本 authorize ✓ → 承载它的那条流可用
   ↓（链路抖动 / WS 重建 / 前端重连 —— 切语言恰好会触发）
新建 raw 流 → rawAuthorized = false（F2+F3）
   ↓
页面守卫已置真 → 不会再次 authorize（F4）
   ↓
新流上的 session/prompt → CLOSE 403（F1）  ← 用户看到的那条
```

**判据**：这是**生命周期**问题 —— 所以表现为"时好时坏"，而非确定性复现。实测中同一步骤在不同时刻结果不同，正符合此判据。

---

## 2. 影响

1. **服务器转发路径不可用（间歇）**：这是**唯一**会走 E2EE raw 流的路径（F6），因此也是唯一会踩到这个洞的路径；
   内网直连不受影响 —— 这解释了"内网好好的，换到外网就不行"的直觉落差。
2. **表现为"随机"**：因为是流生命周期问题，用户与支持都难以复现，容易被误判为"网络抖动"。
3. **授权语义被架空**：注入脚本天然"每页一次"（F4），而门禁要求"每流一次"（F2+F3）—— **两者从设计上就对不上**；
   F5 进一步说明：连 authorize 请求自身解锁的都只是它自己那条流。
4. **诊断盲点**（F8）：403 无日志，运维侧无法从网关日志定位，只能靠 app 端报错反推。

---

## 3. 根因

**`rawAuthorized` 的作用域选错了。** 它的语义应当是「**这个页面是否已证明自己知道访问口令**」，
但被实现成「**这一条 raw 流是否已证明**」。前者是**页面级**（理想）事实，后者是流级事实。
网关侧没有跨流的"页面/会话"标识，能落地的最近粒度是**实例级**（§4.1）。

一句话：**authorize 证明的是"页面知道口令"，不是"某条流知道口令"。**

---

## 4. 修法（含热修验证结果）

### 4.1 采用方案：把 `rawAuthorized` 上提到 `startJoin` 作用域

```diff
  // packages/gateway/src/join.ts
  const gate = { accessCode: opts.gateway?.accessCode ?? null };   // :405
+ /** raw 门禁：页面是否已授权。实例级共享（原 per-raw-stream）—— authorize 证明的是
+  *  "页面知道口令"，不是"某条流知道"；per-stream 会让新建流未授权即 403。 */
+ let rawAuthorized = false;                                       // :417
```
```diff
  // makeInnerDispatcher() 内 —— 删除这两行
- /** raw 门禁：当前 raw 流是否已被页面授权（动态判定：见 handleOpen 的条件，含运行中 gate 开关） */
- let rawAuthorized = false;
```

**作用域边界：以「网关实例」为单位 —— 既不是 raw 流，也不是隧道连接。** 这一点与直觉不同，必须写清：

| 边界 | 是否共享授权 | 依据 |
|---|---|---|
| 同一实例内的**多条 raw 流** | ✅ 共享（**这就是本次修复点**）| 都在 `startJoin` 闭包内 |
| 同一实例内的**隧道重连** | ✅ **也共享** | 重连函数 `connect()`（`join.ts:1061`）**嵌在 `startJoin` 内部**并自我 `setTimeout(connect, …)`（`:1144`）⇒ 重连**不重建** `startJoin` 作用域 |
| **另一台网关实例**（另一主机进程）| ❌ 隔离 | 各自独立闭包 |

**为什么必须容忍"跨重连共享"**：隧道重连会重建客户端的 raw 流，而**已加载的页面不会重跑 authorize 脚本**（F4）。
若把标志做成"每条隧道连接一份"，**每次重连都会原样重现那个 403** —— 等于修了个假的。故此处**没有更细的可行边界**。

**⚠️ 安全取舍（必须与修复一并记录）**：访问口令的校验粒度由「每条 raw 流一次」放宽为「**每个网关实例一次**」。
即：任一页面用正确口令授权过一次后，该主机进程生命周期内（含重连、含该实例承载的所有客户端）
后续 raw 流不再校验口令。残余风险与缓解：

- 到达隧道的**前置条件是 hub 账号鉴权**（主门禁）；raw 门禁是**第二层**（`accessCode`，feature 15）；
- 另有 E2EE（hub 只见密文）+ 主机指纹 TOFU pin；
- 该标志随网关进程重启归零；
- 若产品方认为不够，可加**时间上界**（例如与 `GATE_COOKIE_TTL_MS` 同级或更短），代价是超期后需页面重新授权 ——
  属**可选的后续加固，不在本次小修范围**。

### 4.2 被否方案

| 方案 | 做法 | 否掉原因 |
|---|---|---|
| 乙 | 客户端每次新建 raw 流时重新 authorize（放宽 F4 守卫） | 需要同时改客户端 + 页面脚本；且客户端无法知道网关何时重建了流；把"流级"知识推给客户端，边界更乱 |
| 丙 | 把 `rawAuthorized` 放**模块作用域**（真全局，跨所有 `startJoin` 实例） | ❌ **越界**：会让**多个网关实例之间**共享授权，等于废掉 raw 门禁的隔离语义（R7）。注意与本方案的边界区分：本方案是 `startJoin` 作用域 = **每实例一份**（§4.1） |

### 4.3 热修与真机验证（已完成）

在真机 `remote-dsh 0.14.0` 上直接热修**编译产物**（源码修复待发版，见 §6）：

| 项 | 值 |
|---|---|
| 目标文件 | `…/remote-dsh/node_modules/rdsh-gateway/dist/join.js` |
| 备份 | 同目录 `join.js.bak-<timestamp>`（sha256 `4119de88…`）|
| 改动 | 仅上述 2 处搬移（`let rawAuthorized` 由 :342 → :278，即 `startJoin` 作用域）|
| 校验 | `node --check` OK；`diff` 仅 2 处 |
| 装回 | 保持 `root:root 644`（sha256 `c6d0156f…`）|
| 重启 | `systemctl --user restart rdsh-join.service` → `active`，日志 `tunnel established` |

**验证结果（产品方真机复测）**：把**鲸语通 UI 与 DSH UI 都切成英文**，语音对话
→ **回答正确、不再出现 `raw stream not authorized`**。此前该步骤必现。

> ⚠️ 热修只落在那一台真机的 `dist/`，**不在仓库、也不在任何发布产物里**。
> 必须落到源码并发版（§4.4 / §6），否则：① 该机 `npm i -g` 后会退化；② 其它部署仍带病。

### 4.4 源码修复与回归测试（已实施，待发版）

| 项 | 内容 |
|---|---|
| **源码** | `packages/gateway/src/join.ts`：`let rawAuthorized` 由 `makeInnerDispatcher()` 内上提到 `startJoin` 作用域（`:417`）；另加**测试注入用**的 `e2eeKeyDir`（`StartJoinOptions` / `JoinOptions`），使测试不触碰真机 `~/.rdsh` |
| **测试** | 新增 `packages/gateway/test/join-raw-authorize-shared.test.ts` —— **驱动真实 raw（E2EE）路径**（每条流独立 Noise 握手、内层帧全部加密），复用 `join-gate` 的 fake-hub 脚手架 + `portal/src/e2ee.ts` 的 `initiatorHandshake` |
| **用例** | **AC1** 流 A 授权后新建流 B 不再被拦（修复前此例必红）；**AC2** 另一台网关实例未授权 → 仍 403；**AC3** 错误 token → 不解锁 |
| **结果** | `pnpm --filter rdsh-gateway build` 零错误；`pnpm --filter rdsh-gateway test` → **162/162 通过**（原 159 + 新增 3）|
| **测试自证** | 临时把声明塞回 `makeInnerDispatcher()`（遮蔽外层）以复现修复前行为 → **AC1 精确变红**、AC2/AC3 仍绿 ⇒ 该用例确实锁住了这个回归，不是"改前改后都绿"的空测试 |

> `target` 指向无监听端口（`127.0.0.1:1`）：**过了门禁**的请求会以 `UPSTREAM_UNREACHABLE` 收场 ——
> 据此把"被门禁拦下（CLOSE 403）"与"放行但上游不通（ERROR）"区分开，这是该测试能断言的关键技巧
> （沿用 `join-gate.test.ts` 的既有手法）。

---

## 5. 验收标准（AC）

| # | 标准 |
|---|---|
| **AC1** | **同一实例内**：raw 流 A 完成 `/__rdsh/authorize` 后，**新开的** raw 流 B 发普通请求**不再**被 `CLOSE 403`（**含隧道重连后新建的流** —— 见 §4.1 边界表）|
| **AC2** | **跨实例仍隔离**：**另一台网关实例**（未授权）的 raw 流**仍必须** `CLOSE 403` —— 防止授权退化成模块级全局 |
| **AC3** | 错误 token **不**解锁门禁（`/__rdsh/authorize` 的验签路径仍严格）|
| **AC4** | 未设访问口令（`accessCode === null`）时行为不变：raw 门禁不生效，`/__rdsh/direct-candidates` 照常可用 |
| **AC5** | 无回归：plain 路径（内网直连、cookie gate）行为不变；`join-gate` 既有用例全绿 |
| **AC6** | 真机复测：服务器转发路径下，反复切 DSH UI 语言 + 语音对话，**不再出现**该报错 |

**覆盖情况**：AC1/AC2/AC3 由 §4.4 的新增用例覆盖；AC5 由既有 159 个用例覆盖；
AC4 由静态审查覆盖（本次未改动该分支）；**AC6 待发版装机后复测**。

---

## 6. 交付状态（源码修复 + 发版）

| # | 事项 | 状态 |
|---|---|---|
| 1 | 源码修复 `packages/gateway/src/join.ts`（§4.1）| ✅ **已完成** |
| 2 | 回归测试 `packages/gateway/test/join-raw-authorize-shared.test.ts`（AC1/AC2/AC3）| ✅ **已完成**，并已自证能抓住该回归（§4.4）|
| 3 | `pnpm --filter rdsh-gateway build` + `test` | ✅ **已完成**（build 零错误；**162/162 通过**）|
| 4 | `packages/gateway` 版本 bump → `remote-dsh` 版本 bump → `npm publish` | ⏳ **待产品方确认**（发布即对外）|
| 5 | 装机后**回滚真机热修**（§4.3 的备份覆盖 + 重启），确保线上跑的是发布产物而非本地热修 | ⏳ 待 4 完成 |
| 6 | AC6 真机复测（服务器转发路径 + 反复切 DSH UI 语言）| ⏳ 待 5 完成 |

---

## 7. 非目标

- **本项不处理** `patchLoopbackJs` 失效 —— 见 §7.1：**已证伪为"僵尸代码"，不是缺陷**；
- 不改 E2EE 协议 / 握手 / 密钥派生；
- 不改 plain 路径的 cookie gate（feature 15）语义；
- 不给 raw 门禁加"降级放行"之类的兜底 —— **fail-closed 是刻意设计**（R7），本次只修"授权的作用域"。

### 7.1 `patchLoopbackJs`：证伪记录（一度被当作第二个缺陷）

排查中它看着很像元凶：`patchLoopbackJs`（`join.ts:302-307`）在字节里找字面量
`isLoopbackHostname(pageLocation.hostname)` 替换成 `true`，而该串**在前端产物里找不到**
（fail-open 静默失效，只在日志留 miss；`join.ts:302-307`）。

**关键反证来自产品方：真机已在 dsh `0.1.7-rc.2` 上运行数日无异常。** 随后静态核实（本机同为 `0.1.7-rc.2`）：

| 标识符 | `index-*.js` (614K) | `vendor-*.js` (723K) |
|---|---|---|
| `isLoopbackHostname` / `pageLocation` | 0 | 0 |
| `localhost` / `127.0.0.1` / `loopback` | 0 | 0 |
| `ownsHost` | 1（`ownsHost:!0`）| 0 |

`localhost` / `127.0.0.1` 是**字符串字面量**，压缩不会改写它们；它们**归零**说明
**前端已不再用"页面主机名"判断 loopback** —— 上游换了机制（保留了 `ownsHost` 这类 transport 侧属性）。
因此：

- 该补丁 **target 的代码已不存在** ⇒ 补丁自我失效，属**僵尸代码**，**不是缺陷**；
- 它 **不解释** `raw stream not authorized` —— 本次元凶只有 §3 那一个（与热修验证结论一致）；
- **⚠️ 关于那条启动警告的定性（产品方澄清，勿误读）**：它是**兼容性「覆盖范围」提示，不是「不兼容」结论** ——
  团队对 `0.1.7-rc.1` 做过兼容测试、对 `rc2` **没做过**，所以措辞才是"**可能**不可用"。
  实测 `rc2` 已稳定运行数日 ⇒ **不要据此判定 rc2 有问题**，也不要把本项排查往这个方向带。
  正确处理是**补一次 rc2 的兼容验证**、然后把范围放宽（见下条），而不是把它当缺陷修。
- **维护建议（低优先级，不属本项）**：① 做一次 `0.1.7-rc.2` 兼容验证后把实测范围放宽；
  ② 补丁本体**保留**（旧版本仍需要），但可考虑按 dsh 版本跳过，省掉每次加载的一行 miss 日志。
