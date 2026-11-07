# Changelog

**English** | [中文](CHANGELOG.zh.md)

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [remote-dsh 0.21.0 · rdsh-gateway 0.17.0 · dsh-web-remote 0.15.0] - 2026-11-07

### Added

- **Host metadata file** (gateway, cli, web-remote): `rdsh-meta.json`, written next to `host.json` by the launcher — `rdsh join` / `rdsh serve` (CLI), the plugin on first connect, and the box install flow (`rdsh-boxd --write-meta`). The gateway only **reads** it and reports it to `POST /api/hosts/self/meta`, so it no longer probes `/etc/rdsh/device.json`, spawns `dsh --version`, or reads `/run/rdsh-boxd/status.json` while reporting.

### Changed

- **`versions` keys are npm package names** (gateway): `remote-dsh`, `rdsh-gateway`, `dsh-web-remote`, `@deepseek-ai/dsh`, `rdsh-boxd`. The old keys were misleading — `rdsh` held the gateway package version and `gateway` held a role string (`"gateway"` / `"plugin"`) rather than a version, and the plugin version was never reported.
- **Device form lives in the metadata file** (gateway, cli): `host.json` no longer carries `deviceKind`; `rdsh join --device-kind` seeds it into `rdsh-meta.json`.
- **Plugin display name** (web-remote, carried over from the unpublished 0.14.2): the DSH Plugins card and settings section show `WhaleLink` / `鲸语通`.

## [dsh-web-remote 0.14.2] - 2026-11-07

### Changed

- **Plugin display name**: the DSH Plugins card and settings section now show the brand alone — `WhaleLink` (English) / `鲸语通` (Chinese) — instead of `WhaleLink Voice` / `鲸语通 语音助手`. The guides, the plugin-mode blog and the app now use the same name.

## [rdsh-gateway 0.16.1 · dsh-web-remote 0.14.1] - 2026-11-04

### Fixed

- **Plugin teardown never ran** (web-remote, gateway): the plugin registered shutdown on `ctx.on("dispose")`, which Cordis 4 does not emit, so the tunnel, the LAN direct listener (port 8442), and the reporter timer were never stopped at host shutdown. The leftover listener kept the host process alive past the desktop shell's 10 s graceful deadline and refused in-app updates (`desktop update: Host did not complete graceful task teardown`). Teardown now registers through `ctx.effect(...)`, which the host awaits, and a `disposed` guard closes the `autoConnect` race.
- **Bounded final usage report** (gateway): `UsageReporter.flush`/`stop` and `JoinHandle.stop` now accept an optional `timeoutMs`/`flushTimeoutMs` (defaults unchanged); teardown passes 1.5 s so a slow hub cannot hold the process past the shutdown deadline. `hubRequest` also gained an `AbortSignal` and no longer pools keep-alive sockets, so an in-flight report is aborted and its socket released.
- **Reconnect timer leak** (gateway): a pending exponential-backoff reconnect timer is now stored and cancelled on `stop()`, so a tunnel stopped mid-backoff can no longer keep the process alive up to 60 s.

### Changed

- **Correction** (web-remote): the 0.14.0 note "dispose now also stops the direct listener" was wired to the never-fired `dispose` event and did not actually take effect; this release makes teardown real and covers it with a real-Cordis lifecycle test and a `getActiveResourcesInfo()` no-linger test.

### Known issues

- During the startup `autoConnect` window (the first seconds after boot), an in-flight `registerJoin` HTTP request can still hold the process up to its 10 s timeout if shutdown lands exactly then; noted, not fixed (low probability).

## [rdsh-gateway 0.16.0 · rdsh-hub 0.20.0 · rdsh-hub-cli 0.20.0 · remote-dsh 0.20.0 · dsh-web-remote 0.14.0] - 2026-11-03

### Added

