# DSH 智能体的 HTTPS 交给 apache2：正式域名 + 证书 90 天全自动续期

[English](../en/03-cloud-apache-acme.md) | **中文**

> 2026-08-23 · remote-dsh 0.3.0
> 云服务器部署系列：② rdsh 单独 + 内置 TLS → ③ apache2 反代（本文）→ ④ nginx 反代

---

## 场景

上一篇（[② 单独 + 内置 TLS](../zh/02-cloud-single-tls.md)）是最快路径，但正式使用有几个痛点：

- 想在标准的 **443 端口**（不用带 `:8443` 后缀）
- 服务器上可能**还有其他网站/服务**，想共用一个 443 统一管理
- 证书想**全自动续期**（Let's Encrypt 90 天有效期，手动换太烦）

解法：**apache2 在前台管 HTTPS 与证书，rdsh 退到 127.0.0.1 只做认证与转发**。rdsh 开 `behindProxy: true`，完全信任反代终止的 TLS —— 它自己可以跑纯 http，密码照样安全（因为链路已经被反代加密）。

## 架构

```
浏览器 ──https://example.com──► apache2:443 (TLS + 证书) ──http──► 127.0.0.1:8443 (rdsh)
                                      │                              ▲
                        acme.sh 续期 → apache2 reload       behindProxy + password 认证
```

## 部署步骤

### ① 安装 apache2 并启用所需模块

```bash
apt update && apt install -y apache2
a2enmod proxy proxy_http proxy_wstunnel rewrite ssl headers
systemctl restart apache2
```

> `proxy_wstunnel` 必须启用 —— DSH 的实时事件流走 WebSocket，没有它 upgrade 会断。

### ② 配置 rdsh（监听本机 + behindProxy）

```bash
npm install -g remote-dsh
rdsh user add admin
```

写 `~/.rdsh/config.json`：

```jsonc
{
  "host": "127.0.0.1",          // 只监听本机，绝不直接暴露公网
  "port": 8443,
  "behindProxy": true,          // 信任反代终止的 TLS（允许 password + http）
  "auth": {
    "mode": "password",
    "users": []
  }
  // 可选 "allowFrom": ["1.2.3.0/24"]  —— 注意：反代场景按 X-Forwarded-For 取真实 IP
}
```

```bash
rdsh service install           # systemd 常驻（开机自启 + 崩溃重启）
rdsh service status            # active
```

### ③ acme.sh 签发证书 + cron 自动续期

```bash
curl https://get.acme.sh | sh -s email=you@example.com
acme.sh --issue -d example.com --webroot /var/www/html
acme.sh --install-cert -d example.com \
  --fullchain-file /etc/letsencrypt/live/example.com/fullchain.pem \
  --key-file      /etc/letsencrypt/live/example.com/privkey.pem \
  --reloadcmd     "systemctl reload apache2"    # 续期后自动重载证书
```

acme.sh 自带 cron（每天检查），到期前自动续期并执行 `reloadcmd` —— **证书 90 天续期全程零手动**。

### ④ apache vhost：443 → 127.0.0.1:8443（含 WebSocket）

写 `/etc/apache2/sites-available/rdsh.conf`：

```apache
<VirtualHost *:443>
    ServerName example.com
    SSLEngine on
    SSLCertificateFile      /etc/letsencrypt/live/example.com/fullchain.pem
    SSLCertificateKeyFile   /etc/letsencrypt/live/example.com/privkey.pem

    ProxyPreserveHost On
    ProxyPass        / http://127.0.0.1:8443/
    ProxyPassReverse / http://127.0.0.1:8443/

    # WebSocket（DSH 实时事件流依赖）：
    RewriteEngine On
    RewriteCond %{HTTP:Upgrade} =websocket [NC]
    RewriteRule /(.*) ws://127.0.0.1:8443/$1 [P,L]
</VirtualHost>
```

```bash
a2ensite rdsh
systemctl reload apache2
```

### ⑤ 放行 443 + 访问

- 云安全组放行 **TCP 443**（8443 不用放 —— rdsh 只听本机）
- 浏览器打开 `https://example.com` → 输入 **admin + 密码** → 进入 DSH 智能体界面

## 验证 WebSocket 没断

DSH 界面能看到智能体**实时执行过程**（事件流推送），说明 WS 反代正常。也可以命令行验证：

```bash
curl -i -s -N -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: x3JJHMbDL1EzLkh9GBhXDw==" \
  https://example.com/api/events.mux | head -3
# HTTP/1.1 101 Switching Protocols   ← 成功
```

（返回 101 即 upgrade 打通；未登录会先看到 307 跳登录 —— 也正常。）

## 运维与安全

```bash
rdsh user passwd admin        # 改密 = 全部会话立即失效
rdsh service status           # rdsh 运行状态
systemctl status apache2      # 反代状态
acme.sh --list                # 证书到期时间
```

- **X-Forwarded-For 只信回环**：rdsh 只有确认连接来自 127.0.0.1 才采信 XFF，公网直连 8443 时伪造 XFF 无效（何况 8443 本来就没对外开）
- 防火墙只开 443；`host: 127.0.0.1` 保证 rdsh 不能被绕过反代直接访问
- 登录失败限流（5 次/10 分钟锁定）按 **XFF 真实 IP** 计数，防爆破
- 证书续期不需要碰 rdsh —— 反代重载配置即可；真要换证书路径才改 config 并 `rdsh service restart`

## 下一篇

想用 nginx？配置几乎一样（`proxy_pass` + upgrade 头），见 [④ nginx 反代](../zh/04-cloud-nginx.md)。

## 关于项目

- GitHub: [github.com/floatinghotpot/remote-dsh](https://github.com/floatinghotpot/remote-dsh)
- 安装: `npm i -g remote-dsh`（MIT 协议，开源）
