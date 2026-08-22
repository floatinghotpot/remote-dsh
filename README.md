# remote-dsh

**English** | [中文](README.zh.md)

Make your DeepSeek Harness available anywhere.

![rdsh logo](media/rdsh256.png)

**remote-dsh** adds a secure remote-access layer on top of
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH):
run `dsh web` as usual on your machine, then operate it from any device —
another laptop or phone in the same LAN, and (with the hub) from anywhere on
the internet.

## Status

**M1 MVP complete** (2026-08-23): the LAN gateway (`rdsh serve`) is implemented
and verified on real devices. Next milestone: M2 cloud-server direct access (TLS).
See [doc/feature/01-remote-access](doc/feature/) for the requirements pipeline,
[doc/overview/roadmap.md](doc/overview/roadmap.md) for the roadmap, and
[doc/overview/proposal.md](doc/overview/proposal.md) for the full product
proposal.

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

**M2 — Run it on a rented cloud server (e.g. Alibaba Cloud) (planned)**
- [ ] HTTPS (TLS) — secure direct access over the public internet
- [ ] User/password sign-in (`rdsh user add/passwd`; scrypt-hashed; changing password revokes all sessions)
- [ ] IP allow-list (`allow_from` in config file) for extra hardening
- [ ] Config file (default `~/.rdsh/config.json`, or `--config <path>` / `$RDSH_CONFIG`)
- [ ] Run as a system service (systemd / launchd — auto-start on boot)

**M3 — Use DSH from anywhere (planned)**
- [ ] Reach any of your machines from the internet — no public IP or router setup
- [ ] One account, manage multiple machines
- [ ] Web portal to see and pick your machines

**M4+ — Planned**
- [ ] Mobile apps (Android / iOS)
- [ ] WeChat mini program
- [ ] Share a machine with your team
- [ ] End-to-end encrypted sessions

## Quick start (MVP)

```bash
npm install -g remote-dsh   # alongside dsh; command is `rdsh`
rdsh serve                 # starts a LAN auth gateway that spawns dsh web
```

Open `http://<your-ip>:<port>` from another laptop on the same network, enter
the pairing code shown in your terminal, and you are in.

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

## Blog

Scenario guides (中文 → [doc/blog/zh/](doc/blog/zh/), English → [doc/blog/en/](doc/blog/en/)):

- [Control your DSH agent from your phone, at home or in the office (LAN)](doc/blog/en/01-lan-access.md)
- Cloud-server deployment series (bilingual):
  - [② rdsh standalone + built-in TLS: remote-control from any browser](doc/blog/en/02-cloud-single-tls.md)
  - [③ Apache2 reverse proxy + acme.sh auto-renewed certs](doc/blog/en/03-cloud-apache-acme.md)
  - [④ nginx reverse proxy (shared port 443)](doc/blog/en/04-cloud-nginx.md)

## Development

- Node.js ≥ 22 (see `.nvmrc`), pnpm ≥ 9
- TypeScript monorepo (`packages/*`), Flutter app (`apps/app`), WeChat mini
  program (`apps/weapp`), future Go hub (`go/`)
- See [CONTRIBUTING.md](CONTRIBUTING.md) and the internal docs under `doc/`

## Maintainers

- [Liming Xie](https://github.com/floatinghotpot) — liming.xie@gmail.com

## License

MIT — see [LICENSE](LICENSE). Brand assets (logo, name) are excluded — see [NOTICE](NOTICE).
