# 跨主机智能体通信层（agent mesh）（discussion）

> **日期**: 2026-09-11（同日四轮：v1 构想+审计；v2 组件边界与机密性；v3 范围收敛；v4 需求澄清 Q1–Q6 收口）
> **触发**: 用户提出——在 remote-dsh（尤其 `dsh-web-remote` 插件）之上，扩展出「跨主机 DSH 智能体通信层」
> **状态**: 构想与审计完成；范围已收敛；**决策 D1–D25 全部已定，无未决项（2026-09-11）**；`req.md` 已产出，待用户批准需求本身
> **性质**: 原始记录（构想 + 审计事实 + 出处）。`req.md` 存在后本文件转为只读需求来源（新需求直接进 `req.md`）
> **v2 变更（2026-09-11）**：① **不重构现有组件**——host 侧改为全新插件 `dsh-agent-mesh`，hub 侧仅加法式新增（§3.2 / D8 / D9）；② **agent↔agent 做端到端加密**，且与首个带载荷版本（P1）同期上线（§6.2 / D2 / D10 / D11）。
> **v3 变更（2026-09-11）**：① **范围收敛为「仅同一 owner 的 host 可同处一个 mesh」**（§0.1 / D20），跨 owner 整段移出范围；② 授权简化为 `owner_id` 相等，**同 owner 免逐次审批**；③ 三条新边界：共享成员不入 mesh、单跳防环、每主机方向与能力上限（D17–D19）；④ 新增交互模型与访问层级（D12–D14、D16）。
> **v4 变更（2026-09-11）**：需求澄清 Q1–Q6 收口 —— **D16 身份粒度**（Q1）、**D21 长任务进度语义**（Q2）、**D22 离线语义**（Q3）、**D21 含可取消**（Q4）、**D23 运行实例边界**（Q5）、**D7 心跳缺口**（Q6，独立修复记录：[doc/fix/20260911-heartbeat-pong-timeout/](../../fix/20260911-heartbeat-pong-timeout/record.md)）。
> **v5 变更（2026-09-11）**：把原先打包成一条非目标的「群组广播 / 总线 / 订阅」**拆开评估**——**广播/散射-收集纳入本期**（P1.5 扇出投递 → P2.5 聚合；成本≈0，复用逐对加密），**总线/订阅另立 `22-agent-bus`**（群组密钥 + 保留语义 + ACL），见 **§10 / D24**。
> **关联**: `packages/tunnel/PROTOCOL.md`、`packages/gateway/`、`packages/hub/`、`packages/web-remote/`、`doc/feature/16-portal-dark-mode/`（同批次事实审计范式）

---

## 0. 用户构想（原样记录）

> 你想在 remote-dsh 项目（特别是 dsh-web-remote 组件）基础上，扩展出一个跨主机 DSH 智能体通信层：
>
> 1. **核心目标**：让不同设备上的 DSH 智能体互相注册、寻址、通信，无需公网 IP。
> 2. **复用基础**：直接沿用 remote-dsh 已有的 Hub 注册、反向隧道、E2EE（Noise NK）、多路复用、心跳能力。
> 3. **需要新增**：
>    - Hub 侧：Agent Card 索引（能力标签、在线状态），寻址到「主机 + 智能体/会话」二级粒度
>    - 插件侧：注册 `send_to_peer` / `ask_remote` / `list_peers` 等工具，支持智能体主动发起跨主机通信
>    - 协议侧：在隧道之上定义轻量 Agent Message 格式（`{from, to, type, payload, correlationId}`）
> 4. **关键差距**：remote-dsh 目前是「人远程操控 DSH Web UI」，需要升级为「智能体对智能体通信」，主要补应用层协议和工具注册，底层网络架构可直接复用。

### 0.1 范围边界（2026-09-11 用户定案）

> **只有属于同一个 owner 的 host 才能处于同一个 mesh 网络。**

由此**移出范围**（或据此简化）：

| 原设计 | 收敛后 |
|---|---|
| 跨 owner 配对流程（指纹比对、双向同意、配对码） | ❌ 移出范围 |
| 入站逐次人工确认（`userQuestions.ask`） | ❌ 不需要（同账号免审批）；改为**可见 + 可叫停** |
| 借用 `host_share` 作为 mesh 授权依据 | ❌ 不需要——`host_share` 回归原本用途（把某台 host 的 **UI** 分享给别的账号） |
| hub 侧授权策略 | ✅ 降为**一行**：`sender.owner_id === target.owner_id` |
| 开放问题「谁可以被发现」 | ✅ 定了：仅同账号内的 host 互相可见 |
| 跨 owner 配额/计费 | ✅ 简化为"防跑飞"的配额，不涉计费 |

**未随之删减的一项**：**载荷端到端加密仍然保留**（D10）——理由与 owner 无关，而在于 hub 是谁（见 §6.2）：自建 hub 时运营者是自己，明文过 hub 可接受；而 **rdsh.cn 这类第三方 hub 上，同 owner 的两台机器之间的内容仍会被运营者看到**。

---

## 1. 定位

| | 今天 | 目标 |
|---|---|---|
| 通信主体 | **人** → hub → host → dsh Web UI | **agent** → hub → host → 对端 dsh 内的 **agent / 会话** |
| 流量性质 | 浏览器 HTTP/WS 透传（人类驱动） | 结构化 Agent 消息（agent 驱动），带请求-应答语义 |
| 寻址粒度 | `/h/<hostId>/` 一级（进某台主机） | `owner → host → agent/session` **二级** |
| 价值 | 人在哪都能用自己的 DSH | 多台机器上的 DSH **互相派活、互相问答** |

一句话：**网络层复用，新增的是「应用层协议 + 寻址索引 + 工具面 + 授权模型」**。用户对"底层可复用"的判断基本正确，但审计发现**两处需要修正的认知**（§2.2 的 E2EE 边界、§2.7 的授权缺失），这两处决定了工作量分布。

### 1.1 典型使用场景（用户原话，作为验收剧本的基础）

> 现在：一个用户在 hub 有一个账号，可以让几台 host 加入这个账号。
> 本特性完成后：
> 1. 他可以给**部分或全部** host 开启 mesh 能力；
> 2. 他仍能像今天一样**进入任意一台** host 工作；
> 3. **新增**：他在正在用的 agent A 上说一句"嘿 A，请让 agent B 去做某件事"。

对应机制：

| 用户描述 | 机制 | 状态 |
|---|---|---|
| ① 给部分/全部 host 开 mesh | 每台 host 一个开关（**默认关**）+ 发布 AgentCard（能力标签） | 本次新增 |
| ② 仍能进任意一台工作 | portal → `/h/<hostId>/` | **已有，不变** |
| ③ 让 A 去问/派活给 B | A 的 agent 调 `list_peers` + `send_to_peer` / `ask_remote` | 本次新增 |

值得对照的两种"用远端能力"的方式：

- **"进 B 干活"** = 同步、人工、重授权（等于拿到那台机器的完整 UI）
- **"让 A 找 B"** = 异步、可审计、可并发（B 的上下文与权限都留在 B 手上）

### 1.2 人类如何与 mesh 交互

**交互模型（D12）：代表制为默认。** 人在自己惯用的一台（**primary host / 指挥台**）里工作，通过自己的 agent 联络 peer；跨主机结果是回到自己会话里的工具结果/任务。**会话保持主机本地，跨主机只传消息、不共享上下文**（安全不变量）。排障/接管时仍可"进任意一台"（玻璃座舱，即今天已有的 portal 路径）。