- **Product analytics** (hub): `POST /api/analytics/event` accepts client events (`app_open` / `purchase_start`) with idempotent `event_id` and UTC+8 day bucketing, feeding `analytics_daily` plus `analytics_first_seen` aggregation; `GET /api/admin/analytics` backs the admin dashboard (paid retention cohorts, subscription funnel, revenue, churn, daily registrations). Contract in `packages/hub/API.md` §19.
- **Cloud voice router** (hub, cli, portal): voice billing lives in `voice_usage_daily` (idempotent watermark + three-bucket debit); `POST /api/voice/session` issues short-lived ASR/TTS tickets; the router joins and pulls its sealed config through `/api/internal/voice/{routers/join,config,usage}`. Upstream keys gain `service` / `credential_type` and a per-provider credential schema (volcengine / aliyun / tencent / iflytek / baidu / minimax); routers and join tokens reuse the `llm_routers` / `llm_router_join_tokens` tables with a `service` column. `rdsh-hub router --service` plus `llm` / `voice` aliases; the portal renders the structured key form and a router type column.
- **Voice provider config** (hub, portal): new `voice_provider_configs` table (migration 0020) separates provider-level params (URLs, resource ids, voice list) from key secrets; providers without a config row are skipped. Admin API gains `upstream-providers` (provider enum + credential schema), `upstream-provider-configs` (CRUD), key `reveal`, and key update (label / weight / secret re-encrypt). `GET /api/voice/config` exposes the voice whitelist to the app.
- **Entitlements file** (hub): `billing.entitlementsFile` reads the app's `entitlements.json` (`levels.<tier>.package.{hosts,credits}`), so subscription host counts and monthly bonus credits come from one source; a missing or malformed file fails startup instead of silently falling back.
- **Granular activity** (gateway): `activityOf` reports eight kinds (commands / edit / read / web / tools / subagents / plan / questions) with detail taken from the process header.
- **Service install after join** (cli): after a QR join, `rdsh` offers to install the host service and enable `loginctl` linger, so the host survives logout without a manual `rdsh service install`.

### Changed

- **WebView API v2** (gateway): the injected `window.__rdshWebViewApi` bumps `version` to `2`; `readReply` now also returns `userText` / `reasoning` / `activity` / `rich` / `question`; `fillAndSend` now signals the insert window via the global `window.__rdshInserting` marker instead of an internal keyboard guard. Contract documented in `packages/gateway/WEBVIEW_API.md`.
- **Singleton apply** (web-remote): the desktop shell applies the plugin twice in one process; `apply()` now runs only the first instance (the second returns before registering anything), so the tunnel, direct listener, RPC route, and dispose each run once. This removes the `processTunnel` / `adoptProcessTunnel` / `ownsTunnel` sharing workaround and its fallout (disconnect/revoke no-op, direct-listener leak on uninstall). `describeLock` now classifies a reused self pid as `pid-reuse` (reap-able) so `autoConnect` clears it; `startDirect` retries once on `EADDRINUSE` (previous instance releasing the port asynchronously).
- **Plan status** (hub): `plan_status="internal"` replaces `NULL` as the exclusive / unlimited tier, and `NULL` is now fail-closed (no privileges); bonus credits are granted by subscription events (started / renewed / changed) plus the tier difference on upgrade, replacing the calendar-month sweep; `rdsh-hub user add` creates internal accounts and the admin plan action rejects `null`.
- **Daily points spend** (hub, portal): `GET /api/credits/spend-daily` aggregates `relay_charge` / `llm_usage_daily` / `voice_usage_daily` by day; the per-transaction debit ledger view is dropped.
- **Active router by service** (hub): router selection is centralised on `service`, so host LLM keys and the voice config no longer pick each other's router.
- **Migration safety** (hub): migration runs are serialised by a session advisory lock, and `schema_migrations` records `source` / `pid` for auditing.
- **Portal** (portal): plan cards, tier matrix, and navigation aligned with the app; nav reordered (hosts before account) and plans shown for internal accounts.

### Fixed

- **Admin plan labels** (portal): the admin user list and user detail "Plan" column now localizes every `plan_status` value (`internal` / `trial` / `grace` / `free` / `subscribed`). Previously only `internal` was translated and the rest leaked raw English enums; unknown values now show a localized placeholder instead of the backend value.
- **Admin account status labels** (portal): the admin user list and user detail "Status" column now localizes `account_status` (`active` / `banned` / `deleted` / `pending`) instead of leaking raw English enums.
- **Direct listener leaked on plugin uninstall** (web-remote): the plugin's `dispose` handler stopped the tunnel but not the LAN direct listener (port 8442); reinstalling the plugin without restarting DSH then left the old listener holding the port, so `startDirect` failed with `EADDRINUSE` and reported empty direct candidates. `dispose` now also stops the direct listener. _(Correction in 0.14.1: this was wired to the never-fired `ctx.on("dispose")` event and did not actually take effect.)_
- **Force unlock now supersedes a live lock holder** (web-remote): the lock gate now treats a confirmed-alive holder (`alive`) as `allowed` (with a risk confirmation), so a freshly reinstalled plugin can reclaim a lock left by a stale DSH process that did not exit. `self` and `fresh-corrupt` remain `blocked`.
- **Stop-button activity parity** (gateway): `activityOf` now applies the same stop-button check as the app, so a stopped run no longer reports a stale activity.
- **Destructive PG test guard** (hub): tests that wipe tables refuse to run unless the target looks like a test database.

