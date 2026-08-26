# Let Apache2 handle DSH HTTPS: real domain + fully automatic cert renewal (acme.sh)

> 2026-08-23 · remote-dsh ≥ 0.5.0 (commands and config per the 0.5.0 command tree)
> Cloud-server deployment series: ② rdsh standalone + built-in TLS → ③ Apache2 reverse proxy (this post) → ④ nginx reverse proxy

**中文版**：[中文](../zh/02-02-cloud-apache-acme.md)

---

## The scenario

The previous post ([② standalone + built-in TLS](../en/02-01-cloud-single-tls.md)) is the fastest path, but production use has a few pain points:

- You want the standard **443 port** (no `:8443` suffix)
- The server may host **other sites/services** — share one 443 and manage them together
- You want **fully automatic cert renewal** (Let's Encrypt certs expire every 90 days; manual rotation is tedious)

The fix: **Apache2 in front handles HTTPS and certs; rdsh steps back to 127.0.0.1 and only does auth + forwarding**. rdsh runs with `behindProxy: true` and fully trusts the TLS terminated by the proxy — it can even run plain http, because the link is already encrypted by the reverse proxy.

## Architecture

```
Browser ──https://example.com──► apache2:443 (TLS + certs) ──http──► 127.0.0.1:8443 (rdsh)
                                       │                                ▲
                         acme.sh renewal → apache2 reload     behindProxy + password auth
```

## Deployment steps

### ① Install Apache2 and enable required modules

```bash
apt update && apt install -y apache2
a2enmod proxy proxy_http proxy_wstunnel rewrite ssl headers
systemctl restart apache2
```

> `proxy_wstunnel` is required — DSH's live event stream runs over WebSocket; without it the upgrade breaks.

### ② Configure rdsh (listen on localhost + behindProxy)

```bash
npm install -g remote-dsh
rdsh host user add admin
```

Write `~/.rdsh/host.json`:

```jsonc
{
  "mode": "cloud",                  // cloud HTTPS gateway
  "host": "127.0.0.1",          // localhost only — never exposed directly
  "port": 8443,
  "behindProxy": true,          // trust TLS terminated by the proxy (allows password + http)
  "auth": {
    "mode": "password",
    "users": []
  }
  // Optional "allowFrom": ["1.2.3.0/24"]  — behind a proxy, the real IP comes from X-Forwarded-For
}
```

```bash
rdsh host service install           # systemd service (auto-start + auto-restart)
rdsh host service status            # active
```

### ③ Issue a cert with acme.sh + auto-renew via cron

```bash
curl https://get.acme.sh | sh -s email=you@example.com
acme.sh --issue -d example.com --webroot /var/www/html
acme.sh --install-cert -d example.com \
  --fullchain-file /etc/letsencrypt/live/example.com/fullchain.pem \
  --key-file      /etc/letsencrypt/live/example.com/privkey.pem \
  --reloadcmd     "systemctl reload apache2"    # auto-reload cert after renewal
```

acme.sh ships its own cron (checks daily) and renews before expiry, then runs `reloadcmd` — **zero manual work for the 90-day renewal cycle**.

### ④ Apache vhost: 443 → 127.0.0.1:8443 (incl. WebSocket)

Write `/etc/apache2/sites-available/rdsh.conf`:

```apache
<VirtualHost *:443>
    ServerName example.com
    SSLEngine on
    SSLCertificateFile      /etc/letsencrypt/live/example.com/fullchain.pem
    SSLCertificateKeyFile   /etc/letsencrypt/live/example.com/privkey.pem

    ProxyPreserveHost On
    ProxyPass        / http://127.0.0.1:8443/
    ProxyPassReverse / http://127.0.0.1:8443/

    # WebSocket (DSH live event stream):
    RewriteEngine On
    RewriteCond %{HTTP:Upgrade} =websocket [NC]
    RewriteRule /(.*) ws://127.0.0.1:8443/$1 [P,L]
</VirtualHost>
```

```bash
a2ensite rdsh
systemctl reload apache2
```

### ⑤ Open port 443 + browse

- Cloud security group: allow **TCP 443** only (no need to open 8443 — rdsh listens on localhost)
- Open `https://example.com` → enter **admin + password** → full DSH agent UI

## Verify WebSocket is intact

If the DSH UI shows the agent's **live execution stream**, the WS proxy works. Or verify from the command line:

```bash
curl -i -s -N -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: x3JJHMbDL1EzLkh9GBhXDw==" \
  https://example.com/api/events.mux | head -3
# HTTP/1.1 101 Switching Protocols   ← success
```

(101 = upgrade works; if not logged in you'll see a 307 to the login page first — also expected.)

## Ops & security

```bash
rdsh host user passwd admin        # change password = all sessions die instantly
rdsh host service status           # rdsh status
systemctl status apache2      # proxy status
acme.sh --list                # cert expiry dates
```

- **X-Forwarded-For trusted from loopback only**: rdsh only honors XFF when the connection comes from 127.0.0.1; forging XFF directly on 8443 is useless (and 8443 isn't publicly open anyway)
- Firewall: 443 only; `host: 127.0.0.1` guarantees rdsh can't be reached around the proxy
- Login rate limiting (5 attempts / 10 min lock) counts the **real XFF IP** — anti brute-force
- Cert renewal never touches rdsh — the proxy reloads config; only when you actually change cert paths do you edit host.json and `rdsh host service restart`

## Next post

Prefer nginx? The config is nearly identical (`proxy_pass` + upgrade headers), see [④ nginx reverse proxy](../en/02-03-cloud-nginx.md).

## About the project

- GitHub: [github.com/floatinghotpot/remote-dsh](https://github.com/floatinghotpot/remote-dsh)
- Install: `npm i -g remote-dsh` (MIT license, open source)