**访问层级（D13，三级）**：

| 级别 | 人能做什么 | 机制 | 状态 |
|---|---|---|---|
| **L0 消息** | 通过自己的 agent 给同账号其他 agent 派活/提问 | mesh 配对（本特性） | 新增 |
| **L1 旁观/接管单个会话** | 进对端的「收件会话」看进度、插话、接管 | mesh 可选（监督路径） | 新增（可选） |
| **L2 进入完整 UI** | 打开对端 DSH，用其全部会话/终端/文件 | `host_share`（今天 role 只有 owner/member，无只读档） | **已存在** |

**两条不变量**：

1. **agent 永不获得"进入"权**：agent 只能发消息，不能拿对端 UI。人可以进，但进入受 `host_share` 管辖，与 mesh 解耦。
2. **mesh 配对只给 L0**：不要让"能派活"自动升级成"能进整台机器"（进入 = 能在对端跑命令，是很重的授权）。

**需要的最小人类界面**（P1 最小 / P2 完整）：① `list_peers` 的可读输出（host 名 + 能力 + 在线）；② 跨主机进度可见（`ask_remote` 本就是 job，复用 DSH jobs 视图）+ **可叫停**；③ 入站消息的审计可见（谁派了什么、何时）。

---

## 2. 查档事实（只读审计，2026-09-11；均带 file:line）

> 审计方式：3 个只读子代理分别核实「remote-dsh 线协议/E2EE/hub 索引边界」「DSH 工具注册 API」「DSH 会话注入能力」。本节只记**已核实事实**，推断另标注。

### 2.1 传输层：可复用，且协议已冻结 v1

- 帧格式：15B 头 `magic("RDSH") | version | flags | type | streamId(4B BE) | length(4B BE)`；payload 上限 **16 MiB**（`packages/tunnel/PROTOCOL.md:18-28`、`src/frame.ts:10-12`）
- 帧类型：`OPEN 0x01 / DATA 0x02 / CLOSE 0x03 / PING 0x04 / PONG 0x05 / ERROR 0x06`（`PROTOCOL.md:32-39`、`src/constants.ts:10-17`）
- 多路复用：**hub 分配** streamId（原子递增 uint32），gateway 原样回显（`PROTOCOL.md:64`、`hub/src/tunnel.ts:40-52`）
- 一条 WS message 恰为一帧（binary）；隧道内承载的 DSH WS 内容以 **text** 帧转发（`PROTOCOL.md:14`、`hub/src/relay.ts:198`、`gateway/src/join.ts:757-758`）
- 方向：**host 出站拨号**到 hub 的 WSS `/tunnel`，`Authorization: Bearer <hostToken>`（`gateway/src/join.ts:727-729`、`hub/src/server.ts:286-312`）⇒ **无需公网 IP** 的核心机制已具备
- 重连：1s→60s 指数退避 + 抖动；401/403 fail-fast（`join.ts:790-791`、`:736-743`）
- 扩展性：**两端都忽略未知帧类型、透传未知 flag 位**（`hub/src/tunnel.ts:189-191`、`gateway/src/join.ts:709-710`、`tunnel/src/frame.ts:59-62`）——是新增消息族的天然挂点，**但"静默忽略"意味着必须有能力协商**

**⚠️ 已核实的存量偏差（与协议文档不一致）**：`PROTOCOL.md:73-74` 写「心跳 30s + 10s 未回 PONG 判离线」，但**实现里只有 gateway 发 PING**（`join.ts:748-754`），**hub 从不发 PING**，**两端都忽略 PONG**，判活**仅靠 TCP/WS close**。→ 对 agent 索引的「在线状态」是直接地质问题（见 §2.3、§8 D7）。

### 2.2 🔴 E2EE 的真实边界（重要修正）

- 实现是**手写的简化 Noise NK**（X25519 + HKDF-SHA256 + AES-256-GCM，label `rdsh-e2ee-nk-v1`），**不用 Noise 库**（`gateway/src/e2ee.ts:1-10,24,78-137`）
- host 静态密钥持久化在 `~/.rdsh/e2ee-key.json`（0600），注册时上报公钥 → hub 存 `hosts.e2ee_public_key`（`e2ee-key-store.ts:21-42`、`join.ts:176-179`、`hub/src/db.ts:207`）
- **信任模型**：**浏览器 pin host 公钥**（localStorage `rdsh_e2ee_pins`；portal 内确认指纹）（`hub/src/e2ee-shim.ts:52-61`、`portal/src/pages.tsx:1234-1257`）。**host 不认证浏览器**（NK = 未认证发起方）；访问控制靠 hub 的 HMAC host cookie（`hub/src/relay.ts:22-34`）
- **保护范围**：只保护**浏览器 ↔ host 的数据面**（fetch + WS，走第二条 WS `/e2e` 的 `kind:"raw"` 流）；HTML/JS 壳明文；**host↔hub 隧道本身只有 WSS/TLS——hub 在非 E2EE 路径下可见明文**（`relay.ts:239-295`、`e2ee-shim.ts:4-8`）

**⇒ 结论**：用户所说"复用 E2EE"只能复用到**密码学原语**与**公钥分发**（两个 host 的 X25519 公钥都已经在 hub 上）；agent↔agent **没有浏览器可 pin**，主机间握手与信任**必须新设计**。若对外宣称"agent 消息端到端"，需要新增握手（static-static ECDH 或经 hub 中继的 Noise XX/IK 取前向保密）；否则应明确声明"agent 消息对 hub 可见（仅 TLS）"。**本项目选择做端到端，方案见 §6.2（D10/D11）。**

### 2.3 hub 侧：有主机注册，**没有** agent/session 概念

- `hosts(id, owner_id, name, token_hash, e2ee_public_key, created_at)`（`hub/src/db.ts:202-209`）
- **在线态只在内存**：`TunnelRegistry = Map<hostId, TunnelConn>`；`isOnline()` = `tunnels.has(hostId)`；**DB 无 last_seen/online 字段**（`hub/src/tunnel.ts:196-223`）
- 另有现成的**跨 owner 授权模型**：`host_share(host_id, user_id, role)`（`db.ts:227-233`）+ `rdsh_host` HMAC cookie（7 天，绑定会话版本）（`relay.ts:22-34`）
- 进入主机：`/h/<hostId>/...` → 校验归属/分享 → Set-Cookie → 根路径全部转发（`hub/src/server.ts:231-241`）
- **hub 对 host 内部的 session/agent 一无所知**（全仓 `packages/hub/src` 无 agent/session 概念）⇒ **Agent Card 索引是全新表 + 全新上报通道**

### 2.4 hub→host 主动推送：今天不存在，但机制可得

- 现状：gateway 把**任何** hub→gateway 的 OPEN 解释为"访客要访问本地 dsh"（`join.ts:676-690`）；`kind` 只认 `http|ws|raw`，未知 kind → `ERROR BAD_OPEN`（`join.ts:474-477`）
- **没有** hub↔gateway 的控制通道：唯一非应答帧是 PING
- 但 `TunnelConn.send/openStream/openRawStream` 是通用公开方法（`hub/src/tunnel.ts:47-90`），且**未知帧类型被忽略** ⇒ 新增消息族不会炸老组件，但老组件也**不会响应**（需能力协商）

### 2.5 DSH 工具面：可注册，跨版本一致

