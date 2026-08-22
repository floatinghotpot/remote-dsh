# remote-dsh 架构文档

> **日期**: 2026-08-22
> **状态**: v1（随 M1 MVP 定稿；后续里程碑按变更流程更新）
> **性质**: 跨里程碑的稳定架构参考。产品决策与需求管线见 `proposal.md` 与 `doc/feature/01-remote-access/`。

---

## 1. 系统组件

### 公网模式（M3+，全链路）

```
┌───────────────────────────┐
│          客户端             │
│    浏览器 / App / 小程序     │
└─────────────┬─────────────┘
              │  HTTPS / WSS
              │  层1：hub 对外 API（JSON + 事件流）
              ▼
┌───────────────────────────┐
│        rdsh-hub           │
│   认证 · 授权 · 路由 · 转发  │
│      (用户/host 注册表)     │
└─────────────┬─────────────┘
              │  WSS 隧道（出站长连接）
              │  层2：rdsh-tunnel（帧复用）
              ▼
┌───────────────────────────┐
│    rdsh-gateway（开发机）    │
│     认证网关 + 隧道端点      │
└─────────────┬─────────────┘
              │  127.0.0.1:<port>
              ▼
┌───────────────────────────┐
│   dsh web（spawn 子进程）    │
└───────────────────────────┘
```

### LAN 模式（M1，当前已实现 —— 无 hub）

```
┌───────────────────────────┐
│      客户端（浏览器）        │
│   笔记本 / 手机（同局域网）   │
└─────────────┬─────────────┘
              │  http://<开发机IP>:<port>
              ▼
┌───────────────────────────┐
│    rdsh-gateway（开发机）    │
│ 认证网关：配对码 → 会话 Cookie │
│   （此模式下即"代理"角色）    │
└─────────────┬─────────────┘
              │  127.0.0.1:<port>（Host/Origin 改写）
              ▼
┌───────────────────────────┐
│   dsh web（spawn 子进程）    │
└───────────────────────────┘
```

> 同一 gateway 进程、两种模式：LAN 模式直接对客户端提供认证与转发；公网模式经 hub 出站隧道（gateway 角色变为隧道端点，认证职责移交 hub）。转发内核（Host/Origin 改写、全双工透传）两者共用。

| 组件 | 职责 | 里程碑 |
|---|---|---|
| rdsh-gateway | 开发机侧：LAN 认证网关 / 公网出站隧道端点；spawn `dsh web` | M1（LAN）/ M3（隧道） |
| rdsh-hub | 服务器：控制面（认证、host 注册、路由）+ 数据面（隧道汇聚转发） | M3（原型 TS）/ M7（Go 单二进制） |
| rdsh-tunnel | 层 2 线协议库（帧复用、心跳、背压） | M1 定稿协议 / M3 实现 |
| rdsh-portal | 门户前端（登录 + host 列表，Vite + React 18） | M3 |
| rdsh-app | Flutter App（WebView 壳 + 原生登录态） | M5 |
| rdsh-weapp | 微信小程序（轻量界面） | M8（2026-08-23 从 M5 拆分） |

### 部署场景（gateway 跑在哪里）

| 场景 | 部署位置 | 特点 | 模式与要点 |
|---|---|---|---|
| **开发机**（M1 主场景） | 开发者工作站 | 有人值守、有显示器 | LAN 模式：终端显示配对码 |
| **云服务器（阿里云等租用实例）** | VPS / ECS | **headless**、有公网 IP | 可公网直连（见安全升级）或经 hub 汇聚多机（M3，推荐） |

**云服务器（headless）的配对码策略**（无人看终端）：

1. **ssh 登录查看**：`ssh <host> 'rdsh serve'` 后从远程终端读配对码（最简单）；
2. **预置配对码**：`rdsh serve --pair-code <code>`（提前通过安全通道下发）；
3. **完全可信网络**：`--no-code`（启动警告）。

**云服务器公网直连的安全升级**（LAN 模式监听 `0.0.0.0` 时公网可达）：

- 当前 M1 为明文 http + 配对码认证 —— **仅适合可信网络**；
- 云服务器公网直连建议：① 反向代理终止 TLS（网关后可接 Caddy/nginx 加证书）；② 或等待 M3 经 hub（hub 侧 https + 隧道，gateway 不出站暴露）—— **推荐**，与"出站隧道免暴露"架构一致；
- 多台云服务器经 hub 时统一由 hub 汇聚（gateway 只出站，无入站端口）。

## 2. 协议分层（核心架构资产）

### 层 1：hub 对外 API —— 客户端实现的唯一契约

