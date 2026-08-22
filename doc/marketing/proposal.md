# remote-dsh 产品提案：让 DeepSeek Harness 随时随地可用

![rdsh logo](../../media/rdsh512.png)

> **日期**: 2026-08-22
> **状态**: 讨论稿 v0.1（待需求评审）
> **一句话**: 在 DSH 之上构建一层"安全远程访问"产品 —— 从局域网手机浏览器，到公网 hub 隧道，再到多租户账号体系与移动端（Android/iOS + 微信小程序）。

---

## 1. 背景与现状

### 1.1 DSH 是什么

DeepSeek Harness（DSH）是 DeepSeek 开源的 AI 编程/执行环境。`npm install -g @deepseek-ai/dsh` 后，一条命令即可在本机启动一个功能完整的 Web GUI（对话、工具执行、文件系统、子代理、工作流等）：

```bash
dsh web          # 打开 http://127.0.0.1:3080
```

### 1.2 现状事实（查档结论，非猜测）

以下结论来自对已安装 `@deepseek-ai/dsh@0.1.1-rc.2` 实际代码的核查：

| 事实 | 出处 |
|---|---|
| 默认绑定 `127.0.0.1`，默认端口 `3080`；`--host` 仅接受 `127.0.0.1` / `0.0.0.0` 两个字面值；`--port 0` 由 OS 分配 | `dsh-web-app/cordis.patch.yml`（`host: !!js ctx.webStartup.host ?? '127.0.0.1'`，`port: ?? 3080`） |
| **没有任何 HTTP 认证层**：webserver 是裸 `node:http` 服务器，无用户名/密码/token/会话 | `dsh-host-webserver/lib/index.js` |
| 安全仅靠"围栏"：Host header 必须是 loopback / LAN IP 字面量 / `--trusted-host` 声明的 authority；`sec-fetch-site: cross-site` 拒绝；带 Origin 必须同源。**代码注释明确写着 "this fence is not an auth layer"** | `dsh-client-connection/lib/index.js`（`isTrustedApiRequest`） |
| 全部能力走 `/api/*`：HTTP RPC + `/api/events.mux`、`/api/events.host` 两条 WebSocket 通道；静态前端走 fallback 路由 | `dsh-client-connection/lib/index.js`（`API_PATH` 等常量） |
| LAN 模式已有雏形：绑定 `0.0.0.0` 时自动推导本机 IPv4 列表并打印 `(LAN: http://<ip>:<port>)`，配合 `--trusted-host` 扩展围栏 | `dsh-web-app/lib/index.js`（`resolveLanTrust`） |
| 前端是独立发布包 `@deepseek-ai/dsh-web-frontend`（含 `dist/index.html`），可整体复用；`/api` 契约类型是 browser-safe 的 | `dsh-web-app/lib/index.js`（`resolveDistIndex`）、`dsh-host-apiproxy` |
| 检测 SSH 启动（`SSH_CONNECTION`/`SSH_TTY`）时自动跳过"打开浏览器"，说明官方已意识到 SSH 端口转发场景 | `dsh-web-app/lib/index.js`（`launchedThroughSsh`） |

### 1.3 痛点

1. **本机锁定**：DSH 只能在本机浏览器使用。人在客厅、地铁、出差，无法操作办公室/家里的开发机。
2. **裸奔不可用**：直接 `--host 0.0.0.0` 暴露到局域网 = 同网段任何人可打开 GUI → DSH 能执行任意 shell 命令，等于把开发机钥匙放在门口。官方围栏**明确不是认证层**，所以任何远程方案都必须自带认证。
3. **公网无路**：家庭宽带无公网 IP / NAT 后无法直接访问；SSH 转发要求客户端装 SSH、且服务端开端口，门槛高、不适用于手机。

### 1.4 机会

- 开发者的 DSH 会话跑在"好机器"（大内存、稳定网络、公司内网）上，人却在任何地方 —— 远程访问是刚需。
- DSH 前端与 `/api` 契约完整可复用：我们不必重写 UI，只需解决"把浏览器流量安全地送进 127.0.0.1:3080"。
- 三步走天然递进：LAN（免费）→ 公网 hub（核心价值）→ 多租户 + 移动端（产品化）。

---

