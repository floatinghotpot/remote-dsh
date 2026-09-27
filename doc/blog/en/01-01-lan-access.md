# Control your DSH agent on the dev machine from your phone / laptop / desktop, at home or in the office (LAN)

> 2026-09-28 · remote-dsh ≥ 0.14 (commands per the current tree; since 0.14 LAN auth uses an **access code** instead of a pairing code)
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
rdsh host setup lan           # writes ~/.rdsh/host.json (mode: lan, default 0.0.0.0:8442) + generates an access code
rdsh host serve               # runs in the foreground, spawns dsh web
```

The terminal shows (the access code is **printed only once** — write it down):

```
rdsh: host 配置为 LAN 网关（访问口令，端口 8442）→ /Users/you/.rdsh/host.json
rdsh: 访问口令（请记录，可用 `rdsh host gate set` 修改）：Xy3kPq9vLm2
rdsh: 运行 `rdsh host serve` 前台启动，或 `rdsh host service install` 常驻。

rdsh serve: gateway on http://172.20.6.203:8442
rdsh serve: LAN: http://172.20.6.203:8442
rdsh serve: dsh web on 127.0.0.1:57067
rdsh serve: auth mode: accessCode
rdsh serve: 访问口令已启用（经隧道或直连访问都需先输入口令）。
```

**② On the controlling device (phone / laptop / desktop, same Wi-Fi), open** `http://172.20.6.203:8442` in the browser:

- You'll see the **rdsh access-code page** (the auth gate — not the DSH UI)
- Enter the **access code** from the agent machine's terminal

**③ You're in the full DSH agent UI — full remote control:**

- Send the agent new tasks, continue conversations
- Watch it call tools, run shell, write files — in real time
- Browse / manage the agent's workspace files
- Live event stream (you always see what the agent is doing)

## The access code = your remote-control key

The access code is **generated on the host and printed once** by `rdsh host setup lan` — a "physical trust anchor": only the person sitting in front of the agent machine can see it. The code **never travels over the network**, and changing it invalidates every previously issued cookie.

- Correct code → an **HttpOnly signed cookie (7 days)** — no re-entry on the same device
- **Devices that never entered the code** stay on the access-code page — strangers can't touch your agent
- Multiple devices (phone + laptop + desktop) can each sign in with the same code
- To rotate it: `rdsh host gate set` (old cookies die immediately)

## Real-world experience

- **Auth**: enter the access code once; no re-entry for 7 days.
- **Phone control**: Full DSH UI (responsive) — chat / tools / files / live stream all work.
- **Folder picker**: Works (secure-context compatibility handled gateway-side).
- **Large files / long tasks**: Streamed transparently.
- **Ctrl+C exit**: Clean — no leftover dsh processes.

## Tips

```bash
rdsh host setup lan --port 9000     # change port (default 8442; 0 = OS-assigned)
rdsh host gate set                  # set a new access code (old code + cookies die immediately)
rdsh host gate status               # check whether an access code is set
rdsh host gate clear                # clear it (⚠ the gateway then has NO auth — trusted networks only)
```

> **Why 8442?** The host gateway defaults to 8442 while the rdsh **hub** defaults to 8443 — separate ports, so running both on one machine never collides.

## Troubleshooting

- **Where's the access code?**: printed once by `rdsh host setup lan` (rotate with `rdsh host gate set`); stored in `~/.rdsh/host.json` (0600).
- **Forgot the code**: run `rdsh host gate set` again (old code and all issued cookies die immediately).
- **Phone can't connect**: Same Wi-Fi; allow incoming connections in macOS firewall; no AP isolation on router.
- **Port in use**: `rdsh host setup lan --port <n>` (or `"port": 0` to let the OS pick).
- **Do I re-auth on a new device?**: No — the same code works for multiple devices; each keeps its own cookie.

## Security notes (important)

- The DSH agent **has no auth of its own** (it can run arbitrary commands) — **the rdsh gateway is the only auth layer**; never expose it unprotected
- Plain-http on LAN is **by design**: the access code never crosses the network, cookies are HttpOnly signed sessions — low threat model
- **Expose it on trusted networks only**; after `gate clear` the gateway has no auth at all
- **Don't** expose `rdsh host serve` (LAN mode, plain http) directly to the internet — for cloud servers use HTTPS + username/password (below), or put a TLS reverse proxy in front yourself

## Next: leaving home / the office?

Two scenarios, two paths:

- **Agent deployed on a cloud server (Alibaba Cloud ECS, etc.)**: **cloud-server direct access**: HTTPS + username/password + systemd service; direct public access ([cloud-server series ②/③/④](../en/02-01-cloud-single-tls.md)).
- **Agent on a home machine (no public IP), accessing it remotely while traveling**: **rdsh cloud hub tunnel**: The agent connects **outbound** to the hub only — no ports exposed. Start with [create an rdsh.cn account](01-03-rdsh-account.md) → [get a join token](01-04-join-token.md).

## About the project

- GitHub: [github.com/floatinghotpot/remote-dsh](https://github.com/floatinghotpot/remote-dsh)
- Install: `npm i -g remote-dsh` (MIT license, open source)
