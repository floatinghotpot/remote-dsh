# remote-dsh

Make your DeepSeek Harness available anywhere.

![rdsh logo](media/rdsh256.png)

**remote-dsh** adds a secure remote-access layer on top of
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH):
run `dsh web` as usual on your machine, then operate it from any device —
another laptop or phone in the same LAN, and (with the hub) from anywhere on
the internet.

## Status

MVP in progress: the LAN gateway (`rdsh serve`) is the first milestone.
See [doc/feature/01-remote-access](doc/feature/) for the requirements pipeline
and [doc/marketing/proposal.md](doc/marketing/proposal.md) for the full product
proposal.

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
        │  HTTPS/WSS — layer 1: hub public API
        ▼
    rdsh-hub  ◄──── WSS tunnel — layer 2: rdsh-tunnel ──── rdsh-gateway ──► dsh web (127.0.0.1)
```

Two protocol layers: **layer 1** (hub public API, JSON over HTTPS + WSS events)
is the only contract clients implement; **layer 2** (`rdsh-tunnel`) runs between
hub and gateway only — clients never implement it.

## Development

- Node.js ≥ 22 (see `.nvmrc`), pnpm ≥ 9
- TypeScript monorepo (`packages/*`), Flutter app (`apps/app`), WeChat mini
  program (`apps/weapp`), future Go hub (`go/`)
- See [CONTRIBUTING.md](CONTRIBUTING.md) and the internal docs under `doc/`

## Maintainers

- [Liming Xie](https://github.com/floatinghotpot) — liming.xie@gmail.com

## License

MIT — see [LICENSE](LICENSE). Brand assets (logo, name) are excluded — see [NOTICE](NOTICE).
