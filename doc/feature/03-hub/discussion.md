# 03-hub — 讨论（discussion.md）

> **日期**: 2026-08-23
> **范围**: M3 —— 公网 hub（rdsh-hub 控制面 + 数据面、`rdsh join` 出站隧道、rdsh-portal 门户）
> **来源**: `doc/overview/proposal.md`（§2.3 组件、§4.5 层 1 API 雏形、§5.2 阶段二、§7 技术栈、§10 Q5/Q6/Q8）、`doc/overview/architecture.md`（§2 协议分层、§3 公网模式数据路径）、`packages/tunnel/PROTOCOL.md`（层 2 草案）
> **状态**: 讨论记录（READ-ONLY 后：需求进 req.md）

---

## 1. 目标（既有定案）

让开发机（**无公网 IP / 无端口映射**）上的 DSH 智能体，被**异地浏览器**经一个公网 hub 域名访问：

- gateway **只出站**建立 WSS 隧道（免 NAT 穿透、免开入站端口）
- 客户端永远只连 hub 一个域名（`https://hub.example.com`）
- 浏览器流程：登录 hub → host 列表 → 选一台 → 完整操作 DSH

验收（roadmap M3）：异地浏览器登录 hub → 选择 host → 完整操作 DSH；token 吊销即时生效。

## 2. 查档事实（2026-08-23）

### 2.1 层 1：hub 对外 API 雏形（proposal §4.5，M3 前文档定稿）

| 端点 | 方法 | 认证 | 说明 |
|---|---|---|---|
| `/api/auth/login` | POST | — | 返回 access + refresh JWT |
| `/api/auth/refresh` | POST | refresh token | token 轮换 |
| `/api/hosts` | GET | Bearer JWT | 我的机器列表（在线状态、名称、延迟） |
| `/api/events` | WSS | Bearer JWT | host 在线/离线推送 |
| `/h/<hostId>/...` | 任意 | Bearer JWT（或注入 Cookie） | 透传 DSH 界面与 API（走层 2 隧道） |

**统一约定**：路径 `/api/*`；错误 `{ error: { code, message } }`；时间 ISO 8601；认证 `Authorization: Bearer <JWT>`（原生壳）/ Cookie（WebView 内页面）。

### 2.2 层 2：rdsh-tunnel 草案（PROTOCOL.md，DRAFT）

- 载体 WSS（TLS 1.3），gateway 出站；单 host 一条隧道长连接
- 帧头：magic `RDSH`(4B) + version(1B) + flags(1B, **bit0 = E2E 预留，实现必须忽略未知位原样透传**) + type(1B: open/data/close/ping/pong/error) + streamId(4B) + length(4B) + payload(N)
- 多路复用：单隧道按 streamId 分帧，并发 HTTP/SSE/WS upgrade
- 背压：大负载（DSH 上限 300 MB）流式转发、禁止整体缓冲
- **payload 格式未定稿**（HTTP 请求行/头/体如何编码）—— solution.md 定稿

### 2.3 host 注册与令牌（proposal §5.2）

- `rdsh join https://hub.example.com` → 打印**一次性配对码** → 用户登录 hub 网页输码 → 生成长期 **host token**（仅 gateway 持有，建隧道凭证）
- 令牌体系（JWT，`jose` 库）：
  - 用户侧：access（如 1h）+ refresh（轮换、可吊销）
  - gateway 侧：host token（长期，可随时吊销，**吊销即断隧道**）
- 令牌最小化：host token 只能建隧道，不能登录门户/改账号
- 数据库：`node:sqlite`（Node ≥22.5 内置）；令牌只存哈希（host token 存 SHA-256 摘要）

### 2.4 数据面（proposal §5.2 / architecture §3）

- 隧道注册表：`hostId → 活跃 WSS 隧道`；断开自动摘除、重连自动恢复
- 请求路由：客户端 `https://hub.example.com/h/<hostId>/api/...` → hub 剥前缀 → 经对应隧道转给 gateway → gateway 还原为对 `127.0.0.1:<port>` 的本地请求
- **纯透传**：hub 鉴权后不改写业务报文（dsh 版本兼容）；认证在 hub，gateway 侧只认隧道内来源
- DSH 前端复用 `@deepseek-ai/dsh-web-frontend`：hub 把该 host 的 index.html + 静态资源原样透传（gateway 从本地 dist 提供），`window.__DSH_BOOT__` 引导机制不变

