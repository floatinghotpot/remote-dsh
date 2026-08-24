# remote-dsh 博客索引（按使用场景）

> 全部博客中英双语（`doc/blog/zh/` 中文 / `doc/blog/en/` English）。
> 按"**怎么接入你的 DSH**"组织：先看场景分类，再点对应文章。

---

## 1. 局域网 / VPN：直连 IP 访问

| 场景 | 文章 |
|---|---|
| 1.1 同一 WiFi/LAN，任意设备浏览器直连开发机 IP（配对码） | [局域网 IP 直连](zh/01-01-lan-access.md) |
| 1.2 出差在外，先 VPN 回内网、再按 IP 访问 | [VPN 回连局域网](zh/01-02-vpn-lan.md) |

## 2. 云服务器（ECS）：公网 IP / 域名直连

| 场景 | 文章 |
|---|---|
| 2.1 单独部署 + 内置证书 / HTTPS（最简单） | [云服务器直连（内置 TLS）](zh/02-01-cloud-single-tls.md) |
| 2.2 主机放 apache2 后面（443 + 证书自动续期） | [主机经 apache2 反代](zh/02-02-cloud-apache-acme.md) |
| 2.3 主机放 nginx 后面 | [主机经 nginx 反代](zh/02-03-cloud-nginx.md) |

## 3. 无公网 IP（NAT / 内网 VM）：经 hub 转发（主机接入）

### 3.1 添加主机（host 归属 hub 用户）

| 场景 | 文章 |
|---|---|
| 3.1.1 注册账号 | ⏳ 规划中（见 roadmap）；当前由 hub 管理员建号 |
| 3.1.2 portal 登录（用户名 / 密码） | 见 usage.md §8.3 |
| 3.1.3 添加主机（join token）： | |
| 3.1.3.1 前台运行（`rdsh host join <hub> --token <t>`） | [join token 一键接入](zh/03-04-join-token.md) |
| 3.1.3.2 服务化常驻（`rdsh host service install`，开机自启 / 崩溃重启） | [join token 一键接入](zh/03-04-join-token.md)（常驻变体）+ [usage.md §8.5 服务化要点](../overview/usage.md) |

> 还没有可用的 hub？自己搭一个见**第 4 章**（自己搭 hub）。

## 4. 自己搭 hub（转发服务，hub 管理员）

### 4.1 部署 hub

| 场景 | 文章 |
|---|---|
| 4.1.1 在 ECS 部署 hub（内置 TLS） | [hub 公网部署](zh/03-01-hub-public.md)（部署部分；主机接入见 3.1.3） |
| 4.1.2 hub 放 apache2 后面 | [hub 经 apache2 反代](zh/03-02-hub-behind-apache-https.md) |
| 4.1.3 hub 放 nginx 后面 | [hub 经 nginx 反代](zh/03-03-hub-behind-nginx.md) |

### 4.2 hub 用户管理（建号 / 改密 / 吊销）

| 场景 | 文章 |
|---|---|
| 4.2.1 用户管理 | 见 [usage.md §8.3](../overview/usage.md) |

> 搭好之后，主机怎么接入见**第 3 章**（经 hub 转发）。

## 5. 相关手册

| 文档 | 说明 |
|---|---|
| [usage.md](../overview/usage.md) | 完整操作手册（安装 / 配置 / 命令 / 安全 / 排障） |
| [roadmap](../overview/roadmap.md) | 里程碑与规划（注册账号、多租户、移动端等） |