### Notes

- **`dsh-web-remote`** and **`remote-dsh`** are republished so their pinned `rdsh-gateway` moves from `0.15.3` to `0.16.0`; both also carry their own changes above.
- **`rdsh-tunnel`** is unchanged this release — the wire protocol is untouched.
- The rebuilt portal bundle must be committed together with its source; production only pulls, deploys, and verifies.

## [rdsh-gateway 0.15.3 · remote-dsh 0.19.1 · dsh-web-remote 0.13.1] - 2026-10-24

### Added

- **Automatic LLM provider provisioning** (gateway): when `llm` is configured, `rdsh host serve` provisions the DSH `llm-router` provider and API key on every start instead of requiring a manual settings edit. The provisioned model config surfaces upstream `reasoningEfforts`, and the key list supports create / edit / delete with created and last-used timestamps. New `llm-provision.ts`; the CLI passes `config.llm` through to the gateway's `join()`.
- **`llm` switch** (gateway): provisioning can be turned off per host via config.

### Changed

- **Ready timeout** (gateway): the `dsh web` cold-start wait is now 120s (was 30s), so older machines are no longer killed mid-startup.
- **Provider display name** (gateway): renamed to the product name.

### Fixed

- **DSH settings/credentials RPC** (gateway): wrap the RPC payload in the `args` envelope and send the real `expectedRevision` so `settings/mutate` persists; drop the optional `settings/describe` call and harden the `dshJson` timeout.
- **Stale credentials lock** (gateway): clear a leftover DSH credentials lock before spawning.
- **`reasoningEfforts.off`** (gateway): emit `null` instead of an empty string.

### Notes

- **`dsh-web-remote`**: no source changes in this release; it is republished so its pinned `rdsh-gateway` dependency moves from `0.15.0` to `0.15.3`.
- **`rdsh-hub` / `rdsh-hub-cli`**: unaffected — deployed from git, so no npm release in this batch.

## [rdsh-hub 0.19.0 · rdsh-hub-cli 0.19.0 · remote-dsh 0.19.0] - 2026-10-20

### Added

- **PostgreSQL backend** (hub): `hub.json` gains `db.driver` (`sqlite` default, or `postgres` + `db.dsn`); the hub ships `createPgPool` / `migratePg` / `createPgStore` behind a `HubStore` abstraction, with pg-store parity tests against the SQLite store.
- **Standalone server CLI** (hub-cli): `rdsh-hub` is a new package with `rdsh-hub serve|user|audit|host|service` plus `setup` and `db`; `rdsh` keeps only the user/gateway commands, and `rdsh host ...` stays as a compatibility alias.
- **Hub setup and DB management** (hub-cli): `rdsh-hub setup` writes `hub.json` (backend prompt, TLS, `--force`); `rdsh-hub db migrate` runs the SQLite→PostgreSQL migration (preflight → backup → copy → verify → identity-sequence reset), and `db verify` / `db check` inspect the result.
- **Backend-aware admin commands** (hub-cli): `user`, `audit` and `host` operate on either backend through `HubStore`.

### Changed

- **CLI split** (cli): `rdsh hub ...` and the `rdsh node` stub left `remote-dsh`; short-form commands (`rdsh serve|join|setup|service|leave|user|gate`) are the norm, with `rdsh host ...` kept for compatibility.
- **Migration tool** (hub): the one-shot `tools/migrate-sqlite-to-pg` tool is now `rdsh-hub db migrate`, and the `tools/` workspace entry is gone.

## [rdsh-gateway 0.15.2 · remote-dsh 0.18.1] - 2026-10-18

### Changed

