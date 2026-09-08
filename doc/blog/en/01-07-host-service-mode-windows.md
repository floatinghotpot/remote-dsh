# Background service · Windows: current status and usable routes

> 2026-09-08 · rdsh.cn cloud service
> rdsh.cn onboarding series: ③ access mode 3: background service — **Windows post (this post: limited status + usable routes)** (separate posts for Linux / macOS)

---

## Current status (let's be clear)

One-click "install as a background service" is **not available on Windows yet** — remote-dsh's service support covers Linux (systemd) and macOS (launchd). On Windows, **please don't run** `rdsh host service install` directly (it will fail).

That said, two usable routes exist today — pick one:

### Route 1: follow the Linux post inside WSL2 (recommended)

If you want a Windows computer to stay online around the clock:

1. Install **WSL2 + Ubuntu** (prefer a recent WSL version with systemd support; how to enable it is in Microsoft's official docs);
2. Install `dsh` inside Ubuntu, then **follow the "Background-service access · Linux" post of this series exactly** (one `service install` command does it).

> Benefit: the same verified flow as the Linux post — it auto-starts with WSL at boot and connects to rdsh.cn.

### Route 2: Windows-native — run it in the foreground for now

For temporary use:

- After signing in, open a terminal and run `rdsh host serve` — remote access works while it runs (closing the window disconnects);
- To start it at login, you can use Windows' built-in **Task Scheduler** to launch it at sign-in — this is a generic system-level approach, a stopgap, not an official remote-dsh background service.

## Why there's no one-click service on Windows yet

Windows has no user-level service model like systemd/launchd; it needs a dedicated implementation (Task Scheduler / service wrapper), which is platform work — **it's on our radar**. This post will be updated when it ships, and we'll add the full Windows tutorial then.

> Need it badly? Tell us on the project's GitHub — it helps set priorities.

## Is your computer still safe once it's connected?

- **It "only recognizes you" — it didn't "open a door"**: after connecting, only your account can enter it; nobody else can see it or get in (unless you share it yourself);
- **Everything in transit is encrypted** — the chats and files you view and operate remotely are ciphertext; the relay service can't read the content;
- **You can add a lock on the computer itself** — set a host access password that belongs to you alone (optional, on/off anytime): nobody else, including the service provider, can get past it.

## About the project

- GitHub: [github.com/floatinghotpot/remote-dsh](https://github.com/floatinghotpot/remote-dsh)
- CLI: `npm i -g remote-dsh` (MIT license, open source)
