# No public IP? One URL to remote-control every DSH agent you own

> 2026-08-23 · remote-dsh 0.4.0
> Scenario series: ① LAN control → ②/③/④ Cloud-server deployment → **⑤ Multi-machine + public hub (this post)** → ⑥ Mobile

**中文版**：[中文](../zh/03-01-hub-public.md)

---

## The scenario

Your DSH agents live on **multiple machines**:

- **Home dev machine** (in the study, no public IP)
- **Cloud server** (Alibaba Cloud ECS, running automation)
- **Old laptop** (office / lab, used as a build machine)

You want: **from anywhere, open one URL in the browser, sign in once, and switch between machines** — no IP bookkeeping, no router config, no per-machine HTTPS setup.

**rdsh hub does exactly this**: one public server acts as the "switchboard". Every machine connects to it **outbound only** (no public IP, no port forwarding), and you pick a machine from a web portal.

## How it relates to the earlier posts

| Option | Use case | Notes |
|---|---|---|
| [① LAN control](../en/01-01-lan-access.md) | Single machine, same Wi-Fi | `rdsh host serve` pairing code |
| [②③④ Cloud-server direct](../en/02-01-cloud-single-tls.md) | Single machine with a public IP | `rdsh host serve` + HTTPS / reverse proxy |
| **⑤ Public hub (this post)** | **Multiple machines, no public IP** | `rdsh host join` outbound tunnel + hub portal |

## Architecture

```
        Your browser (anywhere)
              │  https://hub.example.com (sign in → pick a machine)
              ▼
        rdsh-hub (public server: auth + routing)
         │         │         │
   wss tunnel  wss tunnel  wss tunnel   (layer 2 rdsh-tunnel, all outbound)
         ▼         ▼         ▼
   home dev     cloud       old laptop   (each runs rdsh host join + dsh web)
```

- Clients always talk to a single hub domain (one cert, simple setup)
- Machines connect **outbound only**: works behind NAT/firewalls, no public IP, no router setup
- The hub does **pure passthrough**: auth + routing only, never inspects traffic (each machine may run a different dsh version)

## Set it up in three steps

### ① Start the hub on a public server (once)

```bash
npm install -g remote-dsh
rdsh hub user add admin        # admin creates accounts (interactive password; registration is closed — blocks bots)
```

Write `~/.rdsh/hub.json` (TLS cert via acme.sh / Let's Encrypt / cloud vendor, same as the cloud-server posts):

```jsonc
{
  "port": 8443,
  "tls": { "cert": "/etc/letsencrypt/live/hub.example.com/fullchain.pem",
           "key":  "/etc/letsencrypt/live/hub.example.com/privkey.pem" }
}
```

```bash
rdsh hub serve --config ~/.rdsh/hub.json     # verify in the foreground
rdsh hub service install                     # or run as a service: systemd/launchd, auto-start
```

> A public hub requires TLS (`rdsh hub serve` refuses to start without a cert).

### ② Connect each machine (once per machine)

Machine join uses the **join-token** flow (the old pairing-code bind was removed in 04/05):

```bash
npm install -g remote-dsh
rdsh host join https://hub.example.com --token <join-token> --name my-mac
```

Where does the join token come from? Sign in to the hub portal → "**Add host**" → generate (shown once):

1. Sign in to `https://hub.example.com` → "Add host" → enter a **machine name** (defaults to hostname) → pick a **TTL** (default 30 days) → "Generate" → **copy the join command**;
2. Paste and run it on the machine (the command contains the one-time join token) → it registers and establishes its tunnel, appearing in your list;
3. To run it as a background service (auto-start + crash-restart): `rdsh host service install https://hub.example.com --token <t> --name my-mac`.

Full details (restart reuse, one token for several machines, revocation semantics) in [join token access](03-04-join-token.md). Repeat on all three machines — your list now shows them all with live online status.

### ③ Use it from anywhere

Open `https://hub.example.com` → sign in → see your machines (●online / ○offline) → click "Enter" → **the full DSH UI** (chat / tools / files / live event stream — WebSocket works through the tunnel too).

> Tip: one browser tab is on a single host at a time (switching is fine — back to the list, then enter another machine). To watch several machines side by side, use separate browsers / incognito windows. Different people on their own browsers are fully independent.

- Network drop or reboot? The machine reconnects automatically (exponential backoff), and the list updates live
- Rename a machine from the list; when done, "Revoke" it (tunnel drops instantly, reconnects are rejected)

## Real-world experience (0.4.0, tested)

| Item | Experience |
|---|---|
| Binding | Paste the join token once; the host token persists on the machine |
| Switching machines | In and out of the list, anytime |
| Remote access | Public https, same as being at home |
| Live stream | WebSocket relayed through the tunnel, execution visible in real time |
| Disconnects | Auto-reconnect; the list flips back to online |
| Revocation | Tunnel drops immediately, reconnects rejected (token void) |

## Security notes (important)

- **Registration is closed**: hub accounts are created only by the admin (`rdsh hub user add`) — bots/spam accounts can't sign up
- **Login rate limiting**: 5 failed attempts per IP → 10-minute lockout; counted by real IP
- **Password change**: self-service in the portal (verify current password) → **all logged-in devices drop instantly**; if forgotten, reset it yourself after binding an email (see [account security](03-06-account-security.md)), or the admin resets it
- **Host ownership**: a machine belongs to the account that bound it; others can't see it or access it (403)
- **Tokens**: JWT sessions (instant invalidation on password change / revoke); machine tokens stored only as SHA-256 hashes
- **Pure passthrough**: the hub never inspects business traffic; any dsh version per machine

## Ops commands

```bash
rdsh hub user add bob               # add a person
rdsh hub user passwd bob            # reset bob's password (all sessions revoked)
rdsh hub user ls|rm|unlock|reset-2fa   # unlock=unlock a locked account; reset-2fa=reset a user's 2FA
rdsh hub audit ls                   # audit log (login/password/share/email…)
rdsh hub host ls                    # all machines (with owner)
rdsh hub host revoke <hostId>       # revoke a machine
rdsh hub service status             # hub status
```

## Next steps

- **Share with your team**: grant a colleague access to a machine (M5 multi-tenant hardening, implemented: email verification, TOTP 2FA, host sharing, audit log, account lockout — see [usage.md §8.3](../overview/usage.md))
- **Mobile**: phone app / WeChat mini program connecting straight to the hub (later milestones)
- Curious about the protocol? Layer 1 (hub API) and layer 2 (tunnel protocol) are frozen contracts — see `packages/tunnel/PROTOCOL.md`

## About the project

- GitHub: [github.com/floatinghotpot/remote-dsh](https://github.com/floatinghotpot/remote-dsh)
- Install: `npm i -g remote-dsh` (MIT license, open source)
