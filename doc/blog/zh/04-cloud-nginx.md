# 云服务器部署 DSH 智能体：nginx 反代（443 共端口）

[English](../en/04-cloud-nginx.md) | **中文**

> 2026-08-23 · remote-dsh 0.3.0
> 云服务器部署系列：② rdsh 单独 + 内置 TLS → ③ apache2 反代 → ④ nginx 反代（本文）

---

## 场景

和前一篇（[③ apache2 反代](../zh/03-cloud-apache-acme.md)）目标一致：**443 标准端口、证书自动续期、多服务共端口**。区别只是反代换成 **nginx** —— 如果你服务器上已经在用 nginx 管别的站点，或团队偏好 nginx 生态（certbot 插件等），选这篇。

## 架构

```
浏览器 ──https://example.com──► nginx:443 (TLS + 证书) ──http──► 127.0.0.1:8443 (rdsh)
                                       │                            ▲
                         certbot/acme.sh 续期 → nginx reload  behindProxy + password 认证
```

## 部署步骤

### ① 安装 nginx

```bash
apt update && apt install -y nginx
systemctl enable --now nginx
```

### ② 配置 rdsh（监听本机 + behindProxy）

与 [③ apache2 篇](../zh/03-cloud-apache-acme.md) 完全相同的 rdsh 侧配置：

```bash
npm install -g remote-dsh
rdsh user add admin
```

`~/.rdsh/config.json`：

```jsonc
{
  "host": "127.0.0.1",          // 只监听本机
  "port": 8443,
  "behindProxy": true,          // 信任 nginx 终止的 TLS（允许 password + http）
  "auth": {
    "mode": "password",
    "users": []
  }
}
```

```bash
rdsh service install
rdsh service status            # active
```

### ③ 证书（certbot 或 acme.sh 二选一）

**certbot（nginx 插件最省事）：**

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d example.com
# 自动改 nginx 配置 + 装 cron 自动续期（certbot renew 每天跑）
```

**acme.sh（通用）：**

```bash
curl https://get.acme.sh | sh -s email=you@example.com
acme.sh --issue -d example.com --nginx
acme.sh --install-cert -d example.com \
  --fullchain-file /etc/letsencrypt/live/example.com/fullchain.pem \
  --key-file      /etc/letsencrypt/live/example.com/privkey.pem \
  --reloadcmd     "systemctl reload nginx"
```

### ④ nginx server 块：443 → 127.0.0.1:8443

写 `/etc/nginx/sites-available/rdsh`：

```nginx
server {
    listen 443 ssl;
    server_name example.com;

    ssl_certificate     /etc/letsencrypt/live/example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8443;

        # 真实客户端 IP / 协议（rdsh 端 behindProxy 才信任）：
        proxy_set_header X-Forwarded-For  $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket（DSH 实时事件流依赖）：
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

```bash
ln -s /etc/nginx/sites-available/rdsh /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

### ⑤ 放行 443 + 访问

- 云安全组放行 **TCP 443**
- 浏览器打开 `https://example.com` → 输入 **admin + 密码** → 进入 DSH 智能体界面，实时执行流正常 = 全链路打通

## 三篇对比，选哪个？

| 方案 | HTTPS | 证书续期 | 复杂度 | 适用 |
|---|---|---|---|---|
| [② 单独 + 内置 TLS](../zh/02-cloud-single-tls.md) | rdsh | 手动（或 acme.sh hook） | 低 | 快速起步/个人 |
| [③ apache2 + cron acme.sh](../zh/03-cloud-apache-acme.md) | apache2 | **cron 全自动** | 中 | 正式域名/多服务 |
| **④ nginx（本文）** | nginx | certbot/acme.sh 自动 | 中 | 已有 nginx |

> 公网安全铁律：**必须 TLS + 密码认证**（三种方案都满足）；多机/跨地域场景后续可走 hub 隧道（M3，rdsh 只出站不暴露端口）。

## 运维与安全

- 改密：`rdsh user passwd admin` → 全部已登录设备立即掉线
- 登录限流按 **X-Forwarded-For 真实 IP** 计数（rdsh 只信任回环连接的 XFF）
- 证书续期不动 rdsh（nginx reload 即可）；改证书路径才需要 `rdsh service restart`
- `host: 127.0.0.1` + 防火墙只开 443，保证 rdsh 无法被绕过反代直接访问

## 关于项目

- GitHub: [github.com/floatinghotpot/remote-dsh](https://github.com/floatinghotpot/remote-dsh)
- 安装: `npm i -g remote-dsh`（MIT 协议，开源）
