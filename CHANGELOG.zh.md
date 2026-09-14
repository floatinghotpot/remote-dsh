# 变更日志

[English](CHANGELOG.md) | **中文**

本文件记录项目的所有重要变更。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [rdsh-gateway 0.8.4 · rdsh-hub 0.7.3 · remote-dsh 0.10.5 · dsh-web-remote 0.5.3] - 2026-09-14

### 修复

- **E2EE 数据面现在真正生效**（hub）：注入 hostId、门面可构造、`fetch` 输入归一化，修掉三个此前让数据面一直静默明文的缺陷。
- **E2EE 下大文件上传可用**（hub）：请求体按 1 MiB 分片，不再整包一帧。
- **预览字节保真且流式**（hub）：响应按字节流式返回、在 OPEN 时 resolve，JSON 走原生解析，中止/错误正确上抛。
- **请求体全类型支持**（hub）：Blob/File、ReadableStream、FormData、URLSearchParams；其余抛错。
- **manifest 兜底**（hub）：不带 cookie 的 `manifest.webmanifest` 请求不再回传 portal HTML。
- **上游失败分类**（gateway）：只有真连接错误才报"不可达"，中途断开带 errno。
- **LAN 配对会话也打 loopback 补丁**（gateway）：配对模式下设置/API key 同样可用。
- **远程 UI 设置/API key 可用**（gateway）：编码感知补丁、content-length 正确、不再继承 immutable 缓存、补丁未命中留日志。

### 安全

- **超大帧不再打死 hub 或 host（远程 DoS）**：两侧有界发送器按流失败，而不是崩进程。

> hub ↔ host 新旧版本混跑已验证兼容；dsh 兼容性不变。

## [rdsh-hub 0.7.1 · remote-dsh 0.10.3] - 2026-09-11

### 新增

- **Portal 深色模式**：hub 网页门户（`/portal`）现在跟随系统的浅/深色偏好。此前 portal 没有任何主题层——所有颜色都是写死的浅色字面量，所以在深色系统上页面始终是白底。现在引入 **30 个语义化色 token**（`--rdsh-*`），由 `prefers-color-scheme` 驱动（CSS `color-scheme: light dark` + 对应 `<meta>`），深色取值对齐 DSH 官方 token；浅色取值与改动前逐字一致，**浅色不回归**。覆盖 `pages.tsx`（含管理台 CSS 与组件）与法务页，另含二维码容器与架构图（CSS 滤镜，零新资产）。深色对比度按 WCAG AA 核验（18 组全部 ≥ 4.5:1，发布时已独立复算）。详见 `doc/feature/16-portal-dark-mode/`。
- 说明：portal 是随 `rdsh-hub` 分发的（`files: ["portal"]`），而 `remote-dsh` 对 `rdsh-hub` 是**精确锁版本**，因此**两个包必须一起发**——否则 `npm i -g remote-dsh` 拿到的还是旧 portal。

## [rdsh-gateway 0.8.2 · dsh-web-remote 0.5.1 · remote-dsh 0.10.2] - 2026-09-11

### 修复

