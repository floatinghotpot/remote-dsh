# remote-dsh 路线图（roadmap）

> **日期**: 2026-08-24
> **来源**: `proposal.md` §8 里程碑 + §10 决策记录（Q1–Q10）
> **状态**: 04-cli-refactor、05-join-easy 已完成并发布（2026-08-24）；**M4 dsh 插件（远程访问 `dsh-web-remote`）已实现 + 真实 DSH 冒烟通过**；待 npm 发布（gateway 0.4.0 + 插件 0.1.0）

## 里程碑总览

| 里程碑 | 内容 | 状态 |
|---|---|---|
| **M0 需求确认** | discussion / req / solution / plan 定稿 | ✅ 完成（2026-08-22） |
| **M1 MVP（LAN）** | `rdsh serve` 局域网认证网关 | ✅ 完成（2026-08-23，单测 33/33 + 端到端 14/14 + 双设备实测通过） |
| **M2 云服务器直连** | TLS/https + 密码认证 + 配置文件 + 服务化 | ✅ 完成（2026-08-23，单测 57/57 + M2 e2e 43/43 + M1 回归 14/14） |
| **M3 公网 hub** | rdsh-hub（认证/路由）+ `rdsh join` + rdsh-portal | ✅ 完成（2026-08-23，单测 92/92 + M3 e2e 23/23 + M1/M2 回归 57） |
| **M4 dsh 插件（远程访问）** | DSH 插件形态的 rdsh-gateway：`dsh plugin add dsh-web-remote` 即获网关/join，免装 CLI | ✅ 已实现 + 冒烟通过（待 npm 发布） |
| **M5 多租户增强** | 邮箱验证、2FA、共享授权、审计、限流 | ⏳ 未开始 |
| **M6 上线准备** | 域名备案、隐私政策、部署文档、压测 | ⏳ 未开始 |
| **M7 hub Go 化 + E2E** | rdsh-hub Go 单二进制 + conformance；公共 SaaS 化时实现 E2E | ⏳ 未开始 |
| **M8 移动端 App** | rdsh-app（Flutter，Android/iOS） | ⏳ 未开始 |
| **M9 微信小程序** | rdsh-weapp（原生小程序，wss 直连 hub API） | ⏳ 未开始 |

## 各里程碑详情

### M0 需求确认 ✅

- **内容**：产品提案、需求、方案、计划定稿
- **交付物**：`proposal.md`、`doc/feature/01-remote-access/{discussion,req,solution,plan}.md`、`doc/overview/architecture.md`
- **关键决策**：Q1–Q10 全部定案（自托管起步、整实例授权、TS→Go 双栈、E2E 协议预留等）

### M1 MVP（LAN）✅

- **内容**：`npm i -g remote-dsh` + `rdsh serve`：配对码认证 + 签名会话 Cookie + HTTP/SSE/WS 全双工转发；spawn `dsh web --port 0`
- **进度**：
  - ✅ T1–T13 实现（gateway 8 模块 + cli + 5 测试文件；T13 = `--no-code` 跳过配对）
  - ✅ 单测 33/33（session/pair/proxy/server/spawn-dsh）
  - ✅ 端到端 14/14（真实 dsh：认证 → RPC 转发 → 围栏兼容 → WS 桥接 → 优雅退出）
  - ✅ **真实双设备验收通过**（2026-08-23 用户实测：配对 → 目录选择 → 完整操作）
  - ✅ 运行时问题修复：secure-context polyfill（randomUUID）、Origin 围栏 403、SIGTERM 退出挂起、SIGHUP 孤儿进程
- **验收标准**：另一台设备输配对码即可操作 DSH；无认证流量被拒；Ctrl+C 无 dsh 残留 —— 全部达成

### M2 云服务器直连 ✅

