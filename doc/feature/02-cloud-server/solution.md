# 02-cloud-server — 解决方案（solution.md）

> **日期**: 2026-08-23
> **状态**: 草稿，**待用户批准**
> **范围**: M2 —— 云服务器直连（TLS + user/pass + 配置文件 + 服务化）
> **来源**: [req.md](req.md)（R1–R12）, [discussion.md](discussion.md), `doc/overview/roadmap.md`

---

## 1. Goal（目标架构）

```
公网浏览器 ──https──► rdsh-gateway(云服务器, TLS) ──认证(pair|password|none)──► 127.0.0.1:<port> (dsh web)
                          ▲
                    config.json（持久配置唯一来源）
                    systemd/launchd 托管（服务化）
```

`rdsh service install` 后常驻；浏览器经 HTTPS 输 user/pass 登录（或 pair/none），复用 M1 的会话 Cookie 与转发内核。**三种部署用例**（req R1）：① 内置 TLS + 自签；② apache2 反代 + cron acme.sh 自动续期；③ nginx 反代 —— 部署配置见 `doc/overview/usage.md` §7，验收 = [req.md](req.md) §3 端到端场景。

## 2. Facts（现状审计，2026-08-23）

### 2.1 M1 代码接口（0.2.0 已发布）

| 模块 | 现状接口 | M2 复用点 |
|---|---|---|
| `serve.ts` | `serve(ServeOptions)`：host/port/pairCode/sessionTtlSeconds/dshPath/reset/noCode | 保留，扩展从 config 组装 |
| `server.ts` | `startGateway(GatewayOptions)` → `{server, sessions, pair, actualPort}`；node:http server；认证中间件（pair/noCode） | **TLS 改造**（https）、auth mode 路由、allow_from 中间件 |
| `session.ts` | `SessionManager(dir?)`：init/reset/sign/verify/cookieHeader；HMAC 签名 Cookie，密钥 `~/.rdsh/secret.key`（0600） | **改密轮换复用 `reset()`** |
| `pair.ts` | `PairManager(pairCode)`：check/限流（5 次/10 分钟） | pair 模式保留 |
| `pair-page.ts` | 配对页 HTML（内联零依赖） | 新增 login-page.ts（password 模式） |
| `cli/bin.ts` | 手写参数解析：serve 子命令 + flags | **重构为子命令结构**（serve/user/service + --config 全局） |
| 依赖 | 仅 `ws` | 新增依赖：**无**（scrypt/TLS/CIDR 全内置；自签证书用系统 `openssl`） |

### 2.2 环境事实

- Node ≥ 22（`node:crypto.scrypt`、`node:https`、`node:net` 内置）✓
- Linux systemd 用户级 unit：`~/.config/systemd/user/`；macOS launchd：`~/Library/LaunchAgents/`（均无需 sudo）
- 云服务器 headless：无终端交互场景（配对码不可行 → password 模式）

## 3. Gap（差距 = 要解决的问题）

| 需求 | 现状 → 目标 |
|---|---|
| R1/R2 TLS | node:http → **node:https**（`tls.cert/key` 配置；自签自动生成） |
| R3–R5 user/pass | 无 → auth 模块（scrypt 哈希、登录页、改密轮换、限流复用） |
| R6 配置文件 | 无 → config.ts（JSON 加载、--config/RDSH_CONFIG、CLI 优先） |
| R7 用户管理 | 无 → `rdsh user add/passwd/ls/rm` |
| R8 IP 白名单 | 无 → cidr.ts + server 中间件 |
| R9 服务化 | 无 → service.ts（systemd/launchd 模板 + install/uninstall/status） |
| R10 登录页 | 仅配对页 → login-page.ts（password 模式） |
| R11 安全基线 | — → 无 TLS + password 拒绝启动；日志脱敏 |
| R12 兼容 | — → pair 模式行为不变；M1 e2e 回归 |

## 4. Call-site Audit

| 变更函数 | 调用方 | 兼容性 |
|---|---|---|
| `serve(ServeOptions)` 扩展（+`configPath`） | cli/bin.ts（现） | 兼容：新增可选字段 |
| `startGateway(GatewayOptions)` 扩展（+`tls/allowFrom/authMode`） | serve.ts（现）；测试（现） | 兼容：新增可选字段；**http 行为不变**（未配 tls 时走原路径） |
| `SessionManager.reset()`（复用） | 改密流程（新） | 兼容：语义不变（全部会话失效） |
| `bin.ts` 重构（serve/user/service 子命令） | 用户 CLI（对外） | **行为变更**：新增子命令不影响 `rdsh serve` 现有 flags |
| `PairManager` | server.ts（现） | 不变 |

## 5. Tasks（文件变更清单）

> 细节与顺序见 plan.md；此处定文件级职责与关键设计。

### 5.1 gateway 包（`packages/gateway/`）