- API：`import { defineTool } from "@deepseek-ai/dsh-tools"` + `inject = ["tools"]` + `ctx.tools.register(defineTool({...}))`（`dsh-tool-todo/lib/index.js:3,12,95`；服务注册 `dsh-tools/lib/index.js:2567,2606`）
- 必需字段：`name` / `description` / `parameters` / `output{schema,render}` / `execute(args, exec)`；可选 `timeoutMs`、`isConcurrencySafe`、`presentCall/presentResult`
- 参数用 **DSH 自有 JSON-value DSL**（编译为 JSON Schema），**不是** zod/schemastery（`dsh-tools/lib/types/schema.d.ts:9-88`）
- **无 allowlist、无 manifest 字段**：外部插件只要能解析到包 + 被 Cordis 加载即可注册；registry 只做重名/保留名/`output` 必填校验（`dsh-tools/lib/index.js:2774-2781`）
- 跨版本：**0.1.2-rc.1 与 0.1.5-rc.2 同一 API**（`schema.d.ts` 逐字节相同；`lib/index.js` 差异仅 13 行重命名）
- 单次调用上下文：`execute(args, exec)`，`exec` 含 `callId`、`rootCallId`、`agent`、`signal: AbortSignal`、`deferContext()`、`concludeTurn()`（`dsh-tools/lib/types/index.d.ts:197-221,284-301`）
- **没有流式进度通道**：`presentCall/presentResult` 是纯函数、可重放，非实时流 ⇒ 长任务走 `ctx.get("jobs")` + `job_output`（增量读取 / `wait:true` 阻塞）（`dsh-tool-bash/lib/index.js:24-48`、`dsh-tool-jobs/lib/index.js:8-13,229-230`）
- 人工问答：`ctx.userQuestions.ask({questions, agent?, signal})`（`dsh-tool-ask-user/lib/index.js:96-111`）

**实测补充（本次新增，用于决策 D5）**：DSH 启动时会 `healProfilesModuleFallback()`，把整个 DSH 依赖闭包链接到 `$DSH_HOME/profiles/node_modules`（`dsh-app-boot/lib/index.js:657-676`）。本机实测：

```
~/.dsh/profiles/node_modules/@deepseek-ai/dsh-tools
  -> /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools
```

⇒ 插件可解析到**DSH 运行时那一份**（同实例，无双份 `dsh-tools` 隐患）；且 profile 的 `pnpm-workspace.yaml` 已设 `autoInstallPeers: false`，peer 声明不会被装成第二份。

### 2.6 DSH 会话注入：**可行**（本特性的决定性事实）

- 入口（公开、导出在包 `.` 上）：`ctx.sessionController.prompt({requestId, sessionId, mode:"queue"|"steer", content, clientTimeZone}, signal)`（`dsh-api-session-controller/lib/types/index.d.ts:138`；实现 `lib/index.js:2920`；准入 `:778-779` → `agent.steer(message)` / `agent.followup(message)`）
- 低层等价：`ctx.agents.get(id).followup/steer/inject`、`ctx.agents.create/resume`、`ctx.sessions.list/create/get`、`ctx.sessionQuery.*`、`ctx.sessionProjections.snapshot`
- 观测回复：`ctx.sessionController.follow(sessionId)` 是 `@Remote({mode:'stream'})` 的 AsyncIterable（`index.d.ts:171`）；`ctx.agents.get(id).whenIdle()`（`dsh-agent/lib/types/runtime-types.d.ts:166`）
- 取消：`sessionController.cancel(...)`、`agent.cancel(...)`
- **`ctx.subagents.sendMessage` 不可用于任意寻址**：强制直系父子邻接，非直系抛 `UNAUTHORIZED`（`dsh-subagent/lib/types/index.d.ts:118-131,147-149`）
- 参考实现：`dsh-webhook` 的运行时动作就是「创建并 prompt 一个 root 会话」（`dsh-webhook/lib/index.js:101-138`），但其路由包**未在 web profile 默认加载**，且 HMAC 共享密钥、无 per-user 身份

⇒ **推模式成立**：目标主机的 agent 可以被"叫醒"并处理消息，`ask_remote` 也能真实等到回复（无需退化为"轮询收件箱"的拉模式）。

### 2.7 🔴 安全事实：注入零授权，官方围栏明说"不是认证层"

- `ctx.sessionController.prompt` **进程内没有任何授权**——任何声明 `inject:['sessionController']` 的插件都能给任意会话投递
- `/api` 路径上唯一的门是 Host/Origin 浏览器围栏，官方注释直书：*"…binding policy belongs to the webserver config, and **this fence is not an auth layer**."*（`dsh-client-connection/lib/index.js:125-136`）
- `Agent` 的 `inbox/cancel/whenIdle` **无 owner 校验**——持有 live handle 即视为有权限

⇒ **「谁能给我的 agent 派活」这件事，DSH 不替我们做，必须是本特性自己的责任**，且是产品能否长期开着的分水岭（见 §6）。

### 2.8 Go hub 现状

`go/` 目前**只有 README**（11 行，写明 "Empty until the prototype (TS hub) is validated"，并承诺实现 `packages/tunnel/PROTOCOL.md` 的规范线协议）。⇒ 「Go 是否与 v1 语义一致」无从偏差；但也意味着 **agent 层的一切新语义必须写进 `PROTOCOL.md`**，否则未来 Go hub 无据可依（协议先行纪律）。

---

## 3. 目标架构

### 3.1 四层

```
L4 工具面    list_peers / send_to_peer / ask_remote           ← 本地 agent 可见（DSH 工具注册）
L3 Agent 协议 AgentCard 发现 + AgentMessage（§3.3）+ 投递语义（回执/超时/去重/离线队列）
L2 寻址与索引 hub 侧 Agent Card 索引（能力标签 + 在线态）+ 路由（不解析载荷）
L1 传输     复用 tunnel v1：host 出站 / mux / 心跳 / 重连（**线协议不改**）
```

### 3.2 组件边界（2026-09-11 决策：**不重构现有组件**）

| 类别 | 内容 |
|---|---|
| **全新组件**：`packages/agent-mesh` → npm `dsh-agent-mesh`（DSH 插件） | 三个工具、`/agent-inbox` 路由 + 验签 + 授权、AgentCard 上报、correlationId/job 管线、`cordis.patch.yml` loader 行 |
| **复用为库（不改一行）** | `rdsh-gateway`（读 `host.json` / host token / 现有 E2EE 原语）、DSH 的 `dsh-tools`（peerDependency）、`sessionController` / `agents` 服务 |
| **hub 侧加法** | 新表（`agent_cards`、可选 `agent_messages`）、新 API（`POST /api/agent/cards`、`POST /api/agent/send`）、投递复用现有 `TunnelConn.openStream` |
| **绝不触碰** | `rdsh-tunnel` 线协议（不加帧类型/协商）、`rdsh-gateway` 的转发与 join 逻辑、`dsh-web-remote`、CLI、portal（除非以后加拓扑页） |

**为什么"新插件"在 host 侧成立（事实）**：它需要的三件事都与"谁持有隧道"无关——

1. **入站路由**：注册在本地 dsh 的 webServer 上；**任何**持有隧道的组件（CLI 服务 / `dsh-web-remote`）都会把访客请求转发到本地 dsh，路由照样命中（§2.1、`packages/gateway/src/proxy.ts:41-60`）；
2. **叫醒本地 agent**：`ctx.sessionController.prompt`（§2.6），与隧道无关；
3. **对外发消息**：它自己就是一个普通 HTTPS 客户端（本机 host token 认证），不需要隧道。

