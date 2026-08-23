# hub 反代部署：把 rdsh-hub 放到 apache2 后面（443 标准端口 + 证书自动续期）

[English](../en/03-02-hub-behind-apache-https.md) | **中文**

> 2026-08-24 · remote-dsh 0.4.8（含生产部署实测更新）
> 服务器转发模式系列：③ hub 公网直连（内置 TLS）→ **本文：hub 经 apache2 反代**

---

## 场景

[03-01 hub 公网直连](../zh/03-01-hub-public.md) 用 hub **内置 TLS**（hub 自己持证书、监听 8443）。但如果你更想：

- 用**标准的 443 端口**（不带 `:8443`）
- 服务器上已经用 **apache2** 管其他站点，想共用一个 443
- 证书由 **acme.sh / Let's Encrypt 全自动续期**，hub 不碰证书

解法：**apache2 在前台终止 TLS，hub 退到 127.0.0.1 监听 http**——hub 开 `behindProxy: true`，完全信任反代终止的 TLS，自己不用证书。

## 架构

```
gateway(rdsh join) ──wss──► apache2:443 ──http/ws──► hub(127.0.0.1:8443, behindProxy)
浏览器 ──https://hub.example.com──► apache2:443 ────────────────┘
```

- 浏览器与 gateway 的隧道（`/tunnel`）、portal 的在线推送（`/api/events`）、DSH 的 WebSocket（`events.mux`）**全部经 apache2 upgrade 转发**
- hub 限流按 **X-Forwarded-For 真实 IP**（behindProxy 只信任回环连接的 XFF，防伪造）

## 步骤

### ① 安装 apache2 + 启用模块

```bash
apt update && apt install -y apache2
a2enmod proxy proxy_http proxy_wstunnel rewrite ssl headers
systemctl restart apache2
```

> `proxy_wstunnel` 必须启用——hub 的隧道与 DSH 事件流都是 WebSocket。

### ② 配置 hub（behindProxy + 监听本机）

写 `~/.rdsh/hub.json`：

```jsonc
{
  "host": "127.0.0.1",        // 只监听本机，由 apache2 转发
  "port": 8443,
  "behindProxy": true         // 信任反代终止的 TLS，hub 无需证书（监听 http）
  // dbPath / jwtKeyPath 省略时默认 ~/.rdsh/hub.db、~/.rdsh/hub-jwt.key（自动生成）
  // 注意：config 字段值不展开 "~"，自定义路径必须写绝对路径
}
```

```bash
rdsh hub serve --config ~/.rdsh/hub.json    # 日志应显示 hub on http://127.0.0.1:8443
rdsh hub service install                     # 或常驻
```

### ③ acme.sh 签发证书 + 自动续期

```bash
curl https://get.acme.sh | sh -s email=you@example.com
acme.sh --issue -d hub.example.com --webroot /var/www/html
acme.sh --install-cert -d hub.example.com \
  --fullchain-file /etc/letsencrypt/live/hub.example.com/fullchain.pem \
  --key-file      /etc/letsencrypt/live/hub.example.com/privkey.pem \
  --reloadcmd     "systemctl reload apache2"    # 续期后自动重载
```

acme.sh 自带 cron，90 天续期零手动。

> **非 root 部署变体**（rdsh 与 acme.sh 以普通用户运行，如 `<user>`）：证书目录换成**用户可写**路径（如 `~/.rdsh/`），`--reloadcmd` 需要提权 —— `--reloadcmd "sudo systemctl reload apache2"`（前提：该用户在 `/etc/sudoers.d/` 配了 NOPASSWD sudo）。

### ④ apache2 vhost：443 → 127.0.0.1:8443（含 WebSocket）

写 `/etc/apache2/sites-available/rdsh-hub.conf`：

```apache
<VirtualHost *:443>
    ServerName hub.example.com
    SSLEngine on
    SSLCertificateFile      /etc/letsencrypt/live/hub.example.com/fullchain.pem
    SSLCertificateKeyFile   /etc/letsencrypt/live/hub.example.com/privkey.pem

    ProxyPreserveHost On
    ProxyPass        / http://127.0.0.1:8443/
    ProxyPassReverse / http://127.0.0.1:8443/

    # WebSocket（hub 隧道 + DSH 事件流 + portal 推送）：
    RewriteEngine On
    RewriteCond %{HTTP:Upgrade} =websocket [NC]
    RewriteRule /(.*) ws://127.0.0.1:8443/$1 [P,L]
</VirtualHost>
```

```bash
a2ensite rdsh-hub
systemctl reload apache2
```

### ⑤ 放行 443 + 使用

- 云安全组放行 **TCP 443**（8443 不用放——hub 只听本机）
- 浏览器打开 `https://hub.example.com` → 登录 → 绑机器 → 进入 DSH，**实时事件流正常 = WebSocket 反代通了**
- gateway 侧 `rdsh join https://hub.example.com`（隧道经 443 进来）

## 和内置 TLS 方案怎么选

| 方案 | hub 证书 | 端口 | 适用 |
|---|---|---|---|
| [③ hub 内置 TLS](../zh/03-01-hub-public.md) | hub 自己持 | 8443 | 单服务、快速起步 |
| **本文：apache2 反代** | apache2 管（acme.sh 自动续期） | 443 标准 | 多服务共端口、已有 apache2 |

## 注意事项

- **XFF 只信回环**：hub 只有确认连接来自 127.0.0.1 才采信 `X-Forwarded-For`，公网直连 8443 伪造无效（何况 8443 没对外开）
- **防火墙**：只开 443；`host: 127.0.0.1` 保证 hub 不能被绕过反代直接访问
- **证书续期**：不用碰 hub（apache2 reload 即可）；改证书路径才重启 hub
- **实测程度**：`behindProxy` 模式（http 启动 + XFF 限流）2026-08-23 实现验证；**2026-08-24 已在阿里云 ECS（Ubuntu 26.04，remote-dsh 0.4.8）生产部署实测通过**：443 反代 + WS 全通 + acme.sh 续期闭环（非 root 变体）；apache2 配置与 [02-02 apache2 篇](../zh/02-02-cloud-apache-acme.md) 同模式

## 关于项目

- GitHub: [github.com/floatinghotpot/remote-dsh](https://github.com/floatinghotpot/remote-dsh)
- 安装: `npm i -g remote-dsh`（MIT 协议，开源）