| 文件 | 职责 | 关键点 |
|---|---|---|
| `src/config.ts`（新） | 配置加载/默认/校验 | 默认 `~/.rdsh/config.json`；`--config <path>`/`$RDSH_CONFIG`；字段：host/port/sessionTtlSeconds/tls{cert,key}/**behindProxy**/allowFrom[]/auth{mode,pairCode,users[{name,passwordHash}]}/dshPath；**优先级 CLI > config > 默认**；非法字段明确报错 |
| `src/auth.ts`（新） | user/pass 认证 | `node:crypto.scrypt`（每用户随机盐，格式 `scrypt:$N$r$p$salt$hash`）；`verify` 恒定时间；`UserManager`（add/passwd/ls/rm）读写 config |
| `src/cidr.ts`（新） | IPv4 CIDR | 解析 `a.b.c.d/n`；`ipInCidr(ip, list)`；非白名单 → 403 |
| `src/tls.ts`（新） | TLS 证书 | **支持任意 PEM**（`tls.cert/key` 路径，兼容 acme.sh/Let's Encrypt/云厂商证书）；无配置则调用系统 `openssl req -x509 -newkey rsa:2048 -nodes -days 365` 生成自签到 `~/.rdsh/` 并提示浏览器信任；返回 `{key, cert}` |
| `src/login-page.ts`（新） | 登录页 HTML | user/pass 表单（内联零依赖，风格同配对页）；错误/限流提示；可选改密入口（M2 预留，页面占位） |
| `src/server.ts`（改） | TLS + auth 路由 + 白名单 + 反代适配 | `node:https` 当 tls 配置（否则 http）；auth mode 路由：pair → 配对页/POST /pair（现状）；password → 登录页/POST /login（成功 Set-Cookie + 307 /，复用 sessionManager）；none → 直通；**allow_from 中间件**：认证前检查 —— `behindProxy` 时取 `X-Forwarded-For`（仅连接来自回环时信任，防伪造），否则 remoteAddress；**无 TLS + password**：`behindProxy: true` 时允许（信任反代 TLS），否则启动拒绝 |
| `src/serve.ts`（改） | 从 config 组装 + 改密轮换接入 | 读 config（CLI 覆盖）→ 组装 startGateway；`rdsh user passwd` 后调 `sessions.reset()` |
| `src/service.ts`（新） | 服务化 | systemd unit（用户级 `~/.config/systemd/user/rdsh.service`：ExecStart=node <cli>/serve --config <path>，Restart=on-failure，WantedBy=default.target）+ `systemctl --user enable --now`；launchd plist（`~/Library/LaunchAgents/com.rdsh.plist`，KeepAlive=true）；`status` 读 systemctl --user is-active / launchctl print |
| `src/index.ts`（改） | 导出新模块 | config/auth/cidr/tls/service 导出 |

### 5.2 cli 包（`packages/cli/`）

| 文件 | 职责 | 关键点 |
|---|---|---|
| `src/bin.ts`（改） | 子命令结构 | `rdsh serve [--config <path>] [--reset]` / `rdsh user add|passwd|ls|rm [--config <path>]` / `rdsh service install|uninstall|status [--config <path>]` / `--version`/`--help`；`--config` 全局（先于子命令解析） |

### 5.3 依赖与构建

- **新增 npm 依赖：无**（scrypt/https/CIDR 内置；自签证书用系统 openssl —— 云服务器必备）
- 构建：`pnpm build`（tsc strict）；测试 `node --test`

### 5.4 测试（`packages/gateway/test/`）

| 文件 | 覆盖 |
|---|---|
| `config.test.ts` | 默认值/--config 覆盖/CLI 优先/非法字段报错 |
| `auth.test.ts` | scrypt 哈希格式/校验/错误密码/用户增删改查 |
| `cidr.test.ts` | CIDR 解析/命中/边界（/0、/32、前缀） |
| `server.test.ts`（扩展） | password 模式登录流程/改密后旧 Cookie 307/allow_from 403/TLS 启动（自签证书 http 客户端忽略校验）/无 TLS+password 拒绝 |
| `service.test.ts` | systemd/launchd 模板生成（内容断言） |

### 5.5 手工验收

[req.md](req.md) §3 端到端场景（本机 https + curl 模拟 + 真实云服务器可选）+ M1 e2e 回归（14/14）。

## 6. 待定项定稿（来自 req.md §5）

| 项 | 定稿 |
|---|---|
| 证书来源 | **两种方式并存**：① 内置 TLS —— 任意 PEM（acme.sh/Let's Encrypt/云厂商）填 `tls.cert/key`；无配置自签提示信任；acme.sh 续期用 renew hook 调 `rdsh service restart`。② **反代 TLS** —— `behindProxy: true`，nginx/apache/certbot 管证书与 HTTPS，rdsh 监听本地 http（WebSocket 需反代 upgrade 头） |
| 无 TLS + password | **拒绝启动**（错误：`auth.mode=password requires TLS configuration`）—— 安全基线硬约束 |
| 登录限流 | 复用 M1 框架（5 次/10 分钟，按 IP） |
| unit 模板 | 用户级（无 sudo）；ExecStart 指向 `rdsh` 可执行文件绝对路径（`process.execPath` + cli dist） |

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| 自签证书浏览器信任门槛 | 日志引导；支持用户证书（Let's Encrypt/云厂商）覆盖 |
| openssl 缺失 | 报错提示安装；用户证书路径不受影响 |
| 改密后已登录用户困惑 | 登录页提示"密码已更改，请重新登录"（可选 M2 预留） |
| systemd 用户级服务未启用（linger） | `status` 提示 `loginctl enable-linger`（可选文档化） |
| CIDR 误配导致锁死自己 | config 校验 + 启动日志打印生效白名单 |

*关联文档：req.md | discussion.md | 下一步：plan.md（待 solution 批准后）*
