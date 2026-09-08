# Background service · macOS: auto-start after login — reach your DSH securely from anywhere

> 2026-09-08 · rdsh.cn cloud service
> rdsh.cn onboarding series: ③ access mode 3: background service — **macOS (launchd) post (this post, pending new-release verification)** (separate posts for Linux / Windows)

---

## Who this is for

Your Mac stays on at home or in the office, and you want DSH to **come online automatically after login and recover on its own** — no manual start of the command line or plugin each time. The macOS background service:

- connects to rdsh.cn automatically once you're signed into the desktop;
- restarts the connection automatically if the process ever exits unexpectedly;
- runs without a terminal window; logs go to a file.

## First, what it *cannot* do

macOS runs this as a **user-level LaunchAgent**: it loads only **after you sign in to the graphical desktop**. So:

- **If the Mac boots to the login window and nobody signs in, it won't start** — this is not "fully unattended";
- The real difference from the command line / plugin is **no manual start + automatic crash recovery** — not "boots and connects with nobody around";
- For **start-at-boot with no sign-in at all**: use the **Linux post** in this series (systemd + `enable-linger` is supported). On macOS that capability needs a **system-level LaunchDaemon**, which isn't provided yet — feel free to request it on the project's GitHub;
- One more note: with FileVault on, a reboot still needs one unlock at the console.

## What you need first

- A Mac (Intel or Apple Silicon) with `dsh` installed (the service starts the DSH web UI for you);
- An rdsh.cn account (generate the token on the spot when needed).

> ⚠️ **Version prerequisite**: macOS background-service support (launchd) depends on a **release that isn't published yet** — it requires remote-dsh ≥ 0.10.1 / rdsh-gateway ≥ 0.8.1 (npm currently has 0.10.0 / 0.8.0, without the fix). Confirm before you start:

```bash
npm view remote-dsh version    # should show 0.10.1 or higher
```

## Get started: one command installs everything

First, sign in to rdsh.cn → "Add host" → click Generate and copy the **token** shown once (temporary — if you lose it, just generate another). Then run this in the terminal on this Mac:

```bash
npm i -g remote-dsh        # first time only (install the new version above)
rdsh host service install https://rdsh.cn --token <t> --name my-host
```

(Replace `<t>` with the token you copied.) This single command: **binds the computer → writes the config → installs and starts the background service**.

> Already joined from the command line? Just run `rdsh host service install` — your config and binding are still there, no token needed again.

## Verify it's up

- **Status**: `rdsh host service status` → shows `active`;
- **Logs**: `tail -f ~/.rdsh/rdsh-join.log`;
- **The simplest confirmation**: sign in to **rdsh.cn** → host list → this computer shows **online**.

## A note on auto-start (worth reading)

- The service loads **after you sign in to the desktop**: a desktop Mac starts it automatically at login — no manual step;
- To get as close to "nobody needed" as possible: enable **auto-login** under System Settings → Users & Groups (with FileVault on, a reboot still needs one unlock at the console);
- Need **fully unattended, start-at-boot**? — see "what it cannot do" above (macOS would need a LaunchDaemon, not yet provided; the Linux post is the alternative).

## Day to day

- **Restart manually**: `launchctl kickstart -k gui/$(id -u)/com.rdsh-join`;
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