## 2. 产品定位

### 2.1 定位

> **远程访问层**：一条命令把 DSH 从"本机工具"变成"随身服务"。
> 开发者在自己机器上照常 `dsh web`，之后用任何设备（笔记本浏览器、手机浏览器、App、微信小程序）登录自己的账号，即可安全地操作这台机器上的 DSH。

**产品形态（已定，2026-08-22）**：**自用/自托管工具**起步 —— hub 提供一键部署（Docker），账号体系轻量够用即可；架构上预留多租户扩展能力（数据库与令牌模型按多租户设计），价值验证后再决定是否商业化。

### 2.2 目标用户

- 个人开发者：家里/公司多台机器，各自跑 DSH，统一一个入口管理。
- 团队/小公司：共享开发机上的 DSH 实例，成员按账号访问。
- 进阶：DSH 跑在云主机 / NAS / 家庭服务器上的用户。

### 2.3 命名（已定，2026-08-22）

产品全名 **remote-dsh**（非 remote-ssh —— 本项目不是 SSH 协议，而是"DSH Web 远程访问"）；项目短名 / 代码名 **rdsh**。命名三原则：统一 `rdsh-` 前缀（不与 DSH 官方 `dsh-*` 包命名混淆）、组件名反映职责且不与 DSH 既有概念冲突（DSH 生态中 `agent` 指 AI 代理，故开发机组件不叫 agent）、CLI 动词直观。

| 组件 | 名称 | 职责 |
|---|---|---|
| CLI 命令 | `rdsh` | 统一入口：`rdsh serve`（LAN 模式）/ `rdsh join <hub>`（公网模式）/ `rdsh hub ...`（服务器命令，原型期）。**npm 包名 `remote-dsh`**（`rdsh` 裸名被 npm typo-squatting 防护拒绝），已发布 0.1.0 占名（2026-08-22） |
| 服务器 | **rdsh-hub** | 控制面（认证、host 注册、路由）+ 数据面（隧道汇聚转发）。**原型期 = TS/Node（rdsh 包内）；生产期 = Go 单二进制**（见 §7） |
| 开发机侧 | **rdsh-gateway** | 一个进程两种模式：LAN 认证网关 / 公网出站隧道端点；spawn `dsh web` |
| 隧道协议库 | rdsh-tunnel | 帧复用、心跳、背压 |
| 门户前端 | rdsh-portal | 登录 + host 列表页 |
| 手机 App | rdsh-app | Android/iOS（显示名 "rdsh"） |
| 微信小程序 | rdsh-weapp | 轻量界面 + wss 直连 hub |

> **术语约定**：本文后续出现的 "hub"、"gateway"、"portal" 均指上述组件（rdsh-hub / rdsh-gateway / rdsh-portal），不再重复前缀。

---

## 3. 需求分层（三步走）

### Step 1 — 局域网（LAN）【= MVP 范围】

**目标**：同一 WiFi/局域网内，笔记本或手机浏览器直接访问开发机上的 DSH，且安全。

> **MVP 定义（已定，2026-08-22）**：仅交付 rdsh-gateway（LAN 模式）。`npm i -g remote-dsh`（与 dsh 同装，独立 npm 包，spawn PATH 中的 `dsh web`），另一台笔记本**即刻可用**。hub / portal / App / 小程序全部后置。

- [ ] 开发机一条命令启动（如 `rdsh serve`），监听局域网地址
- [ ] 浏览器访问 `http://<开发机IP>:<端口>`，先过认证再进 DSH 界面
- [ ] 默认**拒绝一切未认证流量**（不沿用裸 `--host 0.0.0.0`）
- [ ] 移动端浏览器适配（DSH 前端本身是响应式 SPA，验证为主）

### Step 2 — 公网（hub 转发）

**目标**：任意网络环境（4G/5G、异地 WiFi）都能访问，无需公网 IP、无需路由器端口映射。

- [ ] 一台**公网 hub 服务器**（用户自托管或官方提供）负责认证与转发
- [ ] 开发机上的 **rdsh-gateway** 主动向 hub 建立**出站隧道**（只出不进，穿透 NAT/防火墙）
- [ ] 客户端（浏览器）访问 `https://hub.example.com`，登录后选择目标机器
- [ ] 传输全程 TLS；登录凭证与访问授权分离；支持 token 撤销
- [ ] 多 host：一个 hub 下注册多台开发机，一个账号可访问自己的多台机器

