# 变更日志

[English](CHANGELOG.md) | **中文**

本文件记录项目的所有重要变更。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 修复

- **dsh 0.1.7-rc.1 不再被误报为"超出实测范围"**（gateway）：实测窗口上界 `DSH_COMPAT_MAX` 由 `0.1.5-rc.2` 扩到 `0.1.7-rc.1`，跑在该版本上的 host 不再打印误导性的启动警告。0.1.7 只改前端 dist 形态（`<base href="./">` + 相对 `plugins/…`），同源网关天然免疫；认证与 RPC 未变。G1–G7 清单已对真实包重跑通过——见 `doc/review/20260924-dsh-0.1.7-rc.1-compat.md`。

### dsh 兼容矩阵

| remote-dsh 组件 | 版本 | 已实测兼容的 dsh | 机制 |
|---|---|---|---|
| remote-dsh CLI（`host serve` / `join`） | 0.11.0 | dsh `0.1.1-rc.2` ✅<br>dsh `0.1.2-rc.1` ✅<br>dsh `0.1.5-rc.2` ✅<br>dsh `0.1.7-rc.1` ✅ | 就绪行行为探测，自适应 |
| `dsh-web-remote` 插件 | 0.5.6 | dsh `0.1.2-rc.1` ✅<br>dsh `0.1.5-rc.2` ✅<br>（`0.1.7-rc.1` 本轮未复验） | 原生 `webServer` 路由，无版本分支 |
| rdsh-hub | 任意 | 与 dsh 版本无关 | 纯中继，不解析流量 |

## [rdsh-gateway 0.9.0 · rdsh-hub 0.7.4 · remote-dsh 0.11.0 · dsh-web-remote 0.5.6] - 2026-09-22

### 新增

- **服务手动起停/重启**（cli + gateway）：`rdsh host service` / `rdsh hub service` 新增 `start|stop|restart`，手动起停/重启已装服务而不改变开机自启。host 按 `host.json` 的 mode 定位服务（`rdsh-join` / `rdsh-host`），hub 用 `rdsh-hub`。

### 修复

- **portal 构建类型检查**（portal）：构建时 type-check，清除 97 处累积的类型错误（补 DOM lib、portal 优先构建、copy-portal 防陈旧/缺失 dist）。
- **iOS 表单自动放大**（portal）：手机/平板表单字段 ≥ 16px，避免 iOS 聚焦时自动放大。
- **iOS 面板输入自动放大**（web-remote）：窄屏/触屏下面板输入字号提到 16px。
- **返回条遮挡**（hub）：注入的「返回主机列表」悬浮条降到 `top:90px;right:20px`，不再遮挡 DSH 顶栏 / Session Log。
- **loopback 补丁可观测**（gateway）：记录 loopback 补丁命中日志，不再重扫 shell 资源。

## [rdsh-gateway 0.8.6 · dsh-web-remote 0.5.5 · remote-dsh 0.10.7] - 2026-09-17

### 修复

- **远端浏览器可以正常选择工作区目录**（web-remote + gateway）：DSH 的目录选择器在启动时一次解析；宿主是桌面操作系统且非 SSH 启动时会选成**宿主原生对话框**——它弹在宿主自己的屏幕上，远端浏览器无法操作。现在插件在自己的 bundle patch 里把选择器固定为**浏览器内**形态（无条件，与隧道状态无关）；CLI（`rdsh host serve` / `rdsh host join`）在 spawn `dsh web` 时注入 DSH 判定所用的远端会话信号。面板会显示实际生效的选择器形态。
- **静默回归护栏**（gateway）：`rdsh host serve` / `join` 启动后检查 spawn 出的 dsh 的 boot graph 是否含浏览器内选择器，缺失时告警，而不是让操作者面对一个用不了的目录选择器。

> ⚠️ 选择器是**单占用**的：不要再加第二个 pin 通道（手工写 profile 的 `cordis.patch.yml`，或给 `dsh web` 传 `--patch`）——重复的条目会让 dsh **启动失败**。重装插件（或升级 CLI）即可生效，无需部署 hub。

## [rdsh-gateway 0.8.5 · dsh-web-remote 0.5.4 · remote-dsh 0.10.6] - 2026-09-15

### 修复

- **一台机器只允许一条隧道**（gateway）：join 锁改为原子发布（临时文件 + `link`），只回收确定已死的锁，任何活锁（含本进程自己）一律拒绝。此前两个 `dsh web` 实例会争夺同一个 host，互相踢下线（约 1.2 秒一轮）。
- **锁冲突可见**（web-remote）：面板显示停在 disconnected 的原因，而不是静默失败。

> 线协议未变，无需部署 hub。重装插件（或升级 CLI）即可拿到 `rdsh-gateway` 0.8.5。

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

