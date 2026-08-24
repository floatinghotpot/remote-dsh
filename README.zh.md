# remote-dsh

[English](README.md) | **中文**

让 DeepSeek Harness 随时随地可用。

![rdsh logo](media/rdsh256.png)

## 摘要

**remote-dsh** 在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）之上构建一层安全远程访问：
本机照常 `dsh web`，之后用任意设备 —— 同局域网的笔记本/手机，以及（配合 hub）公网任意位置 —— 都能操作这台机器上的 DSH。

## 架构

```
        客户端（浏览器 / App / 小程序）
                    │
                    │  HTTPS/WSS —— 层1：hub 对外 API
                    ▼
                rdsh-hub
                    │
                    │  WSS 隧道 —— 层2：rdsh-tunnel
                    ▼
             rdsh-gateway
                    │
                    │  HTTP（loopback）
                    ▼
           dsh web (127.0.0.1)
```

两个协议层：**层 1**（hub 对外 API，JSON over HTTPS + WSS 事件）是客户端实现的唯一契约；
**层 2**（rdsh-tunnel）只在 hub 与 gateway 之间运行，客户端从不实现。

## 组件

| 组件 | 名称 | 职责 |
|---|---|---|
| CLI | `rdsh` | `rdsh serve`（局域网）/ `rdsh join <hub>`（公网）/ `rdsh hub ...` |
| 服务器 | rdsh-hub | 控制面（认证、host 注册、路由）+ 数据面（隧道汇聚转发） |
| 开发机侧 | rdsh-gateway | 局域网认证网关 / 公网出站隧道端点；spawn `dsh web` |
| 隧道协议 | rdsh-tunnel | 线协议：帧复用、心跳、背压 |
| 门户 | rdsh-portal | 网页登录 + host 列表（Vite + React） |
| 手机 App | rdsh-app | Flutter（Android/iOS） |
| 微信小程序 | rdsh-weapp | 轻量客户端 |

## 状态

**M1–M3 完成**（2026-08-23）：局域网网关（`rdsh host serve`）、云服务器直连（TLS + 密码）、公网 hub（`rdsh host join` + `rdsh hub` + portal）均已实现并验收（单测 92/92，M3 e2e 23/23，M1/M2 回归 57）。下一里程碑：**M4 dsh-plugin-rdsh**（DSH 插件形态的网关/join，免装 CLI）。

## 功能清单

已实现 `[x]` · 规划中 `[ ]` —— 用户视角

**M1 — 在局域网任意设备上使用 DSH（已实现）**
- [x] 另一台笔记本/手机浏览器直接打开你的 DSH —— 无需 SSH、无需配置
- [x] 安全配对：在开发机终端看一眼配对码，输入一次即可
- [x] 无需账号 —— 配对码就是钥匙
- [x] 完整 DSH 体验：对话、跑工具、浏览文件、实时事件流
- [x] 登录态保持 12 小时 —— 同一设备不用重复配对
- [x] 未配对设备一律进不来（锁定在配对页）
- [x] 一条命令启动：`npm i -g remote-dsh && rdsh serve`
- [x] 可选 `--no-code`（完全可信的网络可跳过配对）
- [x] 干净退出（Ctrl+C / 关终端）—— 不留任何残留进程

**M2 — 部署到租用的云服务器（如阿里云）（已实现）**
- [x] HTTPS（TLS）—— 公网安全直连（用户自备证书）
- [x] 部署在 apache2 / nginx 反代后面（反代终止 TLS；标准 443 端口 + 证书自动续期）
- [x] 用户名 + 密码登录（`rdsh user add/passwd`；scrypt 哈希；改密后全部会话失效）
- [x] IP 白名单（配置文件 `allowFrom` 字段）加固
- [x] 配置文件（默认 `~/.rdsh/config.json`，可用 `--config <path>` 或 `$RDSH_CONFIG` 指定）
- [x] 作为系统服务运行（systemd / launchd —— 开机自启）

**M3 — 经 hub 随时随地使用 DSH（已实现）**
- [x] 从公网访问你的任意机器 —— 无需公网 IP、无需路由器设置（`rdsh join` 出站隧道）
- [x] 一个账号管理多台机器（host 归属账号；注册关闭，管理员建号防 bot）
- [x] 网页门户：登录 / host 列表 / 进入 DSH / 改密 / 吊销（React）
- [x] 配对码绑定（`rdsh join` 打印码 → 门户输码）或 `--token` 脚本化直填
- [x] 吊销即时生效 —— host token 吊销后隧道立即断开、重连被拒
- [x] 层 2 线协议（`packages/tunnel/PROTOCOL.md`）与层 1 对外 API 冻结
- [x] hub 支持内置 TLS，或部署在 apache2 / nginx 后面（443 + 证书自动续期）

**M4+ — 规划中**
- [ ] 以 DSH 插件使用：`dsh plugin add` 一个插件即获远程访问能力，免装 CLI
- [ ] 手机 App（Android / iOS）
- [ ] 微信小程序
- [ ] 与团队成员共享一台机器
- [ ] 端到端加密会话

## 快速开始

```bash
npm install -g remote-dsh   # 与 dsh 一起安装；命令是 rdsh
rdsh host setup lan         # 配置本机为局域网认证网关
rdsh host serve             # 前台运行（自动拉起 dsh web）
rdsh host join <hub-url>    # 或接入 hub（出站隧道）
```

同网络下另一台笔记本浏览器打开 `http://<你的IP>:<端口>`，输入终端显示的配对码即可使用。

## 博客

场景化教程，从简单到复杂 — 完整索引：[中文](doc/blog/README.zh.md) · [English](doc/blog/README.md)

- [在家/办公室用任意设备遥控开发机的 DSH（局域网配对码）](doc/blog/zh/01-01-lan-access.md)
- [把 DSH 搬上云服务器：HTTPS + 密码直连（证书自备）](doc/blog/zh/02-01-cloud-single-tls.md)
- [无法 IP 直连？通过 hub 服务转发、一个账号管理多个主机（推荐）](doc/blog/zh/03-04-join-token.md)
- [搭建你自己的 hub 转发服务：apache2（443 + 证书自动续期）](doc/blog/zh/03-02-hub-behind-apache-https.md)

## 开发

- Node.js ≥ 22（见 `.nvmrc`）、pnpm ≥ 9
- TypeScript monorepo（`packages/*`）、Flutter App（`apps/app`）、微信小程序（`apps/weapp`）、未来 Go hub（`go/`）
- 贡献指南见 [CONTRIBUTING.md](CONTRIBUTING.md)，内部文档见 `doc/`

## 许可证

MIT —— 见 [LICENSE](LICENSE)。品牌资产（logo、名称）不在 MIT 授权范围内 —— 见 [NOTICE](NOTICE)。