### Step 3 — 多租户账号体系 + 移动端

**目标**：产品化 —— 用户注册、账号管理多 host、手机 App 与微信小程序。

- [ ] 用户注册/登录（邮箱或手机号 + 密码 / 验证码），密码安全哈希，可选 2FA
- [ ] 每个用户可注册并管理**多个 host**；host 可归属用户或共享给团队
- [ ] Android / iOS App：登录、host 列表、进入 DSH 界面（WebView 复用前端）
- [ ] 微信小程序：登录、host 列表、轻量会话操作（或 web-view 加载 H5）
- [ ] 管理后台：host 状态、连接日志、吊销令牌

---

## 4. 总体架构

### 4.1 角色与组件

```
┌──────────────┐   HTTPS/WSS    ┌──────────────────┐   WSS 隧道    ┌──────────────────────────┐
│   客户端      │ ─────────────► │    rdsh-hub       │ ◄──────────── │  rdsh-gateway（开发机）    │
│ 浏览器 / App  │   登录+访问     │  认证·授权·路由·转发 │   出站长连接    │  隧道客户端 + 认证网关      │
│ / 小程序      │                │  (用户/host 注册表) │               │           │              │
└──────────────┘                └──────────────────┘               │           ▼              │
                                                                   │  127.0.0.1:<port>        │
                                                                   │  dsh web (spawn 子进程)    │
                                                                   └──────────────────────────┘
```

- **rdsh-gateway（开发机侧）**：Node.js CLI。启动时 spawn `dsh web --port 0 --no-open`（OS 分配端口，避免冲突），读取实际端口后向 hub 建立出站 WSS 隧道。**只出站**：开发机无需公网 IP、无需开任何入站端口。
- **rdsh-hub（公网侧）**：单域名单一入口。职责：
  1. **控制面**：用户注册/登录、host 注册与配对、访问授权、令牌签发/吊销、审计日志。
  2. **数据面**：把客户端的请求按 `hostId` 路由到对应 gateway 隧道，双向透明转发。
- **客户端**：永远只连 hub 一个域名（证书单一、小程序合法域名单一、无需知道开发机地址）。

### 4.2 关键设计决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 隧道方向 | rdsh-gateway **出站**长连接 | 免 NAT 穿透、免端口映射、免公网 IP；与 cloudflared / frp / Tailscale 同范式 |
| 隧道协议 | **WebSocket 承载原始 TCP** | 必须能转发 HTTP + SSE + WebSocket 升级（DSH 依赖 `/api/events.mux`、`events.host` 两条 WS）；WS 在浏览器/App/小程序三端都有成熟支持 |
| 内容归属 | 前端与 API 由 **gateway 从本地 dsh 提供**，hub 只做透传 | 各开发机 dsh 版本可以不同；hub 不缓存不改造业务流量 |
| 认证位置 | 认证在 **hub**，gateway 侧只认隧道内来源 | 单一信任锚点；gateway 不需要存用户密码 |
| 浏览器体验 | 统一门户（rdsh-portal）：`https://hub/` 登录 → host 列表 → 进入某 host 的 DSH | 一个 URL 搞定全部，移动端与桌面端同一入口 |

### 4.3 转发链路（一次访问的完整路径）

```
浏览器 ──https──► rdsh-hub(认证+路由) ──wss──► rdsh-gateway ──http──► 127.0.0.1:3080 (dsh web)
    ▲                                                                             │
    └──────────────────────── 响应原路返回 ◄──────────────────────────────────────┘
```

- Hub 在隧道上复用同一条 WSS 连接做多路复用（一个 host 一条隧道，内部按请求 id 分帧），避免每请求建连。
- 大文件/图片：DSH 聚合图片上限 200 MiB、请求体上限 300 MB，隧道吞吐需按此量级设计（流式转发，禁止整体缓冲）。

### 4.4 协议分层（两个协议层，客户端只碰层 1）

