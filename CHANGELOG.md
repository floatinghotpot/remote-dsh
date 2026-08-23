# Changelog

**English** | [中文](CHANGELOG.zh.md)

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
