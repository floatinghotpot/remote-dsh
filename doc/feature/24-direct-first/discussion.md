# 内网直连优先（direct-first）（discussion）

> **日期**: 2026-09-27
> **特性**: `24-direct-first`（编号在本仓与私仓共享序列中取号：`21-agent-mesh` / `private 22-rdsh-webview-api` / `private 23-entitlement` 已占，24 可用）
> **触发**: 用户提出——App 与 host 常在同一内网，经 hub 公网兜一圈既费时又费带宽；希望"客户端发现同内网后直连 host，hub 隧道只作兜底"
> **修订（2026-09-27 第二轮）**: **目标不变、手段修订**——内网候选**不经过 hub**（host 不上报），改由客户端在**既有 E2EE 通道**内向 host 索取（见 §1.1/§1.2/§2.7 与决策 Q6）
> **状态**: 事实审计完成；**`req.md` 已产出（2026-09-27，待用户批准）** ⇒ 本文件此后作为**只读事实来源**（新需求直接进 `req.md`）。决策进度：**已定 D1/D2（A 案）、D3b/D7（候选走 E2EE）、D4+D15（统一固定口令）、D5+D17（raw 门禁 = host 侧页面 token）、D11、D14、D19（App 先行）**；待定 D3a/D3c/D6/D8–D10/D12/D13/D16/D18/D20；**卡 P7**（App 内是否已有 E2EE pin）与 **P9**（浏览器绕过证书后是否仍算安全上下文）
> **性质**: 原始记录（用户构想 + 代码审计事实 + 出处）。`req.md` 存在后本文件转为只读需求来源（新需求直接进 `req.md`）
> **关联**: [`03-hub`](../03-hub/)、[`04-cli-refactor`](../04-cli-refactor/)（3 模式互斥）、[`09-e2e-encryption`](../09-e2e-encryption/)、[`15-host-access-code`](../15-host-access-code/)、[`private/22-rdsh-webview-api`](../../../private/doc/feature/22-rdsh-webview-api/)、[`21-agent-mesh`](../21-agent-mesh/)、`packages/tunnel/PROTOCOL.md`（层 2 冻结契约）
> **跨仓**: 消费端 = garsync App（`~/workspace/flutter-apps/garsync`，WebView 嵌 DSH 页面 + 语音）；本特性落在 remote-dsh（host/hub 侧）为主

---

## 1. 背景与目标（用户构想，2026-09-27；目标经 2026-09-27 第二轮讨论修订）

**使用主场景**：用户主要通过 garsync App 使用远程 DSH——App 用 WebView 嵌 DSH 页面，并用**语音**（ASR 输入 + TTS 朗读）与之交互，沟通效率高于键盘。手机上访问时，**手机与 host 经常在同一内网**（例如都连家里 WiFi）。

**现状（用户描述）**：App 在 WebView 里打开 hub 相关地址 → hub 登录 → 经 hub 隧道访问 host。于是"同一内网的两台设备"之间的全部流量要绕到公网 hub 再回来。

**历史背景（用户 2026-09-27 补充，已核）**：**M1 的第一个版本本来就是内网直连**——浏览器直接访问 `http://<内网IP>:<端口>`，用**配对码**进门（`doc/blog/zh/01-01-lan-access.md:45-67`、`doc/overview/roadmap.md:13`）。也就是说**这份能力天然具备，且实现仍在仓库里**（F35：`startGateway()` 完整保留，只是 join 模式不调用）。后来有了账号体系与 host 注册，经 hub 访问更方便，于是 join 成了主路径、直连被搁置。

⇒ 所以本特性**不是发明新能力，而是把两条已有的通道合并到同一个 host 上**：既保留"经 hub 公网访问"的便利，又能在交换到内网地址时走直连。**host 自身的门禁（本机口令）是这套方案的安全兜底**——介意被局域网上其他设备访问的人，给自己的 host 设口令即可。

### 1.1 目标（不变）

**目标是同一个**：让同内网的客户端**走内网直连**，不要为了访问同一台 host 而绕公网 hub 一圈。收益有二：

1. **省流量/降延迟**：大流量（工作区文件、事件流、页面 RPC）走内网；
2. **降 hub 压力**：hub 的出口带宽与并发压力显著下降（运维方成本直接受益）。

**握手/引导阶段经 hub 是可以接受的**：不追求"完全不碰 hub"。引导阶段（登录、拿页面、建立安全通道、交换少量信令）体量很小、一次性；**只有建连之后的大量数据才必须走内网**。直连失败、不同内网、或直连条件不成立时，一律回落到 hub 隧道。

**客户端不限于 App（用户 2026-09-27 补充）**：**浏览器**（hub 门户里的 DSH 页面）也在候选范围内——它能拿到性能，但受浏览器策略限制，**档位比 App 低一档**（不能探测内网地址、不能程序化固定证书指纹，见 §2.8）。范围取舍见 **D19**。

### 1.2 手段（**2026-09-27 第二轮讨论修订**）

| | 最初想法（**已废弃**） | 修订后（**采纳**） |
|---|---|---|
| 内网地址如何到达客户端 | host 把内网 IP/端口**报告给 hub**，hub 再转交给 App | **客户端经"到 host 的安全通道"亲自取**：由 host 在既有**端到端加密通道**内下发自己的内网候选（机制见 §2.7） |
| 为什么改 | — | ① **hub 不该知道**内网拓扑（私有信息，能不交就不交）；② hub 转交的 URL **无法防伪造**——hub 本身是 15 号威胁模型里的不可信方，它能改 URL 就能把 App 指向假 host |

**一句话（修订后）**：把数据面从"永远绕 hub"改成"**同内网走直连、其余走 hub 兜底**"；而"内网地址"这件事**不经过 hub**——客户端在**已建立的加密通道**里向 host 索取候选，hub 既不知道也无从伪造。hub 退化为身份/信令/兜底中继，而不是数据通道。

> **明确不做**：host **不**向 hub 上报内网 IP/端口（无新 API、无新表、无新隧道帧；见 §2.7 核实与 Q6）。
>
> **架构约束（用户 2026-09-27 提出）**：**hub 保持不动**——hub 现有机制（在 host 与客户端之间建通道）工作正常，本特性是给 host 侧加"内网能力"，客户端建立直连后不再让数据走 hub。核实结论：**可以做到**（候选下发走既有 E2EE 通道，不需要 hub；raw 流门禁用 host 侧页面 token 修，不需要改层 2 协议或 relay/shim——见 §2.4.3）。

---

## 2. 代码事实审计（2026-09-27，本仓 + garsync 跨仓）

> **编号规则**：`F#` 按**审计发现的时间顺序**递增；后续轮次补充的事实追加新编号 ⇒ 编号与所在章节的顺序**可能不一致**（例：§2.1 含 F35–F39，是第二轮补充的）。

### 2.1 host 侧：join 模式**不监听任何入站端口**，且与网关模式互斥

第一轮查证（见 §7 决策记录）已确认，此处只列结论与出处：