⇒ `dsh-agent-mesh` 是**隧道无关**的：不建隧道、不抢 `join.lock`、不改 `rdsh-gateway`。它假设"本机已通过 CLI 服务或 `dsh-web-remote` 接入 hub"，未接入时报明确错误（见 D9）。

**已知副作用**：CLI 持有隧道时会 spawn **它自己的** `dsh web` 实例，入站消息会落到那个实例；详见 §9 开放问题 6。

### 3.3 AgentMessage 信封（现在定，P1 加密时才填 `security`）

```jsonc
{
  "from": {"owner":"…","host":"…","agent":"…"},
  "to":   {"owner":"…","host":"…","agent":"…"},
  "type": "ask" | "reply" | "event" | "ack",
  "correlationId": "…",
  "security": {
    "e2ee": "x25519-nk-v1" | null,   // 明确标注，不靠猜
    "senderKeyId": "<指纹>",          // 接收方据此选 pin
    "sig": "<Ed25519 签名，覆盖除 sig 外全部字段>"
  },
  "payload": "<不透明字节：明文 JSON 或 AEAD 密文>"
}
```

**hub 只读 `from` / `to` / `type` / `correlationId` 用于路由与授权；`payload` 对 hub 永远不透明**——与现有 `kind:"raw"` E2E 帧同构（hub 原样透传、不解析）。

**身份字段用稳定 ID（D25，2026-09-11 定）**：`from.host` / `to.host` 填 **host UUID**（`hosts.id`），`owner` 填 `owner_id`；**`name` 只用于展示**，由接收侧按 hostId 解析（解析不到则退回显示 hostId）。

- 事实依据：`hosts.name` **无任何唯一约束**（`packages/hub/src/db.ts:205`）且**可改名**（`db.ts:645`、接口 `api.ts:1302`）；`users.name` 虽唯一（`db.ts:178`）但在 D20 范围内恒为同一账号，只提供语境不提供消歧；唯一稳定的是 `hosts.id`（`randomUUID()`，`api.ts:1464`）。
- 若把 name 放进签名/pin 表，会有三个后果：重名让两台 host 挤进同一条 pin 记录（误报"密钥变了"，或**静默接受另一台的签名**）；改名切断 pin 与审计关联；同账号内可被同名冒充。

### 3.4 寻址 / 发布 / hub 职责边界

- **寻址**：`agent://<owner>/<host>/<agent-or-session>`（范围收敛后 `<owner>` 恒为同一账号，保留该段是为了将来可扩展与便于审计）
- **谁发布 AgentCard**：**host 侧**（`dsh-agent-mesh`）经**出站**上报，绝不让 hub 主动连 host（保住「host 只出站、无需公网 IP」这一核心不变量）
- **可见性**：仅**同一 owner** 内可见；且**只有开启 mesh 的 host 才上报**（未开启 = 对外不存在，D14）
- **hub 职责边界**：索引 + 路由 + 在线态（+ 可选离线队列）；**不解析内容**

---

## 4. 端到端流程（MVP：**零线协议改动**）

```
A 机 agent 调用 list_peers / send_to_peer / ask_remote
  │  （工具在 A 机插件进程内执行，from 取 exec.agent 的真实身份）
  ▼
A 机插件 → hub：HTTPS POST /api/agent/send（本机 host token 认证）
  │  ← 纯出站请求，复用既有 host token，无协议改动
  ▼
hub：① 校验 B 与 A 属于**同一 owner**（`sender.owner_id === target.owner_id`，§0.1）
     ② 查 B 在线（TunnelRegistry）且 B 已开启 mesh（方向允许 receive）
     ③ 在 B 的既有隧道上 openStream(kind:"http", path:"/agent-inbox")
        ← 复用现有 relay 机制（hub/src/tunnel.ts:47-90）
  ▼
B 机 gateway：按既有规则转发到本地 dsh（Host/Origin 重写 + 会话 cookie 注入，proxy.ts:41-60）
  ▼
B 机插件新增路由 /agent-inbox：
     ① 验 hub 签名头（防本机/浏览器伪造）
     ② 同 owner ⇒ **无需逐次人工确认**（§0.1）；仅校验"本机 mesh 已开启 + 该能力被允许"
     ③ ctx.sessionController.prompt({sessionId, mode:"queue", content})  ← §2.6
  ▼
B 的 agent 被唤醒；回复经 follow(sessionId) 观测 → 与 correlationId 配对 → 回传 A
```

**回复回传**：B 插件 `follow()` 等到本轮完成，取最终文本；短应答可随 HTTP 响应直接返回，长任务则落成 **job**（§2.5：DSH 无流式进度，长任务走 `jobs`），A 侧用 `job_output` 等待/轮询。

**为什么先走这条**：它把"新协议"推迟到确实需要（长连接、流式、低延迟）时；MVP 只动 hub 的两个 API + 新插件的一条路由 + 三个工具。**线协议、gateway 转发、`dsh-web-remote` 均零改动**（§3.2）。

**目标形态（P3+）**：若要更低延迟/流式/双向推送，再新增帧类型 `AGENT`（如 `0x07`）+ **能力协商**（连接后声明 `agent: true`，否则老 host 只会静默忽略，见 §2.4）。**载荷加密不属于这条**——它按 D10 与 P1 同期上线（见 §6、§7）。

---

## 5. 失败路径与投递语义（必须显式定义）

| 场景 | 语义决定 |
|---|---|
| **非同一 owner 投递** | **一律拒绝**，不进入消息流程（D20）；hub 返回明确错误码，不静默丢弃 |
| **对端未开启 mesh / 方向不允许 receive** | 拒绝并给出可读原因（D14/D19） |
| **环路（A→B→A）与风暴** | 仅单跳 + 跳数上限/`visited` + `correlationId` 去重（D18） |
| **对端离线** | **P1 立即失败**（错误中说明"对端离线/未开 mesh"），**不做离线队列**（D22；队列留 P4） |
| **同步等待上限** | `ask_remote` 默认**同步等 60s**；快任务直接返回结果（D21） |
| **转异步** | 超 60s ⇒ 返回"仍在运行 + jobId"，A 侧 agent 可继续干别的，后续用 `job_output`（增量读 / `wait:true`）取回（D21） |
| **总超时 / 卡死** | 默认**总上限 10 分钟**，另有"N 分钟无进度"看门狗提前失败（D21） |
| **取消** | **P1 即可取消**：A 取消 → B 侧 `sessionController.cancel`；两端都能看到并终止（D21） |
| **进度上报** | B 侧由 `sessionController.follow(sessionId)` 观测，**节流**为 `type:"event"` 进度（每 10–15s 或状态变化：busy/idle、最近活动、可选一行摘要）；**不转发对端内部推理/token 流**（D21） |
| 重复投递 | 幂等键 = `correlationId`；对端去重窗口 |
| 顺序 | 同一 `from→to` 是否保序（建议：按会话 FIFO，不承诺全局） |
| 大 payload | 直接放消息体（16 MiB 帧上限内）还是"引用 + 拉取" |
| 背压/配额 | 每 peer 速率与并发上限（hub 已有 TLS/限流基建可参考） |
| 目标会话选择 | **默认投递到对端专用收件会话**，**绝不默认插入人类正在使用的会话**（防上下文劫持；D16 已定） |
| **运行实例** | **P1 只支持"隧道持有者那个 dsh 实例"**（CLI 服务或 `dsh-web-remote` 插件持有的那个）；"复用已在运行的 dsh"另立特性（D23） |

