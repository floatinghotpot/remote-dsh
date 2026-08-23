# Deploy rdsh-hub behind nginx (shared port 443 + auto-renewed HTTPS)

> 2026-08-23 · remote-dsh 0.4.1
> Server-relay series: ③ hub with built-in TLS → ④ hub behind Apache2 → **this post: hub behind nginx**

**中文版**：[中文](../zh/03-03-hub-behind-nginx.md)

---

## The scenario

Same goal as [④ hub behind Apache2](../en/03-02-hub-behind-apache-https.md): **standard 443, auto-renewed certs, shared port**. The difference is **nginx** — you already run nginx on the box, or prefer the nginx ecosystem (certbot plugin, etc.).

The hub runs with `behindProxy: true` on 127.0.0.1; nginx terminates TLS.

## Architecture

```
gateway(rdsh join) ──wss──► nginx:443 ──http/ws──► hub(127.0.0.1:8443, behindProxy)
browser ──https://hub.example.com──► nginx:443 ─────────────────┘
```

## Steps

### ① Install nginx

```bash
apt update && apt install -y nginx
systemctl enable --now nginx
```

### ② Configure the hub (behindProxy + localhost)

Identical hub-side config to [④ Apache2 post](../en/03-02-hub-behind-apache-https.md):

```bash
npm install -g remote-dsh
```

`~/.rdsh/hub.json`:

```jsonc
{
  "host": "127.0.0.1",        // localhost only; nginx forwards to it
  "port": 8443,
  "behindProxy": true         // trust the nginx-terminated TLS; no cert needed (plain http)
  // dbPath / jwtKeyPath default to ~/.rdsh/hub.db and ~/.rdsh/hub-jwt.key (auto-created)
  // Note: config values are NOT "~"-expanded — use absolute paths when customizing
}
```

```bash
rdsh hub serve --config ~/.rdsh/hub.json    # log should show hub on http://127.0.0.1:8443
rdsh hub service install
```

### ③ Certificate (certbot or acme.sh)

**certbot (nginx plugin, easiest):**

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d hub.example.com
# auto-edits nginx config + installs the cron for auto-renewal
```

**acme.sh:**

```bash
curl https://get.acme.sh | sh -s email=you@example.com
acme.sh --issue -d hub.example.com --nginx
acme.sh --install-cert -d hub.example.com \
  --fullchain-file /etc/letsencrypt/live/hub.example.com/fullchain.pem \
  --key-file      /etc/letsencrypt/live/hub.example.com/privkey.pem \
  --reloadcmd     "systemctl reload nginx"
```

> **Non-root variant** (rdsh and acme.sh run as an unprivileged user, e.g. `<user>`): deploy the cert to a **user-writable** directory (e.g. `~/.rdsh/`) and make `--reloadcmd` escalate — `--reloadcmd "sudo systemctl reload nginx"` (requires NOPASSWD sudo via `/etc/sudoers.d/`).

### ④ nginx server block: 443 → 127.0.0.1:8443

Write `/etc/nginx/sites-available/rdsh-hub`:

```nginx
server {
    listen 443 ssl;
    server_name hub.example.com;

    ssl_certificate     /etc/letsencrypt/live/hub.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/hub.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8443;

        # Real client IP (hub trusts these only with behindProxy):
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket (hub tunnel + DSH events + portal pushes):
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

### ⑤ Open port 443 + use it

- Cloud security group: allow **TCP 443** only
- Browse `https://hub.example.com` → sign in → bind machines → enter DSH; a **live event stream means the WS proxy works**
- Gateway side: `rdsh join https://hub.example.com`

## Which of the three?

| Option | Hub cert | Port | Use case |
|---|---|---|---|
| [③ hub built-in TLS](../en/03-01-hub-public.md) | hub holds it | 8443 | Single service, quick start |
| [④ Apache2 front](../en/03-02-hub-behind-apache-https.md) | Apache2 (acme.sh) | 443 | Already on Apache2 |
| **⑤ nginx front (this post)** | nginx (certbot/acme.sh) | 443 | Already on nginx / prefer nginx |

## Notes

- **XFF trusted from loopback only**: the hub only honors `X-Forwarded-For` from 127.0.0.1 connections; forging on public 8443 is useless
- **Firewall**: 443 only; `host: 127.0.0.1` guarantees the hub can't be reached around the proxy
- **Renewals never touch the hub** (nginx reloads)
- **Tested**: `behindProxy` mode implemented and verified; **the Apache2 variant was production-tested 2026-08-24 on Alibaba Cloud ECS (Ubuntu 26.04, remote-dsh 0.4.8)**; the nginx setup mirrors [02-03 nginx post](../en/02-03-cloud-nginx.md) (behavior identical to the Apache2 post)

## About the project

- GitHub: [github.com/floatinghotpot/remote-dsh](https://github.com/floatinghotpot/remote-dsh)
- Install: `npm i -g remote-dsh` (MIT license, open source)
