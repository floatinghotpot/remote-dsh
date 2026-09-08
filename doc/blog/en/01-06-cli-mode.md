# One command: reach your DSH securely from anywhere

> 2026-09-08 · rdsh.cn cloud service
> rdsh.cn onboarding series: ① create an account → ② get an access token → **③ access mode 2: command line (this post)** (the other access modes are also in this series)

---

## Who this is for

You're comfortable in a terminal: you want to work on the computer via the command line, see connection logs, and stop with a keystroke. It also fits when you only have SSH to the machine and no desktop.

Command-line access is these two commands:

```
rdsh host join https://rdsh.cn    # first time: paste the access token when prompted (it is remembered)
rdsh host serve                   # afterwards: run in the foreground to connect — no token needed again
```

> Note: `serve` is a **foreground** program — keep the terminal open (closing it drops the connection). Want it to "start on boot with nobody watching"? That's another access mode (background service), also in this series.

## What you need first

- Node.js ≥ 22;
- `dsh` installed on the computer (`serve` starts the DSH web UI for you; if dsh isn't in the usual place, point at it with `--dsh <path>`);
- An rdsh.cn account and an access token (not yet? Follow the earlier posts in this series).

## Get started

### ① Install

```bash
npm install -g remote-dsh
```

### ② Bind this computer

On the "Add host" page on rdsh.cn, click "**Copy command**", then paste and run it directly in the terminal — the copied command already carries the token:

```bash
# the copied command looks like this:
rdsh host join https://rdsh.cn --token <t>
```

You'll see something like "已接入 https://rdsh.cn"; next, run `rdsh host serve` from the following step.

> Good to know: `join` only binds and remembers (one-time — you won't need the token again); `serve` in the next step is what actually connects.

### ③ Run it in the foreground

```bash
rdsh host serve
```

It starts the DSH web UI (if not already running) and connects to rdsh.cn; the logs show the connection state.

### ④ Verify

Sign in to **rdsh.cn** in a browser → host list → this computer shows **online** → click it for the full DSH.

## Day to day

- **Pause**: `Ctrl+C` (the connection stops and it exits cleanly);
- **Resume**: `rdsh host serve` — connects again without needing the token;
- **Unbind for good**: `rdsh host leave` — the computer instantly belongs to just you again.
- **Rename**: sign in to rdsh.cn → host list → click "Rename" on this computer and change it right on the page.

## Is your computer still safe once it's connected?

- **It "only recognizes you" — it didn't "open a door"**: after connecting, only your account can enter it; nobody else can see it or get in (unless you share it yourself);
- **Everything in transit is encrypted** — the chats and files you view and operate remotely are ciphertext; the relay service can't read the content;
- **You can add a lock on the computer itself** — set a host access password that belongs to you alone (optional, on/off anytime): nobody else, including the service provider, can get past it;
- **Stop anytime** — `Ctrl+C` pauses the connection; `rdsh host serve` brings it back; `rdsh host leave` unbinds it completely, and the computer instantly belongs to just you again.

## Three different ways to connect

This series covers three ways — pick the one you like:

- **Plugin** — click in the DSH UI with minimal setup: fill in the service URL and token in settings (see the plugin post in this series);
- **Command line (this post)** — comfortable in a terminal, want visible logs, stop with Ctrl+C;
- **Background service** — start on boot with nobody watching (see the background-service post in this series).

A computer is **connected by only one mode at a time**: while the command line is connected, the plugin panel shows a read-only hint, so connections never duplicate.

## About the project

- GitHub: [github.com/floatinghotpot/remote-dsh](https://github.com/floatinghotpot/remote-dsh)
- CLI: `npm i -g remote-dsh` (MIT license, open source)