| # | 事实 | 出处 |
|---|---|---|
| F1 | 运行模式是**单值枚举** `"lan" \| "cloud" \| "join"`，无"同时"表示 | `packages/gateway/src/config.ts:14`、`:35` |
| F2 | `rdsh host join` 直接覆盖 `config.mode = "join"`（lan/cloud 的 `port`/`tls`/`auth`/`allowFrom` 字段保留但变死配置） | `packages/cli/src/bin.ts:314` |
| F3 | `rdsh host serve` 按 mode 二选一：join → 只起隧道并 `return`，**不调用网关 `serve()`** | `packages/cli/src/bin.ts:328-333` |
| F4 | join 是**纯出站**：`dsh web --port 0 --no-open`（默认 127.0.0.1），自身不监听 | `packages/gateway/src/join.ts:7`、`spawn-dsh.ts:93` |
| F5 | 服务名随 mode 切换（`rdsh-join` / `rdsh-host`），同一时刻只管理一个 | `packages/cli/src/bin.ts:348`、`packages/gateway/src/service.ts:21,23` |
| F6 | **编排层**（`serve()`）必然自己 spawn 一个 dsh，并把 target 写死为它 spawn 的 `127.0.0.1:dshPort`——**编排层**没有"用外部 dsh"的选项（但网关层有，见 F36） | `packages/gateway/src/serve.ts:52`、`server.ts:108` |
| F7 | "双通道（一台机器同时 serve + join）"是**显式排除项**，非实现缺陷 | `doc/feature/04-cli-refactor/req.md:50` |
| F35 | **M1 的直连网关实现仍然完整在仓库里**：`startGateway()`（配对/会话/TLS/polyfill 注入/allowFrom/用户口令全都在），只是 join 模式不调用它 | `packages/gateway/src/server.ts:103+`、`serve.ts:30+` |
| F36 | **`startGateway(opts)` 是参数化的**：`dshPort` / `dshAuthCookieHeader` 由调用方传入，内部只做 `target = {127.0.0.1, dshPort}` —— **可以指向 join 已经 spawn 的那个 dsh** | `packages/gateway/src/server.ts:35-69`（`GatewayOptions`）、`:108` |
| F37 | ⇒ **A 案不是"从零写一个 listener"**，而是"在 join 进程里再起一个 `startGateway`，指向同一个 dsh" ⇒ F6 的"双 dsh 实例"问题**可避免**（`serve()` 才 spawn，`startGateway()` 不 spawn） | F35 + F36 |
| F38 | **两种 host 形态都走同一个 `startJoin`**，但落点不同：CLI 形态 = join 进程（自 spawn dsh）；插件形态 = DSH 进程内（`target: {127.0.0.1, ctx.webServer.port}`，即宿主自己的 dsh） | `packages/cli/src/bin.ts:330`、`packages/web-remote/src/index.ts:212-216` |
| F39 | 插件形态**同样具备**起直连口的条件：它已持有 `ctx.webServer.port`（DSH 自己的端口），且已在用 DSH 的 webServer 注册路由 | `packages/web-remote/src/index.ts:39,116,411` |

⇒ **现状下 App 无法直连内网**：host 侧没有任何内网监听口可连——这不是"能不能连上"的问题，而是"**没有门**"。但**门本身还在**（F35–F37：M1 的直连网关实现完整保留，且可指向同一个 dsh），所以缺的是"把门接回去"，不是"造门"。

### 2.2 hub 侧：**不知道、也不存** host 的内网地址

| # | 事实 | 出处 |
|---|---|---|
| F8 | `hosts` 表字段仅 `id / owner_id / name / token_hash / e2ee_public_key / created_at`，**无 IP 类字段** | `packages/hub/src/db.ts:202-209` |
| F9 | 隧道注册表是 `Map<hostId, TunnelConn>`；`TunnelConn` 只持有 `ws / hostId / streams`，未落 socket 远端地址 | `packages/hub/src/tunnel.ts:35-56`、`:252` |
| F10 | hub 能看到的只是 host 的**公网出口 IP**（socket 层，且当前未持久化）；**内网 IP 它本来就看不到**——除非 host 主动上报 | F8/F9 推论 |

⇒ **这正是修订后目标想要的状态**（§1.2）：hub 既不掌握、也无从伪造内网地址。原先「host 上报给 hub、再由 hub 转交」的思路需要新增上报通道 + 落库 + 可见性/TTL 设计，**已按 Q6 废弃**（改由客户端经既有 E2EE 通道向 host 索取，见 §2.7）。

### 2.3 直连内网 = 换 origin + 落入**非安全上下文**

| # | 事实 | 出处 |
|---|---|---|
| F11 | LAN 场景是 `http://<LAN-IP>`，**不是安全上下文**：DSH 前端 RPC 依赖的 `crypto.randomUUID()` 在非安全上下文缺失，仓库为此专门注入 polyfill | `packages/gateway/src/secure-context-polyfill.ts:1-13` |
| F12 | **E2EE 依赖 `crypto.subtle`**（X25519/HKDF/AES-GCM），而 `crypto.subtle` 在非安全上下文**不可用且无法 polyfill** | `packages/portal/src/e2ee.ts:38-107`、`packages/hub/src/e2ee-shim.ts:68-89` |
| F13 | ⇒ **`http://` 直连内网 = 只能明文**；安全上下文是走 https 的硬门槛，不是偏好问题 | F11 + F12 |
| F14 | E2EE 的 TOFU pin 存在 `localStorage`（key `rdsh_e2ee_pins`）→ **按 origin 隔离**，换 origin 需重新 pin | `packages/hub/src/e2ee-shim.ts:17` |
| F15 | hub 会话 `rdsh_host` cookie、网关口令 `rdsh_gate` cookie 均按 origin 隔离 → 直连口需要**自带一套登录** | `packages/hub/src/server.ts:82`、`packages/gateway/src/access-gate.ts:11` |
| F16 | **澄清**：DSH 自身的会话 cookie 由 gateway **服务端换发并注入**转发请求（`dsh-auth-<sha256(authority)>`，authority 是 dsh 的 `127.0.0.1:<port>`），**不随浏览器 origin 变化** → 这一条**不是**直连的障碍 | `packages/gateway/src/spawn-dsh.ts:143-170` |
| F17 | 两条转发路径注入的脚本**不一样**：lan/cloud 注入 `SECURE_CONTEXT_POLYFILL + RDSH_WEBVIEW_API`；join 只注入 `RDSH_WEBVIEW_API`（hub 是 https，无需 polyfill） | `packages/gateway/src/server.ts:35`、`packages/gateway/src/join.ts:825` |

⇒ 若直连口走 http，必须补上 `SECURE_CONTEXT_POLYFILL`（F17），但**补了也救不回 E2EE**（F13）。

### 2.4 访问口令（feature 15）：存在，但**明确不覆盖直连**，且有已知豁免

| # | 事实 | 出处 |
|---|---|---|
| F18 | 访问口令 `gateway.accessCode` 只在 **join 模式**实现（`access-gate.ts` 仅被 `join.ts` 引用） | `packages/gateway/src/join.ts:29,376,571-592` |
| F19 | feature 15 **显式排除** LAN/云直连启用 gate："已有配对/口令认证" | `doc/feature/15-host-access-code/req.md` §2.2 |
| F20 | 设置入口目前**只有插件面板**（写 host.json + 内存即时生效）；**CLI 无命令**，需手改 host.json | `packages/web-remote/src/index.ts:362`（CLI 全仓无 `accessCode` 匹配） |
| F21 | gate 只加在**明文分发器**上（`gate: true`），**E2EE raw 流的内层分发器不查 gate**（15 的 R5 显式接受："raw 流本身不逐帧重查"） | `packages/gateway/src/join.ts:825` vs `:847-872` |
| F22 | raw 流的安全前提是"E2EE shim 只由过 gate 的页面注入"，但**自造客户端不受此约束**；而 host 的 `e2ee_public_key` 就存在 hub 库里 | `packages/hub/src/db.ts:202-209`、`packages/hub/src/e2ee-shim.ts`（注入点 relay） |