- **Portal 深色模式**：hub 网页门户现跟随系统浅/深偏好，用 30 个语义色 token（`--rdsh-*`）+ `prefers-color-scheme` 驱动；深色取值对齐 DSH token，浅色逐字不变（WCAG AA 已核验，18 组 ≥ 4.5:1）。
- 说明：portal 随 `rdsh-hub` 分发，`remote-dsh` 精确锁 `rdsh-hub`，故两包一起发。

## [rdsh-gateway 0.8.2 · dsh-web-remote 0.5.1 · remote-dsh 0.10.2] - 2026-09-11

### 修复

- `dsh-web-remote`（0.5.1）：不再让 dsh `0.1.5-rc.2` 上的 `dsh web` 启动失败——浏览器 RPC 通道改为原生 `/remote-access` 路由，替代 `connection.rpc.handle(...)`（上游回归，discussion #5926）。同一份代码无版本分支，`0.1.2-rc.1` 与 `0.1.5-rc.2` 双版本实测。
- `rdsh-gateway` / CLI：dsh `0.1.5-rc.2` 兼容性端到端实测（spawn、cookie 换发、`/api`、HTML polyfill、WS `remote.mux`、loopback 补丁）；`DSH_COMPAT_MAX` → `0.1.5-rc.2`。
- 提醒：DSH 的 WebSocket 端点自 `0.1.2` 起就是单一 `/api/remote.mux`；rdsh 按 URL 原样透传 WS，更名不影响转发。

### dsh 兼容矩阵

| remote-dsh 组件 | 版本 | 兼容 dsh（冒烟实测） | 机制 |
|---|---|---|---|
| remote-dsh CLI（`host serve` / `join`） | 0.10.2 | dsh `0.1.1-rc.2` ✅<br>dsh `0.1.2-rc.1` ✅<br>dsh `0.1.5-rc.2` ✅ | ready 行行为探测，自适应 |
| `dsh-web-remote` 插件 | 0.5.1 | dsh `0.1.2-rc.1` ✅<br>dsh `0.1.5-rc.2` ✅<br>（`0.1.1` 未实测） | 原生 `webServer` 路由，无版本分支 |
| rdsh-hub | 任意 | 与 dsh 版本无关 | 纯中继不解析业务流量 |

## [rdsh-gateway 0.8.1 · remote-dsh 0.10.1] - 2026-09-08

### 修复

- macOS（launchd）上的 `rdsh host service install`：`ProgramArguments` 正确拆分、重装幂等、`KeepAlive` 仅失败重启、`service status` 区分 active 与 loaded。尚未在真实 Apple Silicon 上回归（Linux systemd 不变）。

## [rdsh-gateway 0.8.0 · dsh-web-remote 0.5.0 · remote-dsh 0.10.0] - 2026-09-08

### 新增

- dsh `0.1.2-rc.1` 兼容：rdsh 换发并注入 dsh 的浏览器会话 cookie，覆盖三条路径（LAN / hub join / 插件）；`0.1.1` 仍靠 ready 行自适应探测；超出测试窗口时运行时打版本告警。
- 修复：dsh 0.1.2 对 index 文档 gzip；rdsh 现在文档导航时剥离 `accept-encoding`，使注入的返回条 / E2EE shim 重新生效。
- 安装提示（pnpm ≥ 12）：发布后 24h 内 `dsh plugin add` 可能装到上一版（`minimumReleaseAge`）；必要时钉精确版本。

### dsh 兼容矩阵

| remote-dsh 组件 | 版本 | 兼容 dsh（冒烟实测） | 机制 |
|---|---|---|---|
| remote-dsh CLI（`host serve`/`join`） | 0.10.0 | dsh `0.1.1-rc.2` ✅<br>dsh `0.1.2-rc.1` ✅ | ready 行行为探测，自适应 |
| `dsh-web-remote` 插件 | 0.5.0 | dsh `0.1.2-rc.1` ✅<br>（`0.1.1` 待测） | 同构 API，无版本门 |
| rdsh-hub | 任意 | 与 dsh 版本无关 | 纯中继不解析业务流量 |

## [dsh-web-remote 0.3.0] - 2026-08-31

> 补记（2026-09-11）：按 npm 发布时间与 tarball 记录——`0.3.0` 是首个含以下特性的版本。

### 新增

- `dsh-web-remote`（0.3.0）：远程访问面板新增「E2EE 下视作本地访问」开关（`dshUiCompat.trustE2EEAsLoopback`，默认开），使 Models/API key 设置可远程使用；插件在 join 模式 + 已持久化 token 且无 CLI 占用隧道时启动即自动连接。

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