```
rdsh-app (Flutter)
 ├─ ① 原生壳（Dart）──HTTPS REST──► hub           ← 层1：hub 对外 API
 ├─ ② WebView 内 portal H5 ──HTTPS/WSS──► hub    ← 层1（标准 Web 流量）
 └─ ② WebView 内 DSH UI ──HTTPS/WSS──► hub ──(层2: rdsh-tunnel)──► gateway ──► dsh web
                                        ↑
                                  层1 的终点，层2 的起点
```

| 层 | 范围 | 协议 | 实现方 |
|---|---|---|---|
| **层 1：hub 对外 API** | 所有客户端 ↔ hub（浏览器 portal、App 原生壳、weapp、未来 SaaS 第三方） | `JSON over HTTPS`（REST）+ `WSS` 事件流 | hub 提供；契约**文档先行**，是 weapp / App 原生实现 / 未来第三方接入的依据 |
| **层 2：rdsh-tunnel** | hub ↔ gateway | `WSS` 承载 + 帧复用（参考 DSH mux 帧） | 原型期 TS 双端 + 未来 Go 侧；**App 完全不实现**，它只和 hub 说话 |

### 4.5 hub 对外 API 雏形（层 1，M2 前文档定稿）

| 调用 | 方法/路径 | 认证 | 用途 |
|---|---|---|---|
| 注册（阶段三） | `POST /api/auth/register` | — | 创建账号 |
| 登录 | `POST /api/auth/login` | — | 返回 access + refresh JWT |
| 刷新 | `POST /api/auth/refresh` | refresh token | token 轮换 |
| Host 列表 | `GET /api/hosts` | Bearer JWT | 我的机器列表（在线状态、名称、延迟） |
| 事件流 | `WSS /api/events` | Bearer JWT | host 在线/离线推送 |
| 进入 host | `GET /h/<hostId>/...` | Bearer JWT（或注入 Cookie） | 透传 DSH 界面与 API（走层 2 隧道） |

**统一约定**（MVP 起即遵循，保证迁移平滑）：路径统一 `/api/*`；错误统一 `{ error: { code, message } }`；时间 ISO 8601；认证 `Authorization: Bearer <JWT>`（原生壳）/ Cookie（WebView 内页面）。

### 4.6 rdsh serve 认证流程（MVP：配对码 + 会话 Cookie）

```
开发机终端                         另一台笔记本浏览器
┌─────────────┐                  ┌──────────────────────┐
│ rdsh serve  │                  │ 访问 http://<IP>:<port>│
│ 生成配对码 123456 ──显示──►      │                      │
│ (仅本机可见) │                  │ ① 无会话 Cookie        │
│             │ ◄── GET / ─────── │ → 返回配对码输入页     │
│             │ ◄── POST /pair ── │ ② 输入 123456         │
│ 校验配对码   │                  │                      │
│ 签发会话     │ ──Set-Cookie──►  │ ③ 以后自动带 Cookie    │
│             │ ◄── GET /api/* ── │ ④ 校验通过→转发 dsh    │
└─────────────┘                  └──────────────────────┘
```

1. **启动生成配对码**：随机 6 位，打印在开发机终端 —— 只给"人在开发机前"的你，物理信任锚点。
2. **首次访问**：无有效会话 → 返回极简配对页（gateway 自带 HTML，非 dsh 前端）。
3. **提交配对**：浏览器 `POST /pair`。
4. **校验**：恒定时间比较（防时序攻击）+ IP 维度失败限流（防爆破）。
5. **签发会话**：`Set-Cookie` 签名会话 Cookie（HMAC-SHA256，**HttpOnly + SameSite=Lax**，默认 12h 可配）。HttpOnly 防 XSS 读取；SameSite=Lax + Origin 校验防 CSRF。
6. **之后全转发**：校验签名+过期 → 通过则**原样转发** dsh（HTTP/SSE/WS upgrade 一视同仁）。
7. **失效**：Cookie 过期或 `rdsh serve --reset`（重置密钥）后重新要求配对码。

- **无状态会话**：签名 Cookie 不存服务端状态，密钥首次生成存 `~/.rdsh/`，重启 gateway 不失效。
- **LAN 场景是 http**（无法加 Cookie `Secure` 属性）：依赖"只监听内网 + SameSite + Origin 校验"兜底，威胁模型低，可接受；公网场景（M2+）全链路 https 自动获得 Secure。

