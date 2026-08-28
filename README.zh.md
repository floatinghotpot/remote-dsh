# remote-dsh

[English](README.md) | **中文**

**remote-dsh 让您把 DeepSeek Harness（DSH）变成「任何地方浏览器即用」的 AI 智能体 —— 免公网 IP、免装客户端。**

![rdsh logo](media/rdsh256.png)

## 为什么选择 remote-dsh

- **浏览器即用**：免公网 IP、免装客户端，开浏览器就能指挥智能体；
- **双通道接入**：DSH 插件（`dsh-web-remote`）一键接入，或 CLI（`remote-dsh`）灵活自控；
- **开源可信**：MIT 开源、协议冻结（gateway 永不需改动），可自托管、可被集成。

## 使用场景

### ① 快速上手（rdsh Hub 云转发）
- **适合**：大多数用户，想最快用上 —— 不用自己搭 Hub、不用公网 IP，在自己机器上装个 DSH 插件即可；
- **需要**：一个 rdsh 账号 + DSH 插件 `dsh-web-remote`；
- **效果**：任何地方（电脑 / 手机 / 微信内浏览器）登录即用。

```bash
dsh plugin add dsh-web-remote   # 在 DSH 里装插件，面板粘贴 hub 地址 + join token
# 或走 CLI：
npm install -g remote-dsh
rdsh host join <hub-url>        # 出站隧道接入 hub
```

### ② 专业直连（免 Hub）
- **局域网**：机器与你在同一网络，`rdsh host serve` 配对后按 IP 直连；
- **云服务器**：有公网 IP / 域名的云主机，`rdsh host serve` + TLS 密码认证直连；
- **适合**：想保留完全控制、不经过任何第三方 Hub 的技术用户。

```bash
npm install -g remote-dsh
rdsh host setup lan             # 或 setup cloud（云服务器，需 --tls-cert/--tls-key）
rdsh host serve                 # 前台运行（自动拉起 dsh web）
# 同网络浏览器打开 http://<IP>:<port>，输终端显示的配对码
```

### ③ 企业自建（自托管 Hub · 完全自控）
- **自托管 Hub**：在自有机器或云主机上运行 `rdsh hub serve`，多用户 / 审计 / 共享；
- **适合**：团队 / 企业，要统一账号、审计、数据自持。

```bash
npm install -g remote-dsh
rdsh hub serve                  # 自建 hub（内置 TLS 或反代部署）
# 成员经 ①（插件）或 `rdsh host join <你的hub>` 接入
```

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
| CLI | `rdsh` | `rdsh host serve`（局域网）/ `rdsh host join <hub>`（公网）/ `rdsh hub ...` |
| 服务器 | rdsh-hub | 控制面（认证、host 注册、路由）+ 数据面（隧道汇聚转发） |
| 开发机侧 | rdsh-gateway | 局域网认证网关 / 公网出站隧道端点；spawn `dsh web` |
| 隧道协议 | rdsh-tunnel | 线协议：帧复用、心跳、背压 |
| 门户 | rdsh-portal | 网页登录 + host 列表（Vite + React） |
| DSH 插件 | dsh-web-remote | DSH 界面内的远程访问面板（免装 CLI） |
| 手机 App | rdsh-app | Flutter（Android/iOS） |
| 微信小程序 | rdsh-weapp | 轻量客户端 |

## 能力与状态

**当前状态**：M1–M5 已完成并验收；**端到端加密（E2EE）已完成**（社区 + SaaS 通用）。完整功能清单见 [features.zh.md](doc/overview/features.zh.md)；里程碑与路线图见 [roadmap](doc/overview/roadmap.md)。

**核心能力**：
- **三模式接入**：局域网直连 / 云服务器直连（TLS + 密码）/ 公网 hub 转发（出站隧道）
- **端到端加密**：hub 中转你的 DSH 流量但**读不到内容**（prompt / 代码 / 文件 / API key 全程密文）——Noise NK 握手（X25519 + AES-256-GCM）、会话密钥每连接轮换、浏览器 TOFU 指纹信任、pin 仅存本地
- **多租户与安全**：邮箱验证 + 2FA、共享授权（owner/member）、审计日志、登录风控（锁定 + 限流）、IP 白名单
- **双通道分发**：`dsh-web-remote` 插件（免装 CLI）或 `remote-dsh` CLI；`rdsh hub` 支持内置 TLS 或反代部署

**规划中**：SaaS 商业化托管 hub、手机 App（Android/iOS）、微信小程序。

## 博客

场景化教程，从简单到复杂 — 完整索引：[中文](doc/blog/README.zh.md) · [English](doc/blog/README.md)

- [在家/办公室用任意设备遥控开发机的 DSH（局域网配对码）](doc/blog/zh/01-01-lan-access.md)
- [把 DSH 搬上云服务器：HTTPS + 密码直连（证书自备）](doc/blog/zh/02-01-cloud-single-tls.md)
- [无法 IP 直连？通过 hub 服务转发、一个账号管理多个主机（推荐）](doc/blog/zh/03-04-join-token.md)
- [不想装 CLI？给 DSH 装插件，界面里点一下就远程访问](doc/blog/zh/03-05-plugin.md)
- [搭建你自己的 hub 转发服务：hub + apache2（443 + 证书自动续期）](doc/blog/zh/03-02-hub-behind-apache-https.md)

## 开发

- Node.js ≥ 22（见 `.nvmrc`）、pnpm ≥ 9
- TypeScript monorepo（`packages/*`）、Flutter App（`apps/app`）、微信小程序（`apps/weapp`）、未来 Go hub（`go/`）
- 贡献指南见 [CONTRIBUTING.md](CONTRIBUTING.md)，内部文档见 `doc/`

## 许可证

MIT —— 见 [LICENSE](LICENSE)。品牌资产（logo、名称）不在 MIT 授权范围内 —— 见 [NOTICE](NOTICE)。
