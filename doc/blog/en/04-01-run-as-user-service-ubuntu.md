# Run rdsh-hub & rdsh-join as systemd user services (no sudo, boot-start, crash-restart)

**中文版**：[中文](../zh/04-01-run-as-user-service-ubuntu.md)

> 2026-08-24 · remote-dsh 0.4.9
> Ops series ①: make the hub and gateway truly always-on — survive SSH disconnects, start at boot, recover from crashes.

---

## The scenario

You followed [03-01 hub with built-in TLS](../en/03-01-hub-public.md) / [03-02 hub behind Apache2](../en/03-02-hub-behind-apache-https.md) and got the hub running, but two problems remain:

- **`rdsh hub serve` / `rdsh join` run inside an SSH terminal** — closing the terminal (or losing the connection) stops the service; `nohup ... &` only prolongs the pain, and there is no boot-start.
- **After a machine reboot** you must manually bring up the hub and the join in the right order.

The fix: **systemd user services**. Unlike system-level services, user-level ones need **no sudo** (files live in `~/.config/systemd/user/`) and give you:

- ✅ **Detached from your session**: keeps running after SSH closes
- ✅ **Boot start**: with `loginctl enable-linger`, no login required
- ✅ **Crash restart**: `Restart=on-failure`
- ✅ **Bonus from the 0.4.9 feature**: a restarted join service reuses its persisted token — **no re-pairing**

## Architecture

```
SSH terminal (safe to close)
   │
   ▼
systemd --user manager
   ├── rdsh.service      (hub:  rdsh hub serve --config hub.json)
   └── rdsh-join.service (join: rdsh join <hub-url>)
          └── spawn → dsh web (child, managed together with join)
```

- On start, the join service injects its environment via `EnvironmentFile` (API keys etc.); the spawned `dsh` inherits it.
- On restart, join reads `~/.rdsh/join-*.token` and reuses it — no pair code printed.

## Steps

### ① Make sure the systemd user manager is available

```bash
systemctl --user is-system-running    # expect: running
```

### ② Hub: one command

```bash
rdsh hub service install
```

Generated unit (`~/.config/systemd/user/rdsh.service`):

```ini
[Unit]
Description=rdsh — remote access for DeepSeek Harness
After=network.target

[Service]
Type=simple
ExecStart=<node> <rdsh-bin> hub serve --config <hub-config>
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

> `<node>` / `<rdsh-bin>` are filled in by the installer with absolute paths (`process.execPath` + the CLI script path) — nothing to edit by hand.

```bash
systemctl --user status rdsh        # expect: active (running)
journalctl --user -u rdsh -f        # live log
```

### ③ Join: write the unit by hand (no built-in command in 0.4.9)

`rdsh join` has no `service install` subcommand yet (watch for future releases). Write a ~10-line unit:

```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/rdsh-join.service <<EOF
[Unit]
Description=rdsh join tunnel (<hub-url>)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=PATH=<node-bin-dir>:/usr/local/bin:/usr/bin:/bin
ExecStart=<node> <rdsh-bin> join <hub-url>
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now rdsh-join
```

> **`Environment=PATH` is mandatory** (the biggest trap in this series): the default PATH of user services does not include nvm / self-installed Node dirs; without it, join's `findDsh` cannot locate `dsh` and the service loops on startup failure.
> Finding the paths: `command -v node`; `readlink -f $(command -v rdsh)`; the node bin dir is `dirname $(command -v node)`.

### ④ Inject environment variables (API keys etc.)

**User services do not read `~/.profile` / `~/.bashrc`** — an API key you export in your login shell is missing in the service, and the spawned `dsh` will report `no API key for provider route`. The correct pattern:

```bash
# 1) Put the secret in a dedicated 0600 file (not in the unit)
echo 'DEEPSEEK_API_KEY=sk-xxx' > ~/.rdsh/join.env
chmod 600 ~/.rdsh/join.env

# 2) Mount it via a drop-in (keeps the main unit clean; survives reinstall)
mkdir -p ~/.config/systemd/user/rdsh-join.service.d
cat > ~/.config/systemd/user/rdsh-join.service.d/env.conf <<'EOF'
[Service]
EnvironmentFile=-/home/<user>/.rdsh/join.env
EOF
systemctl --user daemon-reload && systemctl --user restart rdsh-join
```

> `EnvironmentFile` paths are **not `~`-expanded** — use absolute paths; the leading `-` makes a missing file non-fatal.
> Verify injection: `tr '\0' '\n' < /proc/<dsh-pid>/environ | grep DEEPSEEK_API_KEY` (inspect the actual process, not `systemctl show` — EnvironmentFile variables never appear in the manager's `Environment` property; that is expected).

### ⑤ Boot start without login (the step everyone forgets)

```bash
sudo loginctl enable-linger <user>
loginctl show-user <user> | grep Linger    # expect: Linger=yes
```

> Skip this and your services only run while logged in — no auto-start after reboot. User service + linger = a sudo-free stand-in for system-level persistence.

### ⑥ Stop hand-run instances before starting the services

A hand-run instance holding the port/tunnel makes the service fail to start (`EADDRINUSE` restart loop):

```bash
kill -TERM <hand-run-join-PID> <hand-run-hub-PID>    # SIGTERM cleanly reaps the dsh child
systemctl --user restart rdsh rdsh-join
```

## Ops cheatsheet

| Action | Command |
|---|---|
| Start | `systemctl --user start rdsh-join` |
| Stop | `systemctl --user stop rdsh-join` |
| Restart | `systemctl --user restart rdsh-join` |
| Status | `systemctl --user status rdsh-join` |
| Logs | `journalctl --user -u rdsh-join -f` |
| Boot start | `systemctl --user enable/disable rdsh-join` |
| Edit env config | `systemctl --user edit rdsh-join` (drop-in) |
| Service env (property) | `systemctl --user show rdsh-join -p Environment` |
| Real process env | `tr '\0' '\n' < /proc/<pid>/environ` |

(The hub is the same, service name `rdsh`.)

## Notes & gotchas (production-tested, 2026-08-24, Alibaba Cloud ECS)

- **PATH**: the service's default PATH lacks nvm / self-installed Node dirs → join cannot find `dsh` → set `Environment=PATH=...` (step ③)
- **Env vars**: services do not read `~/.profile` → API keys must come via `EnvironmentFile` (0600) (step ④)
- **Drop-ins first**: `rdsh hub service install` regenerates the main unit, so put env config in `.service.d/` so it survives
- **Don't forget linger**: otherwise "boot start" is fake (step ⑤)
- **Ordering is a non-issue**: join starting before the hub recovers on its own — `Restart=on-failure` retries every 3s plus the tunnel's internal exponential-backoff reconnect
- **Token-persistence payoff**: a restarted join logs `reusing persisted host token` and recovers without re-pairing (0.4.9 feature; see the [bug fix](../../../doc/fix/20260824-join-token-persist/bug-report.md))
- **Secret hygiene**: `join.env` 0600, unit files 600, logs never print tokens (the hub stores only SHA-256 digests)

## About the project

- GitHub: [github.com/floatinghotpot/remote-dsh](https://github.com/floatinghotpot/remote-dsh)
- Install: `npm i -g remote-dsh` (MIT license, open source)
