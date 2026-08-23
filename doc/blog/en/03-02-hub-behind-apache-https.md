# Deploy rdsh-hub behind Apache2 (standard port 443 + auto-renewed certs)

> 2026-08-24 · remote-dsh 0.4.8 (production-tested update)
> Server-relay series: ③ hub with built-in TLS → **this post: hub behind Apache2**

**中文版**：[中文](../zh/03-02-hub-behind-apache-https.md)

---

## The scenario

[03-01 hub with built-in TLS](../en/03-01-hub-public.md) lets the hub hold its own cert on port 8443. But you may prefer:

- a **standard 443 port** (no `:8443` suffix)
- reusing an **Apache2** that already serves other sites on the box — share one 443
- certs **auto-renewed by acme.sh / Let's Encrypt**, hub never touches them

The fix: **Apache2 terminates TLS in front; the hub steps back to 127.0.0.1 over plain http** — the hub runs with `behindProxy: true` and fully trusts the TLS terminated by the proxy.

## Architecture

```
gateway(rdsh join) ──wss──► apache2:443 ──http/ws──► hub(127.0.0.1:8443, behindProxy)
browser ──https://hub.example.com──► apache2:443 ─────────────────┘
```

- The gateway tunnel (`/tunnel`), portal live events (`/api/events`) and DSH WebSockets (`events.mux`) **all flow through Apache2's upgrade proxy**
- Hub rate limiting counts the **real IP from X-Forwarded-For** (trusted from loopback connections only — anti-forgery)

## Steps

### ① Install Apache2 + enable modules

```bash
apt update && apt install -y apache2
a2enmod proxy proxy_http proxy_wstunnel rewrite ssl headers
systemctl restart apache2
```

> `proxy_wstunnel` is required — the hub tunnel and DSH event streams are WebSockets.

### ② Configure the hub (behindProxy + localhost)

Write `~/.rdsh/hub.json`:

```jsonc
{
  "host": "127.0.0.1",        // localhost only; Apache2 forwards to it
  "port": 8443,
  "behindProxy": true         // trust the proxy-terminated TLS; no cert needed (plain http)
  // dbPath / jwtKeyPath default to ~/.rdsh/hub.db and ~/.rdsh/hub-jwt.key (auto-created)
  // Note: config values are NOT "~"-expanded — use absolute paths when customizing
}
```

```bash
rdsh hub serve --config ~/.rdsh/hub.json    # log should show hub on http://127.0.0.1:8443
rdsh hub service install                     # or run it as a service
```

### ③ Issue a cert with acme.sh + auto-renew

```bash
curl https://get.acme.sh | sh -s email=you@example.com
acme.sh --issue -d hub.example.com --webroot /var/www/html
acme.sh --install-cert -d hub.example.com \
  --fullchain-file /etc/letsencrypt/live/hub.example.com/fullchain.pem \
  --key-file      /etc/letsencrypt/live/hub.example.com/privkey.pem \
  --reloadcmd     "systemctl reload apache2"    # auto-reload after renewal
```

acme.sh ships its own cron — zero manual work for the 90-day renewal.

> **Non-root variant** (rdsh and acme.sh run as an unprivileged user, e.g. `<user>`): deploy the cert to a **user-writable** directory (e.g. `~/.rdsh/`) and make `--reloadcmd` escalate — `--reloadcmd "sudo systemctl reload apache2"` (requires NOPASSWD sudo via `/etc/sudoers.d/`).

### ④ Apache2 vhost: 443 → 127.0.0.1:8443 (incl. WebSocket)

Write `/etc/apache2/sites-available/rdsh-hub.conf`:

```apache
<VirtualHost *:443>
    ServerName hub.example.com
    SSLEngine on
    SSLCertificateFile      /etc/letsencrypt/live/hub.example.com/fullchain.pem
    SSLCertificateKeyFile   /etc/letsencrypt/live/hub.example.com/privkey.pem

    ProxyPreserveHost On
    ProxyPass        / http://127.0.0.1:8443/
    ProxyPassReverse / http://127.0.0.1:8443/

    # WebSocket (hub tunnel + DSH events + portal pushes):
    RewriteEngine On
    RewriteCond %{HTTP:Upgrade} =websocket [NC]
    RewriteRule /(.*) ws://127.0.0.1:8443/$1 [P,L]
</VirtualHost>
```

```bash
a2ensite rdsh-hub
systemctl reload apache2
```

### ⑤ Open port 443 + use it

- Cloud security group: allow **TCP 443** only (no need to open 8443 — hub listens on localhost)
- Browse `https://hub.example.com` → sign in → bind machines → enter DSH; a **live event stream means the WS proxy works**
- Gateway side: `rdsh join https://hub.example.com` (the tunnel comes in on 443)

## Built-in TLS vs Apache2 front

| Option | Hub cert | Port | Use case |
|---|---|---|---|
| [③ hub built-in TLS](../en/03-01-hub-public.md) | hub holds it | 8443 | Single service, quick start |
| **This post: Apache2 front** | Apache2 (acme.sh auto-renew) | 443 standard | Shared 443, already on Apache2 |

## Notes

- **XFF trusted from loopback only**: the hub only honors `X-Forwarded-For` when the connection comes from 127.0.0.1 — forging it on public 8443 is useless (and 8443 isn't open anyway)
- **Firewall**: 443 only; `host: 127.0.0.1` guarantees the hub can't be reached around the proxy
- **Renewals never touch the hub** (Apache2 reloads); only a cert-path change needs a hub restart
- **Tested**: `behindProxy` (plain-http + XFF rate limiting) implemented and verified 2026-08-23; **production-tested 2026-08-24 on Alibaba Cloud ECS (Ubuntu 26.04, remote-dsh 0.4.8)**: 443 reverse proxy + full WebSocket + acme.sh renewal loop (non-root variant); mirrors [02-02 Apache2 post](../en/02-02-cloud-apache-acme.md)

## About the project

- GitHub: [github.com/floatinghotpot/remote-dsh](https://github.com/floatinghotpot/remote-dsh)
- Install: `npm i -g remote-dsh` (MIT license, open source)