---

## 5. 分阶段技术方案

### 5.1 阶段一：局域网安全直连（无 hub）

**架构**：本机 `rdsh serve` = **认证网关（rdsh-gateway 的 LAN 模式，MVP）** + dsh 子进程。

```
手机/笔记本浏览器 ──http(s)──► 认证网关(0.0.0.0:<端口>) ──► 127.0.0.1:3080 (dsh web)
                                  │
                                  └─ 首次访问要求输入配对码/口令，通过后签发短期会话
```

- **认证网关**：Node.js 独立进程。静态文件与 API 请求一律先过认证中间件，再原样转发给 dsh（HTTP、SSE、WS upgrade 都要转发）。
- **认证方式（LAN 场景）**：配对码（`rdsh serve` 启动时生成，终端显示，手机输入一次）+ 浏览器短期会话 Cookie。**不上账号体系**，保持轻量。完整流程与安全细节见 §4.6。
- **为什么不能直接 `--host 0.0.0.0`**：DSH 无认证，等同裸奔；网关把"网络可达"与"业务能力"之间加上强制认证闸门。
- **产出**：认证网关是阶段二 rdsh-gateway 的**同一份代码**（gateway = 网关 + 隧道客户端），阶段一即阶段二的地基。
- **安装（MVP）**：`npm i -g remote-dsh`（独立 npm 包，要求 dsh 已在 PATH）。未来提供 dsh 插件形态作为薄适配层，复用同一核心包，两条安装路径并存（见 §10 Q10）。

### 5.2 阶段二：公网 hub + 反向隧道

**新增组件**：rdsh-hub 服务端（控制面 + 数据面）、rdsh-gateway 隧道客户端、rdsh-portal 门户页。

**rdsh-hub 控制面**：

- 用户注册/登录（邮箱 + 密码，密码用 `node:crypto.scrypt` 哈希，或 argon2）。
- Host 注册：开发机首次运行 `rdsh join https://hub.example.com`，打印**一次性配对码**；用户登录 hub 网页输入配对码完成绑定 → 生成长期 **host token**（仅 gateway 持有，用于建立隧道）。
- 授权模型：`用户 ↔ host` 多对多；host 归属 owner，可共享给其他用户（只读/管理角色，先做 owner/member 两档）。
- 令牌体系（JWT）：
  - 用户侧：短期 access token（如 1h）+ refresh token（可轮换、可吊销）；
  - gateway 侧：host token（长期，可随时在 hub 吊销，吊销即断隧道的凭证）；
  - 会话：每次访问 host 时校验用户对 host 的授权，不做"永久放行"。

**rdsh-hub 数据面**：

- 隧道注册表：`hostId → 活跃 WSS 隧道`；连接断开自动摘除，重连自动恢复。
- 请求路由：客户端请求路径加 host 前缀（如 `https://hub.example.com/h/<hostId>/api/...`），hub 剥前缀后经对应隧道转给 gateway，gateway 还原为对 `127.0.0.1:<port>` 的本地请求。
- 多路复用协议：单隧道内按 request-id 分帧（借鉴 DSH 自身 mux 帧设计），支持并发 HTTP/SSE/WS 流。
- 鉴权放行后**不改写业务报文**（只透传），保证 dsh 各版本兼容。

**门户页（rdsh-portal）**：

- 登录/注册页、host 列表（在线状态、延迟、最近访问）、进入 host 的 DSH。
- DSH 界面本身完全复用 `@deepseek-ai/dsh-web-frontend`：hub 把该 host 的 index.html + 静态资源**原样透传**（gateway 从本地 dist 提供），页面内 `window.__DSH_BOOT__` 等引导机制不变。
- 证书：hub 用 Let's Encrypt 自动签发（自托管用户可自备证书）。

### 5.3 阶段三：多租户产品化 + 移动端

**账号体系增强**：邮箱验证、找回密码、可选 2FA（TOTP）、登录风控（限流/锁定）、审计日志（登录、host 访问、令牌吊销）。

**移动端 App（Android/iOS）**：

- 推荐第一版：**原生壳 + WebView**（WKWebView / Android WebView）加载 hub 门户 H5。理由：
  - DSH 前端整体复用，零 UI 重写；
  - 登录态存原生安全存储（Keychain/Keystore），WebView 内免重复登录；
  - 成本最低、迭代最快；后续如需推送通知/原生能力再逐步原生化。
