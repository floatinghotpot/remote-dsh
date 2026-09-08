# Scenario tutorials, indexed by use case

> Full index: [English](en/) · [中文](zh/). All tutorials are bilingual.
> Start with one question: **which machine is your DSH on, and where do you want to reach it from?** Then follow the matching path, from simple to complex.

---

## 1. Get started: make your DSH reachable from anywhere

First try the direct routes on your own network; no public IP? relay through the **rdsh cloud hub (https://rdsh.cn)** — register once, then pick how the machine connects:

> **Not sure which way? The easiest route**: if the **DSH web UI is already running** on your computer, go straight to [plugin access](en/01-05-plugin-mode.md) (create an [account](en/01-03-rdsh-account.md) → get an [access token](en/01-04-join-token.md) → install the plugin — three steps). If DSH isn't installed at all, start with [creating an account](en/01-03-rdsh-account.md) and come back once DSH is set up.

- **Same network, no hub** — on the same Wi-Fi, open `http://<dev-machine-ip>:8443` in any browser and type the pair code once — [LAN direct access (pair code)](en/01-01-lan-access.md). On the road? VPN back into the LAN first — [VPN back into the LAN](en/01-02-vpn-lan.md).
- **No public IP? Use the rdsh cloud hub (recommended)** — machines only connect outbound to the hub (no open ports), and you reach them from anywhere:
  - [Create an rdsh.cn account](en/01-03-rdsh-account.md) (email-verified, 2FA optional);
  - [Get a join token](en/01-04-join-token.md) — generate it in the portal once, then bring machines online with it;
  - Then run the machine in one of three modes (pick one per machine):
    - **Plugin mode**: a "Remote Access" panel inside DSH — no CLI, no service — [install dsh-web-remote](en/01-05-plugin-mode.md);
    - **CLI mode**: `rdsh host join` + `rdsh host serve` in the foreground — [CLI mode](en/01-06-cli-mode.md);
    - **System-service mode**: one command installs an always-on, boot-starting service, by platform: [Linux (systemd, verified)](en/01-07-host-service-mode-linux.md) · [macOS (launchd: starts after login + crash recovery; needs remote-dsh ≥ 0.10.1; fully unattended needs a LaunchDaemon, not yet)](en/01-07-host-service-mode-mac.md) · [Windows (limited today: WSL2 route)](en/01-07-host-service-mode-windows.md).
- **Team & security**: 2FA, password recovery, host sharing, audit log — [account security & team sharing](en/01-08-account-security.md).

## 2. Move DSH to a cloud server: HTTPS + password sign-in (bring your own cert)

Your DSH runs on a machine with a public IP (Alibaba Cloud ECS and friends), and you want to sign in from any browser (username + password). Three flavors, pick one:

- **Simplest**: rdsh holds its own cert, one port, no nginx/apache — [Cloud server direct (built-in TLS)](en/02-01-cloud-single-tls.md)
- **Standard 443 + fully auto-renewed certs**, HTTPS handled by a reverse proxy: [Apache2](en/02-02-cloud-apache-acme.md) or [nginx](en/02-03-cloud-nginx.md)

## 3. Set up your own hub relay service

Want to run a hub for your team / yourself? Three deployment routes + user management. The machine-side guides in §1 work with **any** hub — just use your hub URL in place of `https://rdsh.cn`:

- [Deploy the hub on an ECS (built-in TLS, fastest)](en/03-01-hub-public.md)
- [Hub behind Apache2 (443 + auto-renewed certs)](en/03-02-hub-behind-apache-https.md)
- [Hub behind nginx](en/03-03-hub-behind-nginx.md)
- User management (create / password / revoke hosts) — see [usage.md §8.3](../overview/usage.md)