- **dsh compatibility window** (gateway): the tested window now ends at `0.2.1-rc.2` (was `0.1.7-rc.1`), so dsh 0.2.x stops tripping the "beyond the tested range" warning. Evidence: desktop 0.2.1-rc.1 on darwin x64 ran the plugin end to end; 0.2.1-rc.2 was audited against its release commit. The full G1–G7 checklist and the CLI spawn path were not re-run on 0.2.x.
- **Gateway dependency** (cli): `remote-dsh` 0.18.1 depends on `rdsh-gateway` 0.15.2 to carry that window.

## [rdsh-gateway 0.15.1 · remote-dsh 0.18.0] - 2026-10-18

### Added

- **QR host join** (cli): `rdsh host join [hub-url]` binds this machine by scanning a terminal QR code with the WhaleLink app instead of pasting a join token. The hub URL defaults to `https://hub.rdsh.cn` and stays overridable positionally; `--token` keeps the non-interactive path, and a hub without bind-session support falls back to the token prompt. The bind session carries only `rdsh://bind?code=<id>` (no secret), expires after five minutes, and is approved by the signed-in account on the phone.

### Changed

- **Join metadata exports** (gateway): `readJoinMeta` and `persistJoinMeta` are exported from the package root so the CLI can persist the host credentials a QR bind grants.

## [dsh-web-remote 0.13.0] - 2026-10-18

### Changed

- **Branded plugin identity** (web-remote): the Plugins card and the settings section use the product brand — `鲸语通 语音助手` / `WhaleLink Voice`, a localized one-line description, and a microphone `icon.svg` that reads on both light and dark surfaces.

### Fixed

- **dsh 0.2 startup** (web-remote): the bundle row id `remote-access` collided with the DSH 0.2 built-in `@deepseek-ai/dsh-api-remote-access`, which kept `remoteAccess` from activating and made `dsh web` fail its API requests; the row id is now `dsh-web-remote`.

- **Desktop double load** (web-remote): when the desktop shell applies the plugin twice in one process, the second instance reuses the running tunnel instead of reporting `external` or surfacing "another tunnel is already running in this process".

## [rdsh-gateway 0.15.0 · rdsh-hub 0.15.0 · rdsh-portal 0.3.0 · remote-dsh 0.17.3 · dsh-web-remote 0.12.0] - 2026-10-17

### Added

- **Relay self-service onboarding** (relay + hub): `rdsh-relay join <hub-url> --join-token <token> [--relay-url <url>] [--name <name>]` registers a relay node from a join token (created disabled, pending admin approval); `--relay-url` and `--name` default to the machine `{hostname}`. The relay config now carries `listen` and a TLS mode (`behindProxy` / `acme` / `tls`), validated at serve time.
- **Admin list filters** (hub + portal): users by role / status / login-time range, hosts by online / E2EE / join-time range, and billing by order id / plan / status.
- **Admin relay-node onboarding** (portal): a new "add node" flow generates a ready-to-run `rdsh-relay join` command and a complete `relay.json` (listen address + TLS mode: behind-proxy default `127.0.0.1:8444`, direct `0.0.0.0:443`) from a join token, instead of pre-creating the node.
- **Admin list pagination** (hub + portal): users, hosts, relay nodes, orders and audit lists are paginated, each with a per-page selector (10/20/50/100, default 20).

### Changed

- **Portal usage page and user navigation rework** (portal).
- **Stateless relay assign tokens** (relay + hub): the host-assignment token is no longer derived from a relay-side host token, so a relay-side failure cannot destroy the host token.

### Fixed

- **Relay-side 401 no longer destroys the host token** (relay): an assignment 401 is treated as transient instead of self-destructing the host token (P0).
- **Gateway hardening** (gateway): crash loops are bounded, the usage flush is serialized, and the request surface is hardened; ambiguous 401s no longer permanently stop the host, read errors no longer silently regenerate the user-side identity, and direct-path usage is now metered.
- **Web-remote revoke/disconnect bound** (web-remote): the revoke/disconnect RPC is bounded so the panel no longer hangs, a signal-killed `dsh` is handled cleanly, and the revoke message is surfaced.

## [rdsh-gateway 0.14.0 · rdsh-hub 0.14.0 · remote-dsh 0.17.2 · dsh-web-remote 0.11.0] - 2026-10-16

### Added

