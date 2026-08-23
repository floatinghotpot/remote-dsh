# hub 反代部署：把 rdsh-hub 放到 nginx 后面（443 共端口 + 证书自动续期）

[English](../en/03-03-hub-behind-nginx.md) | **中文**

> 2026-08-23 · remote-dsh 0.4.1
> 服务器转发模式系列：③ hub 公网直连（内置 TLS）→ ④ hub 经 apache2 反代 → **本文：hub 经 nginx 反代**

---

## 场景

和 [04 hub 经 apache2 反代](../zh/03-02-hub-behind-apache-https.md) 目标一致：**标准 443 端口、证书自动续期、多服务共端口**。区别只是反代换成 **nginx** —— 服务器上已经在用 nginx，或团队偏好 nginx 生态（certbot 插件等）。

hub 同样开 `behindProxy: true` 监听 127.0.0.1，nginx 终止 TLS。

## 架构

```
gateway(rdsh join) ──wss──► nginx:443 ──http/ws──► hub(127.0.0.1:8443, behindProxy)
浏览器 ──https://hub.example.com──► nginx:443 ─────────────────┘
```

## 步骤

### ① 安装 nginx

```bash
apt update && apt install -y nginx
systemctl enable --now nginx
```

### ② 配置 hub（behindProxy + 监听本机）

与 [04 apache2 篇](../zh/03-02-hub-behind-apache-https.md) 完全相同的 hub 侧配置：

```bash
npm install -g remote-dsh
```

`~/.rdsh/hub.json`：

```jsonc
{
  "host": "127.0.0.1",        // 只监听本机，由 nginx 转发
  "port": 8443,
  "behindProxy": true,        // 信任 nginx 终止的 TLS，hub 无需证书（监听 http）
  "dbPath": "~/.rdsh/hub.db",
  "jwtKeyPath": "~/.rdsh/hub-jwt.key"
}
```

```bash
rdsh hub serve --config ~/.rdsh/hub.json    # 日志应显示 hub on http://127.0.0.1:8443
rdsh hub service install
```

### ③ 证书（certbot 或 acme.sh 二选一）

**certbot（nginx 插件最省事）：**

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d hub.example.com
# 自动改 nginx 配置 + 装 cron 自动续期
```

**acme.sh：**

```bash
curl https://get.acme.sh | sh -s email=you@example.com
acme.sh --issue -d hub.example.com --nginx
acme.sh --install-cert -d hub.example.com \
  --fullchain-file /etc/letsencrypt/live/hub.example.com/fullchain.pem \
  --key-file      /etc/letsencrypt/live/hub.example.com/privkey.pem \
  --reloadcmd     "systemctl reload nginx"
```

### ④ nginx server 块：443 → 127.0.0.1:8443

写 `/etc/nginx/sites-available/rdsh-hub`：

```nginx
server {
    listen 443 ssl;
    server_name hub.example.com;

    ssl_certificate     /etc/letsencrypt/live/hub.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/hub.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8443;

        # 真实客户端 IP（hub 端 behindProxy 才信任）：
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket（hub 隧道 + DSH 事件流 + portal 推送）：
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

```bash
ln -s /etc/nginx/sites-available/rdsh-hub /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

### ⑤ 放行 443 + 使用

- 云安全组放行 **TCP 443**（8443 不用放）
- 浏览器打开 `https://hub.example.com` → 登录 → 绑机器 → 进入 DSH，**实时事件流正常 = WS 反代通了**
- gateway 侧 `rdsh join https://hub.example.com`

## 三篇选哪个？

| 方案 | hub 证书 | 端口 | 适用 |
|---|---|---|---|
| [③ hub 内置 TLS](../zh/03-01-hub-public.md) | hub 自己持 | 8443 | 单服务、快速起步 |
| [④ apache2 反代](../zh/03-02-hub-behind-apache-https.md) | apache2（acme.sh） | 443 | 已在用 apache2 |
| **⑤ nginx 反代（本文）** | nginx（certbot/acme.sh） | 443 | 已在用 nginx / 偏好 nginx |

## 注意事项

- **XFF 只信回环**：hub 只有连接来自 127.0.0.1 才采信 `X-Forwarded-For`；公网直连 8443 伪造无效（8443 没对外开）
- **防火墙**：只开 443；`host: 127.0.0.1` 保证 hub 不能被绕过反代直接访问
- **证书续期**：不动 hub（nginx reload 即可）
- **实测程度**：`behindProxy` 模式已实现并验证；nginx 反代配置与 [02-03 nginx 篇](../zh/02-03-cloud-nginx.md) 同模式

## 关于项目

- GitHub: [github.com/floatinghotpot/remote-dsh](https://github.com/floatinghotpot/remote-dsh)
- 安装: `npm i -g remote-dsh`（MIT 协议，开源）
