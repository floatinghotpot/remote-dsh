# 变更日志

[English](CHANGELOG.md) | **中文**

本文件记录项目的所有重要变更。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布] - 2026-08-24

### 新增

- M4 插件 `dsh-web-remote@0.1.0`（新包）：`dsh plugin add dsh-web-remote` 在 DSH 界面安装「远程访问」面板（接入 / 断开 / 注销 + 实时状态），复用 join 隧道、免装 rdsh CLI。server 半在进程内跑隧道并暴露 `/remote-access` RPC 通道；client 半渲染设置页。
- `rdsh-gateway@0.4.0`：`startJoin()` —— join 隧道作为可复用的进程内核心（不 spawn、外部 target、`stop()` 句柄、`onState`/`onLog` 钩子）；`join()` 保留为 CLI 封装。新增 join pid 锁（`~/.rdsh/join.lock`），强制 CLI 与插件同机单隧道。

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

## [0.5.0] - 2026-08-24

### 新增

- 组件化 CLI：`rdsh host {setup lan|cloud, join, serve, service, leave, user}`；`rdsh hub` 不变。（`remote-dsh@0.5.0`）
- `~/.rdsh/host.json`（mode `lan` | `cloud` | `join`）取代 `config.json`，自动迁移。
- 用户级 join token：portal 生成 / 复制 / 列表 / 吊销（默认 30 天，可配 1 天–1 年，只显示一次，哈希存储）。（`rdsh-hub@0.3.0`）
- `POST /api/hosts/register`（join token → host token，限流，对 host token 幂等）+ `POST /api/hosts/self-revoke`。
- `rdsh host join` 交互粘贴 token；TLS 证书自动检测（无需 `--insecure`）。
- portal「添加主机」页（生成/复制接入命令或 token、token 列表/吊销）。
- 服务名独立（`rdsh-host` / `rdsh-join` / `rdsh-hub`），host 服务 unit 注入 node PATH（nvm 下 `#! /usr/bin/env node` 127 修复）。（`rdsh-gateway@0.3.0`）

### 移除（breaking）

- join 的配对码流程（`--code`、`/api/hosts/pending` + `/api/hosts/bind`）——join 现在只用 join token；配对码仅保留给 LAN/cloud 网关的 pair 认证。
- 旧顶层命令 `rdsh serve` / `rdsh join` / `rdsh user` / `rdsh service`。

## [0.4.9] - 2026-08-24

### 修复

- DSH host 访问不再受 1 小时 access token 过期影响：进入 host（`/h/<hostId>`）现在会签发 HMAC 签名 Cookie（7 天、绑定用户会话版本），relay 改由该 Cookie 认证，而非反复校验短期 access token。改密会使版本 +1，旧 Cookie 立即失效。（`rdsh-hub@0.2.4`）
- `rdsh join` 现在把 host token 持久化到 `~/.rdsh/join-*.token`（0600）并在重启时复用：gateway 重启不再强制重新配对，也不再在 hub 上累积死条目。token 被吊销（401）时自动回退配对码流程；`--reset` 可忘记已持久化的 token。显式 `--token` 被拒时明确报错退出，不再静默无限重连。（`rdsh-gateway@0.2.3`）

## [0.4.7] - 2026-08-24

### 修复

- WebSocket 转发改为文本帧：隧道此前把 DSH 的 WS 消息当 binary 发，前端丢弃（"malformed binary WebSocket frame"）导致界面不实时刷新，需刷新页面才看到新输出。

## [0.4.6] - 2026-08-24

### 修复

- portal 静态资源已打包进 hub 包内（构建时从 packages/portal/dist 复制）。此前 npm 安装的 hub 的 `/portal` 返回 404（dist 只存在于 workspace）。

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
