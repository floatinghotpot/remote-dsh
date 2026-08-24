# No CLI needed: install a DSH plugin and get remote access right in the UI

**English** | [中文](../zh/03-05-plugin.md)

> 2026-08-24 · dsh-web-remote 0.1.0 (M4 dev build, unpublished)
> Server-relay series: ⑤ multi-machine + public hub → **this: DSH plugin, no CLI**

---

## The scenario

You already run `dsh web` (DeepSeek Harness's browser UI) on this machine, and you want to reach it from anywhere — but you'd rather not install the rdsh CLI or set up systemd services.

Install the `dsh-web-remote` plugin and a "**Remote Access**" panel appears right in the DSH UI: paste the hub URL + auth token, click Connect, and you're online. It **reuses the exact same join tunnel as the CLI** — the entry point just lives inside the DSH UI.

## How it works

```
DSH web process (this machine)
  ├─ server plugin: runs the join tunnel in-process, forwarding to "itself" (127.0.0.1:<dsh port>)
  └─ client plugin: "Remote Access" settings panel (status + form + Connect/Disconnect/Revoke)
        │  RPC /remote-access (connect/disconnect/revoke/state)
        ▼
   hub ──wss tunnel──► this machine's dsh web
```

- **No CLI**: `dsh plugin add` is all it takes;
- **Embedded, no spawn**: the plugin runs inside the dsh process — no second dsh is launched;
- **Dual distribution**: CLI and plugin share one host core and one host identity.

## Steps

### ① Install the plugin

```bash
dsh plugin --profile web add dsh-web-remote
```

(`dsh web` is an alias for `--profile web`, so install into the web profile.)

### ② Restart dsh web and open the panel

```bash
# Ctrl+C the running dsh web, then start it again (plugins load at boot, not hot)
dsh web
```

Open `http://127.0.0.1:3080` in the browser → **Settings** → find the "**Remote Access**" panel.

### ③ Connect

1. In the hub portal, "Add host" to generate an **auth token** (one-time plaintext, shown once);
2. Fill in **Hub URL** + **Auth Token** + **Name** in the panel;
3. Click "**Connect**" → the dot goes "Connecting…" → "**Connected**";
4. The hint under the status shows the **hub URL** (clickable) — sign in to the hub portal from anywhere, find this host in the host list, and open it.

### ④ Day to day

| Action | What happens |
|---|---|
| Disconnect | Stops the tunnel, **config + auth kept** (the token box shows `••••••••`); click Connect to resume — no need to re-paste the token |
| Revoke | Stops the tunnel + revokes on the hub + clears locally → back to the empty "Not joined" form |
| Drop | Reconnects automatically with exponential backoff — no manual action |

## Panel states

| State | Meaning |
|---|---|
| Not joined | First time; hub + auth token required |
| Connecting / Connected / Reconnecting | Tunnel lifecycle (auto-reconnect on drop) |
| Disconnected (config kept) | After Disconnect; token saved, leave it empty and click Connect to resume |
| Managed by rdsh CLI/service | Another CLI join is running on this machine; the panel is read-only |

## Relationship with the CLI

- **One host identity**: CLI and plugin share `~/.rdsh/host.json` + the session token, so **only one tunnel runs per machine at a time** (a pid lock prevents double tunnels);
- When the CLI already owns the join, the panel shows the read-only "managed by CLI" state to avoid stealing the tunnel;
- To hand back to the CLI: Revoke in the panel, then `rdsh host join <hub>`.

## Notes / gotchas

- The plugin pulls in its dependency `rdsh-gateway` automatically;
- The auth token is shown once and stored only as a hash on the server — treat it like a password;
- If the hub revokes the token, the panel reports "host token rejected"; paste a new auth token and Connect again.

## About the project

- GitHub: [github.com/floatinghotpot/remote-dsh](https://github.com/floatinghotpot/remote-dsh)
- Plugin: `dsh plugin add dsh-web-remote`; CLI: `npm i -g remote-dsh` (MIT, open source)