⇒ 用户的设想"host 设访问密码 + 直连答对才放行"**需要用 15 之外的机制**：lan/cloud 现有的是**配对码（pair）/ 用户名口令（password）**认证（feature 01/02）。若要把 `accessCode` 扩到直连路径，属**超出 15 范围的新需求**（D4）。F21/F22 也意味着：若 24 打算让访问口令成为直连的**唯一防线**，这个前提需要重新评估（D5）。

#### 2.4.1 现状：**三套门禁机制并存**（2026-09-27 核实，纠正"两条通道用同一套口令"的直觉）

| 机制 | 属于哪条路径 | 形态 | 怎么设置 | 出处 |
|---|---|---|---|---|
| `auth.mode: "pair"` | lan/cloud **直连** | **动态** 6 位配对码（终端显示 / `--pair-code` 固定）→ 12h HttpOnly 会话 cookie | `setup lan --pair-code` | `packages/cli/src/bin.ts:230`、`doc/blog/zh/01-01-lan-access.md:45-67` |
| `auth.mode: "password"` + `auth.users` | **cloud 直连**（需 TLS） | 固定 用户名 + 口令（多用户） | `rdsh host user add/passwd` | `packages/cli/src/bin.ts:415-455` |
| `gateway.accessCode` | **join 隧道**（CLI-join **与** 插件**都**用它） | 固定**单一口令** → challenge 页 → HMAC 签名 cookie（7 天） | 插件面板 live 生效（`set-access-code`）；**CLI 只能手改 host.json 后重启** | `packages/web-remote/src/index.ts:362`、`packages/gateway/src/join.ts:571-592` |

| # | 事实 | 出处 |
|---|---|---|
| F40 | 上述三套是**不同代码路径、不同配置字段、不同 UX**：直连口（`server.ts`）走 pair/password；隧道口（`join.ts`）走 accessCode | 三行出处见上表 |
| F41 | **CLI 没有设置 `gateway.accessCode` 的命令**：全仓 `packages/cli/src/` 无 `accessCode` 匹配；15 号的"CLI 通道"实为"`join()` 透传 `config.gateway`，**手改 host.json 后重启生效**"，不是命令 | `packages/cli/src/bin.ts`（无匹配）、`doc/feature/15-host-access-code/plan.md:4`、`verification.md:19` |
| F42 | 插件形态与 CLI-join 形态**用的是同一个** `gateway.accessCode`（都经 `startJoin({gateway})`）——"插件的固定口令"与"CLI 的配对码"并不是一对对应关系 | `packages/cli/src/bin.ts:330`、`packages/web-remote/src/index.ts:212-216` |

⇒ **用户决策（Q8）**：两条通道**统一用"可设定的固定口令"**，**不使用动态配对码**。这条把 15 号明确排除的"gate 扩到直连路径"**纳入 24 的范围**，并顺带补上 15 号遗留的 **CLI 设置入口**（F41）。落地形态见 D15/D16。

#### 2.4.2 为什么 raw 流绕过成立：**机制根因**（2026-09-27 追加核实，D5 落地必需）

| # | 事实 | 出处 |
|---|---|---|
| F43 | raw 流的 OPEN payload **只有** `{kind:"raw"}`——**没有任何 headers/凭据字段** | `packages/hub/src/tunnel.ts:109-113`、`packages/tunnel/PROTOCOL.md`（OPEN payload） |
| F44 | hub 建 raw 流时**只用 `authorizeHost(req)` 认证浏览器**（读的是 `rdsh_host`），随后 `openRawStream()` **不向 host 转发任何头或 cookie** ⇒ 浏览器在 `/e2e` WS 上自动携带的 `rdsh_gate` **到不了 host** | `packages/hub/src/relay.ts:261-282` |
| F45 | 且内层 HTTP 请求也带不了 cookie：`Cookie` 是浏览器 forbidden header，`fetch` 无法设置 ⇒ **host 在 E2EE 通道上拿不到任何 gate 凭据**（这就是绕过的机制根因） | F43 + F44（规范约束） |
| F46 | 15 号在**明文路径**上已建立"hub 透传 `rdsh_gate` 不透明标记（D12）"的**先例**：hub 剥会话 cookie、放行 `rdsh_gate` | `packages/hub/src/relay.ts:156-175`、`doc/feature/15-host-access-code/req.md` R9 |
| F47 | ⇒ 把同一模式延伸到 raw 建流处**与既有设计一致**，且不新增信任面：hub 全程不知道 code，伪造不了 `sha256(accessCode)` 的 HMAC | `packages/gateway/src/access-gate.ts:23-26` |

> ⇒ 但**不推荐 (a)**：存在 hub 零改动、且同样能挡住自造客户端的更优修法（见 §2.4.3）。

#### 2.4.3 **hub 零改动的修法（推荐）**：用"页面可达性"当门禁凭据（2026-09-27 追加，纠正 §2.4.2 末尾的结论）

> **先纠正**：§2.4.2/D17 原先写"两条路都要动 hub 包"——**这是错的**。host 手里有一个 hub 没有的注入点：**gate 通过后返回的 DSH 页面本身**。据此可以做出完全 host 侧的修法。

| # | 事实 / 设计依据 | 出处 |
|---|---|---|
| F54 | **"能拿到 DSH 页面"就是"过了 gate"的证据**：未过 gate 的请求拿到的是挑战页（`sendChallenge`），**根本收不到 DSH 的 HTML** | `packages/gateway/src/join.ts:466-470,571-592` |
| F55 | host 已经在往这个页面里注入脚本（`htmlInject` 槽），且是**动态可编程**的位置（由 dispatcher 选项传入）；HTML 响应在注入前**已被缓冲**，具备按响应生成 per-load 内容的条件 | `packages/gateway/src/join.ts:621-655,825` |
| F56 | 注入脚本与 shim 的**顺序有保障**：hub 把 E2EE shim 注入 `<head>` 最前，gateway 把脚本注入 `</head>` 前 ⇒ 注入脚本运行时 `fetch` 已被 wrap，且都在 DSH 应用脚本（module，deferred）之前 | `packages/hub/src/relay.ts:115-118`、`packages/gateway/src/proxy.ts`（`</head>` 前插入） |
| F57 | **设计（4 步，全部在 gateway 包内）**：① 每次 DSH 页面加载，host 生成**一次性 token** 并随注入脚本下发；② 注入脚本开页后立刻用 token 向 host 发一次**授权请求**（走 E2EE 内层 HTTP）；③ host 的 raw 分发器**授权前不服务任何请求**（宽限窗口 + 小缓冲上限，防内存放大）；④ 收到有效 token → 放行并服务（含缓冲的请求）；超时/无 token → 关流 | F54 + F55 + F56 |
| F58 | 效果：**自造客户端拿不到页面 ⇒ 拿不到 token ⇒ 在 E2EE 通道上拿不到任何响应**；而明文路径本来就受 gate 保护 ⇒ gate 在两条通道上同时成立 | F57 |
| F59 | **诚实边界**：token 经过明文路径（页面 HTML 是明文），**主动的 hub 管理员可抓取并重放**。但这**不是新弱点**——现有 `rdsh_gate` cookie 在明文路径上同样被 hub 看到（D12 白名单透传），所以 §2.4.2 的 (a) 方案**有完全一样的重放弱点**。彻底关闭需凭据完全不经过 hub ⇒ 需改客户端 shim（hub 注入）；而 15 号已把"主动 hub MITM"列为 **Out of Scope**（其职责属 E2EE） | `packages/hub/src/relay.ts:156-175`、`doc/feature/15-host-access-code/req.md` §2.2 |
| F60 | 之所以不去做"token 绑定 E2EE 临时公钥"（可挡 hub 重放）：临时公钥由 **shim 内部**生成并持有（`e2ee-shim.ts:73`），host 注入的脚本拿不到，只能 monkey-patch `crypto.subtle` —— 收益有限（只挡主动 hub）、代价高且脆弱 ⇒ **不做，记为已知边界** | `packages/hub/src/e2ee-shim.ts:73` |

