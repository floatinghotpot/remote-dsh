# remote-dsh

**English** | [中文](README.zh.md)

Make your DeepSeek Harness available anywhere.

![rdsh logo](media/rdsh256.png)

## Summary

**remote-dsh** adds a secure remote-access layer on top of
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH):
run `dsh web` as usual on your machine, then operate it from any device —
another laptop or phone in the same LAN, and (with the hub) from anywhere on
the internet.

## Architecture

```
        Client (browser / app / weapp)
                    │
                    │  HTTPS/WSS — layer 1: hub public API
                    ▼
                rdsh-hub
                    │
                    │  WSS tunnel — layer 2: rdsh-tunnel
                    ▼
             rdsh-gateway
                    │
                    │  HTTP (loopback)
                    ▼
          dsh web (127.0.0.1)
```

Two protocol layers: **layer 1** (hub public API, JSON over HTTPS + WSS events)
is the only contract clients implement; **layer 2** (`rdsh-tunnel`) runs between
hub and gateway only — clients never implement it.

## Components

| Component | Name | Role |
|---|---|---|
| CLI | `rdsh` | `rdsh serve` (LAN) / `rdsh join <hub>` (public) / `rdsh hub ...` |
| Server | rdsh-hub | control plane (auth, host registry, routing) + data plane (tunnel relay) |
| Host agent | rdsh-gateway | LAN auth gateway / outbound tunnel endpoint; spawns `dsh web` |
| Tunnel protocol | rdsh-tunnel | wire protocol: framing, multiplexing, heartbeat |
| Portal | rdsh-portal | web login + host list (Vite + React) |
| Mobile app | rdsh-app | Flutter (Android/iOS) |
| WeChat mini program | rdsh-weapp | lightweight client |

## Status

**M1–M3 complete** (2026-08-23): the LAN gateway (`rdsh host serve`), cloud-server
direct access (TLS + password), and the public hub (`rdsh host join` + `rdsh hub` +
portal) are implemented and verified (unit 92/92, e2e M3 23/23, M1/M2 regression
57). Next milestone: **M4 dsh-plugin-rdsh** (gateway/join as a DSH plugin — no
CLI install).

## Features

Implemented `[x]` · planned `[ ]` — from the user's point of view

**M1 — Use DSH from any device on your network (implemented)**
- [x] Open your DSH in a browser on another laptop or phone — no SSH, no setup
- [x] Secure pairing: type the code shown in your host terminal, once
- [x] No account needed — the pairing code is your key
- [x] Full DSH experience: chat, run tools, browse files, live event stream
- [x] Stay signed in for 12 hours — no re-pairing on the same device
- [x] Unauthorized devices are locked out until they pair
- [x] One command to start: `npm i -g remote-dsh && rdsh serve`
- [x] Optional `--no-code` for fully trusted networks
- [x] Quit cleanly (Ctrl+C / close terminal) — no leftover processes

**M2 — Run it on a rented cloud server (e.g. Alibaba Cloud) (implemented)**
- [x] HTTPS (TLS) — secure direct access over the public internet (user-provided cert)
- [x] Deploy behind Apache2 / nginx reverse proxy (TLS terminated by the proxy; standard port 443, auto-renewed certs)
- [x] User/password sign-in (`rdsh user add/passwd`; scrypt-hashed; changing password revokes all sessions)
- [x] IP allow-list (`allowFrom` in config file) for extra hardening
- [x] Config file (default `~/.rdsh/config.json`, or `--config <path>` / `$RDSH_CONFIG`)
- [x] Run as a system service (systemd / launchd — auto-start on boot)

**M3 — Use DSH from anywhere via the hub (implemented)**
- [x] Reach any of your machines from the internet — no public IP or router setup (`rdsh join` outbound tunnel)
- [x] One account, manage multiple machines (hosts belong to the account; registration closed, admin-created users)
- [x] Web portal to see and pick your machines (login / host list / enter DSH / change password / revoke)
- [x] Pair-code binding (`rdsh join` prints a code; enter it in the portal) or `--token` for scripting
- [x] Instant revocation — a revoked host token drops the tunnel and blocks reconnects
- [x] Frozen wire protocol (layer 2, `packages/tunnel/PROTOCOL.md`) and public API (layer 1)
- [x] Run the hub with built-in TLS, or behind Apache2 / nginx (443, auto-renewed certs)

**M4+ — Planned**
- [ ] Use it as a DSH plugin: add it with `dsh plugin add` — remote access with no CLI install
- [ ] Mobile apps (Android / iOS)
- [ ] WeChat mini program
- [ ] Share a machine with your team
- [ ] End-to-end encrypted sessions

## Quick start

```bash
npm install -g remote-dsh   # alongside dsh; command is `rdsh`
rdsh host setup lan         # LAN: configure this machine as an auth gateway
rdsh host serve             # run it (spawns dsh web)
rdsh host join <hub-url>    # or connect to a hub (outbound tunnel)
```

LAN: open `http://<your-ip>:<port>`, enter the pairing code from your terminal.
Public: open the hub URL, sign in, pick a machine — full DSH in the browser.

## Blog

Scenario guides, from simple to complex — full index: [English](doc/blog/README.md) · [中文](doc/blog/README.zh.md)

- [Control your DSH from any device on the same LAN (pair code)](doc/blog/en/01-01-lan-access.md)
- [Put your DSH on a cloud server: HTTPS + password (own cert)](doc/blog/en/02-01-cloud-single-tls.md)
- [No public IP? Relay through a hub — add a host with a join token (recommended)](doc/blog/en/03-04-join-token.md)
- [Run your own hub relay: hub + Apache2 (443 + auto-renewed certs)](doc/blog/en/03-02-hub-behind-apache-https.md)

## Development

- Node.js ≥ 22 (see `.nvmrc`), pnpm ≥ 9
- TypeScript monorepo (`packages/*`), Flutter app (`apps/app`), WeChat mini
  program (`apps/weapp`), future Go hub (`go/`)
- See [CONTRIBUTING.md](CONTRIBUTING.md) and the internal docs under `doc/`

## License

MIT — see [LICENSE](LICENSE). Brand assets (logo, name) are excluded — see [NOTICE](NOTICE).
