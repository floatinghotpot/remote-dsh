# Add a new host to your hub with a join token: generate in portal, one command on the machine

**中文版**：[中文](../zh/03-04-join-token.md)

> 2026-08-24 · remote-dsh 0.4.9+ (dev, 04/05 features, unreleased)
> Server-relay series: ⑤ hub public access → **this post: one-click join with a join token (recommended)**

---

## The scenario

Hub onboarding originally used a **pair code**, but the code requires "**someone at a browser to type it**" — awkward for headless cloud servers and for machines run as systemd services (see [usage.md §8.5 service tips](../overview/usage.md#85-服务化要点)): the code only lands in the journal and expires in 10 minutes. **That flow was removed in the 04/05 refactor (token-only)** — onboarding is now unified on join tokens:

**Join tokens** reduce onboarding to two steps:

```
hub portal「Add host」→ generate an access command (one-time join token, shown once)
  → paste & run it on the machine → registered → host goes online
```

- **Self-service**: the token belongs to your hub account — no admin involvement;
- **Service-friendly**: `rdsh host service install <hub> --token <t>` registers and installs the always-on service in one line; **the unit never contains the token**;
- **Restart without re-pairing**: after registration the host token is persisted and reused automatically;
- **Token-only**: the pair-code flow was removed in the 04/05 refactor — all onboarding goes through join tokens.

## Architecture

```
Browser (your account)                  Machine (headless / service)
   │ sign in to hub                        │
   ├─「Add host」→ generate join token ────► paste & run:
   │                                       │   rdsh host service install <hub> --token <t>
   │                                       │   or rdsh host join <hub> --token <t>
   │                                       ▼
   │   POST /api/hosts/register (token auth, IP rate-limited)
   │  ◄────────── hostId + hostToken ──────┘
   │   establish wss tunnel (host token persisted, restart-safe)
   ▼
hub list shows the host online ●
```

## Steps

### ① Generate the access command in the portal

1. Open `https://hub.example.com` in a browser → sign in;
2. Go to「**Add host**」→ enter the **machine name** (e.g. `my-ecs`; defaults to the hostname, editable);
3. Tick「**Always-on service**」(for boot-start + crash-restart; leave unticked for foreground);
4. Pick the **TTL** (default 30 days; 1d/7d/30d/90d/1y available);
5. Click「Generate」→ the access command is **shown only once** → click「Copy command」.

The command looks like:

```bash
# Always-on service (recommended for headless / unattended):
rdsh host service install https://hub.example.com --token <t> --name my-ecs

# Foreground (debugging / someone at the machine):
rdsh host join https://hub.example.com --token <t> --name my-ecs
```

### ② Paste & run it on the machine

```bash
# If rdsh is not installed yet:
npm i -g remote-dsh

# Paste the copied command (service variant):
rdsh host service install https://hub.example.com --token <t> --name my-ecs
```

One line does everything: **register (token-authenticated) → write host.json (mode: join) → generate and start `rdsh-join.service`** (the unit runs `rdsh host serve` and **never contains the token**).

```bash
systemctl --user status rdsh-join        # active (running)
journalctl --user -u rdsh-join -f        # expect: tunnel established (heartbeat 30s)
```

### ③ Verify + daily ops

- Hub portal host list: new host **online ●**;
- Reboot/restart: **recovers automatically, no re-pairing** (log: `reusing persisted host token`);
- Foreground variant: after `rdsh host join`, run `rdsh host serve` to bring up the tunnel;
- Unregister: `rdsh host leave`.

## Join token semantics (important)

| Item | Description |
|---|---|
| Ownership | **your hub account** (registered hosts belong to you; others get 403) |
| TTL | 30 days default; 1d/7d/30d/90d/1y selectable |
| Shown once | plaintext appears once in the portal; **the server stores only SHA-256** |
| Revocable | revoke anytime from the portal list → **only blocks future registrations**, existing hosts are unaffected |
| Multi-machine | **one token can register several hosts** (each gets its own host token) |
| Security | register endpoint is IP rate-limited; treat the token like a password |

## Onboarding approaches (token-only)

The pair-code flow was removed in the 04/05 refactor; onboarding is unified on join tokens:

| Approach | Use case |
|---|---|
| **`rdsh host service install <hub> --token <t>`** (this post, recommended) | service/headless/many machines, nobody at the machine |
| `rdsh host join <hub>` (interactive paste) or `--token <t>` | foreground / debugging |

## Notes & gotchas (production-tested, 2026-08-24, Alibaba Cloud ECS)

- **nvm-managed Node**: the systemd service environment's default PATH lacks the node dir, so `dsh` may fail to start (code 127) — see the PATH section of [usage.md §8.5 service tips](../overview/usage.md#85-服务化要点) for the drop-in workaround (reported as a bug; a future release will handle it automatically);
- Self-signed hub: add `--insecure` (unneeded with a proper cert);
- Expired/revoked token → registration 401; already-registered hosts are unaffected;
- Several machines can register with the same token and are managed separately in the portal.

## About the project

- GitHub: [github.com/floatinghotpot/remote-dsh](https://github.com/floatinghotpot/remote-dsh)
- Install: `npm i -g remote-dsh` (MIT license, open source)
