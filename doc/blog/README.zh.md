# 场景化教程，按使用场景索引

> 完整索引：[中文](zh/) · [English](en/)。所有教程中英双语。
> 先想清楚一个问题：**你的 DSH 跑在哪台机器上、你打算从哪儿访问它？** 然后照着对应的路线走，从简单到复杂。

---

## 1. 从零开始：让 DSH 随处可用

先试自家网络内的直连；没有公网 IP？用 **rdsh 云 hub（https://rdsh.cn）** 转发——注册一次账号，然后选一种机器接入方式：

> **不知道怎么选？最省事的一条路**：电脑上**已经在跑 DSH 网页版** → 直接走 [插件接入](zh/01-05-plugin-mode.md)（先[注册账号](zh/01-03-rdsh-account.md) → 再按[接入令牌](zh/01-04-join-token.md)拿令牌 → 装插件，三步搞定）；连 DSH 网页版都还没装的，就从[注册账号](zh/01-03-rdsh-account.md)开始，装好 DSH 再回来。

- **同一网络、免 hub**——同一 WiFi 下任意设备浏览器打开 `http://<开发机IP>:8443`，输一次终端显示的配对码即可 —— [局域网 IP 直连（配对码）](zh/01-01-lan-access.md)；出差在外先 VPN 回内网 —— [VPN 回连局域网](zh/01-02-vpn-lan.md)。
- **没有公网 IP？用 rdsh 云 hub（推荐）**——机器只**出站**连 hub（不开任何端口），你从任何地方都能访问它：
  - [注册 rdsh.cn 账号](zh/01-03-rdsh-account.md)（邮箱验证，可开 2FA）；
  - [获取 join token](zh/01-04-join-token.md)——portal 生成一次，之后用它把机器接进来；
  - 然后每台机器三选一接入方式：
    - **插件模式**：DSH 界面内「远程访问」面板——免 CLI、免服务 —— [装 dsh-web-remote 插件](zh/01-05-plugin-mode.md)；
    - **CLI 模式**：`rdsh host join` + `rdsh host serve` 前台运行 —— [CLI 模式接入](zh/01-06-cli-mode.md)；
    - **系统服务模式**：一条命令装好常驻、开机自启的服务，按平台分篇：[Linux（systemd，已实测）](zh/01-07-host-service-mode-linux.md) · [macOS（launchd：登录后自启 + 崩溃自愈；完全无人值守需系统级 LaunchDaemon，尚未提供——另需待新版 ≥ 0.10.1）](zh/01-07-host-service-mode-mac.md) · [Windows（当前受限：走 WSL2 路线）](zh/01-07-host-service-mode-windows.md)。
- **团队与安全**：两步验证（2FA）、找回密码、主机共享、审计日志 —— [账号安全与团队共享](zh/01-08-account-security.md)。

## 2. 把 DSH 搬上云服务器：HTTPS + 密码直连（证书自备）

DSH 跑在阿里云 ECS 这类有公网 IP 的机器上，你想在任何地方用浏览器登录访问（用户名 + 密码）。三种方案按口味选：

- **最简单**：rdsh 自己持证书、一个端口直连，不需要 nginx/apache —— [云服务器直连（内置 TLS）](zh/02-01-cloud-single-tls.md)
- **想要标准 443 + 证书全自动续期**，把 HTTPS 交给反代：[apache2](zh/02-02-cloud-apache-acme.md) 或 [nginx](zh/02-03-cloud-nginx.md)

## 3. 搭建你自己的 hub 转发服务

想自己搭一个 hub 给团队/自用？三条部署路线 + 用户管理。§1 的机器侧教程对**任何 hub** 都适用——把命令里的 `https://rdsh.cn` 换成你的 hub 地址即可：

- [在 ECS 部署 hub（内置 TLS，最快）](zh/03-01-hub-public.md)
- [hub 放 apache2 后面（443 + 证书自动续期）](zh/03-02-hub-behind-apache-https.md)
- [hub 放 nginx 后面](zh/03-03-hub-behind-nginx.md)
- 用户管理（建号 / 改密 / 吊销 host）见 [usage.md §8.3](../overview/usage.md)