#### 2.4.4 三种修法对比（D17）

| | (a) hub 转发 `rdsh_gate` 进 raw OPEN | (b) shim 换票 + Noise prologue | **(c) host 侧页面 token（推荐）** |
|---|---|---|---|
| 层 2 协议 | **要改**（+ conformance） | 不动 | **不动** |
| hub 改动 | relay 要改 | shim 要改 | **无** |
| 升级顺序要求 | **有**（先 hub 后 host，否则 E2EE 断） | 有（shim 随 hub 部署） | **无**（host 单独升级即可） |
| 挡自造客户端 | ✅ | ✅ | ✅ |
| 挡主动 hub 重放 | ❌（cookie 明文可读） | ❌（ticket 明文可读） | ❌（token 明文可读）——三者同级 |
| 改动归属 | gateway + hub + 协议 | gateway + hub(shim) | **gateway 单包**（与 22 号"适配脚本随 gateway 发布"口径一致） |

#### 2.4.5 废弃动态配对码的影响面（D15 决策的代价，2026-09-27 核实）

| # | 受影响面 | 具体 |
|---|---|---|
| F48 | 配置层 | `AuthMode = "pair" \| "password" \| "none"`、`AuthConfig.pairCode`、`DEFAULT_AUTH.mode = "pair"`（**默认值**要改） |
| F49 | 网关层 | `pair.ts` / `pair-page.ts`、`server.ts` 的 `PairManager` 与会话签发、`--no-code` 语义 |
| F50 | CLI 层 | `setup lan` 写入 `auth.mode = "pair"`、`--pair-code` 参数、帮助文案 |
| F51 | 文档与测试 | `doc/blog/zh/01-01-lan-access.md`（整篇讲配对码流程）、`doc/overview/usage.md`、README 双语、M1 e2e 用例 |

出处：`packages/gateway/src/config.ts:13,27-28,77,196-204`、`packages/cli/src/bin.ts:230,238`、`packages/gateway/src/server.ts`（`PairManager`）、`packages/gateway/src/pair.ts`、`pair-page.ts`。

### 2.5 App 侧（garsync，跨仓）：形态如用户所述；但**有一条浏览器没有的可行性通道**

| # | 事实 | 出处 |
|---|---|---|
| F23 | App 用 `webview_flutter` 把用户**自由填写**的 URL 加载进 WebView；URL 无 hub 语义 | `lib/rdsh/rdsh_page.dart:243-246`、`lib/rdsh/rdsh_host.dart` |
| F24 | garsync 代码里**没有** hub 相关逻辑（无 `rdsh.cn`、无 `/h/` 构造）⇒"经 hub 访问"是**用户填了 hub URL** 的结果，不是 App 内建流程 | garsync `lib/rdsh/` 全目录检索 |
| F25 | hub 侧进入 host 的流程：`/h/<hostId>/...` → 校验归属 → `Set-Cookie rdsh_host` → 302 到该 host 根路径；未登录由门户登录承载 | `packages/hub/src/server.ts:256-317`、`:285` |
| F26 | 语音**不走 hub**：ASR 是端上系统能力（iOS `SFSpeechRecognizer` / Android `SpeechRecognizer`），TTS 是系统 TTS | garsync `lib/rdsh/asr/system_asr_provider.dart:11-12`、`lib/rdsh/tts/system_tts.dart` |
| **F27** | **可行性的关键发现**：App 的 WebView **可以对自签证书做 SSL 错误豁免/固定**——`webview_flutter` 应用层暴露 `NavigationDelegate(onSslAuthError:)`；底层 Android `onReceivedSslError`、iOS `serverTrust` 回调齐备 | `webview_flutter-4.14.0/lib/src/navigation_delegate.dart:56`；`webview_flutter_platform_interface-2.15.1`（`setOnSSlAuthError`）；`webview_flutter_android-4.12.0`；`webview_flutter_wkwebview-3.25.1`（`_onSslAuthError`）；版本取自 garsync `pubspec.lock` |

⇒ F27 **改变了可行性判断**：App 侧可以走 `https://<LAN-IP>` + **自签证书 + 证书固定**，从而（a）保住安全上下文 → `crypto.subtle` 可用 → **E2EE 在直连路径上仍然成立**；（b）不需要公网 CA，也不需要给每台设备装本地 CA。这正是**浏览器做不到**的部分——浏览器要么拿到可信证书，要么退化成明文（F13）。

### 2.6 非安全上下文（`http://<LAN-IP>`）的能力损失清单——**实测**，非推测

扫描已安装 DSH `0.1.7-rc.2` 的**全部浏览器侧文件**（`@deepseek-ai/*/lib/client.js` 共 69 个 + 前端壳 `dsh-web-frontend/dist/assets/index-*.js`，合计 70 个文件）：

| 受 secure context 限制的 API | 出现次数 | 所在模块 | 走 http 直连的后果 |
|---|---|---|---|
| `crypto.randomUUID` | 4 | `dsh-client-file-upload/lib/client.js`、`dsh-client-ui-conversation/lib/client.js` | **硬依赖**：缺失会抛错 → 必须注入 `SECURE_CONTEXT_POLYFILL`（仓库已有，lan/cloud 路径在用，F17） |
| `navigator.clipboard` | 5 | `dsh-client-ui-settings-account`、`dsh-cordis-client-runner`、前端壳 bundle | 可选链调用（`navigator.clipboard?.writeText`）→ **复制类功能静默失败**，不报错 |
| `navigator.mediaDevices` | 1 | **`dsh-experimental-client-ui-voice-input/lib/client.js`** | **DSH 页面内的语音输入不可用**（`mediaDevices` 为 undefined）← **直接命中本特性的动机（语音），见 D11** |
| `crypto.subtle` | 0 | — | DSH 前端**自己不需要**；只有 rdsh 注入的 E2EE shim 需要（F12）→ 直连若不做 E2EE 则无此需求 |
| `serviceWorker` / `geolocation` | 0 | — | 无影响 |
| `Notification` | 5 | （未逐个定位） | 通知不可用（App 场景通常无关） |

**关于剪贴板：不是死结，可 polyfill（2026-09-27 追加）**

| # | 事实 | 出处 |
|---|---|---|
| F52 | `navigator.clipboard` 按规范带 `[SecureContext]` ⇒ 只在 https / localhost / `127.0.0.1` 暴露；`http://192.168.x.x` 下为 `undefined`（这不是"权限被拒"，而是**根本不存在**）。**但**：注入脚本可用 `document.execCommand('copy')` + 隐藏 `textarea` 重新实现 `writeText`（`execCommand` **不受**安全上下文限制，只需用户手势）；仓库已有同构先例（`SECURE_CONTEXT_POLYFILL` 就是往页面注入脚本、补齐非安全上下文缺失的 API） | `packages/gateway/src/secure-context-polyfill.ts:10`；DSH bundle 的 `navigator.clipboard?.writeText`（可选链 ⇒ 静默失败） |
| F53 | ⇒ **"http 丢失剪贴板"不构成选型理由**：补一段注入脚本即可。D3c 应纯粹按**安全**定：**固定口令只能挡"未授权访问"，挡不住"冒充 host"**——`http` 下同网段攻击者可伪装成 host 收集你输入的固定口令（钓鱼）或直接读取会话 cookie 接管智能体；**动态配对码同样挡不住**（on-path 中继一遍即可），只有**对 host 的密码学认证**（TLS+pin / Noise）能挡 | F52 + §2.3 F13 |