### 2.5 可复用组件（M1/M2 已实现）

| 组件 | 位置 | M3 复用点 |
|---|---|---|
| 转发内核 `forwardHttp` / `createUpgradeProxy` | `packages/gateway/src/proxy.ts` | Host/Origin 重写逻辑（DSH 围栏兼容）；hub 侧入站→隧道、gateway 侧隧道→本地的 HTTP 语义一致 |
| 会话 Cookie（HMAC 签名） | `packages/gateway/src/session.ts` | **hub 侧 WebView 会话可选复用**（portal 页面登录态）；JWT 为主 |
| TLS 加载 `loadTls` | `packages/gateway/src/tls.ts` | hub 的 https 证书（Let's Encrypt / 自备） |
| 服务化 `installService` | `packages/gateway/src/service.ts` | `rdsh hub` 服务化（systemd/launchd） |
| CLI 子命令框架 | `packages/cli/src/bin.ts` | 新增 `rdsh join` / `rdsh hub` 子命令 |
| 登录页/配对页（内联零依赖 HTML） | `login-page.ts` / `pair-page.ts` | portal 登录页可先内联复用，后续换 React portal |

### 2.6 技术栈定案（proposal §7）

- hub 原型 = TS/Node（随 `rdsh` npm 包，`rdsh hub` 命令）；生产 = Go 单二进制（M7）
- 依赖：`ws`（隧道/HTTP 升级）、`jose`（JWT）、`node:sqlite`（内置）；**零数据库外部依赖**
- portal = Vite + React 18（与 DSH 前端同构），`packages/portal` 已有骨架
- Docker 镜像（Q6 定案）：包装而非唯一路径
- conformance（e2e/）：TS↔Go 在 M7；M3 先做 TS 双端协议一致性测试

## 3. 关键设计问题（待决，进 req.md/solution.md 定稿）

| # | 问题 | 现状/倾向 | 需确认 |
|---|---|---|---|
| D1 | **用户模型** | M3 多用户（简单注册/登录），host 归注册用户所有；共享授权/邮箱验证/2FA 在 M4 | 是（无共享）还是先单管理员？ |
| D2 | **host 绑定** | `rdsh join` 打印一次性配对码（如 10 分钟有效），网页输码绑定后生成 host token | 配对码有效期；是否支持 gateway 侧直接填 token（绕过网页）？ |
| D3 | **层 2 payload 格式** | HTTP 请求封装：帧头 + JSON 头块（method/path/headers）+ 二进制体分帧；WS 升级单独 type | solution.md 定稿并更新 PROTOCOL.md |
| D4 | **hub 会话** | 用户侧 JWT（access 1h + refresh 7d 轮换）；WebView 内 portal 用 Cookie 存 JWT | 刷新策略；登出 = 吊销 refresh |
| D5 | **portal 范围** | 登录页 + host 列表（在线/离线/名称/延迟）+ 进入 host（透传 DSH UI）；React 重写 `packages/portal` | 管理功能（host 改名/吊销 token）放 portal 还是 CLI？ |
| D6 | **hub 管理命令** | `rdsh hub user add/rm/ls`、`rdsh hub host ls/revoke`、`rdsh hub serve`（服务化） | 与 gateway 的 `rdsh user/service` 命令平行设计 |
| D7 | **隧道健壮性** | 断线自动重连（指数退避 + 抖动）；心跳 ping/pong；`/api/events` 推送 host 在线状态 | 重连上限/退避参数 |
| D8 | **hub 数据面并发** | 单 hub 多 host、单 host 多客户端并发访问（同一条隧道内多个并发流） | streamId 分配策略（原子递增） |
| D9 | **E2E 预留** | flags bit0 加密位：原型必须忽略未知位原样透传 | 帧头不变，仅预留 |

## 4. 参考

- `packages/tunnel/PROTOCOL.md`（层 2 草案，DRAFT）
- `doc/overview/proposal.md` §2.3/§4.5/§5.2/§7/§10（Q5 E2E 预留、Q6 Docker、Q8 双栈）
- `doc/overview/architecture.md` §2 协议分层 / §3 公网模式 / §4 安全模型
- `doc/overview/roadmap.md` M3（验收：登录 hub → 选择 host → 完整操作 DSH；token 吊销即时生效）