---

## 6. 安全与信任模型

### 6.1 授权（范围收敛后大幅简化：同 owner 免审批）

范围定案为**仅同 owner**（§0.1）后，授权从"三层 + 人工确认"降为**两处校验 + 一条审计**：

1. **hub 侧**：`sender.owner_id === target.owner_id`（一行判定）——不同 owner 一律拒绝，不进入消息流程；hub 记录元数据审计（from/to/time/size）
2. **host 侧**：入站 `/agent-inbox` 必须验 hub 签名头（由 host token 派生密钥），拒绝本机/浏览器伪造；再校验"本机 mesh 已开启 + 方向允许 receive + 能力在上限内"（D19）
3. **不再需要逐次人工确认**（同账号免审批）——改以**可见 + 可叫停** 替代：跨主机任务在执行侧以 job 呈现，两侧都能看到并终止
4. **身份以 hub 断言为准**：接收端**不信任**信封 `from` 文本，改用 hub 签名头里断言的发送方身份；而 `from` 又被发送方签名覆盖 ⇒ hub 改写路由字段会被检出（D4 + D10）
5. **防重放**：hub 签名头材料 = `method + path + timestamp + nonce + body hash`；host 拒绝时间偏移 >60s 的请求并缓存已见 nonce —— 否则一次重放就等于往收件会话再灌一次 prompt（重复干活 + 烧 token）

能力标签（AgentCard）同样需要签名防冒名（见 6.2）。**AgentCard 的可见性**随范围收敛而定：仅同一 owner 的 host 之间可见（未开启 mesh 的 host 不上报、也不可见）。

**为什么同 owner 仍需 D17–D19 三条边界**（不是所有风险都随"同一个账号"消失）：共享出去的 host 可能被别的账号使用（D17）；同一账号内一台被攻破的 host 理论上能指挥其余全部（D19）；而消息链路本身可能出现 A→B→A 或广播风暴（D18）。

### 6.2 机密性：agent↔agent 要做端到端（2026-09-11 讨论定案）

**背景事实（§2.2）**：现有 E2EE 是**浏览器↔host**（简化 Noise NK + 浏览器 pin host 公钥），**host↔hub 只有 TLS**，hub 在非 E2EE 路径下可见明文。

**为什么 agent 消息更需要加密**：hub（尤其 rdsh.cn 这类**多租户** hub）既不是发送方也不是接收方；agent 之间交换的是任务、代码与上下文。而产品对外已经承诺过「路上内容是加密的，中转服务读不到内容」——若 agent 消息明文过 hub，等于给该承诺开了一个**用户想不到的例外**。因此不采用"先明文上线、以后再补"的路线。

**范围收敛后这条依然成立（重要）**：`仅同 owner` 收敛的是**授权**，不是**机密性**。判断标准是"**hub 由谁运营**"，而不是"两端是否同一个账号"：

| hub 归属 | hub 能否读 agent 消息 | 结论 |
|---|---|---|
| 用户自建（自己的服务器） | 运营者即用户本人 | 明文过 hub 可接受；E2EE 降级为可选加固 |
| **rdsh.cn / 任何第三方 hub**（参考部署） | **能读**——即便 A、B 属于同一 owner | **必须 E2EE** |

**方案（D10）**：**B = 静态 X25519 ECDH + Ed25519 签名 + 账号内信任（指纹校验为可选加固）**

| 要素 | 做法 | 复用情况 |
|---|---|---|
| 机密性 | 两侧用 host **已有**的静态 X25519 密钥做 ECDH → HKDF-SHA256 → AES-256-GCM | 密钥已存在（`~/.rdsh/e2ee-key.json`）且**公钥已注册在 hub**（`hosts.e2ee_public_key`），原语在 `packages/gateway/src/e2ee.ts` |
| 真实性 | **新增 Ed25519 签名密钥**：host 本地生成、注册时上传公钥（hub `hosts` 表加一列）；每条消息与 AgentCard 均签名 | 新（X25519 只能 DH、不能签名） |
| 抗 MITM | **同 owner ⇒ 账号内互信**：hub 在同账号内分发对端公钥即可；**指纹展示/比对降为可选加固**（不再是必经流程，因为已无跨 owner 配对 UX） | 复用现有"浏览器 pin host 公钥"的交互范式（`hub/src/e2ee-shim.ts:52-61`），可选使用 |
| 前向保密 | P1 **不做**（static-static 无 FS）；P3 可升级为临时密钥握手 | 见分期 |

> 为什么不"全账号共用一个对称密钥"：那样一把密钥泄露就等于整个 mesh 沦陷；按 host 对做 ECDH 能把爆炸半径限制在单对 host。

**威胁模型必须诚实（2026-09-11 补，R15）**：对端公钥由 **hub 分发**，而指纹比对只是"可选加固" ⇒ **恶意 hub 可以主动 MITM**（替换对端公钥后全解）。因此默认行为改为 **TOFU + 本地 pin**：首次见到某 peer 的公钥即固定，之后**变更就拒绝并告警**，需人工显式重新 pin（与 SSH 同模型）；人工比对指纹仍是可选。文档必须写清边界：**防被动窃听 / 防第三方 ✓；防恶意 hub 的主动 MITM ✗（除非人工比对过指纹）**。

**跨协议复用与重放的实现约束（2026-09-11 补）**：同一把 host X25519 静态密钥同时服务于"浏览器↔host 的 NK"与"agent↔agent"，KDF 必须用**独立 label**（如 `rdsh-agent-msg-v1`）并把 `from`/`to`/`type`/`correlationId`/协议版本放进 **AAD**，避免跨协议混淆；nonce 用随机 12B（静态长驻密钥下不要用计数器当唯一防线），配合 `correlationId` 去重窗口。签名覆盖除 `sig` 外**全部字段**，接收端顺序固定为 **先验签 → 再解密 → 再 prompt**。

**与分期的绑定（关键）**：**E2EE 与"第一个会传 payload 的版本"同期上线**——
- P0 只有发现（`list_peers`），**不传 payload、无隐私暴露** ⇒ 可先落地，不需要 E2EE；
- P1（`send_to_peer`，第一次传数据）**必须带 E2EE**，避免出现"已经能传数据但还没加密"的窗口期。

**hub 侧不需要为加密做任何特殊处理**：信封的路由字段明文（供授权与路由），`payload` 不透明——与现有 `kind:"raw"` E2E 帧同构。

### 6.3 E2EE 明确**做不到**的事（必须对用户诚实）

1. **元数据仍可见**：谁与谁通信、频率、消息大小、时间——hub 为了路由必须知道；
2. **防不了恶意 hub 的可用性攻击**：丢弃、延迟、重排、选择性审查仍可能（可用序号 + 回执 + 超时重传缓解）；
3. **端点被攻破则密钥失效**：E2EE 不解决端点安全；
4. **不替代授权**：授权仍是 hub 侧元数据级策略（同 owner 判定 + 每主机方向/能力上限，§6.1）；加密只保证"内容不被第三方读"，不决定"谁有权派活"；
5. **无前向保密（P1 阶段）**：长期静态密钥一旦泄露，历史密文可解——这是 P3 才补的。
6. **账号内横向移动**：同账号内任一台 host 被注入或攻破，它的 agent 可以指挥其余已开 mesh 的主机（这是"同 owner 免审批"的直接推论）。**不做逐 peer 审批**（理由见 §9.9），改为按影响面约束：D19 方向/能力上限 + 每对 peer 限速、R16（可信头 + 破坏性操作仍走人类确认）、以及跨主机投递审计。