- **Credits wallet and top-up** (hub + portal): a credits ledger with balance buckets, `GET /api/credits/tiers`, and a portal top-up page. Credit tiers and plans now come from the shared product catalog file (`iap_products.json`) instead of being hard-coded, and the A-class initiate proxy accepts credit tiers as well as plans.
- **Store (B-class) purchase crediting** (hub): unicpay `store.purchase.succeeded|refunded|revoked` events credit and reverse the purchased bucket. A successful `store/verify` now credits **in place**, so an Apple/Google purchase lands immediately and the webhook becomes an idempotent backstop.
- **Payment order check** (hub + portal): `POST /api/billing/order/check` reconciles a platform-paid order and delivers it idempotently (same idempotency key as the webhook). The portal's payment dialogs check the active order, and the A-class initiate response now carries the platform `ticket` so a client can query the order and draw its own QR.
- **Localized verification emails** (hub): verification mails follow the user's language (zh/en).
- **TTS read-aloud usage statistics** (hub + portal): per-day read-aloud counters and a responsive usage page.
- **Join-lock self-service diagnostics and force-unlock** (web-remote + gateway): the plugin reports which process holds the join lock, overrides a lock held by a dead process, and can clear a stale lock instead of failing with an opaque error.

### Changed

- **Breaking: billing plan `intervalDays` renamed to `intervalMonths`** (hub). Subscriptions now bill by calendar month instead of a fixed day count (`intervalDays: 30` → `intervalMonths: 1`). If the old `intervalDays` field is still present, the hub fails fast at startup with a migration hint.
- **WeChat H5 / official-account (JSAPI) subscription payment migrated to unicpay** (hub + portal). The direct WeChat Pay and CMB merchant integrations are retired.
- **Portal recharge tiers** (portal): responsive cards with popular / best-value badges, capped at two columns on narrow screens.
- **Portal captcha and theming** (portal): host-provided theme support and a text-free arithmetic captcha.
- **Dependency refresh** (cli): `remote-dsh` 0.17.2 repins `rdsh-gateway` 0.14.0 and `rdsh-hub` 0.14.0, so `npm i -g remote-dsh` installs the new components.

### Fixed

- **Direct-path bootstrap injection was lost when header names arrived lowercase** (gateway + relay): request header keys are normalized to lowercase, restoring the injected direct bootstrap.
- **Store/verify failures are diagnosable** (hub): the upstream status, error code and message are now passed through instead of a blanket `502`, and the outbound unicpay call has a timeout with a transport-error fallback.
- **The subscription QR stays open until the expiry actually extends** (portal).
- **Resend-code entry with captcha** (portal) on the verify and reset pages.
- **Relay node heartbeat / usage errors are no longer swallowed, and `relayNodeToken` is issued on register** (relay + hub).

## [rdsh-gateway 0.11.0 · rdsh-hub 0.9.0 · remote-dsh 0.14.0 · dsh-web-remote 0.7.0] - 2026-09-28

### Added

- **Direct-first LAN access** (gateway + cli + web-remote): in join mode the host also listens on a LAN port (default **8442**, host config) that forwards to the *same* dsh instance. Over the E2EE channel the gateway hands the page a list of private-IPv4 candidates plus a **one-time direct ticket** (`window.__rdshDirectInfo`), so a client on the same network can skip the public hub round-trip; `?ticket=` bootstraps a session and redirects, and a consumed/forged/expired ticket is rejected. The hub is unchanged and never sees LAN topology.
- **Unified host gate on an access code** (gateway + cli): the gate now covers the LAN/cloud gateway, the join tunnel and the direct listener. `rdsh host setup lan` generates the code; `rdsh host gate set|clear|status` manages it.
- **Admin entitlement actions** (hub + portal): grant-trial and grant-subscription actions; `adjustPlan` rejects *subscribed-without-subscription* and *unlimited-with-expiry*; `creditOrder` keeps a single active subscription; the portal user menu offers extend-trial / gift-subscription / unlimited-forever instead of raw plan fields; a read-only `inspect-entitlements.mjs` ops script was added.
- **`readReply` carries `turn` / `userTurn`** (gateway): the injected WebView contract can now fire its stop-immediately rule; absent values default to `-1`.
- **Clipboard polyfill for plain-http pages** (gateway): `navigator.clipboard` is shimmed via `document.execCommand('copy')` so copying works on the http direct page.

### Changed