补充事实：

- **F28**：DSH 的 `dsh-api-gateway/lib/client.js:295` 已自行实现 `randomUUID()`（基于 `crypto.getRandomValues`，非安全上下文可用）→ 说明上游也在适配非安全上下文；但 `file-upload` / `ui-conversation` 仍**直接**调 `crypto.randomUUID`，故 polyfill 仍是必需。
- **F29**：host 侧**没有**自签证书生成能力：`packages/gateway/src/tls.ts` 只加载 PEM（注释指向 `openssl` 手工生成），仓库无证书生成类依赖（无 `selfsigned` / `node-forge`）。⇒ https 路线要么调 `openssl` CLI（macOS/Linux 常备，Windows 未必），要么新增依赖（与"依赖最小化"纪律冲突）。**这是 https 路线的唯一真实新增成本。**
- **F30**：garsync 侧语音是**原生**能力（F26），WebView 内未见 `getUserMedia` / `onPermissionRequest` 使用；但 DSH 页面内**另有**一个语音输入模块（上表第 3 行）——**App 用户是否会用页面内那个语音按钮，必须澄清（D11）**。

### 2.7 候选地址改走 **E2EE 通道**下发（用户 2026-09-27 提议）——机制核实：**hub 侧零改动可行**

用户提议：**host 不把内网 IP/端口报告给 hub**，而是让浏览器/WebView **在 E2EE 通道内**拿到候选地址。核实结论：**可行，且不需要动 hub 的协议、表或端点**。

| # | 事实 | 出处 |
|---|---|---|
| F31 | E2EE 是浏览器侧一条独立 WS：`(wss\|ws)://<hub>/e2e`，由注入脚本建立 | `packages/hub/src/e2ee-shim.ts:112` |
| F32 | 该通道内层是**完整 HTTP 语义**：`OPEN{kind:"http", method, path, headers}` + DATA + CLOSE，全部位于密文内 | `packages/hub/src/e2ee-shim.ts:284`、`:396` |
| F33 | hub 对 raw 流**只做纯字节双向转发、不解析内容**（PATH/HEADERS 均不可见；可见的只有流的存在、字节数与时序） | `packages/tunnel/PROTOCOL.md`（E2E 加密 raw stream）、`packages/hub/src/relay.ts:258-320` |
| F34 | ⇒ **实现路径**：host 侧暴露一个普通 HTTP 端点（如 `GET /__rdsh/direct`）返回本机候选（IP/端口/多网卡/IPv6）；由于 shim 已 wrap `fetch`，页面内取该端点即走密文；**无需新帧、新端点、新表** | F32 + F33 |

**由此获得的三条收益（优于原 D7 方案）**：

1. **hub 零改动**：不新增 API、不落库、不新增隧道帧（层 2 冻结契约不受影响）。
2. **隐私更强**：hub **永远看不到**内网拓扑（原方案要把 IP 交给 hub，还要设计 TTL/可见性）。
3. **"URL 可信"免费拿到**：候选由 host 经**端到端加密通道**亲口给出 ⇒ 恶意/被攻破的 hub **无法伪造候选地址**（对照 §3 的 D3b）。

**但必须同时记下三条限制**：

| # | 限制 | 出处/理由 |
|---|---|---|
| L1 | **只解决"URL 可信"，不解决"直连链路可信"**：App 拿到正确的 `IP:port` 后，那条 `http` 连接本身**不认证 host** → 同网段攻击者可冒充/抢答该地址 | 与 §3 D3b 解耦为两个问题：候选可信（本节已解） vs 连接可信（仍需 TLS+pin，或直连上重放 Noise） |
| L2 | **前置：E2EE 必须真的在跑**。shim 仅在 host 已被 pin（`localStorage.rdsh_e2ee_pins`）时才 wrap fetch/WS；而 pin 由 **portal 页面**写入 | `packages/hub/src/e2ee-shim.ts:17,59`；`packages/portal/src/pages.tsx:37-47` |
| L3 | **可见性**：hub 的 `authorizeHost` 放行 owner **与共享成员** → 若共享成员也拿候选，等于把 host 的内网拓扑交给他们 | `packages/hub/src/relay.ts:31-42` |

> ⚠️ **L2 是本特性的 App 场景第一硬前置**：garsync 的 WebView 若从未走过 portal 信任流程，其 localStorage 里**没有 pin** ⇒ E2EE 处于关闭（09 的 optional 语义：不 pin 则明文直通）⇒ 候选变成 hub 可见/可改的明文，"认主"失效。**需先确认 App WebView 内是否已建立 pin**（P7），或为 App 设计一个原生信任流程。

### 2.8 浏览器侧可行性（用户 2026-09-27 提出：不一定只在 App 里做）

| # | 事实 | 出处 / 依据 |
|---|---|---|
| F61 | **浏览器不能从 hub 页面"探测"内网地址**：hub 页面是 `https`，往 `http://<LAN-IP>` 的 `fetch` / `<img>` 会被**混合内容策略**拦掉；`ws://<LAN-IP>` 同样被拦（Chrome 报 "insecure WebSocket … blocked"）⇒ 用户设想的"**用 websocket 探测通畅**"在浏览器里**做不到**。**顶层导航不受混合内容限制** ⇒ 可行做法是"用户点击 → `location.href` 跳到内网地址"，或"`window.open` + 目标页 `postMessage` 回执"（能做到探测，但受弹窗策略约束且是独立窗口） | 浏览器策略（无源码可引）；对照 App 侧无此限制（原生 socket，F23） |
| F62 | **浏览器没有证书固定钩子**：App 有 `NavigationDelegate(onSslAuthError:)`（F27），浏览器**没有**等价 API ⇒ 自签证书只能靠用户点"继续访问"，无法程序化固定指纹 ⇒ **D3c（防同网段冒充）在浏览器侧做不干净** | 对照 F27 |
| F63 | **一次性 token 的模式已有先例可复用**：dsh 自身的 `GET /?token=<t>` → 303 + `Set-Cookie`（token 用完即弃、不留在地址栏）⇒ 直连口照做：客户端经 **E2EE 通道**拿到 host 铸的 token → 直连 URL 带上它 → host 校验后 303 换会话 cookie | `packages/gateway/src/spawn-dsh.ts:143-170` |
| F64 | **"跳过去就丢了返回按钮"有解**：直连口**自己也注入 HTML**（`server.ts:35` 的 `HTML_INJECT`），可注入**绝对 URL** 的返回入口指回 hub 门户（`/portal/hosts`）；顺带可在直连页把 hub 注入的那个悬浮条（`relay.ts:52` 的 `BACK_BAR_HTML`，`position:fixed` 浮在页面上、用户觉得不美观）换成更合适的形态 | `packages/gateway/src/server.ts:35`、`packages/hub/src/relay.ts:52,121-122` |
| F65 | **待实测**：`https` 页面在用户点过"继续访问"（绕过自签警告）后 `window.isSecureContext` 是否为 `true`。若为 `true`，直连页的 `crypto.subtle` / `clipboard` 全部正常，浏览器档位显著提升（但**身份仍未被强认证**，只能退化为"门户显示指纹 + 肉眼核对"） | ⏳ 见 P9 |

**结论：浏览器直连可行，但与 App 的定位不同。**

| 客户端 | 发现方式 | 连接安全 | 能力（secure context） |
|---|---|---|---|
| **App（garsync）** | 原生探测 + 自动切换 | **TLS 自签 + 指纹固定**（F27） | https ⇒ 完整（clipboard 正常、可做 E2EE） |
| **浏览器** | 用户点击切换 / 顶层导航（**不能探测**，F61） | 只能 `http` 明文，或 https + 用户手动绕过证书（**无法程序化固定指纹**，F62） | http ⇒ 需 polyfill 补 clipboard（F52）；https+绕过 ⇒ 待实测（F65） |

