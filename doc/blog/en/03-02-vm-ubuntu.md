# Remote-control the DSH agent inside a VM: no network changes, one `rdsh join`

> 2026-08-23 · remote-dsh 0.4.1
> Scenario series: ① LAN control → ②/③/④ Cloud-server deployment → ⑤ Public hub → **⑥ Virtual machines (this post)** → ⑦ Embedded Linux

**中文版**：[中文](../zh/03-02-vm-ubuntu.md)

---

## The scenario

Your DSH agent runs inside a **virtual machine** — an Ubuntu under VMware Workstation / Fusion, VirtualBox, Parallels, or Hyper-V — rather than on bare metal.

VMs default to **NAT networking**: the VM hides behind the host, with **no public IP of its own**, and LAN devices can't reach it. Switching to bridged mode means fiddling with the hypervisor and the router.

**The easy path: don't touch the network — let the VM connect out to a hub.** One `rdsh join` command, and you can reach that VM's DSH from anywhere.

## Option A (recommended): keep NAT, use `rdsh join` (hub outbound tunnel)

Inside the VM (zero network-config changes):

```bash
npm install -g remote-dsh
rdsh join https://hub.example.com
```

A 6-digit pairing code is printed → sign in to the hub in the browser → enter the code → bind → access this VM's DSH from anywhere.

- The VM connects **outbound only** — no ports opened on the host or corporate network
- NAT / bridged / host-only networking **all work** — you don't care which mode it is
- Hub setup: [⑤ No public IP? One URL to remote-control every DSH agent you own](../en/03-01-hub-public.md)

## Option B (alternative): bridged mode → `rdsh serve` (LAN direct)

If you only need LAN access and the VM is already **bridged** (its own LAN IP on the same subnet as the host):

```bash
npm install -g remote-dsh
rdsh serve
# From another device: http://<VM-IP>:8443, enter the pairing code
```

Good for quick same-Wi-Fi access; downside: you must switch the VM to bridged mode first (default NAT won't work).

## Manage several VMs at once

One host running several VMs, each with its own DSH? Run `rdsh join` in each; the portal lists them all:

```
hub portal
 ├─ ● dev-ubuntu-vm1   （Ubuntu in VMware, NAT outbound）
 ├─ ● build-vm2        （VirtualBox, NAT outbound）
 └─ ● raspberry-pi     （Raspberry Pi, see post ⑦）
```

## Notes

- **Snapshots / suspend**: the tunnel drops while the VM is suspended and `rdsh join` reconnects automatically — nothing to do
- **Resources**: DSH needs CPU/RAM; give the VM 2G+ RAM to be safe
- **Clock sync**: VM clock drift can break JWT session validity — enable time sync (VMware Tools / guest additions)
- **Tested**: the `rdsh join` tunnel is verified by M3 acceptance (real dsh + hub); VM networking follows the hypervisor's docs

## About the project

- GitHub: [github.com/floatinghotpot/remote-dsh](https://github.com/floatinghotpot/remote-dsh)
- Install: `npm i -g remote-dsh` (MIT license, open source)
