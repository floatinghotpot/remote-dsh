# 01-remote-access — 解决方案（solution.md）

> **日期**: 2026-08-22
> **状态**: 草稿，**待用户批准**
> **范围**: M1 MVP —— `rdsh serve` 局域网认证网关
> **来源**: [req.md](req.md)（R1–R11，已批准）, [discussion.md](discussion.md)

---

## 1. Goal（目标架构）

`npm i -g remote-dsh` 后，`rdsh serve` 在开发机监听局域网地址；同 LAN 设备的浏览器先看到配对页，输入终端显示的配对码后签发会话 Cookie，之后所有 HTTP/SSE/WebSocket 流量原样转发到本机 `dsh web`（由 rdsh 自动 spawn）。

```
   浏览器（另一台笔记本）
          │  http
          ▼
rdsh-gateway (0.0.0.0:8443)
          │  认证中间件：无会话 → 配对页 / 有会话 → 转发（Host 重写）
          ▼
  dsh web (127.0.0.1:<dshPort>)
```

验收 = [req.md](req.md) §3 端到端场景全通过。

## 2. Facts（现状审计，非假设）

### 2.1 当前仓库状态（2026-08-22 审计）

| 位置 | 现状 |
|---|---|
| `packages/gateway/src/index.ts` | 仅导出 `NAME = "rdsh-gateway"`，无实现、无 `test/` |
| `packages/gateway/package.json` | 骨架（`rdsh-gateway@0.1.0`，`build: tsc`，`test: node --test test/`），无依赖 |
| `packages/cli/src/bin.ts` | 仅打印 "0.1.0 (skeleton)"；`src/index.ts` 导出 NAME/VERSION/DESCRIPTION |
| `packages/cli/package.json` | 已发布 `remote-dsh@0.1.0`（占名）；`bin.rdsh → dist/bin.js`；`files: ["dist"]` |
| `packages/tunnel/hub/portal` | 骨架，本里程碑不涉及 |
| 仓库根 | 无 pnpm；无统一构建脚本（`pnpm build` 需 pnpm 环境） |

### 2.2 环境事实（本机）

- Node `v22.23.2`（≥22 ✓），npm `12.0.2`
- **`dsh` 在 PATH**（`~/.nvm/.../bin/dsh`）→ 可真实端到端测试
- pnpm 未安装（monorepo 声明 pnpm-workspace，但当前不可用）

### 2.3 DSH 事实（查档于 discussion.md §2，与本方案强相关）

- `dsh web --port 0 --no-open`：OS 分配端口；`--no-open` 不弹浏览器。
- **Host 围栏**：`isTrustedApiRequest` 要求 Host 为 loopback（127/8、localhost、::1）或 trusted authority；跨站（`sec-fetch-site: cross-site`）拒绝；带 Origin 须同源。**→ 转发请求必须把 Host 重写为 `127.0.0.1:<dshPort>`**，否则 `/api` 一律 403。这是"转发能通"的关键约束。
- `/api/*` 承载全部 RPC + `/api/events.mux`、`/api/events.host` 两条 WebSocket；静态 dist 走 fallback（无围栏）。
- 请求体上限 300 MB → 转发必须流式、禁止整体缓冲。

## 3. Gap（差距 = 要解决的问题）

| 需求 | 现状 → 目标 |
|---|---|
| R1 命令 | bin 只打印 skeleton → 完整参数解析 + `serve` |
| R2 dsh 集成 | 无 → 发现 PATH 中 dsh、spawn `--port 0 --no-open`、解析实际端口、失败报错 |
| R3 监听 | 无 → `0.0.0.0:<port>`（默认 8443），`--port`/`--host` 可配，打印 LAN URL |
| R4/R5 配对 | 无 → 配对码 + 恒定时间比较 + IP 限流 |
| R6 会话 | 无 → HMAC 签名 Cookie（HttpOnly/SameSite/TTL/`--reset`） |
| R7 转发 | 无 → HTTP/SSE/WS 全双工透传 + **Host 重写** |
| R9 生命周期 | 无 → 信号处理、dsh 子进程跟随退出 |
| R10 大流量 | 无 → 流式 pipe、并发 |
| R11 安全基线 | 无 → 默认拒绝、密钥 600、日志脱敏 |
| 构建 | 无 pnpm → 安装 pnpm 或调整构建方式 |

## 4. Call-site Audit

本方案**无既有实现可破坏**（gateway/cli 均为空骨架），但定义两个新契约，后续里程碑必须兼容：

| 新契约 | 定义 | 未来调用方 |
|---|---|---|
| `gateway` 包导出 `serve(options)` | `{ host, port, pairCode?, sessionTtlSeconds, dshPath? }` → 启动网关；SIGINT/SIGTERM 优雅退出 | cli 包 `rdsh serve`（现）；M3 `rdsh join` 复用认证/转发内核 |
| 网关内部 `proxy` 转发规则 | 所有转发请求 Host 重写为 `127.0.0.1:<dshPort>` | M3 隧道端点复用同一转发内核（目标改为隧道远端） |

## 5. Tasks（文件变更清单）

> 实现细节与顺序见 plan.md；此处定义文件级变更与职责。

### 5.1 gateway 包（`packages/gateway/`）—— 新增实现