**共享部分（增量成本很小）**：host 侧机制完全一致——直连口、候选端点、一次性 token（F63）、注入返回入口（F64）⇒ 浏览器侧只多"一段注入脚本里的横幅/按钮 + 顶层跳转"。

### 2.9 收益与代价（诚实拆分，避免为小头做大工程）

| 流量/体验类别 | 现状经 hub 的代价 | 直连收益 |
|---|---|---|
| DSH 前端壳资源（~1.3 MB，见 `join.ts:440` 注释） | 仅首次/换版本时走一次，之后浏览器缓存 | 小 |
| 交互与事件流（`/api/events.mux`、`events.host`、页面 RPC） | 字节量小，**但每轮往返都吃公网 RTT** | **大**（体感主要来源） |
| 工作区大文件读写/预览/上传 | 字节量大，且是 hub 的**出口带宽成本**（运维方付费） | **大** |
| 语音（ASR/TTS） | **不经 hub**（F26） | 无直接影响；但语音之后每一轮的往返仍受益 |

**结论**：价值主张应写成"**直连优先（降延迟 + 省出口带宽），hub 兜底**"，而不是单纯"省带宽"。

---

## 3. 候选架构与取舍（待决议，本文件不拍板）

| # | 方案 | 形态 | 主要代价 |
|---|---|---|---|
| **A** | **join 进程双前门**：隧道进程额外监听一个直连口，转发到**同一个 dsh 实例** | 一个进程、一条 dsh 会话、两个入口（隧道 + 内网 https） | 需在 `join.ts` 增加 listener（含 auth/TLS/注入三件事）；打破"只出站不监听"（F4）需显式设计其认证与门禁 |
| **B** | **恢复 lan/cloud 网关并存**（双通道改造）：把 `mode` 单值枚举改成能力开关，复用现成 `server.ts`（pair/password 认证、TLS、polyfill + webview api 注入） | 复用存量最多 | 改 mode 语义（F1/F2/F3/F5）；且 `serve()` 必自己 spawn dsh（F6）→ 会出现**两个 dsh 实例**，与"同一会话"目标冲突，除非一并改造 |
| **C** | **不改 URL、只把数据面直连**（保留 hub 页面 origin，直连走 WebRTC/自签 https 数据通道 + 前端改造） | 无双 origin 问题 | 复杂度最高（host 侧 WebRTC 栈需本地依赖；服务端渲染的数据面需另建协议），本特性不建议纳入（可记录为未来项） |

**倾向（已定）**：**A**（用户 2026-09-27 定，见 Q5）。

---

## 4. 待决议项（D1–D18）

| # | 问题 | 备选 | 状态 |
|---|---|---|---|
| D1 | 直连口的**归属**：join 进程多监一个口（A） vs 复活 lan/cloud 网关（B） | A / B | ✅ **已定 = A**（2026-09-27） |
| D2 | **同一 dsh 实例**是否硬性要求 | 硬性 / 可接受双实例 | ✅ **已定 = 硬性**（A 案的必然推论：一个进程、一条隧道、一个 dsh、两个前门） |
| D3a | **防同网段嗅探**：内网 http 的可接受性 | ✅ **已定（req C1，2026-09-27）= 分两步：P1 先 `http` 明文跑通，P3 补 `https` + 指纹固定**；P1/P2 必须在状态与发布说明中显式标注限制，且剪贴板能力需补齐（req R13） | ✅ 已定 |
| D3b | **URL 可信**（防 hub 指向假 host） | 候选地址走 E2EE 通道下发（§2.7） | ✅ **已定 = 走 E2EE 通道**（2026-09-27，用户提议；hub 零改动、隐私更强） |
| D3c | **连接可信**（防同网段冒充 host）：拿到正确 URL 后，那条连接本身如何认证 host | ✅ **方向已定（req C1/R8）= App 侧 TLS 自签 + 指纹固定，P3 交付**（P1/P2 为明文档位、已知限制；浏览器侧做不干净，F62，且已后置 Q13）。**注意 F53**：明文档位下固定口令挡不住冒充 | ✅ 方向已定（档位实现顺延 P3） |
| D4 | **门禁机制**：两条通道统一 | 现状三套并存（§2.4.1 F40–F42）→ 选定一种 | ✅ **已定 = 统一用"可设定的固定口令"**（`gateway.accessCode` 语义），**不用动态配对码**（2026-09-27 用户定，Q8） |
| D5 | F21/F22 的 **raw 流绕过**是否在本特性内修（若访问口令要当直连唯一防线则必须先修） | ✅ **已定 = 在 24 里修**（2026-09-27 用户定，Q11）⇒ 落地方式见 D17 | ✅ 已定 |
| D6 | 是否把 **04 的"3 模式互斥"改造**纳入本特性前置范围 | A 案下**不需要**改 mode 语义（只在 join 进程内多开一个 listener）；但"只出站"承诺需显式改写 | ⏳ 待定 |
| D7 | **候选地址下发**：host → 客户端 | ✅ **已定 = E2EE 通道内用普通 HTTP 响应下发（§2.7, F34）**；hub 不存储、不可见 | ✅ 已定（2026-09-27） |
| D8 | **客户端选路**：并行试连 + 测速 + 短超时 + 隧道兜底（不在客户端算"同网段"，浏览器/WebView 拿不到掩码） | — | ⏳ 待定 |
| D9 | **协议先行**：D7 走 E2EE 后，层 2 **无需改动**；剩余信令（是否需要"已切直连"回执）再评估 | 预计层 1/层 2 均无改动 | ⏳ 待定（风险已大幅下降） |
| D10 | **双路一致性**：直连与隧道并存时的会话/pin/cookie 归属，以及"直连失败体验不得比现状差" | 注意：不同 origin 的 cookie/localStorage 各自独立（F14/F15），但 dsh 会话 cookie 由服务端注入（F16）→ **不换智能体，只换入口** | ⏳ 待定 |
| D11 | **App 的语音走哪条路**：garsync 原生 ASR（F26） vs DSH 页面内的 `voice-input` 模块（§2.6 表第 3 行） | ✅ **已定 = 只用 garsync 原生语音面板**（2026-09-27）⇒ 页面内 `mediaDevices` 不可用**不构成阻塞**；http 仅剩 `clipboard` 退化（可用 polyfill/接受） | ✅ 已定 |
| D12 | **E2EE 未激活时的降级**（L2）：未 pin / 明文降级 / hub `e2ee.mode=off` 时是否禁用直连优先 | 建议：**仅 E2EE 激活时启用直连**，否则一律走隧道 | ⏳ 待定 |
| D13 | **候选对共享成员的可见性**（L3）：owner-only vs 共享成员同等 | 建议 owner-only | ⏳ 待定 |
| D14 | **覆盖面**：两种 host 形态（CLI 起的 host / 插件注册的 host）是否都要有直连口 | ✅ **已定 = 都要**（同一个 `startJoin`、同一个 dsh；插件已知 `ctx.webServer.port`，F38/F39） | ✅ 已定（2026-09-27，Q9） |
| D15 | **D4 的落地形态**：直连口怎么接上固定口令 gate，以及**动态配对码的去留** | ✅ **已定 = 废弃动态配对码，全部改用固定口令**（2026-09-27 用户定，Q10；影响面见 §2.4.3 F48–F51）。**仍待定**：直连口 gate 用 (a) 抽出 `accessCode` 挑战流供 `server.ts`/`join.ts` 共用，(b) `auth.mode: password`（多用户 + 强制 TLS），(c) 组合 | ⏳ 部分已定 |
| D16 | **CLI 设置入口**（补 15 号遗留 F41）：命令名与交互 | 备选：`rdsh host gate set\|clear` / `rdsh host code set` / 复用 `rdsh host passwd`（注意与现有 `rdsh host user passwd` 语义冲突） | ⏳ 待定 |
| D17 | **raw 流门禁的落地方式** | ✅ **已定 = (c) host 侧页面 token**（2026-09-27 用户定，Q12）：只改 gateway 包、层 2 不动、hub 不动、无升级顺序；设计见 §2.4.3，对比见 §2.4.4。（a)(b) 的成本更高且未采纳；三者对"主动 hub 重放"同级，属 15 号 Out of Scope） | ✅ 已定 |
| D18 | **迁移与首次口令**：现有 lan 用户的 `auth.mode: "pair"` 配置怎么办；统一后口令从哪来 | 备选：`setup lan` 自动生成随机固定口令 → 写 host.json（0600）+ 终端打印一次（对齐"配对码只显示一次"的既有体验）；旧配置走 `normalizeConfig` 迁移或报错引导；`auth.mode: password` + `auth.users`（多用户）保留还是并入单一口令 | ⏳ 待定 |
| D19 | **客户端范围**：浏览器与 App 是否同期支持直连优先 | ✅ **已定 = App 先行、浏览器后置**（2026-09-27 用户定，Q13）。理由：App 可做 TLS 自签 + 指纹固定（安全档位完整），浏览器只能 http 明文或 https+手动绕过（F61/F62）⇒ 不同档位分阶段交付 | ✅ 已定 |
| D20 | **直连页的返回入口**：跳过去就丢了 hub 注入的悬浮返回条（F64） | 备选：(a) host 直连口注入**绝对 URL** 的返回入口指回 `/portal/hosts`；(b) 复用/改造 hub 的 `BACK_BAR_HTML`（用户 2026-09-27 提到其形态不美观，**样式重构另行讨论**）；(c) 依赖浏览器后退键。**另需定**：返回入口是否保留"当前会话"（直连页 → 门户列表会离开会话） | ⏳ 待定 |

