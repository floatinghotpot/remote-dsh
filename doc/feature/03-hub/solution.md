# 03-hub — 解决方案（solution.md）

> **日期**: 2026-08-23
> **状态**: 草稿，**待用户批准**
> **范围**: M3 —— 公网 hub（层 1 API + 层 2 协议定稿 + `rdsh join` 隧道 + portal）
> **来源**: [req.md](req.md)（R1–R12）, [discussion.md](discussion.md), `doc/overview/proposal.md` §4.5/§5.2/§7, `packages/tunnel/PROTOCOL.md`

---

## 1. Goal（目标架构）

```
浏览器 ──https://hub.example.com──► rdsh-hub（TS 原型）
                                      │  控制面：/api/*（JWT/Cookie）+ /api/events（WSS）
                                      │  数据面：/h/<hostId>/* 透传
                                      │  wss 隧道（层2 rdsh-tunnel，出站）
                                      ▼
                                rdsh-gateway（join 模式）
                                      │  http（Host/Origin 重写复用）
                                      ▼
                               dsh web (127.0.0.1:<port>)
```

- gateway **只出站**；客户端永远只连 hub 一个域名
- 层 1（hub 对外 API）与层 2（rdsh-tunnel）均为**冻结契约**（文档先行，跨语言）
- hub 纯透传业务流量（不解析/改写），portal 壳在 iframe 外（不侵入 DSH 界面）

## 2. Facts（现状审计，2026-08-23）

| 事实 | 证据 |
|---|---|
| gateway 转发内核：`forwardHttp`（HTTP/SSE 流式 + HTML 注入）、`createUpgradeProxy`（WS 双向桥接 + 排队防竞态）；Host 重写为 `127.0.0.1:<port>`、Origin 同步改写（DSH 围栏兼容） | `packages/gateway/src/proxy.ts`（已读全） |
| **dsh 不设置 X-Frame-Options / CSP frame-ancestors** → iframe 内嵌 DSH 界面可行 | grep `@deepseek-ai/dsh` 全部 lib（无 frame 头） |
| 隧道帧草案：magic `RDSH` + version + flags(bit0 E2E 预留) + type + streamId + length + payload；**payload 编码未定稿** | `packages/tunnel/PROTOCOL.md`（DRAFT） |
| tunnel / hub 包现状：仅占位（`export const NAME`），零实现 | `packages/tunnel/src/index.ts`、`packages/hub/src/index.ts` |
| portal 现状：Vite + React 18 骨架（`main.tsx` 占位），与 DSH 前端同构 | `packages/portal/` |
| CLI 子命令框架：`serve` / `user` / `service`（switch 分发 + 全局 `--config`） | `packages/cli/src/bin.ts` |
| 密码哈希 `hashPassword/verifyPassword`（scrypt）、`loadTls`（PEM/https）、服务化 `installService`（systemd/launchd）、限流模式（5 次/10 分钟）、`spawnDsh`（端口解析） | `packages/gateway/src/` |
| proposal 技术栈定案：JWT 用 `jose`、DB 用 `node:sqlite`、隧道用 `ws` | proposal §7 |
| 绑定流程定案：`rdsh join` 打印一次性配对码（10 分钟）→ 网页输码 → 长期 host token；`--token` 直填；**注册关闭**（管理员建号） | discussion D2 + req R4/R5/R12 |

## 3. Gap（差距 = 要解决的问题）

| 需求 | 现状 → 目标 |
|---|---|
| R2 层 2 协议 | 帧头草案 → **payload 编码定稿**（OPEN/DATA/CLOSE/PING/PONG/ERROR 语义 + HTTP/WS 封装）+ PROTOCOL.md 冻结 |
| R1/R12 hub 服务 | 占位包 → `rdsh hub serve`（https + DB + portal 静态） |
| R4 绑定 | 无 → pending 配对码（10 分钟）+ host token（SHA-256 摘要存储）+ gateway 轮询取 token |
| R5 层 1 API | 无 → login/refresh/logout/password/hosts/events/透传全套（契约冻结） |
| R3 隧道 | 无 → join 出站 WSS + 心跳 + 指数退避重连 |
| R8 数据面 | 无 → 隧道注册表 + `/h/<hostId>` 路由 + 多流复用 + 纯透传 |
| R6 portal | 占位 → React 四页面（登录/列表/进入 iframe/改密） |
| R9 多用户 | 无 → users/hosts 归属 + 隔离 |
| R11 一致性测试 | 无 → tunnel 帧编解码测试 + hub/gateway 双端 e2e |