---

## 7. 分期建议

范围收敛为**仅同 owner**（§0.1）后，跨 owner 相关的工作整段消失，分期也变短：

| 阶段 | host 侧（`dsh-agent-mesh` 新插件） | hub 侧（加法） | 载荷 / E2EE | 可独立交付 |
|---|---|---|---|---|
| **P0** | 读配置 + AgentCard 上报 + `list_peers`（只读发现） | `agent_cards` 表 + 上报/查询 API（**同 owner 过滤**） | 无载荷 ⇒ 不需要 E2EE | ✅ 零执行风险、零隐私暴露 |
| **P1** | `/agent-inbox` 路由 + 验签 + mesh 开关/方向校验 + `send_to_peer` | `POST /api/agent/send`（**owner 相等**一行判定）+ 用现有 `openStream` 投递 | **有载荷 ⇒ 与 E2EE 同期上线（D10）** | ✅ |
| **P1.5** | **广播投递**：`broadcast_to_peers`（本地扇出 N 份逐对加密，逐台返回结果）—— 见 R14 / D24 | 无（复用 P1 的投递路径） | 复用 | ✅ 成本≈0 |
| **P2** | `ask_remote`（correlationId + `follow` + job 化）+ 叫停 | 可选：投递回执与审计记录 | 复用 P1 会话密钥 | ✅ 用户价值点 |
| **P2.5** | **散射-收集**：广播 + 聚合回复（受 D21 超时/取消约束）；防风暴与配额 | 无 | 复用 | ✅ |
| **P3** | E2EE 增强：临时密钥（前向保密）、密钥轮换 | 可选：能力协商（若确需新增帧类型） | 增强 | — |
| **P4** | 能力路由（"谁会做 X"→ 自动选 peer）、配额、mesh 视图 | 运营后台对接（复用 10-admin） | 复用 | — |

**两个前置项**：

1. **心跳偏差（§2.1）—— 已定，且独立修复**：两侧实现文档已写的「10s 未回 PONG → 判离线并断开」+ hub 也开始发 PING（D7）。**独立记录**：[doc/fix/20260911-heartbeat-pong-timeout/record.md](../../fix/20260911-heartbeat-pong-timeout/record.md) —— **已完成**（2026-09-11：协议先行 + 两侧实现 + 测试；真实时序 40.1s 判离线），不混进本特性立项。
2. **P0 的降级验证技巧**：先支持**静态 peer 表**（配置里写死对端），可在**不改 hub** 的情况下验证工具面与 `/agent-inbox` 注入链路（路由仍可被 hub 既有 http OPEN 命中）；等链路验证通过，再上 hub 索引。

**验收剧本（已作为 `req.md` 验收标准的基础）**：同一账号下的两台真实 host（如 iMacPro 与 office-mac-studio），各跑一个 DSH，均开启 mesh；在 A 的会话里说"让 B 做 X"→ A 的 agent 调 `ask_remote` → B 的收件会话被唤醒并完成 → 结果回到 A 的会话；同时覆盖：长任务（超 60s 转 job + 节流进度 + 可取消）、对端离线（立即失败并给出原因）、hub 只能看到路由元数据（payload 不可读）、非同一 owner 无论是否开 mesh 一律拒绝。

---

## 8. 决策汇总（D 编号）