- 备选：Flutter/React Native 重写界面 —— 收益低、成本高，**不建议首版**。

**微信小程序**：

- 硬约束（事实）：小程序网络请求必须 `https`；socket 必须 `wss`；所有域名必须 **ICP 备案**并在小程序后台配置为合法域名；`web-view` 组件只能打开已备案的业务域名。
- 方案 A（推荐起步）：**原生小程序界面** + `wss` 直连 hub —— 做轻量版：host 列表、会话列表、发消息、看结果/文件。够用且审核风险低。
- 方案 B（进阶）：`web-view` 加载门户 H5，体验完整但受限于域名配置与 web-view 能力（不能混合原生组件）。
- 注意：小程序后台配置的 socket 合法域名**只能有一个 wss 域名**（多 host 也走同一 hub 域名，正好满足）。

**管理后台**：host 在线/离线、隧道流量、用户列表、令牌管理、操作审计。

---

## 6. 安全设计（Best Practice 清单）

> 前提认知：**把 DSH 暴露到网络 = 把任意 shell 执行能力暴露到网络**。DSH 自身无认证（见 §1.2），因此本产品第一原则是"默认拒绝，显式授权"。

### 6.1 传输安全

- 全链路 TLS 1.3（hub 证书 Let's Encrypt；LAN 阶段可用自签证书 + 首次信任提示，或本地生成 CA 安装到设备）。
- gateway→hub 永远 WSS 出站；拒绝明文降级。
- 可选增强：敏感数据端到端加密（gateway↔客户端协商密钥，hub 不可读）——已定：MVP 不实现，协议层预留，公共 SaaS 化时实现（见 §10 Q5）。

### 6.2 认证（你是谁）

- 密码：scrypt/argon2 哈希 + 随机盐；禁止明文/弱哈希。
- 令牌：短期 JWT + refresh 轮换；所有令牌服务端可吊销。
- 可选：TOTP 2FA、登录失败限流 + 账户临时锁定、新设备登录通知。
- gateway 配对码：一次性、短时效（如 10 分钟）、使用后立即作废。

### 6.3 授权（你能碰什么）

- 用户只能访问**绑定到自己名下/被共享**的 host；hub 在每次请求路由时校验，而不是登录时一次放行。
- 令牌最小化：用户 token 与 host token 分离；host token 只能建隧道，不能登录门户、不能改账号。
- 后续可扩展：profile 级授权（一个 DSH 实例可跑多个 profile/workspace，按 profile 授权，见 §10 Q4）。

### 6.4 数据安全

- 数据库：令牌与密钥只存哈希（host token 存 SHA-256 摘要，不存原文）。
- 审计日志：登录、配对、host 绑定/解绑、令牌吊销、异常流量，留痕可查。
- 隐私：hub 尽量不落盘业务流量；转发即用即弃。

### 6.5 加固与运维

- 登录/注册接口限流（IP + 账号双维度）、验证码（阶段三）。
- hub 侧 CORS 白名单（只允许门户同源）；拒绝跨站请求（沿用 DSH 的 Host fence 思路）。
- 依赖最小化（见 §7），降低供应链风险；定期更新。
- 日志脱敏（不记密码、不记完整 token）。

### 6.6 合规（中国，阶段三上线前必须）

- hub 域名 **ICP 备案**（微信小程序强制要求）；
- 小程序：`wss` 合法域名配置、用户隐私协议、类目审核；
- App 上架：应用商店开发者账号、软著/备案（按平台要求）；
- 数据合规：隐私政策、用户数据删除入口（GDPR/个保法）。

---

## 7. 技术栈建议

**语言策略（已定，2026-08-22）——分阶段双栈**：

- **原型期（M1–M2）**：全 TypeScript/Node —— rdsh-hub 以 TS 实现并随 `rdsh` npm 包分发，单一语言、迭代最快；
- **生产期（价值验证后）**：rdsh-hub 用 **Go 重写**为单静态二进制（`go:embed` 内嵌 portal 前端），独立分发（GitHub Release / Docker），服务器免 Node 运行时。
- **前提契约**：tunnel 线协议与 hub 对外 API 在原型期**文档先行、定稿**，作为 Go 重写的唯一契约 —— gateway 与客户端永不需要改动。

