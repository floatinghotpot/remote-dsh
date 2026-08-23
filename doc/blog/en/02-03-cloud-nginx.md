# Put DSH behind nginx: shared port 443, auto-renewed HTTPS

> 2026-08-23 · remote-dsh 0.3.0
> Cloud-server deployment series: ② rdsh standalone + built-in TLS → ③ Apache2 reverse proxy → ④ nginx reverse proxy (this post)

**中文版**：[中文](../zh/02-03-cloud-nginx.md)

---

## The scenario

Same goal as the previous post ([③ Apache2 reverse proxy](../en/02-02-cloud-apache-acme.md)): **standard port 443, automatic cert renewal, share one port across services**. The only difference is the reverse proxy is **nginx** — pick this if your server already runs nginx for other sites, or your team prefers the nginx ecosystem (certbot plugin, etc.).

## Architecture

```
Browser ──https://example.com──► nginx:443 (TLS + certs) ──http──► 127.0.0.1:8443 (rdsh)
                                       │                             ▲
                         certbot/acme.sh renewal → nginx reload  behindProxy + password auth
```

## Deployment steps

### ① Install nginx

```bash
apt update && apt install -y nginx
systemctl enable --now nginx
```

### ② Configure rdsh (localhost + behindProxy)

The rdsh side is **identical** to the [Apache2 post](../en/02-02-cloud-apache-acme.md):

```bash
npm install -g remote-dsh
rdsh user add admin
```

`~/.rdsh/config.json`:

```jsonc
{
  "host": "127.0.0.1",          // localhost only
  "port": 8443,
  "behindProxy": true,          // trust TLS terminated by nginx (allows password + http)
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

### ③ Certificate (certbot or acme.sh)

**certbot (nginx plugin, easiest):**

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d example.com
# auto-edits nginx config + installs the cron for auto-renewal (certbot renew runs daily)
```

**acme.sh (generic):**

```bash
curl https://get.acme.sh | sh -s email=you@example.com
acme.sh --issue -d example.com --nginx
acme.sh --install-cert -d example.com \
  --fullchain-file /etc/letsencrypt/live/example.com/fullchain.pem \
  --key-file      /etc/letsencrypt/live/example.com/privkey.pem \
  --reloadcmd     "systemctl reload nginx"
```

### ④ nginx server block: 443 → 127.0.0.1:8443

Write `/etc/nginx/sites-available/rdsh`:

```nginx
server {
    listen 443 ssl;
    server_name example.com;

    ssl_certificate     /etc/letsencrypt/live/example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8443;

        # Real client IP / protocol (rdsh trusts these only with behindProxy):
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket (DSH live event stream):
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

### ⑤ Open port 443 + browse

- Cloud security group: allow **TCP 443**
- Open `https://example.com` → enter **admin + password** → full DSH agent UI; a live execution stream means the whole chain works

## Which of the three to pick?

| Option | HTTPS | Cert renewal | Complexity | Use case |
|---|---|---|---|---|
| [② standalone + built-in TLS](../en/02-01-cloud-single-tls.md) | rdsh | Manual (or acme.sh hook) | Low | Quick start / personal |
| [③ Apache2 + cron acme.sh](../en/02-02-cloud-apache-acme.md) | Apache2 | **Fully automatic via cron** | Medium | Real domain / multiple services |
| **④ nginx (this post)** | nginx | certbot/acme.sh automatic | Medium | Already on nginx |

> Public-internet rule of thumb: **TLS + password auth, mandatory** (all three satisfy it); for multi-machine / cross-region access, later you can use the hub tunnel (M3 — rdsh only connects outbound, no ports exposed).

## Ops & security

- Change password: `rdsh user passwd admin` → all logged-in devices drop instantly
- Login rate limiting counts the **real IP from X-Forwarded-For** (rdsh only trusts XFF from loopback connections)
- Cert renewal never touches rdsh (nginx reload suffices); only a cert-path change needs `rdsh service restart`
- `host: 127.0.0.1` + firewall (443 only) guarantees rdsh can't be reached around the proxy

## About the project

- GitHub: [github.com/floatinghotpot/remote-dsh](https://github.com/floatinghotpot/remote-dsh)
- Install: `npm i -g remote-dsh` (MIT license, open source)