---

## 5. 查证清单（P1–P9，进 solution 前需结论）

| # | 查证项 | 现状 |
|---|---|---|
| P1 | garsync 侧"host 地址"的填写/管理入口（`rdsh_list_page` / `rdsh_settings`），是否有承载"内网候选地址"的位置 | ⏳ 待查 |
| P2 | ~~同一 profile 跑**两个 `dsh web`** 是否冲突~~ → A 案已定（同一 dsh 实例），此项**降级为"若将来考虑 B 案再查"** | ⏭️ 不阻塞 |
| P3 | 直连路径的 E2EE 现状：pin 按 host 还是按 origin；换 origin 后的重新 pin 交互（F14） | ⏳ 待查 |
| P4 | iOS/Android WebView 对 `http://<私有IP>` 的非安全上下文判定实测（§2.6 的清单是**按 DSH 源码静态扫描**得出，需在真机 WebView 上确认 `clipboard` / `randomUUID` / `mediaDevices` 的实际表现） | ⏳ 待查 |
| P5 | host 侧自签证书的生成与轮换方案（谁生成、存哪、App 如何固定指纹、过期怎么办） | ⏳ 待查 |
| P6 | **量化收益**：一次典型 App 会话经 hub 的字节数/RTT 构成（首屏 / 事件流 / 大文件），用于排期取舍 | ⏳ 待查 |
| P7 | **App 的 WebView 里是否已建立 E2EE pin**（`localStorage.rdsh_e2ee_pins`）——决定 L2 是否阻塞本特性；未建立则需先设计 App 侧信任流程 | ⏳ 待查（**L2 硬前置**；验证步骤见 **§9**） |
| P8 | 直连优先的客户端逻辑归属：由 **hub 注入的 shim** 承担（中心部署、改动快） vs 由 **host 注入的脚本**（`join.ts:825` 先例、随 gateway 包发布，与 22 号特性口径一致） | ⏳ 待定 |
| P9 | **实测**：`https` 页面在用户点过"继续访问"（绕过自签证书警告）后 `window.isSecureContext` 是否为 `true`（F65）——决定浏览器直连能否保住 `crypto.subtle` / `clipboard` | ⏳ 待查 |

---

## 6. 非目标（本特性**不做**，除非另行批准）

- ❌ 浏览器直连的**可信身份**方案（可信证书分发 / 程序化指纹固定）——浏览器无此能力（F62），本期不解决
- ❌ 从 hub 页面**主动探测**内网地址（混合内容策略禁止，F61）——浏览器侧只能"用户点击切换"
- ❌ host 公网 IP + 端口的"直连"（那等价于既有的 cloud 模式 / 端口转发，另属既有能力）
- ❌ 跨 owner 的直连发现（候选地址只对该 host 的 owner 可见，D13）
- ❌ 主动 hub MITM 防护（属 E2EE 职责，15 已界定）
- ❌ **host 向 hub 上报内网 IP/端口**（首轮思路，已按 Q6 废弃：hub 不该知道内网拓扑，且经 hub 转交的 URL 无法防伪造）

---

## 7. 决策记录（已定）

| # | 决策 | 依据 |
|---|---|---|
| Q1 | 特性编号 **`24-direct-first`**（本仓 `doc/feature/24-direct-first/`） | 用户 2026-09-27 定；22/23 已被私仓占用 |
| Q2 | **App 先行**：第一落点 = garsync App 的内网直连优先；浏览器后置 | 用户 2026-09-27 定；F27 证明 App 侧可行而浏览器侧受阻 |
| Q3 | 定位 = **"直连优先 + hub 兜底"**，不是替代 hub | 用户 2026-09-27 定 |
| Q4 | 语音（ASR/TTS）是**使用动机**，但语音本身不经 hub（F26）→ 收益口径按 §2.9 表述 | 2026-09-27 审计 |
| Q5 | **直连口归属 = A 案**：join 进程在隧道之外**额外监听一个内网端口**，转发到**同一个 dsh 实例**（D1/D2 收口） | 用户 2026-09-27 定；理由：一个进程、一条隧道、一个 dsh、两个前门 |
| Q6 | **候选地址走 E2EE 通道下发**，host **不向 hub 上报**内网 IP/端口（D3b/D7 收口）：host 暴露普通 HTTP 端点，页面内由已被 wrap 的 `fetch` 取回 | 用户 2026-09-27 定；§2.7 已核实 hub 侧零改动、隐私更强、hub 无法伪造候选 |
| Q7 | **App 语音只用 garsync 原生面板**（D11 收口）⇒ DSH 页面内 `voice-input` 的 `mediaDevices` 不可用**不构成阻塞**，http 的残余代价仅 `clipboard` | 用户 2026-09-27 定 |
| Q8 | **两条通道的门禁统一为"可设定的固定口令"**（`gateway.accessCode` 语义），**不用动态配对码**（D4 收口）。由此：① 把 15 号明确排除的"gate 扩到直连路径"**纳入 24 范围**；② 顺带补 15 号遗留的 CLI 设置入口（F41） | 用户 2026-09-27 定；§2.4.1 已核实"三套门禁并存"的现状（F40–F42） |
| Q9 | **两种 host 形态（CLI 起的 host / 插件注册的 host）都在范围内**——两者是同一个 `startJoin` 与同一个 dsh 网关，只是在不同进程内起直连口（F38/F39） | 用户 2026-09-27 表述；可行性见 F39 |
| Q10 | **废弃动态配对码（`auth.mode: "pair"`）**，两条通道全部改用可设定的固定口令（D15 收口）。代价（影响面）见 §2.4.3 F48–F51：配置默认值、`pair.ts`/`pair-page.ts`、`setup lan`/`--pair-code`、M1 博客与 usage.md、M1 e2e | 用户 2026-09-27 定 |
| Q11 | **raw 流绕过在本特性内修**（D5 收口）：让统一门禁在 E2EE 通道上也真实生效；落地方式见 D17 | 用户 2026-09-27 定 |
| Q12 | **raw 流门禁的落地方式 = (c) host 侧页面 token**（D5/D17 收口）：只改 gateway 包、层 2 协议与 hub 均不动、无升级顺序要求（设计见 §2.4.3） | 用户 2026-09-27 定 |
| Q13 | **客户端范围 = App 先行、浏览器后置**（D19 收口）：本期交付 App 侧直连优先；浏览器侧可行性已核实（§2.8）但作为后续特性（其安全档位低一档，且不能探测/固定指纹） | 用户 2026-09-27 定 |
| Q14 | **直连传输分两步 = 先 `http` 跑通、P3 补 `https`**（req C1 收口；含"中间态必须显式标注限制"与"剪贴板能力补齐"两条连带）；证书来源与生成方式（须覆盖插件形态）**顺延 P3**（req C8） | 用户 2026-09-27 定 |
| Q15 | **未设固定口令就不监听直连口**（req C9/R14 收口）：避免"零认证的明文入口"，把"介意的人自己设口令"变成**默认安全** | 用户 2026-09-27 定 |

