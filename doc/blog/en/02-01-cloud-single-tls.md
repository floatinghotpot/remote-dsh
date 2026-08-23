# Put your DSH agent on a cloud server: sign in from any browser (bring your own TLS cert)

> 2026-08-23 · remote-dsh 0.3.0
> Cloud-server deployment series: ② rdsh standalone + built-in TLS (this post) → ③ Apache2 reverse proxy → ④ nginx reverse proxy

**中文版**：[中文](../zh/02-01-cloud-single-tls.md)

---

## The scenario

You rented an **Ubuntu cloud server** (Alibaba Cloud ECS, Tencent Cloud, etc.) and deployed a **DeepSeek Harness (DSH) agent** on it to run automation tasks.

Now you want: **from anywhere, open an https address in the browser, enter a username and password, and fully operate the DSH agent on that server** — send tasks, watch execution in real time, manage workspace files — exactly as if you were sitting at the server.

This series covers exactly that (three cloud-server deployment options). This post is the **simplest one**: rdsh runs standalone, holds the TLS certificate itself, and exposes a single public port.

## Architecture

```
Your browser ──https──► cloud server:8443 (rdsh) ──auth──► 127.0.0.1:<port> (dsh web)
                              ▲
                    config.json + systemd service
```

- The rdsh gateway is the **only auth layer** (DSH itself has no auth): HTTPS + username/password → HttpOnly session cookie → then full-duplex forwarding (HTTP / SSE / WebSocket)
- The certificate is used **directly by rdsh** (`tls.cert/key`) — no nginx/apache needed

## Prerequisites

| Item | Requirement |
|---|---|
| Cloud server | Alibaba Cloud ECS etc., Ubuntu 22.04+ (headless is fine) |
| Node.js | ≥ 22 (`node -v`) |
| dsh | Installed with `dsh` in PATH |
| Domain | **Optional**: with a domain you can get a trusted cert automatically (acme.sh / Let's Encrypt); without one, self-sign manually (browser trusts once) |

## Deploy in six steps

### ① Install remote-dsh

```bash
npm install -g remote-dsh
rdsh --version   # 0.3.0
```

### ② Add a login user (interactive password, stored as scrypt hash)

```bash
rdsh user add admin
# enter and confirm the password (no echo)
```

Passwords are stored **only as scrypt hashes** — never in plaintext.

### ③ Get a certificate (pick one)

**A. Have a domain → acme.sh auto-issue (recommended, 90-day renewal):**

```bash
curl https://get.acme.sh | sh -s email=you@example.com
acme.sh --issue -d rdsh.example.com --webroot /var/www/html
acme.sh --install-cert -d rdsh.example.com \
  --key-file /root/.rdsh/key.pem \
  --fullchain-file /root/.rdsh/cert.pem \
  --reloadcmd "rdsh service restart"   # auto-reload cert after renewal
```

**B. Cloud vendor certificate**: apply for a free cert in the cloud console (e.g. Alibaba Cloud SSL), download the Nginx-format PEM, put it on the server (e.g. `/etc/rdsh/`), `chmod 600`.

**C. No domain, quick start → manual self-sign** (browser must trust once):

```bash
mkdir -p /etc/rdsh && cd /etc/rdsh
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout key.pem -out cert.pem -days 365 \
  -subj "/CN=<server-public-IP>"
```

### ④ Write the config file `~/.rdsh/config.json`

```jsonc
{
  "port": 8443,                                  // public port (open in security group)
  "tls": {                                       // cert paths (from one of the three options above)
    "cert": "/root/.rdsh/cert.pem",
    "key": "/root/.rdsh/key.pem"
  },
  "auth": {
    "mode": "password",                          // username/password auth (M2 primary)
    "users": []                                  // managed by `rdsh user`, don't hand-edit
  }
  // Optional:
  // "allowFrom": ["1.2.3.0/24"],                // IP whitelist (CIDR); outside → 403
  // "sessionTtlSeconds": 43200,                 // session lifetime, default 12h
}
```

> ⚠ Security baseline: `auth.mode: password` requires TLS (or behindProxy). If you force password mode without a cert, rdsh **refuses to start** and tells you why — that's intentional, don't disable it.

### ⑤ Run as a service (auto-start + auto-restart)

```bash
rdsh service install    # systemd unit (Ubuntu) / launchd plist (macOS), no sudo needed
rdsh service status     # "active" = running
```

- rdsh doesn't fork into the background itself; systemd manages it (together with the dsh process it spawns)
- Auto-restart on crash (`Restart=on-failure`); auto-recovers after machine reboot

### ⑥ Open the port + browse

- Cloud security group (Alibaba Cloud console → Security Groups → inbound): allow **TCP 8443** (or the port you configured)
- Open `https://<server-public-IP>:8443` in the browser
  - Self-signed cert: the browser warns "certificate not trusted" → trust it manually and continue
  - Real cert: straight in
- Enter **admin + password** → **DSH agent UI** → full remote control

## Day-to-day ops

```bash
rdsh user passwd admin    # change password — all logged-in devices drop instantly (re-login)
rdsh user ls              # list users
rdsh user rm bob          # remove user
rdsh service status       # running status
rdsh service uninstall    # remove service (stop + disable auto-start)
rdsh serve --reset        # rotate session keys (emergency: kick all sessions)
```

## Security notes (important)

- The DSH agent **has no auth of its own** (it can run arbitrary commands) — **the rdsh gateway is the only auth layer**
- Public direct access = **HTTPS + password auth, mandatory**; only open the port you use in the security group
- **Rate limiting** on login: 5 wrong attempts per IP → locked for 10 minutes (anti-brute-force)
- Session cookie is an **HttpOnly + SameSite=Lax** HMAC-signed value — not readable by browser scripts
- Optional `allowFrom` whitelist: only allow specific source IP ranges (defense in depth)
- Keep cert private key / config file at 600; logs never print passwords or cookies

## When to switch to a reverse proxy (next posts)

| Need | Use |
|---|---|
| Single port, quick start | **This post: standalone + built-in TLS** |
| Have a domain; standard 443; fully automatic cert renewal | [③ Apache2 reverse proxy](../en/02-02-cloud-apache-acme.md) |
| Already running nginx for other sites; share port 443 | [④ nginx reverse proxy](../en/02-03-cloud-nginx.md) |

When multiple services share 443 and the reverse proxy manages certs, rdsh just needs `behindProxy: true` listening on 127.0.0.1 — see you there.

## About the project

- GitHub: [github.com/floatinghotpot/remote-dsh](https://github.com/floatinghotpot/remote-dsh)
- Install: `npm i -g remote-dsh` (MIT license, open source)