| # | 议题 | 结论 | 状态 |
|---|---|---|---|
| **D20** | **范围边界** | **只有同一 owner 的 host 才能处于同一 mesh**；跨 owner 一律拒绝（§0.1） | ✅ **用户已定（2026-09-11）** |
| D1 | feature 目录与命名 | `21-agent-mesh`（中文名「跨主机智能体通信层」） | ✅ 已定 |
| D2 | 机密性目标 | agent 消息做**端到端加密**，且与首个带载荷版本（P1）同期上线（P0 纯发现不传载荷，无需加密）——见 D10 | ✅ **已定（2026-09-11）** |
| D3 | MVP 载体 | 走 §4「hub API + 既有 http OPEN + `/agent-inbox`」，**零线协议改动**。可行性已核实为事实：gateway 转发无路径白名单（`req.url` 原样透传，`packages/gateway/src/proxy.ts:81`、WS `:143`）⇒ 插件自建路由可被既有隧道命中 | ✅ **已定（2026-09-11）** |
| D4 | 授权模型 | hub 侧 **`owner_id` 相等**；host 侧验 hub 签名头 + mesh 开关/方向/能力校验（D14/D19）。**补两条硬约束**：① 签名材料 = `method+path+timestamp+nonce+body hash`，拒绝 >60s 偏移并缓存已见 nonce（**防重放**）；② **身份以 hub 断言为准**，不信任信封 `from` 文本（§6.1） | ✅ **已定（含细化）** |
| D5 | 插件依赖策略 | `@deepseek-ai/dsh-tools` 声明为 **peerDependency**（实测 fallback 指向 DSH 那份；`autoInstallPeers:false`；声明成 dependency 会装出第二份、模块实例不同）；补兼容范围声明 + 缺失时明确报错 | ✅ **已定（2026-09-11）** |
| D6 | 与 proposal §7「gateway 永不需要改动」承诺的关系 | 把承诺写精确为「**老 host/gateway 永不因 hub 升级而失效；新增帧类型必须向后兼容 + 能力协商**」（现存"未知帧类型忽略、未知 flag 保留"即该机制）；**本期故意不动用该例外**；边界补进 `doc/overview/proposal.md` §7 | ✅ **已定（2026-09-11）** |
| D7 | 心跳偏差（文档 30s+10s 超时 vs 实现只有 gateway 发 PING、无 PONG 超时判定） | **两侧实现文档已写的行为**：各自记录未回 PING → 10s 超时 → 主动断开（断开触发既有重连）；**hub 也开始发 PING**。**独立修复**：[doc/fix/20260911-heartbeat-pong-timeout/](../../fix/20260911-heartbeat-pong-timeout/record.md)，排在 P0 前 | ✅ **已实施并验证（2026-09-11）** |
| D8 | 组件边界 | host 侧 = **全新插件 `dsh-agent-mesh`**；**不重构** `rdsh-gateway` / `dsh-web-remote`；hub 侧**加法式**新增；线协议与 gateway 转发零改动（§3.2） | ✅ **已定（2026-09-11）** |
| D9 | 前置依赖 | `dsh-agent-mesh` **不建隧道**，依赖"本机已通过 CLI 服务或 `dsh-web-remote` 接入 hub"；未接入时报明确错误。**补**：插件必须装在"**隧道持有者那个 dsh profile**"（CLI 持隧道时会 spawn 自己的 dsh 实例），并提供"我是否入站目标"的自检；文档写明**一 token 一隧道** | ✅ **已定（含补充）** |
| D10 | 机密性方案 | **方案 B**：静态 X25519 ECDH（复用 host 现有密钥）+ **Ed25519 签名** + **账号内信任**；E2EE 与 P1 同期上线（§6.2）。**补三条**：① 威胁模型诚实化 + 默认 **TOFU 本地 pin**（见 R15 / §6.2）；② KDF **独立 label** + AAD 绑定路由字段、随机 12B nonce、不与浏览器↔host E2EE 跨协议复用；③ 签名覆盖除 `sig` 外全部字段，接收端 **先验签→再解密→再 prompt** | ✅ **已定（含细化）** |
| D11 | 密钥与身份 | 复用 host 现有 X25519 静态密钥协商；**新增 Ed25519 签名密钥**（本地生成、注册上传、hub `hosts` 加一列），用于消息与 AgentCard 签名防冒名。**密钥生命周期 P1 最小版**：密钥变更 ⇒ 对端 pin 校验失败 + 可读告警 + 人工显式重新 pin；**不做撤销广播** | ✅ **已定（含细化）** |
| D12 | 交互模型 | **代表制为默认**：人在自己惯用的一台（primary host / 指挥台）工作，通过 agent 联络 peer；排障时仍可进任意一台。**会话保持主机本地、跨主机只传消息——按安全不变量对待**（合并上下文会让一台机器读到的敏感内容无声流入另一台） | ✅ **已定（含强化）** |
| D13 | 访问层级不变量 | L0 消息 / L1 旁观单个会话 / L2 完整进入；**mesh 只给 L0**；L2 必须显式 `host_share`；**agent 永不获得 L1/L2**（L1 旁观只给人）（§1.2） | ✅ **已定（硬不变量）** |
| D14 | mesh 启用粒度 | **主机级开关（默认关）**；未启用的 host 不上报 AgentCard、对外不存在。**补**：① 能力标签**默认最小**（只暴露通用 `task`），描述性标签（docker/GPU/集群等）需显式 opt-in；② 关闭/开启必须可被 hub 感知 —— 变更即时上报 + AgentCard **TTL 90s** + 优雅退出主动报 off（R1 的"≤30s 出现/消失"据此可测） | ✅ **已定（含补充）** |
| D15 | 审批 | **同 owner 免逐次审批**，以"可见 + 可叫停"替代（§6.1）。**已明确的边界**：① **开启 mesh 即授权声明**，**不设逐 peer 人工闸门**（R17 不采纳，见 §9.9）；② 首次接触以"可见"呈现（可信头"新 peer"标记 + peers 列表标注）；③ 可撤回（关 mesh / 改方向 / 拉黑单台，≤30s 生效）+ 跨主机投递留审计。**已知代价**：我的 agent 可花我在另一台机器上的额度/时间而不问我 —— 由 D19 的上限 + R16 + 审计约束（残余风险见 §6.3.6） | ✅ **已定（2026-09-11，含边界）** |
| D16 | 身份粒度 | **每主机一张卡**（人可读名字用 hub 上已有的 host `name`）；**P1 不做会话级暴露**；入站固定落对端**专用收件会话** | ✅ **已定（Q1）** |
| D17 | 共享成员不入 mesh | 被 `host_share` 分享给其他账号的 member **能进 UI，但不能用其 agent 调用本 mesh**；反向亦成立（我方 agent 不入对方 mesh）；peer 列表不出现"分享给我的 host"。实现 = mesh 资格只看 host 自身账号的 `owner_id`，**永不**从 `host_share` 推导 | ✅ **已定（含实现口径）** |
| D18 | 单跳 + 防环 | **仅单跳**（A→B；A→B→C 不允许）；`visited` + 跳数上限 + `correlationId` 去重。**补"回复风暴"**：`type:"reply"` **永不触发新的 ask**，外加每对 peer 速率/并发上限与熔断 | ✅ **已定（含补充）** |
| D19 | 每主机方向与能力上限 | mesh 方向可分 **send-only / receive-only / both**，并支持"只接受某类能力标签"。**细化**：**接收侧校验为准**（不信发送方声明），hub 存一份用于"早失败"；默认方向 both、能力白名单最小、每对 peer 限速 | ✅ **已定（含细化）** |
| **D21** | **长任务进度语义** | `ask_remote` **默认同步等 60s**→ 快任务直接返回；超时**转 job**（返回 jobId，`job_output` 增量读/`wait:true`）；默认**总上限 10 分钟** + "N 分钟无进度"看门狗；**P1 即可取消**（A 取消 → B `sessionController.cancel`）；进度由 B 侧 `follow` 观测并**节流**为 `type:"event"`（10–15s 或状态变化：busy/idle、最近活动、可选一行摘要）；**不转发对端内部推理/token 流** | ✅ **已定（Q2+Q4）** |
| **D22** | **离线/可达性语义** | **P1 立即失败**（错误说明"对端离线 / 未开 mesh"），**不做离线队列**（留 P4） | ✅ **已定（Q3）** |
| **D23** | **运行实例边界** | **P1 只支持"隧道持有者那个 dsh 实例"**（CLI 服务或 `dsh-web-remote` 持有的那个），并在文档写明；"CLI 复用已在运行的 dsh"另立特性 | ✅ **已定（Q5）** |
| **D24** | **广播与总线的处置** | 「群组广播 / 总线 / 订阅」**拆开**：**广播/散射-收集纳入本期**（P1.5 扇出投递 → P2.5 聚合；复用逐对加密 + 本地扇出，无 hub 语义改动）；**总线/订阅（topic + retention）= 另立特性 `22-agent-bus`**（群组密钥、保留与位点、ACL/配额）——分析见 §10 | ✅ **已定（2026-09-11）** |
| **D25** | **身份与展示字段** | wire 上 `from`/`to` 的 `owner`、`host` 用**稳定 ID**（`owner_id` / host UUID），**`name` 仅展示层**由接收侧按 hostId 解析（解析不到则退回 hostId）；pin 与授权键 = **hostId + 指纹**；人类可见头由插件从**验签后的字段**生成（首次接触或指纹变更时含指纹）。事实依据：`hosts.name` 无唯一约束且可改名（`db.ts:205`/`645`、`api.ts:1302`），唯一稳定的是 `hosts.id`（`api.ts:1464`） | ✅ **已定（2026-09-11，本轮新增）** |

---

## 9. 开放问题

> 已随 v3/v4 收敛或定案而删除的：谁可以被发现、是否人工审批、跨 owner 计费（D20）、身份粒度（D16/Q1）、结果语义（D21/Q2）、隧道实例（D23/Q5）。

