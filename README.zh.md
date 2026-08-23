# remote-dsh

[English](README.md) | **中文**

让 DeepSeek Harness 随时随地可用。

![rdsh logo](media/rdsh256.png)

**remote-dsh** 在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）之上构建一层安全远程访问：
本机照常 `dsh web`，之后用任意设备 —— 同局域网的笔记本/手机，以及（配合 hub）公网任意位置 —— 都能操作这台机器上的 DSH。

## 状态

**M1–M3 完成**（2026-08-23）：局域网网关（`rdsh serve`）、云服务器直连（TLS + 密码）、公网 hub（`rdsh join` + `rdsh hub` + portal）均已实现并验收（单测 92/92，M3 e2e 23/23，M1/M2 回归 57）。下一里程碑：M4 多租户增强。
需求管线见 [doc/feature/](doc/feature/)，路线图见 [doc/overview/roadmap.md](doc/overview/roadmap.md)，完整产品提案见 [doc/overview/proposal.md](doc/overview/proposal.md)。

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

**M4+ — 规划中**
- [ ] 手机 App（Android / iOS）
- [ ] 微信小程序
- [ ] 与团队成员共享一台机器
- [ ] 端到端加密会话

## 快速开始

```bash
npm install -g remote-dsh   # 与 dsh 一起安装；命令是 rdsh
rdsh serve                 # 启动局域网认证网关（自动拉起 dsh web）
```

同网络下另一台笔记本浏览器打开 `http://<你的IP>:<端口>`，输入终端显示的配对码即可使用。

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

## 博客

场景化教程（中文 → [doc/blog/zh/](doc/blog/zh/)，English → [doc/blog/en/](doc/blog/en/)）：

- 通过内网 IP，访问另一台主机上的 DSH（局域网模式）：
  - [在家或办公室，用手机/笔记本/台式机遥控开发机的 DSH 智能体（局域网篇）](doc/blog/zh/01-01-lan-access.md)
  - [出差在外也能访问家里的 DSH：VPN 连回局域网，配对码照用](doc/blog/zh/01-02-vpn-lan.md)
- 通过公网 IP 或域名，远程访问云服务器中的 DSH（云服务器模式）：
  - [把 DSH 智能体搬到云服务器：浏览器输密码就能遥控（证书自备）](doc/blog/zh/02-01-cloud-single-tls.md)
  - [DSH 智能体的 HTTPS 交给 apache2：正式域名 + 证书全自动续期](doc/blog/zh/02-02-cloud-apache-acme.md)
  - [用 nginx 给 DSH 智能体套 HTTPS：443 共端口、证书自动续期](doc/blog/zh/02-03-cloud-nginx.md)
- 无公网 IP 远程操控多个主机 DSH（服务器转发模式）：
  - [没有公网 IP，也能从任何地方远程访问所有 DSH 智能体](doc/blog/zh/03-01-hub-public.md)
  - [虚拟机里的 DSH 智能体也能远程访问：不用改网络，一条 rdsh join 搞定](doc/blog/zh/03-02-vm-ubuntu.md)
  - [从任何地方远程访问嵌入式 Linux（树莓派）上的 DSH 智能体（构想，未实测）](doc/blog/zh/03-03-embed-linux.md)

## 开发

- Node.js ≥ 22（见 `.nvmrc`）、pnpm ≥ 9
- TypeScript monorepo（`packages/*`）、Flutter App（`apps/app`）、微信小程序（`apps/weapp`）、未来 Go hub（`go/`）
- 贡献指南见 [CONTRIBUTING.md](CONTRIBUTING.md)，内部文档见 `doc/`

## 维护者

- [Liming Xie](https://github.com/floatinghotpot) — liming.xie@gmail.com

## 许可证

MIT —— 见 [LICENSE](LICENSE)。品牌资产（logo、名称）不在 MIT 授权范围内 —— 见 [NOTICE](NOTICE)。
