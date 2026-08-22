# 02-cloud-server — 需求（req.md）

> **日期**: 2026-08-23
> **状态**: 草稿，**待用户批准**
> **范围**: M2 —— 云服务器直连（headless HTTPS：TLS + user/pass + 配置文件 + 服务化）
> **来源**: [discussion.md](discussion.md), `doc/overview/roadmap.md`（M2）

---

## 1. 目标

把 `rdsh serve` 从"局域网工具"升级为"**云服务器可用的常驻服务**"：租用的云服务器（阿里云等）上配置一次（TLS + 用户 + 配置文件），`rdsh service install` 后常驻运行；用户从公网浏览器经 **HTTPS** 用**用户名 + 密码**登录，完整操作 DSH。headless 场景不再依赖配对码/终端。

## 2. 范围

### 2.1 包含（In Scope）

| 编号 | 需求 | 验收标准 |
|---|---|---|
| R1 | **HTTPS（TLS 1.3）**：网关支持 TLS（config `tls.cert`/`tls.key`）；无 TLS 配置时保持现状（http，仅允许 pair/none 模式） | `tls` 配置后访问为 https；未配置时行为与 M1 一致 |
| R2 | **自签证书快速可用**：无证书时 `rdsh serve` 可自动生成自签证书（提示浏览器信任） | 无证书配置也能以 https 启动；启动日志提示证书来源 |
| R3 | **用户名 + 密码认证**（config `auth.mode: password`）：scrypt 哈希（每用户独立盐）存 config；浏览器登录页输 user/pass → 签发会话 Cookie（复用 M1 机制） | 登录成功进入 DSH；错误密码拒绝；`auth.mode` 三值（pair/password/none）切换生效 |
| R4 | **改密 = 全部旧会话失效**：`rdsh user passwd` 后轮换会话密钥，已登录设备全部掉线 | 改密后旧 Cookie 访问被拒（307 登录页），新密码可登录 |
| R5 | **登录失败限流**：复用 M1 限流框架（按 IP，超阈值锁定） | 连续失败达阈值后锁定并返回 429；锁定期间即使密码正确也拒绝 |
| R6 | **配置文件**：默认 `~/.rdsh/config.json`；`--config <path>`（全局）+ `$RDSH_CONFIG`；serve/user/service 共享同一 config | `--config /tmp/x.json` 后所有子命令读该文件；缺失时用默认值 |
| R7 | **用户管理 CLI**：`rdsh user add <name>` / `passwd <name>` / `ls` / `rm <name>`（交互设密码，scrypt 哈希） | 四命令可用；config 中 users 正确读写；`rm` 后该用户无法登录 |
| R8 | **IP 白名单**（config `allow_from`，CIDR 列表）：请求来源不在白名单 → 拒绝（403） | 配置后白名单外 IP 全部被拒；CIDR 格式（含 IPv4 前缀）正确解析 |
| R9 | **服务化**：`rdsh service install / uninstall / status` —— systemd unit（Linux）/ launchd plist（macOS）；用户级安装无需 sudo；开机自启 + 崩溃重启（`Restart=on-failure`） | install 后服务注册并可 start；status 反映运行态；uninstall 移除；重启机器后服务自启 |
| R10 | **登录页**（password 模式）：user/pass 表单替换配对页；错误提示/限流提示；可选改密入口 | 无会话访问 → 登录页（非配对页）；登录成功 → DSH |
| R11 | **安全基线**：密码/哈希不明文落盘；日志不记录密码/Cookie；`password` 模式在无 TLS 时拒绝启动（或强警告）；config 文件权限 600 | 代码审查 + 测试；无 TLS + password 模式无法启动或显著警告 |
| R12 | **兼容**：pair 模式行为与 M1 完全一致（0.2.0 回归）；`--no-code` CLI flag 保留（等价 `auth.mode: none`） | M1 端到端验收（14/14）回归通过 |

### 2.2 不含（Out of Scope）

- ❌ 公网 hub / `rdsh join`（M3）
- ❌ 多租户/账号体系/角色（M4）
- ❌ OIDC 登录（后续可选，不排期）
- ❌ 移动端/小程序（M5/M8）
- ❌ 反向代理集成（用户可选：本网关内置 TLS 已够用）

## 3. 端到端验收场景

> **场景**：阿里云 ECS（Ubuntu，headless）。
> 1. `npm i -g remote-dsh` → `rdsh user add admin`（设密码）→ 编辑 config（tls/allow_from 可选）→ `rdsh service install`。
> 2. 公网浏览器访问 `https://<ECS公网IP>:8443` → 证书信任（自签）→ 登录页 → 输 admin/密码 → 进入 DSH 完整操作（对话/工具/文件）。
> 3. 错误密码 5 次 → 429 锁定；白名单外 IP → 403。
> 4. `rdsh user passwd admin` → 已登录设备立即掉线（需新密码重登）。
> 5. `sudo reboot` → 服务自动恢复（开机自启），无需人工介入。
> 6. 无 TLS 配置时：`auth.mode: password` 拒绝启动（或强警告）；pair 模式行为与 M1 一致。

## 4. 验收执行方式

- 自动化：`node --test`（哈希/改密失效/限流/白名单 CIDR/config 解析/登录页路由）
- 手工：上述端到端场景（真实云服务器或本机模拟 https + curl）
- 回归：M1 端到端（14/14）全量重跑
- 文档：`verification.md` 逐条对照 R1–R12 + RTTM

## 5. 待定项（留给 solution.md，不阻塞 req 批准）

- 自签证书实现（内置生成 vs openssl 调用；有效期）
- 无 TLS + password 模式的处置（拒绝启动 vs 强警告）
- 登录限流参数（复用 5 次/10 分钟？）
- systemd/launchd 模板细节（用户级路径、环境变量传递）

*关联文档：discussion.md | roadmap.md（M2）| 下一步：solution.md（待 req 批准后）*