### 原型期技术栈（TS 全栈，依赖最小化）

| 组件 | 选型 | 说明 |
|---|---|---|
| 语言 | TypeScript（tsc strict） | 与 DSH 一致；可复用 DSH 的 `/api` 契约类型（browser-safe） |
| gateway / hub 传输 | `node:http` + `ws` | DSH 自身即用 `ws`；HTTP/SSE/WS 升级全支持 |
| 隧道多路复用 | rdsh-tunnel 帧协议（参考 DSH mux 帧） | 小协议，几百行内可控，不引重型 RPC；**协议文档先行** |
| hub 数据库 | `node:sqlite`（Node ≥22.5 内置，v24 稳定）→ 规模化换 PostgreSQL | 零依赖起步；单文件部署 |
| 密码哈希 | `node:crypto` scrypt | 内置、无需原生依赖 |
| JWT | `jose`（WebCrypto，无原生依赖） | 轻量纯 JS |
| CLI | commander（DSH CLI 同款） | `npm i -g remote-dsh` 一个包聚合 serve/join/hub |
| 前端（门户 + DSH UI） | 复用 `@deepseek-ai/dsh-web-frontend` + 极薄门户壳（Vite + React 18，与 DSH 前端同构） | **不重写 DSH 界面**，这是本产品最大的复用红利 |
| 移动端 App | **Flutter/Dart** + `webview_flutter`（首版 WebView 壳 + 原生登录态存储） | 单代码库双端；**不实现隧道协议**（隧道只在 hub↔gateway 之间） |
| 微信小程序 | 原生小程序（轻量界面 + wss 直连 hub API） | 平台硬约束：Flutter 不可用于小程序；原生最稳、审核风险最低 |
| 部署 | hub 单进程 + SQLite，Docker 可选 | 自托管友好 |

### 生产期 rdsh-hub（Go，标准生态）

| 项 | 选型 |
|---|---|
| HTTP/WS | `net/http` + `gorilla/websocket` |
| SQLite | `modernc.org/sqlite`（纯 Go，免 CGO，交叉编译友好） |
| 认证 | `golang-jwt` + `golang.org/x/crypto`（argon2id） |
| 前端内嵌 | `go:embed` 打包 rdsh-portal dist → 单二进制含门户 |
| 隧道协议 | 按定稿的 rdsh-tunnel 线协议实现 Go 侧；**TS↔Go 互操作 conformance 测试** |

**仓库结构建议**（monorepo，pnpm workspace，与 DSH 生态一致）：

```
remote-dsh/
├── packages/
│   ├── gateway/      # rdsh-gateway：认证网关 + 隧道客户端（spawn dsh web）
│   ├── tunnel/       # rdsh-tunnel：隧道协议（帧格式、复用、心跳）+ 协议文档
│   ├── hub/          # rdsh-hub：服务器（原型期 TS；生产期替换为 Go 实现）
│   ├── cli/          # rdsh CLI：统一 bin（聚合 serve/join/hub 子命令）
│   └── portal/       # rdsh-portal：门户前端（登录 + host 列表）
├── apps/
│   ├── app/          # rdsh-app：Flutter（Android/iOS）
│   └── weapp/        # rdsh-weapp：微信小程序
├── go/               # （生产期）rdsh-hub Go 实现 + conformance 测试
└── doc/
```

---

## 8. 里程碑

