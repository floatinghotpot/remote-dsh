# 你的 DSH，随处可达 —— 场景选择指南

> 所有教程中英双语（[中文](zh/) / [English](en/)）。
> 先想清楚一个问题：**你的 DSH 跑在哪台机器上、你打算从哪儿访问它？** 然后照着对应的路线走，每条都有一条命令起步的方案。

---

## 在家里或办公室：同一 WiFi 就够了

DSH 跑在开发机上，人却在客厅、会议室、或者另一台电脑前？不需要任何公网 IP，也不需要 hub：

- **同一 WiFi 下**，任意设备浏览器打开 `http://<开发机IP>:8443`，输一次终端显示的配对码，就是完整的 DSH（对话、工具、文件、实时流全都有）—— [局域网 IP 直连（配对码）](zh/01-01-lan-access.md)
- **出差在外**？先 VPN 回内网，然后和在家里一模一样 —— [VPN 回连局域网](zh/01-02-vpn-lan.md)

## 在云服务器上：有公网 IP，直接 HTTPS

DSH 跑在阿里云 ECS 这类有公网 IP 的机器上，你想在任何地方用浏览器登录访问（用户名 + 密码）。三种方案按口味选：

- **最简单**：rdsh 自己持证书、一个端口直连，不需要 nginx/apache —— [云服务器直连（内置 TLS）](zh/02-01-cloud-single-tls.md)
- **想要标准 443 + 证书全自动续期**，把 HTTPS 交给反代： [apache2（cron + acme.sh 自动续期）](zh/02-02-cloud-apache-acme.md) 或 [nginx](zh/02-03-cloud-nginx.md)

## 没有公网 IP（NAT 后面 / 内网虚拟机）：让 hub 帮你转发

机器藏在 NAT 或内网里，外面连不进来？解法是找一台**公网 hub** 当"总机"：机器只**出站**连上 hub（不需要公网 IP、不需要开端口），你从任何地方访问 hub 就能进任何机器。按你的角色走：

**你是主机使用者**（把某台机器加入 hub）—— 一条路：
- [用 join token 接入：portal 生成 → 机器粘贴一条命令 → 上线](zh/03-04-join-token.md)。注册后 token 持久化，重启免配对；想常驻后台，同一篇文章里有服务化变体（开机自启 + 崩溃重启）。
- 账号从哪来？现在由 hub 管理员建号（自助注册在 roadmap 上）；登录就用用户名 + 密码进 portal。

**你是 hub 管理员**（要自己搭一个 hub 给团队/自用）—— 三条部署路线 + 用户管理：
- [在 ECS 部署 hub（内置 TLS，最快）](zh/03-01-hub-public.md)
- [hub 放 apache2 后面（443 + 证书自动续期）](zh/03-02-hub-behind-apache-https.md)
- [hub 放 nginx 后面](zh/03-03-hub-behind-nginx.md)
- 用户管理（建号 / 改密 / 吊销 host）见 [usage.md §8.3](../overview/usage.md)