## 4. Call-site Audit

| 变更 | 调用方 | 兼容性 |
|---|---|---|
| `cli/bin.ts` 加 `join`/`hub` 子命令 | 现有 `serve/user/service` | 兼容：switch 扩展，不破坏现有 flags |
| `proxy.ts` 提取 Host/Origin 重写 helper（`rewriteHeadersForDsh`） | `forwardHttp`/`createUpgradeProxy`（现调用方，行为不变）| 兼容：重构提取，join.ts 复用 |
| `tunnel/PROTOCOL.md` 草案 → 冻结 | 无现有实现 | 兼容：从零实现，无破坏 |
| gateway `serve.ts` | join 模式新增独立代码 | 兼容：serve 不动 |
| hub 认证（JWT） | gateway 的 session.ts **不复用**（hub 用 JWT，独立实现） | 无影响（gateway LAN/M2 不受扰） |

## 5. 关键设计定稿

### 5.1 层 2 协议（PROTOCOL.md 冻结，跨语言契约）

**帧头**（不变，草案已定）：

```
magic "RDSH"(4B) | version(1B) | flags(1B) | type(1B) | streamId(4B BE) | length(4B BE) | payload(N)
```

- flags bit0 = **E2E 加密预留**：实现必须忽略未知位并原样透传（向后兼容）
- 心跳：应用层 PING/PONG（30s 间隔；10s 超时判定离线）

**type 与 payload**（本次定稿）：

| type | 值 | payload | 语义 |
|---|---|---|---|
| OPEN | 0x01 | JSON `{kind, method?, path?, headers?, status?, reason?}` | 流开始。**hub→gateway = 客户端请求**（kind:"http" 或 "ws"，method/path/headers）；**gateway→hub = 上游响应**（kind:"http"，status/reason/headers）。streamId 由 hub 分配，响应流复用同一 streamId |
| DATA | 0x02 | 原始字节 | 请求/响应体分片（流式，禁止整体缓冲；300 MB 上限按分片转发） |
| CLOSE | 0x03 | JSON `{code?, message?}` | 流正常结束（code 0）或异常（如上游 502） |
| PING | 0x04 | JSON `{ts}` | 心跳探测 |
| PONG | 0x05 | JSON `{ts}` | 心跳回显 |
| ERROR | 0x06 | JSON `{code, message}` | 协议级错误（认证失败、host 不存在等），关闭对应流 |

**隧道认证**：WSS 连接 URL query `?token=<hostToken>`（WSS 已加密；hub 日志明确不记录 query）。连接后第一条有效流之前，hub 先校验 token → 关联 hostId。

**WS 升级流**：浏览器 → hub 的 `/h/<hostId>/api/events.mux` upgrade → hub 发 `OPEN {kind:"ws", path, headers}` → gateway 向本地 dsh 发起 ws 升级 → 双向 `DATA`（WS 二进制帧原样）→ 任一端断 → `CLOSE`。

**多路复用**：streamId 为 hub 侧原子递增 uint32；gateway 原样回显。同一隧道并发多个流（多客户端同时访问同一 host）。

**错误映射**：隧道不存在 → hub 直接回 `{error:{code:"HOST_OFFLINE"}}`（503）；gateway 侧 dsh 不可达 → gateway 发 `ERROR` → hub 回 502。

### 5.2 hub 架构（packages/hub）

```
src/
  config.ts      hub.json（~/.rdsh/hub.json）：host/port/tls{cert,key}/dbPath
  db.ts          node:sqlite（内置）：users/hosts/pending/refresh_tokens
  jwt.ts         手写 JWT（HMAC-SHA256，base64url 三段式，node:crypto 零依赖）
  auth.ts        login/refresh/logout/password + 限流（复用 M2 模式）+ 用户 ver 版本化
  api.ts         层 1 REST 端点（契约冻结）
  events.ts      WSS /api/events（host 在线/离线推送，登录态订阅）
  tunnel.ts      隧道注册表（hostId → WSS）+ 帧处理（hub 侧）
  relay.ts       数据面：/h/<hostId>/* HTTP 透传 + WS upgrade 透传
  portal.ts      静态服务 portal dist（Vite 构建产物）
  server.ts      node:https 组装（复用 gateway loadTls 思路：PEM 或报错）
  serve.ts       rdsh hub serve 编排（config/DB/监听/信号）
```

