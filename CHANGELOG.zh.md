# 变更日志

[English](CHANGELOG.md) | **中文**

本文件记录项目的所有重要变更。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.0] - 2026-08-23

### 新增

- M1 MVP：`rdsh serve` 局域网认证网关 —— 配对码 + 签名会话 Cookie、HTTP/SSE/WebSocket 全双工转发、自动拉起 `dsh web`。
- `--no-code` 跳过配对（仅限完全可信网络，启动警告）。
- 运行时修复：secure-context polyfill（明文 http 下 `crypto.randomUUID`）、DSH Host 围栏兼容（Host + Origin 改写）、优雅退出（SIGINT/SIGTERM/SIGHUP）、无 dsh 孤儿进程。
- 发布 `rdsh-gateway@0.1.0` + `remote-dsh@0.2.0` 到 npm。

## [0.1.0] - 2026-08-22

### 新增

- 名称保留发布：`remote-dsh@0.1.0` 已发布到 npm。
- monorepo 骨架：`packages/{tunnel,gateway,hub,cli,portal}`、`apps/{app,weapp}`、`go/`、`e2e/`。
- 开源文档：LICENSE（MIT）、README（中/英）、CONTRIBUTING、CODE_OF_CONDUCT、NOTICE、CI 工作流。
- 产品提案（`doc/overview/proposal.md`），含 Q1–Q10 已定路线。

## [未发布]

### 新增（M3 — 公网 hub）

- 公网 hub：`rdsh hub serve`（必须 TLS、SQLite 控制面、托管 portal 静态资源）。
- 层 2 线协议冻结 v1（`packages/tunnel/PROTOCOL.md`）：帧格式、payload 编码（open/data/close/ping/pong/error）、E2E 预留位透传。
- 层 1 对外 API 冻结：认证（login/refresh/logout/password/first-password）、host（list/pending/bind/改名/吊销）、WSS `/api/events`、`/h/<hostId>` 透传。
- `rdsh join <hub-url>`：出站隧道 —— 配对码绑定（10 分钟，门户输码）或 `--token` 脚本化直填；心跳；指数退避重连；`--insecure`（自签 hub）。
- `rdsh hub user add/passwd/rm/ls`（注册关闭 —— 管理员建号防 bot/垃圾）、`rdsh hub host ls/revoke`（吊销即断隧道）、`rdsh hub service ...`。
- portal（React）：登录、host 列表（实时在线状态）、绑定、改名、吊销、修改密码、iframe 进入 host（`/h/<hostId>`）。
- 多用户 host 归属与隔离；JWT 会话（ver 版本化即时失效）；host/refresh token 只存 SHA-256 摘要。
- host 访问改为根路径承载：经 `/h/<hostId>` 进入（校验归属 → Set-Cookie `rdsh_host` → 302 根路径），DSH 绝对路径（/assets、/api）原样可用。portal 移到 `/portal`。同一浏览器一次在一个 host 上下文（cookie）；多用户/多浏览器互不影响。
- 修复：隧道 HTTP method 透传（POST 被降级为 GET）、流生命周期（GET 响应挂起）、配对码限流计数、join 漏 findDsh、自签 hub 的 TLS 处理。

## [0.2.0] - 2026-08-23
