# Install a plugin: reach your DSH securely from anywhere

> 2026-09-08 · rdsh.cn cloud service
> rdsh.cn onboarding series: ① create an account → ② get an access token → **③ access mode 1: desktop plugin (this post)** (the CLI mode is a sibling post in this series)

---

## Why it's worth it: remote, anytime, secure

- **Anytime**: your DSH agent keeps working on the computer, and from **anywhere** (your phone, tablet, or any computer's browser) you can see how far it's got and send new tasks — no need to sit by the machine for long jobs. "Step away — the work doesn't stop."
- **Secure**: it all runs over encrypted connections — what you view and operate remotely is ciphertext, and only your account can enter your computer. Using it from outside feels as safe as sitting right in front of it.
- **Workspace picking just works**: once the plugin is installed, DSH's directory picker is pinned to the **in-app** browser — from a remote browser you can browse this computer's filesystem and create folders (DSH's native OS dialog would open on that computer's own screen, out of your reach).

## How it works: two paths, pick one

- **DSH desktop app**: install a plugin called `dsh-web-remote`, and a "**Remote Access**" panel appears in DSH — fill in the service URL + token, click Connect;
- **CLI**: **no plugin needed** — `npm i -g remote-dsh`, then `rdsh join`.

Both paths offer the same capability; pick whichever fits you. This post covers the desktop plugin (see the "CLI mode" post for the command line).

## What you need first

- The DSH app works on this computer (desktop app, or `dsh web`);
- An rdsh.cn account and an access token (not yet? Follow the earlier posts in this series: create the account, then "Add host" on rdsh.cn to generate a token);
- **Desktop plugin only**: installing the plugin uses `pnpm` (if it's missing, get it with `npm i -g pnpm` or `corepack enable pnpm`).

## Get started (desktop)

### ① Install the plugin

1. Open the **DSH desktop app** → "**Plugins**" in the top-left → **install a third-party plugin**;
2. Enter the plugin name `dsh-web-remote`, then open the plugin panel — it appears in DSH as "WhaleLink Voice".

### ② Bind this computer

1. On the page where you generated the token on rdsh.cn, **copy the "Hub URL" and the "token" separately** (the page shows them only once; if you lost them, generate a new token);
2. In the plugin panel fill in three things: the **service URL (Hub URL)**, the **token**, and a **host name** (any name that helps you recognize this computer in the list), then click "**Connect**" → the status becomes "Connected";
3. Or just **scan the QR code with the WhaleLink App** (recommended — fastest, no copy-paste);
4. From anywhere, sign in to rdsh.cn in a browser → host list → click this computer → the full DSH.

### ③ Day to day

- **Pause**: click "Disconnect" — the token is kept, so clicking "Connect" resumes it later without re-pasting;
- **Drop**: it reconnects automatically — nothing to do;
- **Remove for good**: click "Revoke" to go back to the not-connected state.

The panel status is easy to read:

- **Connected**: reachable from outside now;
- **Connecting / Reconnecting**: connecting, or auto-recovering after a drop;
- **Not connected**: never joined, or revoked;
- **Managed by the command line**: the command line is currently connected on this computer, so the panel is read-only (a computer runs one connection method at a time).

## Or: the CLI (no plugin)

```bash
npm install -g remote-dsh
rdsh join                       # omit the hub URL to print a QR code, then scan it with the WhaleLink App
rdsh serve                      # foreground; install as a service with rdsh service install
```

## Is your computer still safe once it's connected?

- **It "only recognizes you" — it didn't "open a door"**: after connecting, only your account can enter it; nobody else can see it or get in (unless you share it yourself);
- **Everything in transit is encrypted** — the chats and files you view and operate remotely are ciphertext; the relay service can't read the content;
- **You can add a lock on the computer itself** — set a host access password that belongs to you alone in the panel (optional, on/off anytime): nobody else, including the service provider, can get past it;
- **Disconnect anytime** — click "Disconnect" in the panel to pause, and reconnect when needed; "Revoke" removes it completely, and the computer instantly belongs to just you again.

## About the project

- GitHub: [github.com/floatinghotpot/remote-dsh](https://github.com/floatinghotpot/remote-dsh)
- Desktop plugin: search `dsh-web-remote` under "Plugins" in the DSH desktop app; CLI: `npm i -g remote-dsh` (MIT license, open source)