| 里程碑 | 内容 | 验收标准 |
|---|---|---|
| **M0 需求确认** | 评审本文档 → `req.md`（用户批准） | 需求清单 + 验收标准定稿 |
| **M1 MVP（LAN）** | `npm i -g remote-dsh` + `rdsh serve`：认证网关 + 配对码 + 转发 HTTP/SSE/WS；与 dsh 同装 | 另一台笔记本（同 LAN）浏览器输配对码即可操作 DSH；无认证流量被拒 |
| **M2 公网 hub** | rdsh-hub（注册/登录/host 绑定/路由）+ `rdsh join`（出站隧道）+ rdsh-portal | 异地浏览器登录 hub → 选择 host → 完整操作 DSH；token 吊销即时生效 |
| **M3 多租户增强** | 邮箱验证、2FA、共享授权、审计、限流 | 安全加固项逐条过验收 |
| **M4 移动端** | rdsh-app（Flutter）+ rdsh-weapp | App/小程序登录后可访问 host 的 DSH |
| **M5 上线准备** | 域名备案、隐私政策、部署文档、压测 | 达到公开服务标准 |
| **M6 hub Go 化 + E2E 评估** | rdsh-hub Go 单二进制（go:embed 门户）+ conformance 测试；公共 SaaS 化时实现 E2E（协议位已预留） | 单二进制部署；TS↔Go 互操作通过；E2E 需求评审 |

---

## 9. 风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| 安全暴露：把无认证的 DSH 上网 = RCE 风险 | **高** | 认证/授权是 M1 的**前置条件**而非后置项；默认拒绝；全链路 TLS；令牌可吊销 |
| 微信小程序合规成本（备案/审核/域名） | 中 | 小程序放 M4，先用 App + H5 验证价值；备案尽早启动 |
| DSH 上游 `/api` 契约演进 | 中 | 纯透传设计，hub 不解析业务报文；升级 dsh 无需改本产品 |
| 隧道带宽/延迟（300 MB 请求体上限） | 中 | 流式转发、零缓冲；hub 与 gateway 均做背压；可选压缩 |
| hub 成为单点故障 | 中 | 无状态数据面 + SQLite 持久化控制面，多副本可扩展；自托管用户自担 |
| 移动端 WebView 体验（输入法/手势/复制粘贴） | 低 | DSH 前端已有 VS Code webview 移植经验（传输桥方案），验证为主 |

---

## 10. 决策记录与剩余开放问题

### 已定决策（2026-08-22）

| # | 决策 | 结论 |
|---|---|---|
| Q1 | 产品形态 | **自用/自托管工具**起步；架构预留多租户扩展 |
| Q2 | 命名 | **remote-dsh（产品）/ rdsh（代码短名）**；组件：rdsh-hub、rdsh-gateway、rdsh-tunnel、rdsh-portal、rdsh-app、rdsh-weapp（见 §2.3） |
| Q3 | 微信小程序 | **后置**：先 LAN → 公网 → App，小程序最后；域名备案可提前并行启动 |
| Q4 | 授权粒度 | **整实例授权**：绑定 host 即全权访问该 DSH；profile 级隔离后置 |
| Q5 | 端到端加密 | **MVP 不实现，协议层预留**（rdsh-tunnel 帧格式留加密扩展位）；未来公共 SaaS hub 时实现 —— 届时客户端已原生化（E2E 在 Web 端有"改页面 JS"局限，原生 App 中才真正成立） |
| Q8 | 技术栈 | **分阶段双栈**：原型期全 TS/Node（rdsh-hub 随 npm 包）；生产期 rdsh-hub 用 **Go 重写**（标准生态，单二进制）；rdsh-app 用 **Flutter/Dart**；rdsh-weapp 原生小程序。契约前提：tunnel 协议与 hub API 文档先行（见 §7） |
| Q9 | MVP 范围 | **仅 rdsh-gateway（LAN 模式）**：`npm i -g remote-dsh` 与 dsh 同装，另一台笔记本即刻可用；hub / portal / App / 小程序全部后置 |
| Q10 | 安装形式 | MVP：**独立 npm 包 `remote-dsh`**（2026-08-22 已发布 0.1.0 占名；`rdsh` 裸名被 npm typo-squatting 防护拒绝）；未来同时提供 **dsh 插件形态**（薄适配层复用核心包），两种安装路径并存 |

### 剩余开放问题

- **Q6 hub 归属**：是否需要官方提供一个可一键部署的 hub 镜像（Docker），让自托管成本趋近于零？（M6 Go 化后单二进制本身即可分发，Docker 为可选包装）
- **Q7 移动端范围**：首版是否只需要"能进 DSH 界面"（WebView 复用），不需要原生推送/原生文件管理？

---

*关联：本文档为 marketing 提案（讨论稿）。进入开发前需按 Feature Pipeline 产出 `doc/feature/01-remote-access/req.md` 并由用户批准。*
