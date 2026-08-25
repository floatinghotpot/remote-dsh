# 场景化教程，按使用场景索引

> 完整索引：[中文](zh/) · [English](en/)。所有教程中英双语。
> 先想清楚一个问题：**你的 DSH 跑在哪台机器上、你打算从哪儿访问它？** 然后照着对应的路线走，从简单到复杂。

---

## 1. 在家/办公室，用任意设备遥控开发机的 DSH（局域网配对码）

DSH 跑在开发机上，人却在客厅、会议室、或者另一台电脑前？不需要任何公网 IP，也不需要 hub：

- **同一 WiFi 下**，任意设备浏览器打开 `http://<开发机IP>:8443`，输一次终端显示的配对码，就是完整的 DSH —— [局域网 IP 直连（配对码）](zh/01-01-lan-access.md)
- **出差在外**？先 VPN 回内网，然后和在家里一模一样 —— [VPN 回连局域网](zh/01-02-vpn-lan.md)

## 2. 把 DSH 搬上云服务器：HTTPS + 密码直连（证书自备）

DSH 跑在阿里云 ECS 这类有公网 IP 的机器上，你想在任何地方用浏览器登录访问（用户名 + 密码）。三种方案按口味选：

- **最简单**：rdsh 自己持证书、一个端口直连，不需要 nginx/apache —— [云服务器直连（内置 TLS）](zh/02-01-cloud-single-tls.md)
- **想要标准 443 + 证书全自动续期**，把 HTTPS 交给反代：[apache2](zh/02-02-cloud-apache-acme.md) 或 [nginx](zh/02-03-cloud-nginx.md)

## 3. 无法 IP 直连？通过 hub 服务转发、一个账号管理多个主机（推荐）

机器藏在 NAT 或内网里，外面连不进来？找一台**公网 hub** 当"总机"：机器只**出站**连上 hub（不需要公网 IP、不需要开端口），你从任何地方访问 hub 就能进任何机器。用别人搭好的 hub，或自己搭一个（见下一节）：

- **用 join token 接入（推荐）**：portal 生成 → 机器粘贴一条命令 → 上线 —— [join token 接入](zh/03-04-join-token.md)。注册后 token 持久化，重启免配对；想常驻后台，同一篇文章里有服务化变体（开机自启 + 崩溃重启）。
- **不想装 CLI？给 DSH 装插件**：`dsh plugin add dsh-web-remote`，DSH 界面直接出「远程访问」面板，粘贴 hub + 授权令牌点接入即上线 —— [DSH 插件免 CLI 接入](zh/03-05-plugin.md)。
- **多用户与团队**：邮箱验证、两步验证（2FA）、机器共享、审计日志、登录风控 —— [账号安全与团队共享](zh/03-06-account-security.md)。
- 账号从哪来？由 hub 管理员建号（自助注册在 roadmap 上）；登录就用用户名 + 密码进 portal。

## 4. 搭建你自己的 hub 转发服务

想自己搭一个 hub 给团队/自用？三条部署路线 + 用户管理：

- [在 ECS 部署 hub（内置 TLS，最快）](zh/03-01-hub-public.md)
- [hub 放 apache2 后面（443 + 证书自动续期）](zh/03-02-hub-behind-apache-https.md)
- [hub 放 nginx 后面](zh/03-03-hub-behind-nginx.md)
- 用户管理（建号 / 改密 / 吊销 host）见 [usage.md §8.3](../overview/usage.md)