**DB schema（node:sqlite，`~/.rdsh/hub.db`）**：

```sql
CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL, ver INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
CREATE TABLE hosts (id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE pending (id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL,
  expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE refresh_tokens (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT UNIQUE NOT NULL, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
```

**JWT（手写 HMAC-SHA256，偏离 proposal 的 jose —— 理由：依赖最小化，单进程自托管够用；格式为标准三段式 JWT，未来 Go 标准库可解析）**：

- access token（1h）：payload `{sub: userId, name, ver, exp}`；签名密钥 `~/.rdsh/hub-jwt.key`（0600，自动生成）
- **改密/吊销 → `users.ver + 1`** → 中间件查 DB 对比 ver → 不匹配 401（即时失效，同 M2 版本化会话思路）
- refresh token：随机不透明串（32B），DB 存 SHA-256 摘要，7d，轮换（旧 refresh 标记 revoked）
- host token：随机不透明串（32B），DB 存 SHA-256 摘要，长期；吊销 = 删 hosts 行 → 隧道断开 + 重连 401

**绑定流程（R4）**：

```
gateway: rdsh join https://hub        hub:
  1. POST /api/hosts/pending  ──────► 生成 {pendingId, code(6位数字,唯一), 10min}
  2. 打印 "pair code: 123456" ◄───────
  3. 轮询 GET /api/hosts/pending/:id ─► （未绑定则 pending）
浏览器: 登录 → 输码 → POST /api/hosts/bind {code}
  4. ────────────────────────────────► 匹配 pending → 创建 host(owner=当前用户)
                                        → 生成 hostToken → 存 hash → 标记 used
  5. ◄──────────────────────────────── 轮询返回 {hostId, hostToken}
  6. 用 hostToken 建立 WSS 隧道 ?token=…
```

- 配对码 6 位数字，DB UNIQUE（冲突重新生成）；10 分钟过期；输码后 5s 轮询拿 token（10 分钟超时退出）
- `--token <hostToken>` 直填：跳过 1–5，直接建隧道（token 由 hub `host ls` 或重新绑定获取）

### 5.3 gateway join（packages/gateway/src/join.ts）

- `rdsh join <hub-url>`：spawn dsh（复用 spawnDsh）→ 绑定流程（配对码轮询 或 --token 直填）→ 建隧道 → 帧循环
- 帧 → 本地请求：OPEN http → `node:http.request(127.0.0.1:dshPort)`（**复用 Host/Origin 重写 helper**）→ 响应 OPEN/DATA/CLOSE 回传
- 帧 → WS：OPEN ws → `ws` 客户端连本地 dsh → 双向 DATA 转发
- 重连：指数退避 1s→60s + 抖动；心跳 30s；SIGTERM 优雅关闭（复用 serve 模式）

### 5.4 portal（packages/portal）

- 部署在 **`/portal` 前缀**（根路径归 host 转发的 DSH）；路由：`/portal/login` `/portal/hosts` `/portal/settings/password`
- **进入 host = 整页跳转** `location.href = "/h/<hostId>/"`（hub 302 + Set-Cookie `rdsh_host` → 根路径；**2026-08-23 修订**：替代 iframe —— DSH 是 Cordis 插件化动态加载，前缀内容改写不可控，根路径方案 DSH 零改动）
- 单 host 限制：同一浏览器一次一个 host 上下文（cookie 单值），串行使用正常
- API client：`fetch /api/*` + `credentials: "include"`；**httpOnly Cookie 会话**（登录 Set-Cookie `rdsh_session`，同源自动带）；原生壳用 `Authorization: Bearer`
- 绑定弹窗：输 6 位码 → `/api/hosts/bind`
- host 行操作：改名（PATCH /api/hosts/:id）、吊销（DELETE /api/hosts/:id → 立即离线）
- 事件流：`/api/events`（WSS，cookie 认证）→ 在线状态实时更新
- 进入 host：`<iframe src="/h/<hostId>/">`（dsh 无 frame 头限制，已验证）；外层顶条"← 返回列表"

### 5.5 CLI（packages/cli/src/bin.ts 扩展）

