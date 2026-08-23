# Remote-control DSH on an embedded Linux (Raspberry Pi) from anywhere: one `rdsh join` (concept, not yet tested)

> 2026-08-23 · remote-dsh 0.4.1
> Scenario series: ① LAN control → ②/③/④ Cloud-server deployment → ⑤ Public hub → ⑥ Virtual machines → **⑦ Embedded Linux (this post)**

**中文版**：[中文](../zh/03-03-embed-linux.md)

> ⚠ **This post is a concept and has NOT been tested on a real Raspberry Pi / embedded board** (as of 2026-08-23). The steps build on rdsh's verified capabilities (M3 hub tunnel) and general Linux experience; dsh's ARM support depends on the official release.

---

## The scenario

Run a **Raspberry Pi** (or similar ARM embedded Linux board) as an always-on, low-power DSH agent — a little "home server".

A Pi is usually: **on Wi-Fi/ethernet, no public IP, headless**. That matches [⑤ No public IP? One URL to remote-control every DSH agent you own](../en/03-01-hub-public.md) exactly — **`rdsh join` outbound tunnel** is the natural way in.

## Proposed steps

### ① Install Node.js ≥ 22 on the Pi (ARM64)

```bash
# Raspberry Pi OS (64-bit) example; nodejs.org ships official arm64 builds
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # v22.x
```

- Older Pis (32-bit OS / armv7): Node's armv7 support is limited — verify the matching version
- Check the arch: `uname -m` (aarch64 = ARM64)

### ② Install dsh + remote-dsh

```bash
npm install -g remote-dsh
# dsh: follow the DeepSeek Harness official install; ARM support per official release
dsh --version
```

### ③ Join the hub (one command)

```bash
rdsh join https://hub.example.com
# pairing code printed → sign in to the hub, enter the code, bind → reach the Pi's DSH from anywhere
```

Headless is fine: once bound it lives in the hub portal; after a reboot `rdsh join` reconnects automatically (ideally keep it running with a service — see below, treat specifics as untested).

### ④ Run it persistently

```bash
# Concept: user-level systemd service (auto-start + restart on crash)
rdsh service install   # generates a systemd/launchd unit (exact behavior TBD)
```

## Resource considerations (concept)

| Board | Feasibility (concept) | Notes |
|---|---|---|
| Raspberry Pi 4B/5 (4G+ RAM) | Likely | DSH needs CPU/RAM; 4G models are safer |
| Pi 3B+ / Zero 2W | Doubtful | 1G RAM; LLM calls / workflows may struggle |
| Other ARM boards (Rockchip/Allwinner, etc.) | Depends | Needs 64-bit OS + Node 22 support |

## Why the hub (not direct access)

The Pi sits behind home NAT on Wi-Fi with no public IP; `rdsh serve` is LAN-only. For public access, **an outbound tunnel is the only way that needs no public IP / port forwarding** — the same architecture as post ⑤.

## Untested items (honest list)

- Installing/running dsh on ARM64 Raspberry Pi OS (per official release)
- Real usability on low-RAM boards (1G)
- `rdsh service install` behavior on the Pi's systemd (template targets desktop Linux)

If you've tried it on a real Pi, tell us how it went and we'll update this post.

## About the project

- GitHub: [github.com/floatinghotpot/remote-dsh](https://github.com/floatinghotpot/remote-dsh)
- Install: `npm i -g remote-dsh` (MIT license, open source)