| 文件 | 职责 | 关键点 |
|---|---|---|
| `src/session.ts` | 会话密钥管理 + Cookie 签名/校验 | 密钥存 `~/.rdsh/secret.key`（0600，首次生成）；HMAC-SHA256(payload, key)，payload = `{sid, exp}`（ISO 8601）；无状态；`reset()` 删除密钥文件 |
| `src/pair.ts` | 配对码生成/校验 + 限流 | `crypto.randomInt(100000, 1000000)`（6 位）；恒定时间比较（先 SHA-256 再 `timingSafeEqual`，规避长度泄漏）；限流 `Map<ip, {fails, lockedUntil}>`，5 次失败锁 10 分钟；进程生命周期内有效；`--pair-code` 预置 |
| `src/spawn-dsh.ts` | dsh 发现/spawn/端口解析 | PATH 查找 `dsh`（`--dsh <path>` 覆盖）；spawn `dsh web --port 0 --no-open`；stdout/stderr 走管道解析 `dsh web: http://127.0.0.1:(\d+)`，随后透传日志；dsh 退出 → 跟随退出（透传退出码）；超时（如 30s）未就绪 → 报错 |
| `src/proxy.ts` | HTTP/SSE/WS 转发 | HTTP/SSE：`node:http.request` 流式 pipe（零缓冲），**Host 重写 `127.0.0.1:<dshPort>`**，其余头透传；WS upgrade：`ws` 客户端连 `ws://127.0.0.1:<dshPort><path>`（头透传 + Host 重写），上游握手成功后向客户端回写 101，双向二进制帧桥接 + backpressure + 关闭传播 |
| `src/server.ts` | HTTP 服务器 + 认证中间件 + 路由 | `node:http` server；路由：`GET /pair`（配对页）、`POST /pair`（JSON `{code}`，成功 Set-Cookie + 302 `/`，失败 429/401）；其余路径：有有效会话 → `proxy` 转发；无 → 302 `/pair`；`upgrade` 事件同样过认证后转 `proxy`；Origin/SameSite 校验兜底 |
| `src/pair-page.ts` | 配对页 HTML | 内联纯 HTML/CSS/JS（零外部资源），深色风格，自动聚焦输入框，`fetch POST /pair` |
| `src/serve.ts` | `serve` 编排 | 组装上述模块：spawn dsh → 建 server → 打印启动信息（LAN URL + 配对码 + dsh 端口）→ 注册 SIGINT/SIGTERM（先关网关 → 终止 dsh 子进程 → 退出）→ 端口占用报错（EADDRINUSE） |
| `src/index.ts` | 导出 `serve` 等（契约见 §4） | 保留 `NAME` |

### 5.2 cli 包（`packages/cli/`）—— 修改

| 文件 | 职责 | 关键点 |
|---|---|---|
| `src/bin.ts` | 手写参数解析（零依赖） | `rdsh serve [--port <n>] [--host <ip>] [--pair-code <code>] [--session-ttl <sec>] [--dsh <path>] [--reset]`；`--version`/`--help`；未知命令报错退出；`serve` 委托 gateway 包的 `serve()` |
| `src/index.ts` | 不变 | 保持 NAME/VERSION/DESCRIPTION |

### 5.3 依赖与构建

| 项 | 决策 | 理由 |
|---|---|---|
| 新增依赖 `ws`（gateway 包） | **唯一新增依赖** | Node 内置无 WS 客户端/完整握手；`ws` 是 DSH 同款（`dsh-client-connection` 依赖它），生态一致 |
| 其余 | 零依赖 | 参数解析手写；转发用 `node:http`；密码学用 `node:crypto` |
| 构建工具 | **安装 pnpm**（`npm i -g pnpm` 或 corepack） | monorepo 已声明 pnpm-workspace；`pnpm build` 对齐 CLAUDE.md；npm 发布仍用 npm（用户已配置 2FA 流程） |

### 5.4 测试（`packages/gateway/test/`，`node:test` 零依赖）

| 文件 | 覆盖 |
|---|---|
| `session.test.ts` | 签名/校验、过期、篡改拒绝、密钥文件 0600、`reset` |
| `pair.test.ts` | 配对码校验、恒定时间比较路径、限流锁定/解锁 |
| `proxy.test.ts` | HTTP 转发 + **Host 重写断言**、SSE 流式、WS 双向帧（mock 上游 `node:http` + `ws` server） |
| `server.test.ts` | 未认证 302、配对流程、Set-Cookie 属性、Cookie 失效 302 |
| `spawn-dsh.test.ts` | 端口解析正则、dsh 缺失报错（mock PATH） |

### 5.5 手工验收

[req.md](req.md) §3 端到端场景（真实 `dsh` 在本机 PATH，双设备或 curl 模拟另一设备）。

## 6. 待定项定稿（来自 req.md §5）

| 项 | 定稿 |
|---|---|
| 默认监听端口 | **8443**（`--port 0` 允许 OS 分配） |
| 配对码有效期 | 进程生命周期内有效（重启失效）；`--pair-code` 预置；`--reset` 使会话失效（密钥重建） |
| 限流参数 | 5 次失败 / 锁 10 分钟（IP 维度） |
| 会话 TTL | 默认 12h（`--session-ttl` 秒） |

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| Host 围栏误伤（转发 403） | 转发统一 Host 重写；proxy.test.ts 断言 Host 头 |
| WS 桥接泄漏/悬挂 | backpressure + 关闭/错误双向传播；超时兜底 |
| 大文件内存暴涨 | 全程流式 pipe；R10 测试覆盖 |
| 配对码暴力 | 恒定时间比较 + IP 限流（R5 验收） |
| pnpm 引入环境变化 | 仅构建用；运行/发布不受影响 |

*关联文档：req.md | discussion.md | 下一步：plan.md（待 solution 批准后）*
