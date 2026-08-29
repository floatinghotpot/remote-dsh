# remote-dsh 架构文档

> **日期**: 2026-08-29
> **状态**: v2（M1–M5 + E2EE 已定稿并真实环境验证；SaaS 商业化推进中）
> **性质**: 跨里程碑的稳定架构参考。产品决策与需求管线见 `proposal.md`；功能清单与里程碑进度见 `features.md` / `roadmap.md`。

---

## 1. 系统组件

![remote-dsh 架构图](../../media/rdsh-arch.jpg)

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

### 直连模式（LAN / Cloud）（M1，已实现 —— 无 hub）

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

> 同一 gateway 进程、两种模式：**直连模式（LAN / Cloud）**直接对客户端提供认证与转发（LAN 配对码 / Cloud 密码认证）；公网模式经 hub 出站隧道（gateway 角色变为隧道端点，认证职责移交 hub）。转发内核（Host/Origin 改写、全双工透传）两者共用。

| 组件 | 职责 | 里程碑 |
|---|---|---|
| rdsh-gateway | 开发机侧：LAN 认证网关 / 公网出站隧道端点；spawn `dsh web`；E2EE Noise 响应方 | M1（LAN）/ M3（隧道）/ 09（E2EE） |
| rdsh-hub | 服务器：控制面（认证、host 注册、路由）+ 数据面（隧道汇聚转发）+ E2EE shim 注入 | M3（原型 TS）/ M7（Go 单二进制，触发式延后） |
| rdsh-tunnel | 层 2 线协议库（帧复用、心跳、背压、raw stream） | M1 定稿协议 / M3 实现 / 09（raw） |
| rdsh-portal | 门户前端（登录 + host 列表 + 计费，Vite + React 18） | M3 / 08-saas |
| rdsh-app | Flutter App（WebView 壳 + 原生登录态） | M8（品牌/营销渠道，后置） |
| rdsh-weapp | 微信小程序（轻量界面） | M9（品牌/营销渠道，后置） |

### 部署场景（gateway 跑在哪里）

| 场景 | 部署位置 | 特点 | 模式与要点 |
|---|---|---|---|
| **开发机**（M1 主场景） | 开发者工作站 | 有人值守、有显示器 | `mode: "lan"`：终端显示配对码 |
| **云服务器（阿里云等租用实例）** | VPS / ECS | **headless**、有公网 IP | `mode: "cloud"`：HTTPS + 密码认证（M2）；或 `rdsh host join <hub>`（join 模式，经 hub 汇聚，推荐） |
| **团队 / 企业（自托管 hub）** | 自有机器 / 云主机 | 多用户、需统一账号与审计 | `rdsh hub serve` 自建 hub（内置 TLS 或反代）；成员经 DSH 插件 / `rdsh host join` 接入 |

**云服务器（headless）的认证策略**（无人看终端）：

1. **密码认证（推荐）**：`rdsh host setup cloud --tls-cert <p> --tls-key <p>` + `rdsh host user add <name>` —— headless HTTPS 主认证（M2；部署见 `usage.md` §7）；
2. **预置配对码**：`rdsh host setup lan --pair-code <code>`（LAN/可信网络，提前通过安全通道下发）；
3. **免认证**：`auth.mode: "none"`（仅完全可信网络，启动警告）。

**云服务器公网直连的安全要求**（cloud 模式监听 `0.0.0.0` 时公网可达）：

- 公网直连 = **必须 HTTPS + 密码认证**：内置 TLS（`tls.cert/key`）或 `behindProxy: true` 挂反代终止 TLS —— 明文 http 禁止；
- 或经 hub 汇聚（join 模式，推荐）：gateway 只出站连 hub，不暴露任何入站端口；hub 侧 https + 隧道；
- 多台云服务器经 hub 时统一由 hub 汇聚（gateway 只出站，无入站端口）。

## 2. 协议分层（核心架构资产）

### 层 1：hub 对外 API —— 客户端实现的唯一契约

- 范围：所有客户端 ↔ hub（浏览器 portal、App 原生壳、weapp、未来第三方）
- 协议：`JSON over HTTPS`（REST）+ `WSS` 事件流
- 端点：`/api/auth/login`、`/api/auth/refresh`、`/api/hosts`、`WSS /api/events`、`/h/<hostId>/...` 进入 host（Set-Cookie 选 host，DSH 零改动）；SaaS 增补 `billing`（套餐 / 订阅 / 支付下单 / 回调）与 `wechat/oauth/*`（JSAPI openid）
- 统一约定：路径 `/api/*`；错误 `{ error: { code, message } }`；时间 ISO 8601；认证 `Authorization: Bearer <JWT>`（原生壳）/ Cookie（WebView 内页面）
- **契约纪律**：文档先行（M3 前冻结），变更走协议变更流程

### 层 2：rdsh-tunnel —— hub ↔ gateway 内部协议

- 范围：hub ↔ gateway（App 不实现）
- 载体：WSS（TLS 1.3），gateway **出站**连接（免公网 IP / 免端口映射）
- 帧格式（`packages/tunnel/PROTOCOL.md`）：magic "RDSH"(4B) | version(1B) | flags(1B) | type(1B) | streamId(4B BE) | length(4B BE) | payload
- **OPEN kind 三态**：`http` / `ws` / `raw`；`flags` bit0（`FLAG_E2E` = 0x01）= E2E 帧标记
- **raw stream（09 已实现）**：OPEN `{ kind:"raw" }` 后，该 streamId 的 DATA 帧双向承载**原始字节**（内层 Noise NK 握手消息 + AES-256-GCM 密文）；hub 只做纯字节双向转发、不解析内容；老 gateway/hub 无 raw 分支、bit=0 走 http/ws 转发，向后兼容
- 多路复用：单隧道按 streamId 分帧，支持并发 HTTP/WS upgrade
- **契约纪律**：跨语言契约（TS ↔ Go），文档先行 + conformance 测试（`e2e/`；Go conformance 随 M7 里程碑）