- **背景**：`rdsh serve` 已可跑在云服务器（阿里云等）上（M1 能力），但公网直连有安全缺口：明文 http + headless 认证体验差（配对码依赖"人在终端前"）+ 无服务化
- **内容**：
  - 网关内置 **HTTPS**（TLS 1.3，`tls.cert/key` 任意 PEM —— acme.sh / Let's Encrypt / 云厂商 / 手动 openssl 自签；2026-08-23 修订：**不内置自签生成，无证书即 http**，password 模式无证书非反代拒绝启动）
  - **密码认证**（headless HTTPS 主认证，2026-08-23 定案）：**用户名 + 密码**（`rdsh user add/passwd/ls/rm`），scrypt 哈希（每用户独立盐）存 `~/.rdsh/config.json`；浏览器登录页输 user/pass → 签发会话 Cookie（复用 M1 会话机制）；认证失败限流（复用 M1 限流框架）；**改密 = 轮换会话密钥，全部旧会话立即失效**；Web 登录页提供改密入口（可选）；可选叠加 IP 白名单
  - **认证模式**（config.json 的 `auth.mode`，2026-08-23 定案 —— **持久配置一律进 config，不走 CLI**）：`pair`（LAN/可信网络，M1 现有）/ `password`（HTTPS 服务，M2 默认）/ `none`（--no-code 语义，完全可信网络）；`auth.pair_code` 为 pair 模式预置码
  - **IP 白名单**：config.json 的 `allowFrom` 字段（CIDR 列表，持久安全配置，2026-08-23 定案 —— 不进 CLI）
  - **配置文件**：默认 `~/.rdsh/config.json`，支持 `--config <path>` 指定（全局参数，`serve`/`user`/`service` 共享；也可用 `RDSH_CONFIG` 环境变量）—— **持久配置的唯一来源**（host/port/session-ttl/TLS 证书/allow_from/auth），零依赖 JSON 解析。**CLI 结构**：`rdsh serve [--config <path>] [--reset]`（常驻主命令，持久参数从 config 读）+ `rdsh user add|passwd|ls|rm` / `rdsh service install|uninstall|status`（管理子命令）+ `--version/--help`（全局）
  - **服务化**：`rdsh service install / uninstall / status` —— 生成 systemd unit（Linux）/ launchd plist（macOS），开机自启 + 崩溃重启；不自带 fork 后台（交系统进程管理器托管 rdsh，连带其 spawn 的 dsh）
- **验收**：云服务器 `rdsh service install` 后常驻；浏览器访问 https → 输密码 → 完整操作 DSH；`allow_from` 限定来源；错误密码限流生效
- **部署用例**（三种，均覆盖）：① rdsh 单独 + 内置 TLS（用户证书）；② apache2 反代 + cron + acme.sh 自动续期；③ nginx 反代
- **配套博客**（✅ 已写，双语）：[02 单独+内置 TLS](../blog/zh/02-01-cloud-single-tls.md) / [03 apache2+cron acme.sh](../blog/zh/02-02-cloud-apache-acme.md) / [04 nginx](../blog/zh/02-03-cloud-nginx.md)
- **相关决策**：安全基线（公网直连 = 必须 TLS + 密码认证，不做明文裸奔）；认证演进（OIDC 登录可作为后续增强，暂不排期）

### M3 公网 hub ✅

- **内容**：rdsh-hub（注册/登录/host 绑定/路由）+ `rdsh join`（出站隧道）+ rdsh-portal（门户页）
- **验收**：异地浏览器登录 hub → 选择 host → 完整操作 DSH；token 吊销即时生效 —— 全部达成
- **进度**：
  - ✅ 层 2 协议冻结 v1（PROTOCOL.md：payload 编码 + E2E 位预留）
  - ✅ 层 1 API 冻结（login/refresh/logout/password/hosts/pending/bind/events/透传）
  - ✅ `rdsh join`（配对码绑定/--token 直填/心跳/指数退避重连）；`rdsh hub serve/user/host/service`
  - ✅ portal（React：登录/host 列表/iframe 进入/改密/绑定/吊销）
  - ✅ 多用户 + host 归属（注册关闭，管理员建号防 bot）；JWT + SHA-256 摘要
  - ✅ 实现期修复：method 透传、流生命周期、pending 限流计数、join findDsh/TLS
- **前提**：层 1（hub 对外 API）与层 2（rdsh-tunnel）契约文档先行（协议先行纪律）
- **相关决策**：Q6（提供 Docker 镜像，主分发 npm 包/单二进制）

### 前置特性：04-cli-refactor + 05-join-easy（2026-08-24 新增，M4 之前）

> 两个非里程碑 feature，排在 M4 之前完成（顺序：**04 → 05 → M4**）。

#### 04-cli-refactor ✅（2026-08-24 完成）