- `dsh-web-remote`（0.5.1）：**修复插件导致 dsh `0.1.5-rc.2` 上 `dsh web` 无法启动**。原先用于注册浏览器 RPC 通道的 `connection.rpc.handle(...)`，其内部经服务 shadow ctx 访问 `owner.webServer`，在 0.1.5-rc.2 上对第三方插件行无法解析该服务，直接中断整棵插件树（上游回归，deepseek-harness discussion #5926）。现改为在 `ctx.webServer` 上自注册原生 `/remote-access` 前缀路由，由插件实现 `client-request`/`server-response` envelope 与 connection 服务一致的状态语义（404/415/413/400；envelope 非法或 `method` 与 path 不一致 → 200 + `gateway/bad-request`；handler 抛错 → 500），并在其前方复用官方 Host/Origin + 浏览器会话围栏（`connection.requestRejection`）；**浏览器半零改动**。已补协议单测，同一份代码在 dsh `0.1.2-rc.1` 与 `0.1.5-rc.2` 双版本实测通过（无版本分支）；浏览器半已在真实 profile + `0.1.5-rc.2` 验证（客户端 bundle 正常下发、设置页可见「远程访问」面板、经 hub 从远端访问成功）。详见 `doc/fix/20260911-dsh-0.1.5-plugin-rpc/` 与 `doc/review/20260911-dsh-0.1.5-rc.2-plugin-compat.md`。
- 附带修正：插件原先传给 `rpc.handle` 的 `authority: "loopback"` 选项在两个 dsh 版本中**都不存在**（该 helper 只接受 `(channel, handler)`）；真正的围栏一直是 connection 服务的 Host/Origin + 浏览器会话校验，现由插件显式调用。
- `rdsh-gateway` / `remote-dsh` CLI —— **dsh `0.1.5-rc.2` 网关兼容性（实测，非推断）**：用真实 `dsh@0.1.5-rc.2` 冒烟 `rdsh host serve` —— spawn + `--port 0` 就绪行（含 launch token）、浏览器会话 cookie 换发、`/api` 转发（真实 `settings/describe` 返回数据）、HTML polyfill 注入（含 0.1.2 起的 gzip 剥离）、WebSocket `/api/remote.mux` 升级，以及 join 路径的 `patchLoopbackJs` 仍能命中发行版客户端 bundle 里的 `isLoopbackHostname(pageLocation.hostname)`。未发现破坏 ⇒ `DSH_COMPAT_MAX` 从 `0.1.2-rc.1` 扩到 **`0.1.5-rc.2`**，并为 `dshVersionWarning` 补了窗口边界单测。详见 `doc/review/20260911-dsh-0.1.5-rc.2-plugin-compat.md` §5（G1–G7）；随后做了完整端到端：用 `rdsh host serve` 把主机接入生产 hub，并从远端设备成功访问（G9）。
- 提醒（旧笔记/文档）：DSH 的 WebSocket 端点自 **0.1.2** 起就是单一 `/api/remote.mux`（`events.mux` / `events.host` 已不存在）；rdsh 一律按 `req.url` 原样透传 WS、**不硬编码路径**，故该更名不影响转发（仅注释/测试仍用旧名）。

### dsh 兼容矩阵

| remote-dsh 组件 | 版本 | 兼容 dsh（冒烟实测） | 机制 |
|---|---|---|---|
| remote-dsh CLI（`host serve` / `join`） | 0.10.2 | dsh `0.1.1-rc.2` ✅<br>dsh `0.1.2-rc.1` ✅<br>dsh `0.1.5-rc.2` ✅ | ready 行行为探测，自适应 |
| `dsh-web-remote` 插件 | 0.5.1 | dsh `0.1.2-rc.1` ✅<br>dsh `0.1.5-rc.2` ✅<br>（`0.1.1` 线未实测） | 原生 `webServer` 路由，无版本分支 |
| rdsh-hub | 任意 | 与 dsh 版本无关 | 纯中继不解析业务流量 |

> 发布前用仓库自带 `node scripts/smoke-dsh-compat.mjs` 对 dsh `0.1.2-rc.1` 与 `0.1.5-rc.2` 各跑一遍，**S1–S7 全 PASS**；另外 `dsh-web-remote` 浏览器半在真实 profile + `0.1.5-rc.2` 下验证通过（面板可见、经 hub 远端访问成功）。

## [rdsh-gateway 0.8.1 · remote-dsh 0.10.1] - 2026-09-08

### 修复

- macOS（launchd）上的 `rdsh host service install`：`ProgramArguments` 现在把 node / 脚本 / 参数拆成独立 `<string>` argv 元素（launchd 不做空格切分——旧的单字符串形式导致服务无法 exec）；重装幂等（先 unload 再 load）；`KeepAlive` 仅失败退出时重启（与 Linux `Restart=on-failure` 对齐）；`rdsh host service status` 经 `launchctl print` 的 state 区分 `active` 与 `loaded (not running)`。详见 `doc/fix/20260908-host-service-launchd/`。
- 注：macOS 修复尚未在真实 Intel / Apple Silicon 机器上回归（Linux systemd 路径未变，已实测）。

## [rdsh-gateway 0.8.0 · dsh-web-remote 0.5.0 · remote-dsh 0.10.0] - 2026-09-08

