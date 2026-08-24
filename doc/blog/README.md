# Scenario tutorials, indexed by use case

> Full index: [English](en/) · [中文](zh/). All tutorials are bilingual.
> Start with one question: **which machine is your DSH on, and where do you want to reach it from?** Then follow the matching path, from simple to complex.

---

## 1. At home or the office: control the dev machine's DSH from any device (LAN pair code)

Your DSH runs on the dev machine, but you're on the couch, in a meeting room, or at another desk? No public IP and no hub needed:

- **On the same Wi-Fi**, open `http://<dev-machine-ip>:8443` in any browser and type the pair code once — the full DSH is yours — [LAN direct access (pair code)](en/01-01-lan-access.md)
- **On the road**? VPN back into the LAN first, then it works exactly like being at home — [VPN back into the LAN](en/01-02-vpn-lan.md)

## 2. Move DSH to a cloud server: HTTPS + password sign-in (bring your own cert)

Your DSH runs on a machine with a public IP (Alibaba Cloud ECS and friends), and you want to sign in from any browser (username + password). Three flavors, pick one:

- **Simplest**: rdsh holds its own cert, one port, no nginx/apache — [Cloud server direct (built-in TLS)](en/02-01-cloud-single-tls.md)
- **Standard 443 + fully auto-renewed certs**, HTTPS handled by a reverse proxy: [Apache2](en/02-02-cloud-apache-acme.md) or [nginx](en/02-03-cloud-nginx.md)

## 3. No public IP? Relay through a hub service — one account, many hosts (recommended)

The machine is behind NAT or inside a private network — nothing can reach it from outside. The fix: a **public hub** acts as the switchboard. Machines only connect **outbound** to the hub (no public IP, no open ports), and you reach any machine from anywhere through the hub. Use someone's hub, or run your own (next section):

- **Join with a join token (recommended)**: generate in the portal, paste one command on the machine, done — [join token access](en/03-04-join-token.md). After registration the token is persisted — restarts need no re-pairing; the same post covers the always-on service variant (boot-start + crash-restart).
- Where do accounts come from? The hub admin creates them for now (self sign-up is on the roadmap); sign in with username + password.

## 4. Set up your own hub relay service

Want to run a hub for your team / yourself? Three deployment routes + user management:

- [Deploy the hub on an ECS (built-in TLS, fastest)](en/03-01-hub-public.md)
- [Hub behind Apache2 (443 + auto-renewed certs)](en/03-02-hub-behind-apache-https.md)
- [Hub behind nginx](en/03-03-hub-behind-nginx.md)
- User management (create / password / revoke hosts) — see [usage.md §8.3](../overview/usage.md)