- **Breaking: the dynamic pair code is removed** (gateway + cli). Legacy `auth.mode: "pair"` migrates to `"none"` and `pairCode` to an access code on load; `--pair-code` is gone.
- **Breaking: the host default port is now 8442** (was 8443; the hub keeps 8443) so `rdsh hub serve` and `rdsh host serve` can share a machine without colliding.
- Gate, direct-ticket and login redirects now use **303** (Post/Redirect/Get) instead of 302.
- **dsh-web-remote always starts the direct listener** in join mode and restarts it when the access code changes.

### Fixed

- **Hosts with an access code no longer dead-lock E2EE clients** (gateway): the page-authorize script was injected on the plain dispatcher only, so an E2EE (raw) client could never satisfy the fail-closed raw gate and the DSH UI stayed on "connecting" forever. The script now comes from one shared helper used by both dispatchers.
- **Alibaba Cloud captcha verification** (hub + portal): `VerifyCaptcha` returns `"Success"` (not the legacy `"OK"`), so every verification raised and was swallowed as `BAD_CAPTCHA`; the one-time ticket is no longer replayed (cleared on submit failure, button disabled while submitting).
- **`rdsh host gate clear|status` messages** (cli) no longer claim the direct port stops listening without a code — it always listens and only accepts a one-time ticket.

## [rdsh-hub 0.8.0 · remote-dsh 0.13.0] - 2026-09-25

### Fixed

