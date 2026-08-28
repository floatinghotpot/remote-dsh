# 功能清单（features）

[English](features.md) | **中文**

> **日期**: 2026-08-29
> **性质**: 用户视角的功能目录 —— 已实现 `[x]` · 规划中 `[ ]`。里程碑进度、决策与验收见 [roadmap.md](roadmap.md)；安装/配置/操作见 [usage.md](usage.md)。

## 功能清单

**M1 — 在局域网任意设备上使用 DSH（已实现）**
- [x] 另一台笔记本/手机浏览器直接打开你的 DSH —— 无需 SSH、无需配置
- [x] 安全配对：在开发机终端看一眼配对码，输入一次即可
- [x] 无需账号 —— 配对码就是钥匙
- [x] 完整 DSH 体验：对话、跑工具、浏览文件、实时事件流
- [x] 登录态保持 12 小时 —— 同一设备不用重复配对
- [x] 未配对设备一律进不来（锁定在配对页）
- [x] 三步启动：`npm i -g remote-dsh` → `rdsh host setup lan` → `rdsh host serve`
- [x] 可选免认证（`auth.mode: "none"`，仅完全可信网络）
- [x] 干净退出（Ctrl+C / 关终端）—— 不留任何残留进程

**M2 — 部署到租用的云服务器（如阿里云）（已实现）**
- [x] HTTPS（TLS）—— 公网安全直连（用户自备证书）
- [x] 部署在 apache2 / nginx 反代后面（反代终止 TLS；标准 443 端口 + 证书自动续期）
- [x] 用户名 + 密码登录（`rdsh host user add/passwd`；scrypt 哈希；改密后全部会话失效）
- [x] IP 白名单（配置文件 `allowFrom` 字段）加固
- [x] 配置文件（默认 `~/.rdsh/host.json`，可用 `--config <path>` 或 `$RDSH_CONFIG` 指定）
- [x] 作为系统服务运行（systemd / launchd —— 开机自启）

**M3 — 经 hub 随时随地使用 DSH（已实现）**
- [x] 从公网访问你的任意机器 —— 无需公网 IP、无需路由器设置（`rdsh host join` 出站隧道）
- [x] 一个账号管理多台机器（host 归属账号；注册关闭，管理员建号防 bot）
- [x] 网页门户：登录 / host 列表 / 进入 DSH / 改密 / 吊销（React）
- [x] 加入流程（`rdsh host join <hub>` 交互粘贴 token，或 `--token` 脚本化直填）
- [x] 吊销即时生效 —— host token 吊销后隧道立即断开、重连被拒
- [x] 层 2 线协议（`packages/tunnel/PROTOCOL.md`）与层 1 对外 API 冻结
- [x] hub 支持内置 TLS，或部署在 apache2 / nginx 后面（443 + 证书自动续期）

**M4 — 以 DSH 插件使用（已实现）**
- [x] `dsh plugin add dsh-web-remote` 即获远程访问能力，免装 CLI —— DSH 界面「远程访问」面板：接入 / 断开 / 注销 + 实时状态

**M5 — 多租户增强（已实现）**
- [x] 邮箱验证 + 找回密码（可配置 SMTP / 阿里云 DirectMail / 本地 log）
- [x] 两步验证（TOTP）
- [x] 与团队成员共享一台机器（owner / member，member 可进 DSH 但不可管理）
- [x] 审计日志（`rdsh hub audit ls`）
- [x] 登录风控（账户锁定 10 次/15 分钟 + 发信限流 + 算术验证码防 bot）

**E2EE — 端到端加密（已实现，社区 + SaaS 通用）**
- [x] hub 中转你的 DSH 流量但**读不到内容**（prompt / 代码 / 文件 / API key 全程密文）
- [x] Noise NK 握手（X25519 + AES-256-GCM），会话密钥每连接轮换，前向保密
- [x] 浏览器首次信任 host 指纹（TOFU），指纹变更告警；pin 仅存本地、绝不上 hub
- [x] hub 三档开关 `e2ee.mode: off|optional|required`（默认 optional），老 host 明文降级兼容

**M6+ — 规划中**
- [ ] 商业化托管 hub（SaaS：开放注册、订阅计费、微信/支付宝支付）
- [ ] 手机 App（Android / iOS）
- [ ] 微信小程序
