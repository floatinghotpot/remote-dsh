# Changelog

**English** | [中文](CHANGELOG.zh.md)

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [rdsh-gateway 0.8.2 · dsh-web-remote 0.5.1 · remote-dsh 0.10.2] - 2026-09-11

### Fixed

- `dsh-web-remote` (0.5.1): **the plugin no longer breaks `dsh web` on dsh `0.1.5-rc.2`**. `connection.rpc.handle(...)` — how the browser RPC channel used to be registered — reaches `owner.webServer` through a service shadow that cannot resolve `webServer` for third-party plugin rows on 0.1.5-rc.2, which aborts the whole plugin tree at boot (upstream regression, deepseek-harness discussion #5926). The channel is now a native `/remote-access` prefix route registered on `ctx.webServer`, with the `client-request`/`server-response` envelope and the connection service's own status semantics (404/415/413/400, `gateway/bad-request` inside a 200 for an invalid envelope or a `method` that disagrees with the path, 500 for a throwing handler) implemented in the plugin and the official Host/Origin + browser-session fence (`connection.requestRejection`) kept in front of it; the browser half is unchanged. Covered by protocol unit tests and smoke-tested on both dsh `0.1.2-rc.1` and `0.1.5-rc.2` from one code path (no version fork); the browser half was verified in a real profile on `0.1.5-rc.2` (client bundle served, Remote Access panel renders in Settings, and a remote visit through the hub works). See `doc/fix/20260911-dsh-0.1.5-plugin-rpc/` and `doc/review/20260911-dsh-0.1.5-rc.2-plugin-compat.md`.
- Fix note: the `authority: "loopback"` option the plugin passed to `rpc.handle` never existed in either dsh version (the helper takes `(channel, handler)` only); the real fence has always been the connection service's Host/Origin + browser-session check, which the plugin now calls explicitly.
- `rdsh-gateway` / `remote-dsh` CLI — **dsh `0.1.5-rc.2` compatibility (verified, not just assumed)**: `rdsh host serve` was smoke-tested against a real `dsh@0.1.5-rc.2` — spawn + `--port 0` ready line with launch token, browser-session cookie exchange, `/api` forwarding (real `settings/describe` answered), HTML polyfill injection (including the 0.1.2+ gzip workaround), WebSocket `/api/remote.mux` upgrade, and (for the join path) `patchLoopbackJs` still hitting `isLoopbackHostname(pageLocation.hostname)` in the shipped client bundle. No breakage found, so `DSH_COMPAT_MAX` is now `0.1.5-rc.2` (was `0.1.2-rc.1`) and `dshVersionWarning` gained boundary tests. See `doc/review/20260911-dsh-0.1.5-rc.2-plugin-compat.md` §5 (G1–G7); a full end-to-end check followed — the host was joined to the production hub with `rdsh host serve` and opened from a remote device successfully (G9).
- Note for older notes/docs: the DSH WebSocket endpoint has been the single `/api/remote.mux` since dsh `0.1.2` (`events.mux` / `events.host` are gone); rdsh relays WS by verbatim `req.url` and never hardcodes the path, so the rename does not affect forwarding (only comments/tests still mention the old names).

### dsh compatibility matrix

| remote-dsh component | version | compatible dsh (smoke-tested) | mechanism |
|---|---|---|---|
| remote-dsh CLI (`host serve` / `join`) | 0.10.2 | dsh `0.1.1-rc.2` ✅<br>dsh `0.1.2-rc.1` ✅<br>dsh `0.1.5-rc.2` ✅ | ready-line behavior detection, adaptive |
| `dsh-web-remote` plugin | 0.5.1 | dsh `0.1.2-rc.1` ✅<br>dsh `0.1.5-rc.2` ✅<br>(`0.1.1` line untested) | native `webServer` route, no version fork |
| rdsh-hub | any | dsh-version agnostic | pure relay, never parses traffic |

> Before this release the in-repo `node scripts/smoke-dsh-compat.mjs` was run against dsh `0.1.2-rc.1` and `0.1.5-rc.2` — **S1–S7 all PASS**; the `dsh-web-remote` browser half was additionally verified in a real profile on `0.1.5-rc.2` (panel visible, remote visit through the hub works).

## [rdsh-gateway 0.8.1 · remote-dsh 0.10.1] - 2026-09-08

### Fixed

- `rdsh host service install` on macOS (launchd): `ProgramArguments` now splits node / script / args into separate `<string>` argv elements (launchd does not split on spaces — the old single-string form made the service fail to exec); reinstalling is idempotent (unload before load); `KeepAlive` restarts only on failed exit (aligned with Linux `Restart=on-failure`); `rdsh host service status` distinguishes `active` from `loaded (not running)` via `launchctl print` state. See `doc/fix/20260908-host-service-launchd/`.
- Note: macOS fix is not yet regression-tested on real Intel / Apple Silicon hardware (Linux systemd path unchanged, verified).

## [rdsh-gateway 0.8.0 · dsh-web-remote 0.5.0 · remote-dsh 0.10.0] - 2026-09-08

### Added

- dsh `0.1.2-rc.1` compatibility: rdsh now exchanges and holds dsh's browser-session cookie (introduced in 0.1.2) and injects it into every relayed request (HTTP + WebSocket) across all three access paths (LAN serve / hub join / `dsh-web-remote` plugin), so remote access works again on the latest dsh; the `0.1.1` line still works unchanged via ready-line behavior detection (adaptive, no version fork). A runtime version check warns (without blocking) outside the tested window and prints an upgrade command.
- Fix: dsh 0.1.2 serves the index document gzip-compressed, which made the hub-injected back bar and E2EE shim silently skip; rdsh now strips `accept-encoding` on document-navigation requests so dsh returns plain HTML and the injected UI (back-to-host-list, E2EE data plane) works again.
- Install note (pnpm ≥ 12): within 24h of a release, `dsh plugin add` (bare or `@latest`) can **silently install the previous version** because of pnpm's default `minimumReleaseAge` policy — check the actually installed version with `dsh plugin ls`; pin an exact version (`dsh plugin add <pkg>@<version>`) when it matters (see `doc/review/20260908-pnpm-12-minimum-release-age-plugin-install.md`).

### dsh compatibility matrix

| remote-dsh component | version | compatible dsh (smoke-tested) | mechanism |
|---|---|---|---|
| remote-dsh CLI (`host serve`/`join`) | 0.10.0 | dsh `0.1.1-rc.2` ✅<br>dsh `0.1.2-rc.1` ✅ | ready-line behavior detection, adaptive |
| `dsh-web-remote` plugin | 0.5.0 | dsh `0.1.2-rc.1` ✅<br>(`0.1.1` line pending) | same host API shape across both, no version gate |
| rdsh-hub | any | dsh-version agnostic | pure relay, never parses traffic |

## [dsh-web-remote 0.3.0] - 2026-08-31

> Back-filled (2026-09-11): this release shipped without its own section (`0.2.0` / `0.4.0` lack one too). Recorded from the npm publish date and the published tarballs: `0.2.0` does **not** contain the features below, `0.3.0` contains them first (the `set-ui-compat` RPC and `autoConnect` both match in the 0.3.0 tarball), and `0.4.0` / `0.5.0` carry them on.

### Added

- `dsh-web-remote` (0.3.0): the Remote Access panel gains a **"Trust as local access when E2EE (compatibility)"** checkbox (`dshUiCompat.trustE2EEAsLoopback`, on by default) — with the patch, JS responses relayed through the tunnel treat the browser as loopback, so DSH's Models / API-key settings work remotely; and the plugin now **auto-connects at boot** when `host.json` is in join mode with a persisted token and no CLI owns the tunnel (same behavior as `rdsh host serve`), removing the "connect first to reach the panel" chicken-and-egg.

## [0.6.0] - 2026-08-24

### Added

- `rdsh hub` new subcommands: `audit ls` (query the audit log), `user unlock` (unlock a locked account), `user reset-2fa` (reset a user's 2FA). (`remote-dsh@0.6.0`, depends on `rdsh-hub@0.4.0`)

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
