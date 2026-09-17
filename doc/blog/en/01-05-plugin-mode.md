# Install a plugin: reach your DSH securely from anywhere

> 2026-09-08 · rdsh.cn cloud service
> rdsh.cn onboarding series: ① create an account → ② get an access token → **③ access mode 1: plugin (this post)** (the other access modes are also in this series)

---

## Why it's worth it: remote, anytime, secure

- **Anytime**: your DSH agent keeps working on the computer, and from **anywhere** (your phone, tablet, or any computer's browser) you can see how far it's got and send new tasks — no need to sit by the machine for long jobs. "Step away — the work doesn't stop."
- **Secure**: it all runs over encrypted connections — what you view and operate remotely is ciphertext, and only your account can enter your computer. Using it from outside feels as safe as sitting right in front of it.
- **Workspace picking just works**: once the plugin is installed, DSH's directory picker is pinned to the **in-app** browser — from a remote browser you can browse this computer's filesystem and create folders (DSH's native OS dialog would open on that computer's own screen, out of your reach).

## How it works: install a plugin

Install a plugin called `dsh-web-remote`, and a "**Remote Access**" panel appears in DSH's settings: fill in the service URL and token, click Connect, and you're done. It's the same capability as the command line — the **entry point just lives in the UI**: no command-line tool to install, no background service to manage (prerequisite: the DSH web UI, `dsh web`, is already running on this computer).

## What you need first

- The DSH web UI works on this computer (`dsh web`);
- An rdsh.cn account and an access token (not yet? Follow the earlier posts in this series: create the account, then "Add host" on rdsh.cn to generate a token);
- `pnpm` available on the computer (it's what installs the plugin; pnpm isn't part of npm — if it's missing, get it with `npm i -g pnpm` or `corepack enable pnpm`).

## Get started

### ① Install the plugin

In the terminal on this computer:

```bash
dsh plugin --profile web add dsh-web-remote
```

This installs the plugin into the DSH web UI (check with `dsh plugin --profile web ls dsh-web-remote` — if it lists the package, it's installed).

### ② Restart the DSH web UI

```bash
# Ctrl+C the running dsh web first, then start it again (plugins load at startup)
dsh web
```

It prints a URL and usually opens the browser for you — use that URL to enter the DSH web UI.

### ③ Open the "Remote Access" panel and connect

1. On the page where you generated the token on rdsh.cn, **copy the "Hub URL" and the "token" separately** (the page shows them only once; if you lost them, generate a new token);
2. In DSH's settings, find the "**Remote Access**" panel and fill in three things: the **service URL (Hub URL)**, the **token**, and a **host name** (any name that helps you recognize this computer in the list);
3. Click "**Connect**" → the status changes to "Connected";
4. From anywhere, sign in to rdsh.cn in a browser → host list → click this computer → the full DSH.

> Tip: if this computer was previously joined from the command line, it **auto-connects** after the restart — you can skip this step.

### ④ Day to day

- **Pause**: click "Disconnect" — the token is kept, so clicking "Connect" resumes it later without re-pasting;
- **Drop**: it reconnects automatically — nothing to do;
- **Remove for good**: click "Revoke" to go back to the not-connected state.

The panel status is easy to read:

- **Connected**: reachable from outside now;
- **Connecting / Reconnecting**: connecting, or auto-recovering after a drop;
- **Not connected**: never joined, or revoked;
- **Managed by the command line**: the command line is currently connected on this computer, so the panel is read-only (a computer runs one connection method at a time).

## Is your computer still safe once it's connected?

- **It "only recognizes you" — it didn't "open a door"**: after connecting, only your account can enter it; nobody else can see it or get in (unless you share it yourself);
- **Everything in transit is encrypted** — the chats and files you view and operate remotely are ciphertext; the relay service can't read the content;
- **You can add a lock on the computer itself** — set a host access password that belongs to you alone in the panel (optional, on/off anytime): nobody else, including the service provider, can get past it;
- **Disconnect anytime** — click "Disconnect" in the panel to pause, and reconnect when needed; "Revoke" removes it completely, and the computer instantly belongs to just you again.

## About the project

- GitHub: [github.com/floatinghotpot/remote-dsh](https://github.com/floatinghotpot/remote-dsh)
- Plugin: `dsh plugin --profile web add dsh-web-remote`; CLI: `npm i -g remote-dsh` (MIT license, open source)
