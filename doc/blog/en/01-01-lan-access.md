# Control your DSH agent on the dev machine from your phone / laptop / desktop, at home or in the office (LAN)

> 2026-08-23 · remote-dsh ≥ 0.5.0 (commands per the 0.5.0 command tree)
> Scenario series: ① LAN remote control (this post) → ② Cloud server → ③ Multi-machine / team → ④ Mobile

**中文版**：[中文](../zh/01-01-lan-access.md)

---

## The scenario

Your dev machine (or build machine) runs a **DeepSeek Harness (DSH) agent** — it understands your tasks, calls tools, reads/writes files, runs shell commands, and executes workflows.

But it's locked to that one machine.

- **At home**: the agent runs on your dev machine in the study; you're on the sofa — want to send it a new task from your phone, or watch what it's doing?
- **In the office**: the agent runs on your workstation; you're at a meeting or another desk with a laptop — want to keep driving it?
- **Build machine**: your team has a dedicated build machine running DSH for automation — you need to operate it from any computer?

**remote-dsh (rdsh)** does exactly this: one command turns **any device (phone / laptop / desktop)** into a remote control for your DSH agent, over the local network.

## Install (once)

```bash
npm install -g remote-dsh
```

Requirements: Node.js ≥ 22; `dsh` installed (in PATH) on the machine running the agent.

## Start remote-controlling in three steps

**① Start the remote-control service on the agent machine:**

```bash
rdsh host setup lan           # writes ~/.rdsh/host.json (mode: lan, default 0.0.0.0:8443)
rdsh host serve               # runs in the foreground, spawns dsh web
```

The terminal shows:

```
rdsh serve: gateway on http://172.20.6.203:8443
rdsh serve: LAN: http://172.20.6.203:8443, ...
rdsh serve: dsh web on 127.0.0.1:57067
rdsh serve: pair code: 815858
rdsh serve: enter the pair code in the browser on your other device.
```

**② On the controlling device (phone / laptop / desktop, same Wi-Fi), open** `http://172.20.6.203:8443` in the browser:

- You'll see the **rdsh pairing page** (the auth gate — not the DSH UI)
- Enter the 6-digit pairing code shown in the agent machine's terminal

**③ You're in the full DSH agent UI — full remote control:**

- Send the agent new tasks, continue conversations
- Watch it call tools, run shell, write files — in real time
- Browse / manage the agent's workspace files
- Live event stream (you always see what the agent is doing)

## The pairing code = your remote-control key

The pairing code is **only shown in the agent machine's terminal** — it's a "physical trust anchor": only the person sitting in front of the agent machine can see it. The code **never travels over the network**, so Wi-Fi sniffers can't capture it (like Bluetooth pairing PINs, or the admin password sticker on a router).

- After pairing, the device gets an **HttpOnly session cookie (12 hours)** — no re-pairing on the same device
- **Unpaired devices** stay on the pairing page forever — strangers can't touch your agent
- Multiple devices (phone + laptop + desktop) can each sign in with the same pairing code

## Real-world experience (0.2.0, tested)

| Item | Experience |
|---|---|
| Pairing | Enter once; no re-pairing for 12 hours |
| Phone control | Full DSH UI (responsive) — chat / tools / files / live stream all work |
| Folder picker | Works (0.2.0 fixed the secure-context compatibility) |
| Large files / long tasks | Streamed transparently |
| Ctrl+C exit | Clean — no leftover dsh processes |

## Tips

```bash
rdsh host setup lan --port 9000          # change port (default 8443)
rdsh host setup lan --pair-code 123456   # preset pairing code (e.g. put it in team docs)
```

## Troubleshooting

| Problem | Fix |
|---|---|
| Where's the pairing code? | Terminal line `pair code:`; a restart generates a new one |
| Phone can't connect | Same Wi-Fi; allow incoming connections in macOS firewall; no AP isolation on router |
| Port in use | Pick another with `rdsh host setup lan --port` |
| Do I re-pair on a new device? | No — the code works for multiple devices; each has its own 12h session |

## Security notes (important)

- The DSH agent **has no auth of its own** (it can run arbitrary commands) — **the rdsh gateway is the only auth layer**; never expose it unprotected
- Plain-http on LAN is **by design**: the pairing code never crosses the network, cookies are HttpOnly signed sessions — low threat model
- **Don't** expose `rdsh host serve` (LAN mode, plain http) directly to the internet — for cloud servers use M2 (HTTPS + username/password), or put a TLS reverse proxy in front yourself

## Next: leaving home / the office?

Two scenarios, two paths:

| Scenario | Solution | Notes |
|---|---|---|
| Agent **deployed on a cloud server** (Alibaba Cloud ECS, etc.) | **M2 cloud-server direct access** | HTTPS + username/password + systemd service; direct public access ([cloud-server series ②/③/④](../en/02-01-cloud-single-tls.md)) |
| Agent **on a home machine** (no public IP), accessing it remotely while traveling | **M3 hub tunnel** | The agent connects **outbound** to the hub only — no ports exposed ([⑤ public hub post](../en/03-01-hub-public.md)) |

M2 (cloud-server direct access) and the M3 hub tunnel are both implemented — see the links above.

## About the project

- GitHub: [github.com/floatinghotpot/remote-dsh](https://github.com/floatinghotpot/remote-dsh)
- Install: `npm i -g remote-dsh` (MIT license, open source)