```
rdsh join <hub-url> [--token <t>] [--dsh <path>]
rdsh hub serve [--config <path>] [--port <n>] [--host <ip>]
rdsh hub user add <name> [--no-password]   # 交互设初始密码（M2 promptPassword 复用）
rdsh hub user passwd <name>                # admin 重置
rdsh hub user rm|ls
rdsh hub host ls|revoke <hostId>
rdsh hub service install|status|uninstall
```

### 5.6 依赖

- 新增 npm 依赖：**无**（JWT 手写 HMAC-SHA256；sqlite 用 `node:sqlite`；帧编解码纯 Buffer；ws 已在 gateway 依赖中，hub 复用同一依赖）
- portal 维持 Vite + React（已存在）

### 5.7 测试

| 文件 | 覆盖 |
|---|---|
| `packages/tunnel/test/frame.test.ts` | 帧编解码/类型/streamId/边界（超大 payload 分片）/E2E 位忽略透传 |
| `packages/hub/test/*.test.ts` | JWT 签发/校验/ver 失效/refresh 轮换/改密失效/绑定流程/隔离 403/限流/吊销 |
| `packages/gateway/test/join.test.ts` | 帧→HTTP 转发（Host/Origin 重写）/WS 流/重连退避 |
| `spike/e2e-m3.sh` | 本机双进程模拟公网：hub + 2×join → 登录 → 绑定 → 进入 → WS → 改密 → 吊销 → 断线重连 |
| 回归 | M1 e2e 14/14 + M2 e2e 43/43 不受影响 |

## 6. Tasks（文件变更清单，细节见 plan.md）

| # | 文件 | 内容 |
|---|---|---|
| T1 | `packages/tunnel/PROTOCOL.md` | 草案 → **冻结**（payload 编码定稿，见 §5.1） |
| T2 | `packages/tunnel/src/frame.ts` | 帧编解码（encode/decode、流解析器、E2E 位透传） |
| T3 | `packages/tunnel/test/frame.test.ts` | 协议一致性测试 |
| T4 | `packages/hub/src/config.ts` + `db.ts` | hub.json + sqlite schema/查询 |
| T5 | `packages/hub/src/jwt.ts` + `auth.ts` | JWT 签发/校验 + login/refresh/logout/password + 限流 + ver 版本化 |
| T6 | `packages/hub/src/api.ts` | 层 1 REST：login/refresh/logout/password/hosts(pending,bind,list,patch,delete)/events 升级点 |
| T7 | `packages/hub/src/tunnel.ts` + `relay.ts` + `events.ts` | 隧道注册表 + 帧处理 + /h/ 透传（HTTP+WS）+ 在线推送 |
| T8 | `packages/hub/src/server.ts` + `serve.ts` + `portal.ts` | https 组装 + 编排 + portal 静态 |
| T9 | `packages/hub/src/index.ts` | 导出 |
| T10 | `packages/gateway/src/proxy.ts` | 提取 Host/Origin 重写 helper（行为不变） |
| T11 | `packages/gateway/src/join.ts` | 绑定 + 隧道客户端 + 本地转发 + 重连 |
| T12 | `packages/cli/src/bin.ts` | `join` / `hub` 子命令 |
| T13 | `packages/portal/src/*` | React 四页面 + api client + 路由 |
| T14 | hub/gateway 单测 + `spike/e2e-m3.sh` | 验收 |
| T15 | 文档：usage.md M3 节 + roadmap 状态 + verification.md | 收尾 |

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| hub 单点故障 | 单进程 + SQLite 控制面、内存数据面（重启隧道重连即恢复）；自托管用户自担（M6 评估多副本） |
| 隧道带宽（300 MB 上限） | 流式分片 + 背压（复用 M1 pipe 经验）；hub 不落盘业务流量 |
| JWT 手写 vs jose | 标准三段式格式（header.payload.signature + HMAC-SHA256），未来 Go/第三方可解析；需要 RS256/多算法时再上 jose |
| 配对码碰撞（6 位数字） | DB UNIQUE，冲突重新生成 |
| portal iframe 兼容 | dsh 无 frame 头（已验证）；备选：hub HTML 注入返回条（复用 M1 htmlInject 机制） |
| `node:sqlite` 实验性 | Node ≥22.5 内置（22.23.2 已实测可用）；失败路径报错清晰 |

*关联文档：req.md | discussion.md | 下一步：plan.md（待 solution 批准后）*