- **内容**：CLI 组件化重构 —— `rdsh host {setup lan|cloud, join, serve, service, leave, user}` + `rdsh hub *`；`~/.rdsh/host.json` 唯一配置（**3 模式 lan/cloud/join**）；`config.json` 自动迁移；**self-revoke 端点**；证书自动检测；服务名对齐（`rdsh-host` / `rdsh-join` / `rdsh-hub`）
- **来源**：`doc/feature/04-cli-refactor/`（discussion/req/solution/plan；plan T1–T6 全 ✅）
- **验收**：命令树正确；host.json 读写/迁移；`setup lan/cloud`、`join` 配置向导；`serve` 按 mode 分发；`leave` 自注销回未配置；证书自动检测；三服务名互不覆盖；hub 命令行为不变 —— 达成（随 05 发布 `rdsh-gateway@0.3.0`）

#### 05-join-easy ✅（2026-08-24 完成并发布）

- **内容**：join 接入体验 —— portal 自助生成**用户级 join token**（30 天默认可配、只显示一次、可吊销、哈希存储）；`rdsh host join <hub>` 交互注册免配对；`rdsh host service install --token/--name`；portal「添加主机」页（生成/复制命令）；**join token 取代 hub 侧配对码 bind**（`pending`/`bind` 端点移除；LAN `serve` 的 pair 认证保留）
- **依赖**：04-cli-refactor（命令树）
- **来源**：`doc/feature/05-join-easy/`（discussion/req/solution/plan；实现完成）
- **验收**：portal 生成 → 机器粘贴 → 注册 → 在线；重启免配；吊销/过期被拒；API key 由 DSH 自管 —— 达成（发布 `rdsh-hub@0.3.0` / `rdsh-gateway@0.3.0` / `remote-dsh@0.5.0` / `rdsh-tunnel@0.1.0`）

### M4 dsh 插件（远程访问）✅（2026-08-23 新增，2026-08-24 实现 + 冒烟通过）

- **背景**：host 侧接入目前需 `npm i -g remote-dsh` + `rdsh serve/join`；DSH 插件生态（Cordis）允许把 gateway 能力做进插件 —— 用户 `dsh plugin add` 即获同能力，免装 CLI
- **内容**：`dsh-*` 插件（npm 包）—— **内嵌 join 核心**（不 spawn，转发到本进程 dsh `127.0.0.1:<port>`）+ 复用 05 已验证的 join 隧道/转发内核；DSH 界面「远程访问」面板（接入/断开/注销 + 实时状态点 + 外部托管只读）；与 CLI 双通道分发
- **验收**：在 dsh 里装插件 → 面板粘贴 hub URL + join token → 接入 → hub 在线；断开/注销可用；无需单独安装 rdsh CLI
- **进度**：`doc/feature/06-dsh-plugin/` 全流程（discussion/req/solution/plan/verification/summary/TODO）；D1–D6 决议、P1–P5 查证、P6（npm org）推迟；**2026-08-24 真实 DSH 冒烟通过**（面板 + 接入 + 断开/注销 + i18n/DSH 主题对齐）；待 npm 发布（gateway 0.4.0 + 插件 0.1.0）
- **相关决策**：插件与 CLI 双通道分发（CLI 保留）；单身份铁律（host.json 唯一 + pid 锁防双隧道）；MVP 面板四态 + 外部托管只读；RPC 走 `connection.rpc`（非 `/api` 内置契约）

### M5 多租户增强 ⏳

- **内容**：邮箱验证、2FA（TOTP 或 passkey）、共享授权（owner/member）、审计日志、登录风控
- **验收**：安全加固项逐条过验收

### M6 上线准备 ⏳

- **内容**：域名 ICP 备案、隐私政策、部署文档、压测（含 300 MB 大流量压测，M1 遗留项）
- **验收**：达到公开服务标准

### M7 hub Go 化 + E2E ⏳

- **内容**：rdsh-hub 用 Go 重写（单二进制，go:embed portal）+ TS↔Go conformance 测试；公共 SaaS 化时实现 E2E（帧格式加密位已预留）
- **验收**：单二进制部署；互操作测试通过；E2E 需求评审

### M8 移动端 App ⏳

- **内容**：rdsh-app（Flutter + WebView 壳）
- **验收**：App 登录后可访问 host 的 DSH
- **相关决策**：Q7（首版纯 WebView 壳，验收须含剪贴板/输入法验证）

### M9 微信小程序 ⏳

- **内容**：rdsh-weapp（原生小程序）—— host 列表、会话读写、wss 直连 hub 对外 API（层 1）
- **验收**：小程序登录后可访问 host 的 DSH 轻量操作
- **前置条件**：hub 对外 API（层 1）契约已冻结（依赖 M3）；hub 域名 **ICP 备案** + 小程序后台配置 wss 合法域名（备案周期长，可提前并行启动）
- **约束**：Flutter 不可用于小程序（平台硬约束）；原生实现最稳、审核风险最低
- **相关决策**：Q3（小程序后置）

