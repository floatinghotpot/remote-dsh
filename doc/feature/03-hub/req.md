# 03-hub — 需求（req.md）

> **日期**: 2026-08-23
> **状态**: 草稿，**待用户批准**
> **范围**: M3 —— 公网 hub（控制面 + 数据面 + `rdsh join` 出站隧道 + rdsh-portal 门户）
> **来源**: [discussion.md](discussion.md)（D1–D9 定案）, `doc/overview/roadmap.md`（M3）, `doc/overview/proposal.md` §4.5/§5.2

---

## 1. 目标

开发机（**无公网 IP / 无端口映射**）上的 DSH 智能体，被**异地浏览器**经一个公网 hub 域名访问：

```
浏览器 ──https/hub.example.com──► rdsh-hub ──wss 隧道（层2）──► rdsh-gateway ──http──► dsh web
                                     │ 认证+路由                │ 出站连接，只出不进
```

- gateway **只出站**建隧道（免 NAT 穿透/端口映射）；客户端永远只连 hub 一个域名
- 浏览器流程：登录 hub → host 列表 → 选一台 → 完整操作 DSH

## 2. 范围

### 2.1 包含（In Scope）

| 编号 | 需求 | 验收标准 |
|---|---|---|
| R1 | **hub 服务**：`rdsh hub serve`（TS 原型，随 rdsh 包分发）；https（复用 loadTls：Let's Encrypt/自备证书）+ 可选服务化 | `rdsh hub serve --port 8443` 启动；https 访问；systemd/launchd 可托管 |
| R2 | **层 2 协议定稿**：PROTOCOL.md 从 DRAFT → 冻结（帧头 + payload 格式 + open/data/close/ping/pong/error 语义 + WS upgrade 帧）；**E2E 预留 bit0 忽略透传** | 文档先行；TS 双端（hub↔gateway）按同一协议实现并通过协议一致性测试 |
| R3 | **`rdsh join <hub>`**：gateway 出站 WSS 隧道；单 host 一条长连接；断线自动重连（指数退避+抖动）；应用层心跳 | join 后 hub 侧 host 显示在线；kill 隧道 → 自动重连恢复；心跳超时判定离线 |
| R4 | **host 绑定**：`rdsh join` 打印一次性配对码（10 分钟有效）→ 用户登录 hub 网页输码绑定 → 生成长期 **host token**（仅 gateway 持有）；另支持 `rdsh join --token <hostToken>` 直填（脚本化部署） | 输码绑定成功；过期码拒绝；--token 直填可跳过网页；host token 吊销后隧道立即断开且无法重连 |
| R5 | **层 1 API**（冻结契约，文档先行）：`POST /api/auth/login`（返回 access+refresh JWT）、`POST /api/auth/refresh`、`POST /api/auth/logout`、`POST /api/auth/password`（自助改密：当前密码 + 新密码，成功后该用户全部会话失效需重登）、`GET /api/hosts`（我的机器：在线/离线、名称、hostId）、`WSS /api/events`（host 在线/离线推送）、`/h/<hostId>/...` 透传；**无开放注册端点**（账号由管理员 `rdsh hub user add` 创建，防 bot/垃圾注入） | 全套端点按契约文档实现；错误统一 `{error:{code,message}}`；时间 ISO 8601；`POST /api/auth/register` 不存在（404）；改密后旧 refresh/access 立即失效 |
| R6 | **portal（React）**：登录页 + host 列表（在线状态/名称/延迟）+ 进入 host（透传 DSH UI 原样显示）+ **host 改名 / 吊销 host token 入口** + **修改密码入口**（自助改密，验证当前密码） | 浏览器全流程走通：登录 → 绑定 host → 进入 DSH 完整操作；改名/吊销即时生效；改密后需重新登录 |
| R7 | **令牌与安全**：用户 access（1h）+ refresh（7d 轮换、可吊销、登出即吊销）；host token 服务端只存 **SHA-256 摘要**；登录失败限流（复用 M2 限流模式） | 代码审查 + 测试：refresh 轮换后旧 refresh 失效；吊销 refresh → 立即失效；DB 无明文 token |
| R8 | **数据面路由**：隧道注册表 `hostId → 活跃隧道`（断开自动摘除/重连自动恢复）；客户端 `/h/<hostId>/...` 剥前缀 → 经对应隧道转 gateway → 还原 `127.0.0.1:<port>` 本地请求；**纯透传不改写业务报文**；同一隧道多并发流（streamId 复用） | 两客户端同时访问同一 host 各自独立工作；SSE 流式 + WS upgrade 经隧道全通；hub 不解析业务报文（代码审查） |
| R9 | **多用户 + host 归属**（D1 定案）：hub 多账号，host 归注册者所有，仅 owner 可见可管；共享授权/邮箱验证/2FA 留 M4 | 用户 A 看不到用户 B 的 host；A 不能访问 B 的 host（403） |
| R10 | **安全基线**：DB（`node:sqlite`）只存哈希（用户密码 scrypt、host token SHA-256）；日志脱敏（不记密码/token）；hub 侧 CORS 只允许门户同源；配对码短时效；`/api/events` 需认证 | 代码审查 + 测试；密码/令牌无明文落盘；日志无敏感信息 |
| R11 | **协议一致性测试**：TS 双端（hub↔gateway）按冻结 PROTOCOL.md 跑 conformance（帧编码/解帧/复用/心跳/E2E 位忽略） | `node --test` 全绿；e2e/ 目录记录 TS↔Go 计划（M7） |
| R12 | **CLI**：`rdsh join <hub-url>`（默认路径；--token 直填）；`rdsh hub serve` / `rdsh hub user add <name> [--no-password]`（交互设初始密码，admin 安全信道告知；--no-password 用户首次登录自设）/ `rdsh hub user passwd <name>`（admin 重置）/ `rdsh hub user rm|ls` / `rdsh hub host ls|revoke <hostId>` / `rdsh hub service install|status|uninstall` | 各子命令可执行；`rdsh --help` 输出完整 |

