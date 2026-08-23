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

## [0.4.5] - 2026-08-24

### 修复

- 常驻命令（`rdsh serve` / `rdsh join` / `rdsh hub serve`）恢复进程保持：0.4.3 的显式退出修复导致它们打印启动横幅后即退出。现改为 await 一个永不 resolve 的 Promise，仅通过信号退出（管理命令仍正常退出）。

## [0.4.4] - 2026-08-24

### 修复

- `rdsh hub serve` 等 hub 命令在未传 `--config` 时正确解析 hub 配置路径（`~/.rdsh/hub.json`）。原 parseGlobal 用了 gateway 的解析器（`~/.rdsh/config.json`），导致 hub 静默回退到空配置并拒绝启动（"hub requires TLS"）。

## [0.4.3] - 2026-08-23

### 修复

- 管理命令（user/hub/service）完成后显式退出 —— 修复真实终端交互输入密码（含重试）后进程挂住不退出（TTY stdin 残留句柄）。

## [0.4.2] - 2026-08-23

### 新增

- hub `behindProxy` 反代模式：rdsh-hub 部署在 apache2/nginx 后面（监听本机 http，仅回环信任 X-Forwarded-For —— 限流按真实 IP）。
- 博客 03-02/03-03：hub 经 apache2 / nginx 反代部署（443 + 证书自动续期）。

## [0.4.1] - 2026-08-23

### 修复

- `rdsh --version` 改为从 package.json 读取（原为硬编码，0.4.0 发布后仍显示 0.2.0）。

## [0.4.0] - 2026-08-23

### 新增（M2 — 云服务器直连）

- HTTPS（用户自备证书 `tls.cert/key`）；无证书即 http；`auth.mode: password` 无证书拒绝启动（behindProxy 例外）。
- 密码认证：scrypt 哈希、登录页、限流（5 次/10 分钟）、改密吊销全部会话（版本化）。
- 配置文件（`~/.rdsh/config.json`、`--config` / `$RDSH_CONFIG`）、IP 白名单（`allowFrom` CIDR）、systemd/launchd 服务化。
- CLI：`serve` 子命令、`rdsh user add/passwd/ls/rm`、`rdsh service ...`。

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