### 层 2.5（逻辑）：内层 E2EE 通道（浏览器 ↔ host）

- 载体：hub 的 `/e2e` WS 路由（浏览器 shim 建立）→ 隧道 raw stream（hub → gateway）
- 握手：**Noise NK**（X25519 + HKDF-SHA256 + AES-256-GCM）；host 静态密钥对（持久化 `~/.rdsh/e2ee-key.json`，join 时公钥指纹上送）；浏览器临时密钥；会话密钥每连接轮换（前向保密）
- 认证：浏览器靠 **pin**（首次信任 TOFU，localStorage，绝不上 hub）认证 host；指纹变更 → 告警 + 手动重信任
- 内层复用：复用 tunnel 帧语义（OPEN http/ws + DATA + CLOSE），跑在密文内
- 数据面边界：**HTML/JS 壳明文**（hub 注入 shim 脚本），API(fetch) + WS 密文

## 3. 数据路径

### 直连模式（LAN / Cloud）（M1 MVP，无 hub）

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

### 公网模式明文路径（M3+；老 host / optional 未信任时）

```
        浏览器
          │  https（层1：登录 + 进入 host → Set-Cookie 选 host）
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
- 该路径下 hub 可见明文（老 host / 未信任 pin 的降级路径）

### E2EE 数据路径（09；新 host + 已 pin）

```
        浏览器（hub 页面，host 上下文）
              │  ① 导航加载 HTML 壳（hub 明文 relay，注入 shim + 返回条）
              ▼
       rdsh-hub（明文转发 HTML 壳）
              │  ② 后续 API(fetch) / WS 被 shim 包装
              ▼
       shim → WSS /e2e（Noise 发起方握手 + 密文帧）
              │  ③ hub 按 raw stream 纯字节转发（FLAG_E2E）
              ▼
      rdsh-gateway（Noise 响应方，解密内层帧）
              │  ④ 内层 http / ws 请求
              ▼
       dsh web (127.0.0.1:<port>)
```

- ① HTML/JS 壳明文（hub 可注入返回条 + shim）；② 起 API/WS 全走 `/e2e` 密文通道
- hub 全程只见密文（除明文壳），**读不到业务报文内容**（prompt / 代码 / 文件 / API key）
- 未 pin / 老 host：shim 早退 → 明文路径（`e2ee.mode: optional` 语义）

## 4. 安全模型

### 信任边界

```
客户端 ◄─TLS─► hub ◄─TLS(层2)─► gateway ◄─loopback─► dsh web
        └──── 数据面 E2EE（09）：API/WS 密文，hub 读不到内容；HTML 壳明文 ────┘
```

- **数据面 E2EE（已实现）**：浏览器 ↔ host 端到端加密（API(fetch) + WS）；hub 只中继密文
- **威胁边界**：web E2EE 防「被动/好奇」hub（读不到中转内容），**不防主动恶意 hub**（hub 即发 portal JS 者，可改 shim 偷内容）—— 所有 web E2EE 的固有边界，承诺止于「hub 读不到中转内容」
- **TOFU pin**：浏览器首次信任 host 指纹（localStorage），指纹变更 → 告警 + 手动重信任；pin 绝不上 hub

### 分层防护

| 层 | 机制 |
|---|---|
| 传输 | TLS 1.3（公网）；LAN http + SameSite + Origin 校验兜底（威胁模型低） |
| 认证 | 配对码（物理锚点，LAN）/ 密码认证（cloud，改密失效会话）/ 账号 JWT + 2FA + 邮箱验证（hub，M5）/ host token 可吊销 |
| 授权 | 用户↔host 多对多；owner/member 共享（M5）；整实例授权（Q4 决策） |
| 数据面 | **E2EE（09）**：raw stream + 内层 Noise NK + TOFU pin；hub `e2ee.mode: off\|optional\|required`（默认 optional，老 host 明文降级） |
| 边界 | DSH Host 围栏由网关/隧道**配合**：转发统一 Host 重写为 loopback（否则 `/api` 403） |
| 数据 | 密钥文件 0600；令牌只存哈希；日志脱敏 |
| 加固 | 恒定时间比较、IP 限流、账户锁定、审计（M5） |

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
| 语言双栈 | 原型 TS（gateway/hub）→ 生产 hub 用 Go 重写（go:embed portal，单二进制；触发式，见 roadmap M7） |

## 6. 相关文档

- 产品提案：`proposal.md`
- 功能清单 / 路线图：`features.md`（+ `features.zh.md`）/ `roadmap.md`
- 特性管线：`doc/feature/01-remote-access/`、`doc/feature/09-e2e-encryption/`（discussion / req / solution / plan / verification / summary / TODO）
- 层 2 协议：`packages/tunnel/PROTOCOL.md`
- 变更流程：本文件随里程碑评审更新（M1–M5 / 09 E2EE 已定稿；M6 SaaS / M8 App / M9 小程序 / M7 Go 触发式）