---

## 8. 下一步

1. **先查 P7**（App WebView 里到底有没有 E2EE pin）——它是 Q6 方案的硬前置（L2）；没有 pin 就没有可信的候选通道。
2. 再定 **D3a**（http 可接受性，残余代价仅 `clipboard`）与 **D3c**（连接可信：TLS 自签 + pin / 直连重放 Noise / 不做）——这两条合起来才等于"直连安全"。
3. 然后定 **D17**（raw 流门禁怎么落地，建议 a）与 **D18/D16**（迁移与首次口令、CLI 入口）——D4/D5/D15 已定，剩下的都是落地形态。
4. D8–D10、D12/D13 与 P8 可在 `solution.md` 阶段展开；必要时先做 P4（真机 WebView 能力实测）与 P6（收益量化）。
5. 方向确定后产出 `req.md`（含验收标准：同内网直连成功、跨网段/直连不可达自动回落隧道且体验不劣化、候选不经 hub 也不被 hub 伪造、统一门禁在两条通道与两种 host 形态上均生效）。
6. 本文件在 `req.md` 批准后转只读（**`req.md` 已于 2026-09-27 产出，待批准**）。

> **范围提示（供排期参考，非决策）**：截至 2026-09-27，24 的范围已包含 **host 侧**（A 案直连口 = 复用 `startGateway`、固定口令统一、配对码废弃、raw 流门禁、候选端点、CLI 入口）与 **App 侧**（取候选、试连测速、切换与回退、可能的信任建立流程）。**hub 侧可做到零改动**（D17 选 c：`rdsh_gate` 的 raw 绕过用 host 侧页面 token 修，不碰层 2 协议、不改 relay/shim）。建议在 `req.md` 里按"host 侧能力 → App 侧切换"拆阶段。

---

## 9. 附录：P7 真机验证步骤（App 的 WebView 里到底有没有 E2EE pin）

> 目的：判断 Q6 方案（候选走 E2EE 通道）在 garsync App 里**是否已经有可信通道可用**。
> 背景事实：shim 仅在 `localStorage.rdsh_e2ee_pins` 存在该 host 公钥时才 wrap fetch/WS（`packages/hub/src/e2ee-shim.ts:17,59`）；该 pin 由**门户页面**写入（`packages/portal/src/pages.tsx:37-47`）；garsync 代码里**零** e2ee/pin/portal 引用 ⇒ App 对这个流程无感知。

### 9.1 前置检查（host / hub 侧，零改动）

| # | 命令 / 检查 | 判读 |
|---|---|---|
| H1 | host 上 `ls -l ~/.rdsh/e2ee-key.json` | 存在 = host 具备 E2EE 身份（注册时上送公钥） |
| H2 | hub 上 `sqlite3 ~/.rdsh/hub.db "SELECT id,name,length(e2ee_public_key) FROM hosts;"` | 该 host 的 `e2ee_public_key` 非空 = hub 有公钥可供 pin（这是判定 A 去歧义的关键） |
| H3 | hub 配置 `e2ee.mode` | 必须 ≠ `off`（`off` 时 relay 直接拒绝 raw 流，`packages/hub/src/relay.ts:262`） |

### 9.2 判定 A（零改动，最快）——用门户的信任流程反推

在 **App 的 WebView 里**打开 hub 门户主机列表（把 host URL 临时改为 `https://<hub>/portal/hosts`，或走 App 内既有入口），点开那台 host：

| 观察 | 结论 |
|---|---|
| 弹出**指纹确认框** | 该 WebView **没有 pin**（且 hub 已有公钥）→ **P7 = 否**，需为 App 设计信任流程 |
| 直接进入、无弹窗，且 **H2 有公钥** | **已有 pin**（`readE2eePin(hostId) === pub`，`pages.tsx:1284`）→ **P7 = 是**，E2EE 已启用 |
| 直接进入、无弹窗，但 **H2 无公钥** | 该 host 无 E2EE 可 pin（明文直通）→ 属另一种情况：需重新 `rdsh host join` 上报公钥 |

依据：`packages/portal/src/pages.tsx:1275-1290`（`requestEnter`：无公钥→直连；已 pin→直接进；否则弹信任框）；portal 与 DSH 页面**同源**（都在 hub 根），共用同一个 `localStorage`。

### 9.3 判定 B（权威，Release / iOS 同样有效）——host 侧看有没有 raw 流

1. 在**跑 App 的那台 host** 上改用**仓库版**启动（`node packages/cli/src/bin.ts host serve`，或改 npm 全局安装目录里的 dist）。
2. 在 `packages/gateway/src/join.ts` 的 `startRawStream()` 首行临时加：`console.log("[e2ee] raw stream opened", streamId);`
3. 在 App 里打开该 host，观察日志：

| 观察 | 结论 |
|---|---|
| 出现 `[e2ee] raw stream opened` | 走 E2EE（pin 存在）→ **P7 = 是** |
| 不出现（只有明文请求） | 明文路径 → **P7 = 否** |

依据：E2EE 的 OPEN 是 `{kind:"raw"}` → `startRawStream`（`join.ts:924-927`），明文走 `plainDispatcher`；该函数当前**没有任何日志**（已核），故需临时加一行。

### 9.4 判定 C（Android 可达时最直接）——直接读 localStorage

- **仅 debug 构建可用**：Android 侧已有 `WebView.setWebContentsDebuggingEnabled(true)`，但包在 `FLAG_DEBUGGABLE` 判断里（`android/app/src/main/kotlin/com/unicgames/garsync/MainActivity.kt:25-27`）→ Release 包看不到。
- 跑 debug 包 → Chrome `chrome://inspect` → inspect 该 WebView → Console：
  - `JSON.parse(localStorage.getItem("rdsh_e2ee_pins")||"{}")` → 含该 hostId 即已 pin；
  - Network → WS：存在连到 `/e2e` 的 WebSocket 即 E2EE 正在跑（`packages/hub/src/e2ee-shim.ts:112`）。
- iOS 侧未设 `isInspectable`（garsync `ios/` 无相关设置）→ Safari 检查器不可用，走判定 B。
