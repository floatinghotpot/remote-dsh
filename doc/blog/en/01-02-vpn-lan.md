# On the road, still reach your home DSH: VPN back into the LAN, pairing code works as usual

> 2026-08-23 · remote-dsh 0.4.1
> Scenario series: LAN access — ① direct · **⑧ VPN back to the LAN (this post)**

**中文版**：[中文](../zh/01-02-vpn-lan.md)

---

## The scenario

You're traveling, but home (or the office) already has a **VPN** — WireGuard, OpenVPN, or a corporate VPN.

Once the VPN is up, your device is **effectively on the LAN** (it gets an internal IP and can reach internal resources). Accessing that home DSH agent is then **plain LAN play**: `rdsh serve` + pairing code, nothing to change.

No public hub to set up, no ports exposed — **the VPN handles the link, rdsh handles the auth.**

## Prerequisites

| Item | Notes |
|---|---|
| Home/office | A DSH host (Windows/Mac/Linux) with `remote-dsh` installed |
| VPN | WireGuard / OpenVPN / corporate VPN, reachable from outside |
| On the road | Laptop/phone with the VPN client |

## Three steps

### ① Start rdsh on the home host (as usual)

```bash
# On the host running DSH at home
rdsh serve
# Binds 0.0.0.0:8443 by default — reachable over the VPN subnet too
```

### ② Connect the VPN from your device

Confirm you got an internal IP:

```bash
# WireGuard example
sudo wg-quick up wg0
ip addr show wg0        # see a 10.x.x.x VPN-subnet IP
```

If you can ping the home host (or its VPN virtual IP), the link is up.

### ③ Browse + pairing code

```bash
# On the road, in the browser:
http://<home-host-IP>:8443
# Enter the pairing code shown in the home host's terminal → you're in DSH
```

The pairing code is **only shown in the home host's terminal** — a physical trust anchor, safe even inside the VPN tunnel.

## VPN backhaul vs the public hub

| Option | Use case | Notes |
|---|---|---|
| **VPN backhaul (this post)** | Already have a VPN at work/home | Reuse existing infra, zero extra deployment; `rdsh serve` pairing works as-is |
| [Public hub (`rdsh join`)](../en/03-01-hub-public.md) | No VPN | Outbound tunnel, no network config at all, one URL for all machines |

## Notes

- **Firewall**: allow 8443 (or another port) on the home host; make sure the VPN server/router doesn't block subnet-to-subnet traffic
- **Latency**: VPN link quality matters; the live event stream (WebSocket) stays smooth within a few hundred ms
- **Security**: rdsh's pairing code + HttpOnly session cookie are the auth layer; the VPN tunnel is the transport layer — keep both on
- **Tested**: `rdsh serve` LAN access is verified by M1 acceptance; VPN client connectivity is a generic networking step — follow your VPN's config

## About the project

- GitHub: [github.com/floatinghotpot/remote-dsh](https://github.com/floatinghotpot/remote-dsh)
- Install: `npm i -g remote-dsh` (MIT license, open source)
