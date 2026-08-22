# 02-cloud-server — 需求讨论记录（discussion.md）

> **日期**: 2026-08-23
> **状态**: 讨论记录（req.md 定稿后转为 READ-ONLY）
> **来源**: 2026-08-23 需求讨论 + `doc/overview/roadmap.md` M2 + `doc/overview/architecture.md` 部署场景

---

## 1. 背景

`rdsh serve` 已可跑在云服务器（阿里云等租用实例）上（M1 能力），但公网直连有三类缺口：

1. **明文 http**：公网直连无 TLS，认证凭证/会话可被嗅探；
2. **headless 认证体验差**：配对码依赖"人在终端前"，云服务器无人值守（ssh 查看/预置码均为别扭补丁）；
3. **无服务化**：无法开机自启/崩溃重启，云服务器重启后服务丢失。

## 2. 决策历程（2026-08-23 定案）

| # | 决策点 | 结论 |
|---|---|---|
| C1 | M2 范围 | **云服务器直连**：TLS + user/pass 认证 + 配置文件 + 服务化；原"公网 hub"顺延 M3（roadmap 重排） |
| C2 | 认证方案 | **用户名 + 密码**（headless HTTPS 主认证）；配对码保留为 LAN 模式；`--no-code` 语义升级为 config `auth.mode: none` |
| C3 | 密码存储 | scrypt 哈希（每用户独立盐），存 config.json；**改密 = 轮换会话密钥，全部旧会话立即失效** |
| C4 | 认证与传输 | 密码认证必须配合 TLS —— 明文 http 下禁 password 模式（或强警告） |
| C5 | 配置边界 | **持久配置一律进 config.json**（host/port/session-ttl/TLS/allow_from/auth）；CLI 只保留 `serve`（+`--config`/`--reset`）、`user`、`service`、`--version/--help` |
| C6 | 配置文件路径 | 默认 `~/.rdsh/config.json`；`--config <path>` 全局参数 + `RDSH_CONFIG` 环境变量；serve/user/service 共享 |
| C7 | IP 白名单 | config `allow_from`（CIDR 列表），不进 CLI |
| C8 | 服务化 | `rdsh service install/uninstall/status`：systemd unit（Linux）/ launchd plist（macOS）；用户级无需 sudo；开机自启 + 崩溃重启；**不自带 fork 后台**（交系统进程管理器托管 rdsh，连带 spawn 的 dsh） |
| C9 | 登录页 | password 模式下 Web 登录页（user/pass）替代配对页；提供改密入口（可选） |

## 3. 事实依据

- DSH 无内置 daemon/service 命令（查档：CLI 仅 web/plugin/--profile）；dsh web 是普通长驻进程，可被任意进程管理器托管（`architecture.md` 部署场景）。
- 用户已确认：配对码在 headless 场景体验差（2026-08-23），接受 user/pass。
- 0.2.0 已发布（M1 完整实现），M2 在其上增量。

## 4. 开放问题（留 solution 定稿）

- 自签证书生成方式（内置生成 vs 提示外部工具 openssl）与浏览器信任引导。
- password 模式下 `pair`/`none` 是否仍可切换（config `auth.mode` 已支持三值）。
- 登录失败限流参数（复用 M1 框架：5 次/10 分钟？）。
- systemd/launchd unit 模板细节。

*关联文档：roadmap.md（M2）| architecture.md（部署场景）| 下一步：req.md*