### 2.2 portal 界面流程（文档草图，2026-08-23 定案：不写 text demo，React 直接实现）

**页面 1 — 登录**（未认证访问任意页 → 重定向至此；**无注册入口** —— 账号由管理员 `rdsh hub user add` 创建）：

```
┌──────────────────────────────────────────────┐
│              rdsh · 你的机器，随处可达        │
│                                              │
│    用户名  [______________]                  │
│    密码    [______________]                  │
│           [ 登 录 ]                          │
│    错误提示：用户名或密码错误（限流时：尝试过多，稍后再试）│
└──────────────────────────────────────────────┘
```

交互：管理员在 hub 服务器 `rdsh hub user add alice` 建号 → 用户登录 → 跳转 host 列表。登录失败限流（5 次/10 分钟）。

**页面 2 — host 列表**（`GET /api/hosts`）：

```
┌──────────────────────────────────────────────┐
│  rdsh         你好，alice      [退出登录]     │
│  ──────────────────────────────────────────── │
│  ● dev-ubuntu   在线 · 12ms    [进入] [⋯]     │
│  ○ old-mac      离线           [进入] [⋯]     │
│                                                │
│  提示：在机器上运行 `rdsh join https://hub…`  │
│  显示配对码后，到这里 [绑定新机器]             │
└──────────────────────────────────────────────┘
```

- 每行：在线状态（`/api/events` 实时推送）、名称、延迟（ping 往返估算）
- `[⋯]` 菜单：改名、吊销 host token（吊销后该 host 立即离线、需重新绑定）
- `[绑定新机器]`：输入配对码 → 绑定 → 列表出现新 host

**页面 3 — 进入 host（DSH 界面透传）**：

```
┌──────────────────────────────────────────────┐
│  ← 返回列表     dev-ubuntu                    │
│  ──────────────────────────────────────────── │
│  （DSH 完整界面原样透传：对话/工具/文件/实时流 │
│    —— 走 /h/<hostId>/... 反向代理 + 隧道）    │
└──────────────────────────────────────────────┘
```

- 进入后浏览器地址为 `https://hub.example.com/h/<hostId>/`，DSH 前端与 API 全部经 hub 透传到该 host 的 gateway → 本地 dsh web
- `window.__DSH_BOOT__` 引导机制不变；WebSocket（events.mux/events.host）同样透传
- 顶部细条保留"返回列表"（portal 注入的最小壳，不侵入 DSH 界面）