- **Portal no longer forces re-login in WebView clients** (hub + portal): the 7-day refresh token moved from `sessionStorage` (page-session scoped, discarded by garsync's WKWebView on every page instance) to an **HttpOnly cookie `rdsh_hub_refresh`** (`Path=/api/auth`), so the portal silently refreshes after the 1h access cookie expires instead of dropping to the login form. The refresh token is no longer exposed to page JS.

### Changed

- **Breaking (cookie):** the hub session cookie is renamed `rdsh_session` → **`rdsh_hub_session`** to stop colliding with the gateway's same-named cookie. Clients that don't hard-code the cookie name are unaffected.
- `POST /api/auth/refresh` reads the refresh cookie first, with the JSON body `refreshToken` kept as a fallback (backward compatible — deploy hub before portal).
- WeChat login's one-off `rdsh_wechat_refresh` handoff cookie is removed (the refresh cookie is now set directly).

## [rdsh-gateway 0.10.0 · remote-dsh 0.12.0 · dsh-web-remote 0.6.0] - 2026-09-25

### Added

- **rdsh WebView API contract** (gateway): the gateway injects `window.__rdshWebViewApi` (version 1: `isDshPage` / `readReply` / `fillAndSend`) into proxied DSH pages, in both lan/cloud and join modes, so WebView clients (e.g. garsync) read/write the DSH page through a stable contract instead of fragile DSH DOM details. The injected script is idempotent, defensive, and uses UTF-8-safe base64.

### Fixed

- **dsh 0.1.7-rc.1 is no longer reported as "out of tested range"** (gateway): the smoke-tested dsh window now reaches `0.1.7-rc.1` (`DSH_COMPAT_MAX`, was `0.1.5-rc.2`), so hosts on it stop printing a misleading startup warning. 0.1.7 changes only the front-end dist shape (`<base href="./">` plus base-relative `plugins/…`), which a same-origin gateway is immune to; auth and RPC are unchanged. The G1–G7 checklist was re-run against the real package — see the internal review record.

### dsh compatibility matrix

| remote-dsh component | version | compatible dsh (smoke-tested) | mechanism |
|---|---|---|---|
| remote-dsh CLI (`host serve` / `join`) | 0.12.0 | dsh `0.1.1-rc.2` ✅<br>dsh `0.1.2-rc.1` ✅<br>dsh `0.1.5-rc.2` ✅<br>dsh `0.1.7-rc.1` ✅ | ready-line behavior detection, adaptive |
| `dsh-web-remote` plugin | 0.6.0 | dsh `0.1.2-rc.1` ✅<br>dsh `0.1.5-rc.2` ✅<br>(`0.1.7-rc.1` not re-verified) | native `webServer` route, no version fork |
| rdsh-hub | any | dsh-version agnostic | pure relay, never parses traffic |

## [rdsh-gateway 0.9.0 · rdsh-hub 0.7.4 · remote-dsh 0.11.0 · dsh-web-remote 0.5.6] - 2026-09-22

### Added

- **Service runtime control** (cli + gateway): `rdsh host service` and `rdsh hub service` gain `start|stop|restart` to start/stop/restart the installed service without changing enable-at-boot. Host resolves the unit by `host.json` mode (`rdsh-join` / `rdsh-host`); hub uses `rdsh-hub`.

### Fixed

- **Portal build type-checks** (portal): type-check the build and clear 97 accumulated errors (DOM lib, portal-first build order, copy-portal stale/missing-dist guard).
- **Form auto-zoom on iOS** (portal): keep form fields ≥ 16px on phones and tablets so iOS stops zooming in on focus.
- **Panel input auto-zoom on iOS** (web-remote): raise panel input font to 16px on narrow or touch screens.
- **Back-bar overlap** (hub): lower the injected "back to hosts" bar to `top:90px;right:20px` so it no longer covers the DSH top bar / Session Log.
- **Loopback patch observability** (gateway): log loopback-patch hits and stop re-scanning shell assets.

## [rdsh-gateway 0.8.6 · dsh-web-remote 0.5.5 · remote-dsh 0.10.7] - 2026-09-17

### Fixed

- **Choosing a workspace works from a remote browser** (web-remote + gateway): DSH resolves its directory picker once at boot; on a desktop host launched outside SSH it picked the **host OS dialog**, which opens on the host's own screen and cannot be driven from a remote browser. The plugin now pins the picker to the in-app browser (`browse`) in its bundle patch — unconditionally, connected or not — and the CLI (`rdsh host serve` / `rdsh host join`) spawns `dsh web` with the remote-session signal DSH reads for the same decision. The panel shows which picker actually took effect.
- **Silent regression guard** (gateway): `rdsh host serve` / `join` checks the spawned dsh's boot graph for the in-app picker and warns instead of leaving the operator with an unusable picker.

> ⚠️ The picker is single-occupancy: never add a second pin channel (a hand-written layer in the profile's `cordis.patch.yml`, or `dsh web --patch`). Duplicate rows make dsh fail to boot. Reinstall the plugin (or upgrade the CLI) to pick this up; no hub deployment needed.

## [rdsh-gateway 0.8.5 · dsh-web-remote 0.5.4 · remote-dsh 0.10.6] - 2026-09-15

### Fixed

- **One tunnel per machine** (gateway): the join lock is published atomically (temp file + `link`), only provably dead locks are reaped, and any live lock — including our own pid — is refused. Two `dsh web` instances used to fight over one host, each kicking the other offline every ~1.2 s.
- **Lock conflicts are visible** (web-remote): the panel shows why it stayed disconnected instead of failing silently.

> Wire protocol unchanged, no hub deployment needed. Reinstall the plugin (or upgrade the CLI) to pick up `rdsh-gateway` 0.8.5.

## [rdsh-gateway 0.8.4 · rdsh-hub 0.7.3 · remote-dsh 0.10.5 · dsh-web-remote 0.5.3] - 2026-09-14

### Fixed

- **The E2EE data plane now actually engages** (hub): host-id injection, a constructible WebSocket facade, and `fetch` input normalisation fix three defects that had kept it silently in plaintext.
- **Large uploads work over E2EE** (hub): request bodies are chunked at 1 MiB instead of one oversized frame.
- **Previews stream byte-exact** (hub): responses are a byte-preserving stream resolved at OPEN, JSON goes through the native parser, and abort/error are surfaced correctly.
- **All request body types are supported** (hub): Blob/File, ReadableStream, FormData, URLSearchParams; anything else throws.
- **Manifest fallback** (hub): a cookie-less `manifest.webmanifest` request no longer returns the portal HTML.
- **Upstream failures are classified** (gateway): only real connection errors read "unreachable"; mid-body closes carry the errno.
- **LAN paired sessions apply the loopback patch** (gateway): settings/API key reachable with pair auth too.
- **Settings/API key usable from the remote UI** (gateway): encoding-aware loopback patch, correct content-length, no immutable caching, logged patch misses.

### Security

- **An oversized frame can no longer kill the hub or the host** (remote DoS): bounded senders fail the stream instead of crashing the process.

> hub ↔ host version mixing (old/new) verified compatible; dsh compatibility unchanged.

## [rdsh-hub 0.7.1 · remote-dsh 0.10.3] - 2026-09-11

### Added

- **Portal dark mode**: the hub's web portal now follows the OS light/dark preference via a 30-token semantic colour layer (`--rdsh-*`) driven by `prefers-color-scheme`; dark values align to DSH's tokens and light mode is byte-identical (WCAG AA verified, 18 pairs ≥ 4.5:1).
- Note: the portal ships inside `rdsh-hub`; `remote-dsh` pins `rdsh-hub`, so both release together.

## [rdsh-gateway 0.8.2 · dsh-web-remote 0.5.1 · remote-dsh 0.10.2] - 2026-09-11

### Fixed

- `dsh-web-remote` (0.5.1): no longer breaks `dsh web` on dsh `0.1.5-rc.2` — the browser RPC channel is now a native `/remote-access` route instead of `connection.rpc.handle(...)` (upstream regression, discussion #5926). One code path, no version fork; verified on `0.1.2-rc.1` and `0.1.5-rc.2`.
- `rdsh-gateway` / CLI: dsh `0.1.5-rc.2` compatibility verified end-to-end (spawn, cookie exchange, `/api`, HTML polyfill, WS `remote.mux`, loopback patch); `DSH_COMPAT_MAX` → `0.1.5-rc.2`.
- Note: DSH's WebSocket endpoint has been the single `/api/remote.mux` since `0.1.2`; rdsh relays WS by verbatim URL, so the rename doesn't affect forwarding.

### dsh compatibility matrix

| remote-dsh component | version | compatible dsh (smoke-tested) | mechanism |
|---|---|---|---|
| remote-dsh CLI (`host serve` / `join`) | 0.10.2 | dsh `0.1.1-rc.2` ✅<br>dsh `0.1.2-rc.1` ✅<br>dsh `0.1.5-rc.2` ✅ | ready-line behavior detection, adaptive |
| `dsh-web-remote` plugin | 0.5.1 | dsh `0.1.2-rc.1` ✅<br>dsh `0.1.5-rc.2` ✅<br>(`0.1.1` untested) | native `webServer` route, no version fork |
| rdsh-hub | any | dsh-version agnostic | pure relay, never parses traffic |

## [rdsh-gateway 0.8.1 · remote-dsh 0.10.1] - 2026-09-08

### Fixed

- `rdsh host service install` on macOS (launchd): correct `ProgramArguments` splitting, idempotent reinstall, `KeepAlive` on failure only, `service status` distinguishes active vs loaded. Not yet regression-tested on real Apple Silicon (Linux systemd unchanged).

## [rdsh-gateway 0.8.0 · dsh-web-remote 0.5.0 · remote-dsh 0.10.0] - 2026-09-08

### Added

- dsh `0.1.2-rc.1` compatibility: rdsh exchanges and injects dsh's browser-session cookie across all three paths (LAN / hub join / plugin); `0.1.1` still works via adaptive ready-line detection; a runtime version warning prints outside the tested window.
- Fix: dsh 0.1.2 serves the index gzip-compressed; rdsh now strips `accept-encoding` on document navigation so the injected back bar / E2EE shim apply again.
- Install note (pnpm ≥ 12): within 24h of release, `dsh plugin add` may install the previous version (`minimumReleaseAge`); pin an exact version when it matters.

### dsh compatibility matrix

| remote-dsh component | version | compatible dsh (smoke-tested) | mechanism |
|---|---|---|---|
| remote-dsh CLI (`host serve`/`join`) | 0.10.0 | dsh `0.1.1-rc.2` ✅<br>dsh `0.1.2-rc.1` ✅ | ready-line behavior detection, adaptive |
| `dsh-web-remote` plugin | 0.5.0 | dsh `0.1.2-rc.1` ✅<br>(`0.1.1` pending) | same host API shape, no version gate |
| rdsh-hub | any | dsh-version agnostic | pure relay, never parses traffic |

## [dsh-web-remote 0.3.0] - 2026-08-31

> Back-filled (2026-09-11): recorded from the npm publish date and tarballs — `0.3.0` is the first version with the features below.

### Added

- `dsh-web-remote` (0.3.0): the Remote Access panel gains "Trust as local access when E2EE" (`dshUiCompat.trustE2EEAsLoopback`, on by default) so Models/API-key settings work remotely; the plugin auto-connects at boot when in join mode with a persisted token and no CLI owns the tunnel.

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
