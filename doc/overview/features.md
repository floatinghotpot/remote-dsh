# Feature List (features)

**English** | [中文](features.zh.md)

> **Date**: 2026-08-29
> **Scope**: user-facing feature catalog — implemented `[x]` · planned `[ ]`. See [roadmap.md](roadmap.md) for milestone progress, decisions, and acceptance; [usage.md](usage.md) for install/configuration/operations.

## Features

**M1 — Use DSH from any device on your network (implemented)**
- [x] Open your DSH in a browser on another laptop or phone — no SSH, no setup
- [x] Secure pairing: type the code shown in your host terminal, once
- [x] No account needed — the pairing code is your key
- [x] Full DSH experience: chat, run tools, browse files, live event stream
- [x] Stay signed in for 12 hours — no re-pairing on the same device
- [x] Unauthorized devices are locked out until they pair
- [x] Three commands to start: `npm i -g remote-dsh` → `rdsh host setup lan` → `rdsh host serve`
- [x] Optional no-auth mode (`auth.mode: "none"`, fully trusted networks only)
- [x] Quit cleanly (Ctrl+C / close terminal) — no leftover processes

**M2 — Run it on a rented cloud server (e.g. Alibaba Cloud) (implemented)**
- [x] HTTPS (TLS) — secure direct access over the public internet (user-provided cert)
- [x] Deploy behind Apache2 / nginx reverse proxy (TLS terminated by the proxy; standard port 443, auto-renewed certs)
- [x] User/password sign-in (`rdsh host user add/passwd`; scrypt-hashed; changing password revokes all sessions)
- [x] IP allow-list (`allowFrom` in config file) for extra hardening
- [x] Config file (default `~/.rdsh/host.json`, or `--config <path>` / `$RDSH_CONFIG`)
- [x] Run as a system service (systemd / launchd — auto-start on boot)

**M3 — Use DSH from anywhere via the hub (implemented)**
- [x] Reach any of your machines from the internet — no public IP or router setup (`rdsh host join` outbound tunnel)
- [x] One account, manage multiple machines (hosts belong to the account; registration closed, admin-created users)
- [x] Web portal to see and pick your machines (login / host list / enter DSH / change password / revoke)
- [x] Join flow (`rdsh host join <hub>` pastes the token from the portal, or `--token` for scripting)
- [x] Instant revocation — a revoked host token drops the tunnel and blocks reconnects
- [x] Frozen wire protocol (layer 2, `packages/tunnel/PROTOCOL.md`) and public API (layer 1)
- [x] Run the hub with built-in TLS, or behind Apache2 / nginx (443, auto-renewed certs)

**M4 — Use it as a DSH plugin (implemented)**
- [x] `dsh plugin add dsh-web-remote` — remote access with no CLI install (a "Remote Access" panel in the DSH UI: connect / disconnect / revoke + live status)

**M5 — Multi-tenant hardening (implemented)**
- [x] Email verification + password reset (configurable SMTP / Aliyun DirectMail / local log)
- [x] Two-factor authentication (TOTP)
- [x] Share a machine with your team (owner / member — member can use the DSH but not manage)
- [x] Audit log (`rdsh hub audit ls`)
- [x] Login rate-limiting (account lockout 10 fails / 15 min + send-email limits + arithmetic captcha)

**E2EE — End-to-end encryption (implemented, community + SaaS)**
- [x] The hub relays your DSH traffic but cannot read the content (prompts / code / files / API keys stay encrypted)
- [x] Noise NK handshake (X25519 + AES-256-GCM), fresh session keys per connection, forward secrecy
- [x] Trust the host fingerprint on first use (TOFU), alert on fingerprint change; pin stored locally only, never on the hub
- [x] Hub switch `e2ee.mode: off|optional|required` (default optional), legacy hosts fall back to plaintext

**Host access code — host-side gate (implemented)**
- [x] Optionally protect a host with a code set on the host itself — independent of the hub account
- [x] Visitors pass a challenge page; the code is verified on the gateway (constant-time), never sent to the hub
- [x] 7-day signed cookie (HMAC-SHA256, key derived from the code); changing the code revokes all cookies
- [x] Global rate-limit on wrong codes; local 127.0.0.1 access always allowed (recovery)
- [x] Set from the CLI (host.json `gateway.accessCode`) or the DSH plugin panel (instant apply)

**M6+ — Planned**
- [ ] Managed hub (SaaS: open sign-up, subscription billing, WeChat/Alipay payments)
- [ ] Mobile apps (Android / iOS)
- [ ] WeChat mini program