- 范围：所有客户端 ↔ hub（浏览器 portal、App 原生壳、weapp、未来第三方）
- 协议：`JSON over HTTPS`（REST）+ `WSS` 事件流
- 端点雏形：`/api/auth/login`、`/api/auth/refresh`、`/api/hosts`、`WSS /api/events`、`/h/<hostId>/...` 透传
- 统一约定：路径 `/api/*`；错误 `{ error: { code, message } }`；时间 ISO 8601；认证 `Authorization: Bearer <JWT>`（原生壳）/ Cookie（WebView 内页面）
- **契约纪律**：文档先行（M3 前冻结），变更走协议变更流程

### 层 2：rdsh-tunnel —— hub ↔ gateway 内部协议

- 范围：hub ↔ gateway（App 不实现）
- 载体：WSS（TLS 1.3），gateway **出站**连接（免公网 IP / 免端口映射）
- 帧格式草案：`packages/tunnel/PROTOCOL.md`（magic/version/flags/type/streamId/length/payload）
- **E2E 预留**：flags bit0 为加密帧标记（公共 SaaS 化时实现端到端加密）；当前实现必须忽略未知 flag 位原样透传
- 多路复用：单隧道按 streamId 分帧，支持并发 HTTP/SSE/WS upgrade
- **契约纪律**：跨语言契约（TS ↔ Go），文档先行 + conformance 测试（`e2e/`）

## 3. 数据路径

### LAN 模式（M1 MVP，无 hub）

```
        浏览器（另一台笔记本）
              │  http://<IP>:8443
              ▼
    rdsh-gateway (0.0.0.0:8443)
              │  认证中间件：无会话 → 配对页 / 有会话 → 转发
              ▼
     转发（Host 重写为 127.0.0.1:<dshPort>）
              │
              ▼
      dsh web (127.0.0.1:<dshPort>)
```

- 认证：配对码（终端显示，物理信任锚点）+ 签名会话 Cookie（HttpOnly/SameSite=Lax，HMAC-SHA256）
- 未认证 → 配对页；已认证 → 全双工透传（HTTP/SSE/WS upgrade）

### 公网模式（M3+，经 hub）

```
        浏览器
          │  https（层1：登录 + 访问）
          ▼
   rdsh-hub（认证 + 按 hostId 路由）
          │  wss 隧道（层2：rdsh-tunnel）
          ▼
      rdsh-gateway
          │  http（Host 重写）
          ▼
   dsh web (127.0.0.1:<port>)
```

- hub 按 `hostId` 路由到对应 gateway 隧道；鉴权后**不改写业务报文**（纯透传，dsh 版本兼容）

## 4. 安全模型

### 信任边界

```
客户端 ◄─TLS─► hub ◄─TLS(层2)─► gateway ◄─loopback─► dsh web
        └────── hub 可见明文（E2E 预留：SaaS 化时升级为不可见）──────┘
```

- **信任假设（MVP）**：信任自托管 hub；hub 内存转发不落盘业务流量
- **E2E 演进**：公共 SaaS 化时实现层 2 加密位（客户端原生化后 E2E 才真正成立——Web 端有"改页面 JS"局限）

### 分层防护

| 层 | 机制 |
|---|---|
| 传输 | TLS 1.3（公网）；LAN http + SameSite + Origin 校验兜底（威胁模型低） |
| 认证 | 配对码（物理锚点）/ 账号 JWT（M4）；令牌可吊销、refresh 轮换 |
| 授权 | 用户↔host 多对多（M4）；整实例授权（Q4 决策） |
| 边界 | DSH Host 围栏由网关/隧道**配合**：转发统一 Host 重写为 loopback（否则 `/api` 403） |
| 数据 | 密钥文件 0600；令牌只存哈希；日志脱敏 |
| 加固 | 恒定时间比较、IP 限流、审计（M4） |

### 关键事实（DSH 侧，查档）

- DSH 无 HTTP 认证层；安全靠 Host 围栏（"this fence is not an auth layer"）
- `/api/*` 全部 RPC + `/api/events.mux`、`/api/events.host` 两条 WS —— 转发必须全双工
- 请求体上限 300 MB —— 转发必须流式零缓冲

## 5. 演进约束（架构层面）

| 约束 | 说明 |
|---|---|
| 协议先行 | 层 1 / 层 2 变更必须先文档后实现（CLAUDE.md §5） |
| gateway 不动原则 | 层 2 契约稳定 → Go 重写 hub 时 gateway/客户端零改动 |
| 前端复用 | 所有界面复用 `@deepseek-ai/dsh-web-frontend`，零重写 |
| 依赖最小化 | Node 内置优先；唯一新增依赖 `ws`（DSH 同款） |
| 语言双栈 | 原型 TS（gateway/hub）→ 生产 hub 用 Go 重写（go:embed portal，单二进制） |

## 6. 相关文档

- 产品提案：`proposal.md`
- 特性管线：`doc/feature/01-remote-access/`（discussion / req / solution / plan / verification）
- 层 2 协议：`packages/tunnel/PROTOCOL.md`
- 变更流程：本文件随里程碑评审更新（M3 hub / M7 Go / M5 移动端 / M8 小程序）