## 当前焦点（M4 已实现，待发布）

1. **M4 dsh 插件（远程访问 `dsh-web-remote`）**：已实现 + 真实 DSH 冒烟通过（2026-08-24）；待 **npm 发布** `rdsh-gateway@0.4.0` + `dsh-web-remote@0.1.0`（覆盖 0.0.0 占位，用户终端 + passkey）
2. **已发布**（2026-08-24）：`rdsh-hub@0.3.0` / `rdsh-gateway@0.3.0` / `remote-dsh@0.5.0` / `rdsh-tunnel@0.1.0`（04/05 落地）
3. **命名**：M4 插件名 `dsh-web-remote`（已实现，公开）；npm org 锁 scope（P6）推迟到将来
4. **待办**：远程验证（阿里云 host 升级 `remote-dsh@0.5.0` + 重装服务）；join 孤儿 dsh 兜底；300 MB 压测（可并入 M7）

## 变更记录

| 日期 | 变更 |
|---|---|
| 2026-08-23 | 创建；M1 状态更新（代码完成、polyfill/SIGHUP 修复、待双设备验收） |
| 2026-08-23 | **M1 验收通过**：双设备实测 OK；新增 `--no-code`；四个运行时问题修复；单测 33/33、端到端 14/14 |
| 2026-08-23 | **里程碑重排**：新增 M2 云服务器直连（TLS + headless + IP 白名单）；原 M2 起全部顺延（hub→M3，多租户→M4，App→M5，上线→M6，Go+E2E→M7，小程序→M8） |
| 2026-08-23 | **M2 验收通过**：单测 57/57 + M2 e2e 43/43 + M1 回归 14/14；修订去自动自签（无证书即 http，password 无证书非反代拒绝启动）；修复 CLI 管道输入/config watch/dsh 回收 |
| 2026-08-23 | **M3 验收通过**：层 1/层 2 契约冻结 + join 隧道 + hub + portal；单测 92/92 + M3 e2e 23/23 + M1/M2 回归 57；修复 method 透传/流生命周期/限流计数 |
| 2026-08-23 | **里程碑重排**：新增 M4 dsh-plugin-rdsh（DSH 插件形态的 gateway，免装 CLI，复用 M3 能力）；原 M4 起全部顺延（多租户→M5，App→M6，上线→M7，Go+E2E→M8，小程序→M9） |
| 2026-08-23 | **里程碑重排**：移动端 App 移至 hub Go 化之后（M8）—— 纯 npm 包配合浏览器访问 hub URL 已够用，App 后置；序列：M6 上线准备 → M7 hub Go 化 → M8 移动端 App → M9 小程序 |
| 2026-08-24 | **新增前置特性 04/05（M4 之前）**：04-cli-refactor（CLI 组件化 `rdsh host *` + host.json 3 模式 + self-revoke + 自动迁移 + 证书自动检测）与 05-join-easy（用户级 join token + `host join` 交互注册免配对 + portal「添加主机」页）；discussion/req 已定（待批准）；发布收尾（hub 0.2.4 / gateway 0.2.3 / cli 0.4.9 待发） |
| 2026-08-24 | **04/05 完成并发布**：`rdsh-hub@0.3.0` / `rdsh-gateway@0.3.0` / `remote-dsh@0.5.0` / `rdsh-tunnel@0.1.0`；join token 取代 hub 侧配对码 bind（`pending`/`bind` 移除）；**M4（06-dsh-plugin）规划定稿**：discussion ✅ / req ✅（已批准）/ solution 待批准，命名已定稿（实现前不公开全名），P6（npm org）推迟 |
| 2026-08-24 | **M4（06-dsh-plugin）实现 + 冒烟通过**：gateway `startJoin`（no-spawn/可停止/onState/onLog）+ pid 锁 `lock.ts`（gateway 0.4.0）；插件包 `dsh-web-remote`（server 半 `connection.rpc` + client 半 React 面板，i18n/DSH 设计令牌）；真实 DSH 冒烟通过（面板 + 接入 hub.unicgames.com + 断开/注销）；待 npm 发布 gateway 0.4.0 + 插件 0.1.0 |

*关联文档：proposal.md | doc/overview/architecture.md | doc/feature/01-remote-access/*
