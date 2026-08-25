# Changelog

**English** | [中文](CHANGELOG.zh.md)

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [rdsh-hub 0.4.0] - 2026-08-24

### Added

- M5 multi-tenant: email verification + password reset (configurable `EmailSender` — `smtp`/`aliyun`/`log`), TOTP 2FA, host sharing (owner/member), audit log (`rdsh hub audit ls`), account lockout (10 fails / 15 min, `rdsh hub user unlock`), and send-email rate limiting (per-recipient / per-trigger / global).
- Config: `hub.json` gains `email`, `captcha`, `security` sections. Email is the first external service dependency (`nodemailer` for smtp; the `aliyun` provider hand-writes DirectMail's RPC signature — zero dependency).

## [rdsh-gateway 0.4.0 · dsh-web-remote 0.1.0] - 2026-08-24

### Added

- M4 plugin `dsh-web-remote@0.1.0` (new package): `dsh plugin add dsh-web-remote`
  installs a "Remote Access" panel in the DSH web UI (join / disconnect / revoke
  + live status), reusing the join tunnel without the rdsh CLI. The server half
  runs the tunnel in-process and exposes a `/remote-access` RPC channel; the
  client half renders the settings section.
- `rdsh-gateway@0.4.0`: `startJoin()` — the join tunnel as a reusable in-process
  core (no spawn, external target, `stop()` handle, `onState`/`onLog` hooks);
  `join()` stays as the CLI wrapper. Added the join pid lock
  (`~/.rdsh/join.lock`) enforcing one tunnel per host across CLI and plugin.

## [0.2.0] - 2026-08-23

### Added

- M1 MVP: `rdsh serve` LAN auth gateway — pairing code + signed session cookie,
  full-duplex HTTP/SSE/WebSocket forwarding, auto-spawns `dsh web`.
- `--no-code` to skip pairing on fully trusted networks (with warning).
- Runtime fixes: secure-context polyfill (`crypto.randomUUID` on plain http),
  DSH host-fence compatibility (Host + Origin rewrite), graceful shutdown
  (SIGINT/SIGTERM/SIGHUP), no orphan `dsh` processes.
- Published `rdsh-gateway@0.1.0` + `remote-dsh@0.2.0` to npm.

## [0.1.0] - 2026-08-22

### Added

- Name-reservation release: `remote-dsh@0.1.0` published to npm.
- Monorepo skeleton: `packages/{tunnel,gateway,hub,cli,portal}`, `apps/{app,weapp}`, `go/`, `e2e/`.
- Open-source docs: LICENSE (MIT), README (en/zh), CONTRIBUTING, CODE_OF_CONDUCT, NOTICE, CI workflow.
- Product proposal (`doc/overview/proposal.md`) with decided roadmap Q1–Q10.

## [0.5.0] - 2026-08-24

### Added

- Component-oriented CLI: `rdsh host {setup lan|cloud, join, serve, service, leave, user}`; `rdsh hub` unchanged. (`remote-dsh@0.5.0`)
- `~/.rdsh/host.json` (mode `lan` | `cloud` | `join`) replaces `config.json` with automatic migration.
- User-level join token: generate / copy / list / revoke in the portal (30-day default, 1d–1y configurable, shown once, hash-only). (`rdsh-hub@0.3.0`)
- `POST /api/hosts/register` (join token → host token, rate-limited, idempotent for host tokens) + `POST /api/hosts/self-revoke`.
- `rdsh host join` interactive token paste; TLS certificate auto-detection (no `--insecure` needed).
- Portal "add host" page (generate + copy join command or token, list/revoke tokens).
- Distinct service names (`rdsh-host` / `rdsh-join` / `rdsh-hub`), with node's PATH injected into host service units (nvm fix, `#! /usr/bin/env node` 127). (`rdsh-gateway@0.3.0`)

### Removed (breaking)

- Pair-code join flow (`--code`, `/api/hosts/pending` + `/api/hosts/bind`) — join now uses only the join token; pair code remains only for the LAN/cloud gateway's pair auth.
- Old top-level `rdsh serve` / `rdsh join` / `rdsh user` / `rdsh service` commands.

## [0.4.9] - 2026-08-24

### Fixed

- DSH host access no longer dies at the 1-hour access-token expiry: entering a
  host (`/h/<hostId>`) now sets an HMAC-signed cookie (7-day, bound to the
  user's session version), so the relay authenticates from that cookie instead
  of re-checking the short-lived access token. Changing the password bumps the
  version and invalidates the cookie immediately. (`rdsh-hub@0.2.4`)
- `rdsh join` now persists the host token to `~/.rdsh/join-*.token` (0600) and
  reuses it on restart, so a gateway restart no longer forces re-pairing or
  accumulates dead host entries on the hub. A revoked token (401) falls back to
  the pair-code flow automatically; `--reset` forgets the persisted token.
  A rejected explicit `--token` exits with a clear error instead of silently
  retrying forever. (`rdsh-gateway@0.2.3`)

## [0.4.7] - 2026-08-24

### Fixed

- WebSocket relay now forwards DSH WS messages as text frames. The tunnel sent
  them as binary, so the DSH frontend dropped them ("malformed binary WebSocket
  frame") and the UI never refreshed live — you had to reload to see new output.

## [0.4.6] - 2026-08-24

### Fixed

- Portal assets are now bundled inside the hub package (built from
  packages/portal/dist at build time). npm-installed hubs previously served
  `/portal` as 404 because the dist lived only in the workspace.

## [0.4.5] - 2026-08-24

### Fixed

- Resident commands (`rdsh serve` / `rdsh join` / `rdsh hub serve`) keep the
  process alive again: the 0.4.3 explicit-exit fix made them return and exit
  after printing the startup banner. They now await a never-resolving promise
  and exit only via signals (management commands still exit cleanly).

## [0.4.4] - 2026-08-24

### Fixed

- `rdsh hub serve` (and other hub commands) without `--config` now resolve the
  hub config path (`~/.rdsh/hub.json`) correctly. parseGlobal used the gateway
  resolver (`~/.rdsh/config.json`), so the hub silently fell back to an empty
  config and refused to start ("hub requires TLS").

## [0.4.3] - 2026-08-23

### Fixed

- Management commands (user/hub/service) now exit explicitly after finishing —
  a leftover TTY stdin / handle kept the process hanging after interactive
  password entry (visible on real terminals, e.g. password retry).

## [0.4.2] - 2026-08-23

### Added

- Hub `behindProxy` mode: run rdsh-hub behind Apache2/nginx (plain http on
  localhost, trust X-Forwarded-For from loopback only — rate limiting by real IP).
- Blogs 03-02/03-03: deploy the hub behind Apache2 / nginx (443 + auto-renewed certs).

## [0.4.1] - 2026-08-23

### Fixed

- `rdsh --version` now reads the version from package.json (was hardcoded,
  showed 0.2.0 after the 0.4.0 publish).

## [0.4.0] - 2026-08-23

### Added (M2 — cloud-server direct access)

- HTTPS with user-provided certs (`tls.cert/key`); no cert = plain http;
  `auth.mode: password` refuses to start without TLS (unless behindProxy).
- Password auth: scrypt hashes, login page, rate limiting (5/10min),
  password change revokes all sessions (versioned).
- Config file (`~/.rdsh/config.json`, `--config` / `$RDSH_CONFIG`), IP
  allow-list (`allowFrom` CIDR), systemd/launchd service templates.
- CLI: `serve` subcommand, `rdsh user add/passwd/ls/rm`, `rdsh service ...`.

### Added (M3 — public hub)

- Public hub: `rdsh hub serve` (TLS required, SQLite control plane, portal static hosting).
- Layer 2 wire protocol frozen v1 (`packages/tunnel/PROTOCOL.md`): framing,
  payload encoding (open/data/close/ping/pong/error), E2E reserved flag passthrough.
- Layer 1 public API frozen: auth (login/refresh/logout/password/first-password),
  hosts (list/pending/bind/rename/revoke), WSS `/api/events`, `/h/<hostId>` relay.
- `rdsh join <hub-url>`: outbound tunnel — pair-code binding (10 min, portal) or
  `--token` for scripting; heartbeat; exponential-backoff reconnect; `--insecure`
  for self-signed hubs.
- `rdsh hub user add/passwd/rm/ls` (registration closed — admin-created users
  block bots/spam), `rdsh hub host ls/revoke` (instant tunnel drop), `rdsh hub service ...`.
- Portal (React): login, host list with live online status, bind, rename, revoke,
  change password, iframe host view (`/h/<hostId>`).
- Multi-user host ownership with isolation; JWT sessions with ver-based instant
  revocation; host/refresh tokens stored as SHA-256 hashes.
- Host access serves DSH at the root path: enter via `/h/<hostId>` (validate →
  Set-Cookie `rdsh_host` → 302 root); DSH absolute paths (/assets, /api) work
  unmodified. Portal moved to `/portal`. One browser context is on one host at
  a time (cookie); multiple users/browsers are independent.
- Fixes: HTTP method relay through tunnel (POST was downgraded to GET), stream
  lifecycle (GET responses hung), pending-code rate limiting, join findDsh,
  TLS handling for self-signed hubs.

## [0.2.0] - 2026-08-23
