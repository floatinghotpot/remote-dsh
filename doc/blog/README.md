# Your DSH, anywhere — a scenario guide

> All tutorials are bilingual ([English](en/) / [中文](zh/)).
> Start with one question: **which machine is your DSH on, and where do you want to reach it from?** Then follow the path below — every path has a one-command option.

---

## At home or in the office: the same Wi-Fi is enough

Your DSH runs on the dev machine, but you're on the couch, in a meeting room, or at another desk? No public IP and no hub needed:

- **On the same Wi-Fi**, open `http://<dev-machine-ip>:8443` in any browser and type the pair code shown in the terminal — the full DSH (chat, tools, files, live streams) is yours — [LAN direct access (pair code)](en/01-01-lan-access.md)
- **On the road**? VPN back into the LAN first, then it works exactly like being at home — [VPN back into the LAN](en/01-02-vpn-lan.md)

## On a cloud server: public IP, go straight to HTTPS

Your DSH runs on a machine with a public IP (Alibaba Cloud ECS and friends), and you want to sign in from any browser (username + password). Three flavors, pick one:

- **Simplest**: rdsh holds its own cert, one port, no nginx/apache — [Cloud server direct (built-in TLS)](en/02-01-cloud-single-tls.md)
- **Standard 443 + fully auto-renewed certs**, HTTPS handled by a reverse proxy: [Apache2 (cron + acme.sh auto-renew)](en/02-02-cloud-apache-acme.md) or [nginx](en/02-03-cloud-nginx.md)

## No public IP (behind NAT / inner VM): let a hub relay for you

The machine is behind NAT or inside a private network — nothing can reach it from outside. The fix: a **public hub** acts as the "switchboard". Machines only connect **outbound** to the hub (no public IP, no open ports), and you reach any machine from anywhere through the hub. Pick your role:

**You're a host user** (adding a machine to the hub) — one path:
- [Join with a join token: generate in the portal, paste one command on the machine, done](en/03-04-join-token.md). After registration the token is persisted — restarts need no re-pairing; the same post covers the always-on service variant (boot-start + crash-restart).
- Where do accounts come from? The hub admin creates them for now (self sign-up is on the roadmap); you sign in to the portal with username + password.

**You're a hub admin** (running a hub for your team / yourself) — three deployment routes + user management:
- [Deploy the hub on an ECS (built-in TLS, fastest)](en/03-01-hub-public.md)
- [Hub behind Apache2 (443 + auto-renewed certs)](en/03-02-hub-behind-apache-https.md)
- [Hub behind nginx](en/03-03-hub-behind-nginx.md)
- User management (create / password / revoke hosts) — see [usage.md §8.3](../overview/usage.md)