### 新增

- 适配 dsh `0.1.2-rc.1`：rdsh 现在会换发并代持 dsh 的浏览器会话 cookie（0.1.2 引入），注入所有转发请求（HTTP + WebSocket），覆盖三条访问路径（局域网 serve / hub join / `dsh-web-remote` 插件），在最新 dsh 上远程访问恢复正常；`0.1.1` 线经就绪行行为探测仍照常工作（自适应、无版本分叉）。运行时版本检查在实测窗口外 warn（不阻断）并打印升级命令。
- 修复：dsh 0.1.2 对 index 文档默认 gzip 压缩，导致 hub 注入的返回条与 E2EE shim 静默跳过；rdsh 现在对文档导航请求剥离 `accept-encoding`，使 dsh 返回明文 HTML，注入的 UI（返回主机列表、E2EE 数据面）恢复。
- 安装注意（pnpm ≥ 12）：`dsh plugin add`（裸名或 `@latest`）在版本发布 24 小时内会因 pnpm 默认 `minimumReleaseAge` 策略**静默装上一版本**——装完请以 `dsh plugin ls` 核对实际版本；版本敏感时用 `dsh plugin add <pkg>@<精确版本>` 钉版（详见 `doc/review/20260908-pnpm-12-minimum-release-age-plugin-install.md`）。

### dsh 兼容矩阵

| remote-dsh 组件 | 版本 | 兼容 dsh（逐个实测） | 机制 |
|---|---|---|---|
| remote-dsh CLI（`host serve`/`join`） | 0.10.0 | dsh `0.1.1-rc.2` ✅<br>dsh `0.1.2-rc.1` ✅ | 就绪行行为探测，自适应 |
| `dsh-web-remote` 插件 | 0.5.0 | dsh `0.1.2-rc.1` ✅<br>（`0.1.1` 线待实证） | 宿主 API shape 两版相同，无版本门 |
| rdsh-hub | 任意 | 与 dsh 版本无关 | 纯中继不解析业务流量 |

## [dsh-web-remote 0.3.0] - 2026-08-31

> 事后补齐（2026-09-11）：该版本发布时未单独记录小节（`0.2.0`/`0.4.0` 同样缺节）。本节按 npm 发布时间与已发布 tarball 实测内容补记：`0.2.0` 不含下列特性，`0.3.0` 首次包含（`set-ui-compat` RPC 与 `autoConnect` 均在 0.3.0 tarball 中命中），`0.4.0`/`0.5.0` 沿用。

### 新增

- `dsh-web-remote`（0.3.0）：「远程访问」面板新增**「端到端加密时，信任为本地访问（兼容模式）」复选框**（`dshUiCompat.trustE2EEAsLoopback`，默认开启）——开启后经隧道转发的 JS 响应按 loopback 对待，DSH 的 Models / API key 设置可远程使用；并新增**启动自动接入**（host.json 为 join 模式且有持久化 token、隧道未被 CLI 持有时自动复用 token 建隧道，行为与 `rdsh host serve` 一致），消除「需先点接入才有隧道」的鸡生蛋。

## [0.6.0] - 2026-08-24

### 新增

- `rdsh hub` 新增子命令：`audit ls`（审计日志查询）、`user unlock`（解锁被锁账户）、`user reset-2fa`（重置用户 2FA）。（`remote-dsh@0.6.0`，依赖 `rdsh-hub@0.4.0`）

## [rdsh-hub 0.4.0] - 2026-08-24

### 新增

- M5 多租户：邮箱验证 + 找回密码（可配置 `EmailSender` —— `smtp`/`aliyun`/`log`）、TOTP 两步验证、host 共享（owner/member）、审计日志（`rdsh hub audit ls`）、账户锁定（10 次/15 分钟，`rdsh hub user unlock`）、发信限流（收件人/触发者/全局三层）。
- 配置：`hub.json` 增 `email`、`captcha`、`security` 段。邮件是首个外部服务依赖（smtp 用 `nodemailer`；`aliyun` provider 手写 DirectMail RPC 签名，零依赖）。

## [rdsh-gateway 0.4.0 · dsh-web-remote 0.1.0] - 2026-08-24

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
