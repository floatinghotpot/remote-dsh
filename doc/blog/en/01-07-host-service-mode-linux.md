# Background service · Linux: auto-start and stay online — reach your DSH securely from anywhere

> 2026-09-08 · rdsh.cn cloud service
> rdsh.cn onboarding series: ③ access mode 3: background service — **Linux (systemd) post (this post, verified on real machines)** (separate posts for macOS / Windows)

---

## Who this is for / when you'd use it

Your computer needs to be **online around the clock** with nobody watching a terminal — an always-on desktop or an Ubuntu machine in a server room or at home. Such a computer usually runs DSH for one of these:

- **Cloud-server administration** — run DSH on an always-on ECS / cloud host: from a browser anywhere you sign in and let the agent handle deployment, log checks and scripts on that server;
- **A cloud dev environment** — hand development work to a DSH on a cloud host: on a trip, keep going from the browser on your phone, tablet or any computer;
- **A home "agent workstation"** — an always-on DSH for long tasks (analysis, coding, workflows, file tidying): check progress and send new tasks from the browser while you're away;
- **An unattended build / batch machine** — automation jobs run around the clock and start on schedule or when triggered remotely, with nobody watching;
- **A low-power "home agent box" (e.g. a Raspberry Pi)** — run DSH 24/7 on a small ARM board: quiet, power-sipping, tucked in a corner as a personal AI-assistant host.

> About Raspberry Pi and other ARM boards: in theory it works — as long as you can install Node.js ≥ 22 and `dsh` normally, everything after that is identical to this post. **We haven't tested it on a Raspberry Pi yet**: if you get it running by following this post, let us know — we'll mark it as verified here.

What these have in common: **the computer is always online, but nobody sits in front of it** — exactly what a background service is for. Installed as one, the computer:

- connects to rdsh.cn automatically at boot (no manual step);
- restarts itself if the connection process ever exits unexpectedly;
- runs without a terminal window; logs go to the system service logs.

## What you need first

- A Linux computer (Ubuntu and other mainstream distros are fine) with `dsh` installed (the service starts the DSH web UI for you);
- An rdsh.cn account (generate the token on the spot when needed).

## Get started: one command installs everything

First, sign in to rdsh.cn → "Add host" → click Generate and copy the **token** shown once (temporary — if you lose it, just generate another). Then run this in the terminal on the computer:

```bash
npm i -g remote-dsh        # first time only
rdsh host service install https://rdsh.cn --token <t> --name my-host
```

(Replace `<t>` with the token you copied.) This single command: **binds the computer → writes the config → installs and starts the background service**.

> Already joined from the command line? Just run `rdsh host service install` — your config and binding are still there, no token needed again.

## Verify it's up

- **Status**: `rdsh host service status` → shows `active (running)`;
- **Logs**: `journalctl --user -u rdsh-join -e`;
- **The simplest confirmation**: sign in to **rdsh.cn** → host list → this computer shows **online**.

## A note on auto-start (worth reading)

The service is **user-level**: it starts when the computer boots and that user signs in. For an unattended server:

```bash
loginctl enable-linger $USER
```

After running this once, it starts at boot **without anyone signing in**. Desktop computers start it after login as usual — no extra setup.

## Day to day

- **Restart manually**: `rdsh host service restart` (equivalent to `systemctl --user restart rdsh-join`);
- **Remove for good**: run `rdsh host service uninstall` first to stop and delete the service, **then** `rdsh host leave` to unbind — order matters;
- **Rename**: sign in to rdsh.cn → host list → click "Rename" on this computer and change it right on the page;
- **After upgrading Node or reinstalling remote-dsh**: paths the service points to may change — just re-run `rdsh host service install`.

## Is your computer still safe once it's connected?

- **It "only recognizes you" — it didn't "open a door"**: after connecting, only your account can enter it; nobody else can see it or get in (unless you share it yourself);
- **Everything in transit is encrypted** — the chats and files you view and operate remotely are ciphertext; the relay service can't read the content;
- **You can add a lock on the computer itself** — set a host access password that belongs to you alone (optional, on/off anytime): nobody else, including the service provider, can get past it.

## About the project

- GitHub: [github.com/floatinghotpot/remote-dsh](https://github.com/floatinghotpot/remote-dsh)
- CLI: `npm i -g remote-dsh` (MIT license, open source)