1. ~~**能力标签由谁声明**~~ → **P1 已定最小集（D14）**：默认只暴露通用 `task`；描述性标签（docker / GPU / 集群等）需显式 opt-in。*仍开放*：是否允许"模型自述"标签、是否需要受控词表（P4 能力路由时再定）。
2. **多跳**：D18 已定仅单跳；若未来确需 A→B→C，需重新评估授权与跳数上限。
3. **与 portal/app 的关系**：人类是否需要在 portal 上看到 mesh 拓扑与消息审计？P2 还是 P4？
4. **配额与循环**：同一账号内仍需"防跑飞"——每 host 的并发/速率上限、A↔B 互相触发导致环路的检测与熔断（与 D18 相关）。P1 最小集是什么？
5. **L1 是否给共享成员**：D17 已定"成员不入 mesh"，但成员能否**旁观**（L1，只读那个收件会话）？若给，是否算越权？
6. ~~**密钥生命周期**~~ → **P1 最小版已定（D11）**：密钥变更 ⇒ 对端 pin 校验失败 + 可读告警 + 人工显式重新 pin；**不做撤销广播**。*仍开放*：host 被移出账号 / 重装时的旧对端缓存清理（与 P3 密钥轮换一并处理）。
7. **多设备选择**：同一 owner 多台 host 都能做同一件事时，是否需要"就近/负载/能力优先"的选择策略，还是交给人显式指定（P4 能力路由的前置问题）？
8. **job 的可恢复性**：A 侧进程重启后，`ask_remote` 转成的 job 是否可恢复（DSH jobs 的既有语义）？还是明确"重启即丢失，需重问"？
9. ~~首次接触确认（R17）~~ → **不采纳（2026-09-11 用户定）**：**开启 mesh 本身就是一次授权动作** —— 一个 peer 能出现的前提是 owner 自己签发 join token（`api.ts:1468` 要求 token 属于该 owner）、在那台机器执行 `rdsh host join`、并安装启用本插件；同账号 = 已授权，逐 peer 再问一次属**重复授权**。且闸门只对"每对 peer 的第一条"生效（正常人第一条几乎必然是自己发的，点过一次即永久开放），对 injection 的实际防护 ≈ 一次性减速带，却要新增 pending 语义、headless 审批路径与离线队列的审批定义。**替代（不阻塞）**：开启文案即授权声明 + 首次接触在可信头标记"新 peer" + 可撤回（≤30s）+ 审计；残余风险见 §6.3.6。

---

## 10. 广播与总线（被推迟的方向，2026-09-11 讨论）

> 结论见 **D24**：**广播/散射-收集纳入本期**（P1.5 扇出投递 → P2.5 聚合；复用逐对加密 + 本地扇出，无 hub 语义改动）；**总线/订阅 = 另立特性 `22-agent-bus`**（涉及群组密钥、保留与位点语义、主题 ACL/配额）。用户判断：**本期「1 对 1 + 广播」已够用**。

### 10.1 三件事的成本分层（不要打包看待）

| | 谁决定收件人 | 最小实现 | 增量成本 |
|---|---|---|---|
| **广播**（扇出 / 散射-收集） | 发送方 | 本地对每个 peer 各发一次既有投递 | **≈0** |
| **总线**（发到主题） | 订阅方 | hub 新增主题注册 + 路由 | 中（hub 数据模型 + ACL） |
| **订阅**（持久兴趣） | 订阅方 | 保留 + 位点/重放 + 至少一次 | 高（**与 D22「不做离线队列」冲突**） |

### 10.2 广播为什么不贵

- **加密**：复用**逐对**会话密钥（每对 host 一把，D10），天然正确，无群组密钥问题
- **授权**：仍是"同账号 + 对方已开 mesh"（D20/D8），无新模型
- **代价**：N 倍上行；**无全局顺序**（各收各的）
- **必需防护**：N 份回复若自动回发 ⇒ **N² 风暴** ⇒ 必须配 D18 的防环/去重 + 每主机配额（§9 Q4）
- **最实用形态**：**散射-收集**（广播出去 + 本地聚齐 N 份回复），不需要 hub 参与语义

### 10.3 总线的三个硬点

**1）群组加密（最大的一处）**：D10 是**逐对**静态 X25519，**不能直接用于群组**。

| 方案 | 说明 | 代价 |
|---|---|---|
| 逐对加密 N 份 | 发布者给每个订阅者各加密一份 | O(N) 加密与上行；且发送方必须知道订阅者名单（**退化成广播**） |
| 群组密钥（Sender Keys） | 每个发送者分发链式密钥，订阅者各自派生 | 需**成员变更时轮换**、密钥分发通道、前向保密设计 |
| MLS / 标准群组协议 | 标准化、可扩展 | 引入实现依赖，超出本项目当前密码学体量 |

**2）投递语义**：保留多久、位点/重放、至少一次 + 去重、离线补发还是丢弃。而 **D22 明确本期不做离线队列** ⇒ 总线等于要**重新引入一套保留与补投机制**（hub 从"纯转发"变成有状态）。

**3）治理**：主题命名（自由字符串 vs 受控词表）、发布/订阅 ACL、每主题速率配额、退订与审计。

**4）现有资产勘误**：hub 已有 `EventHub`（`/api/events`），但它是**面向浏览器、非持久、非跨 host** 的 ⇒ **不能当总线用**。

### 10.4 什么时候值得上总线（判断阈值）

- host 数量 **≥ 4–5**，**或**数量会经常变动（"加机器即接入"才有价值）
- 存在真正的**事件型流量**（构建完成、代码已推送、磁盘告警），而不是请求-应答
- 需要"新机器订阅即开始工作"，且**不希望改任何既有 host 的配置**
- 能接受 hub 职责从"纯转发"变为"**存密文 + 主题元数据**"（仍零知识，但不再无状态）
- 反之（2–3 台、事件很少）⇒ **广播扇出就够**，不值得付群组密钥与保留语义的成本

### 10.5 总线的好处（供将来立 `22-agent-bus` 时复用）

**语义解耦**（发送方不知道收件人是谁、有几台、在不在线）、**异步不阻塞**（发布即走，不等回执）、**新增机器零改动**（订阅即接入）、**多智能体协作从 N² 链路降到 N**（共享黑板式协作）、**统一审计与可观测**（主题是一等公民，"谁发布/谁收到"有统一记录）。

> ⚠️ 诚实提醒：**在没有群组密钥之前，总线的好处几乎全在语义层，不在带宽层**——E2EE 下发布方仍需产出 O(N) 份密文。

---

## 11. 参考

- 传输契约：`packages/tunnel/PROTOCOL.md`（帧表、mux、心跳、流式约束）
- E2EE（现有，浏览器↔host）：`packages/gateway/src/e2ee.ts`（X25519+HKDF+AES-GCM 原语与 `rdsh-e2ee-nk-v1` label）、`packages/gateway/src/e2ee-key-store.ts`（host 静态密钥持久化）、`packages/hub/src/e2ee-shim.ts` + `packages/portal/src/pages.tsx`（pin 流程与指纹确认）
- host 公钥分发现状：`packages/hub/src/db.ts`（`hosts.e2ee_public_key`）、`packages/gateway/src/join.ts`（注册时上报）⇒ **D10/D11 的密钥协商基础已就绪，仅签名密钥需新增**
- 依赖解析（D5 实测依据）：`@deepseek-ai/dsh-app-boot` 的 `healProfilesModuleFallback`（`lib/index.js:657-676`）⇒ `$DSH_HOME/profiles/node_modules/@deepseek-ai/*` 指向 DSH 安装的那一份
- hub 侧：`packages/hub/src/{db,tunnel,relay,server,api}.ts`
- 插件与路由范式：`packages/web-remote/src/{index.ts,rpc-route.ts}`、`cordis.patch.yml`
- DSH 工具面：`@deepseek-ai/dsh-tools`（`defineTool`、`ToolRuntime`）、`dsh-tool-todo`（完整范例）、`dsh-tool-jobs`（长任务范式）、`dsh-tool-ask-user`（人工确认）
- DSH 会话注入：`@deepseek-ai/dsh-api-session-controller`（`prompt/cancel/follow/page/inspect`）、`@deepseek-ai/dsh-agent`（`agents.get/create/resume`）
- 同类参考实现：`@deepseek-ai/dsh-webhook` / `dsh-webhook-github`（签名入站 → 创建并 prompt 一个 root 会话）
- 兄弟文档：`doc/feature/16-portal-dark-mode/discussion.md`（同批次事实审计范式）