**页面 4 — 修改密码**（用户菜单 → 修改密码；自助改密，无需找 admin）：

```
┌──────────────────────────────────────────────┐
│  rdsh         你好，alice      [退出登录] [⋯] │
│  ──────────────────────────────────────────── │
│        修改密码（改后全部设备需重新登录）     │
│    当前密码  [______________]                 │
│    新密码    [______________]                 │
│    确认新密码[______________]                 │
│             [ 保存 ]                          │
│    提示：密码已修改，请重新登录               │
└──────────────────────────────────────────────┘
```

- 验证当前密码 → 更新（scrypt）→ 该用户全部 refresh 吊销 + access 立即失效 → 跳登录页
- 用户遗忘密码 → admin `rdsh hub user passwd <name>` 重置（初始密码由 admin 交还）

**交互步骤**（端到端）：管理员 `rdsh hub user add` 建号（交互设初始密码并告知用户，或 `--no-password`）→ 用户登录 →（开发机 `rdsh join` 打印配对码）→ 绑定 → 列表见 host 在线 → 进入 → 完整操作 DSH → 返回 → 改名/吊销 → 修改密码 → 重新登录 → 退出登录。

### 2.3 不含（Out of Scope）
- ❌ 共享授权/邮箱验证/2FA/审计后台（M4）
- ❌ hub Go 重写 + TS↔Go conformance（M7；e2e/ 只记录计划）
- ❌ 移动端 App / 微信小程序（M5/M8）
- ❌ 端到端加密（E2E 预留位仅忽略透传；公共 SaaS 化时实现）
- ❌ hub 多副本/横向扩展（单进程 + SQLite）

## 3. 端到端验收场景

> **场景**：公网服务器跑 hub（`rdsh hub serve`，https）；两台无公网 IP 的开发机分别 join。

1. **准备**：hub 服务器 `rdsh hub serve` 启动；开发机 A/B 上 `rdsh serve` 已配好本地 dsh。
2. **绑定**：A 机 `rdsh join https://hub.example.com` → 打印配对码 → 浏览器登录 hub（账号由管理员预先 `rdsh hub user add` 创建）→ 输码绑定 → A 机自动建立隧道，hub 显示 A 在线。B 机用 `rdsh join --token <hostToken>` 直填绑定。
3. **访问**：异地浏览器登录 hub → host 列表见 A、B 在线 → 进入 A → 完整操作 DSH（对话/工具/文件/实时流 + WS 事件流）→ 返回 → 进入 B → 同样完整。
4. **隔离**：账号 X 看不到/访问不了账号 Y 的 host（403）。
5. **吊销**：portal 里吊销 A 的 host token → A 隧道立即断开，host 变离线；A 机重连被拒（401）。重新绑定后才恢复。
6. **健壮性**：断网 30s 恢复 → A 机自动重连，hub 恢复在线；`rdsh hub service install` 后重启机器 hub 自启。

## 4. 验收执行方式

- 自动化：`node --test`（协议编解码/复用/心跳/E2E 位；API 层；绑定流程；隔离；吊销；限流）+ 本机双进程 e2e（hub + gateway join 同机模拟公网）
- 回归：M1 e2e（14/14）+ M2 e2e（43/43）不受影响
- 文档：`verification.md` 逐条对照 R1–R12 + RTTM

## 5. 待定项（留给 solution.md，不阻塞 req 批准）

- 层 2 payload 具体编码（JSON 头块 + 二进制体分帧；WS upgrade 帧结构）
- portal 与 DSH 前端的同构细节（Vite 配置、`window.__DSH_BOOT__` 透传验证）
- hub 数据库 schema（users/hosts/tokens/refresh 表）
- JWT 密钥管理与轮换

*关联文档：discussion.md | roadmap.md（M3）| 下一步：solution.md（待 req 批准后）*
