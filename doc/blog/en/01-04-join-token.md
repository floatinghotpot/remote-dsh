# Get an access token (join token): bind your computer to your account

> 2026-09-08 · rdsh.cn cloud service
> rdsh.cn onboarding series: ① create an account → **② get an access token (this post)** → ③ pick one of three access modes → ④ account security

---

## What this step does

Once your account is ready, a computer has to be **bound to your account** before it can be reached remotely. The credential used for the binding is called an **access token (join token)**. The whole flow is:

```
Sign in to rdsh.cn → "Add host" → generate a one-time token
  → use the token on the computer to join → the computer is bound to your account → enter it anytime
```

The token is a **one-time, throwaway credential** — not a long-term password: generate it and use it on the computer right away. Once the computer has joined, it **belongs to your account** and no longer depends on the token.

## Steps

### ① Generate the token on the website

1. Sign in to **[rdsh.cn](https://rdsh.cn)**;
2. Click "**Add host**" → give the computer a name (e.g. `my dev machine` — this is how you'll recognize it in the list);
3. Choose the **validity period** (30 days by default; adjustable);
4. Click "Generate" → the page shows what to copy, **only this once**, split by how you plan to connect, with matching "Copy" buttons:
   - **Option 1: DSH plugin** — needs two things: the **hub URL** (which is the rdsh.cn address) and the **token**, each with its own copy button on the page ("Copy hub URL" / "Copy token");
   - **Option 2: command line** — needs just **one ready-made command**, click "Copy command", e.g.:

     ```bash
     rdsh host join https://rdsh.cn --token <t>
     ```

> Plugin users: copy the **hub URL + token** separately and paste them into the "Remote Access" panel in the DSH plugin (you type a host name yourself there). Command-line users: just run the copied command.

### ② Give the token to your computer

With the content in hand, follow the access mode you chose on that computer (plugin and command line each have their own guide, step by step). Once it succeeds, the computer is **bound to your account** and stays in your host list — reboots and network changes need nothing further.

### ③ Pick an access mode

Three modes to choose from (a computer runs one at a time):

- **DSH plugin** — the computer already runs the DSH web UI and you want to install as little as possible: connect with a few clicks in the UI;
- **Command line (foreground)** — you like the terminal and visible logs: run `rdsh host join` (the command above), then `rdsh host serve`;
- **Background service** — always online and starting on boot: use `rdsh host service install` (the same command can become a service).

Each mode has its own guide — follow the one you picked.

## Is your computer still safe once it's connected?

- **It "only recognizes you" — it didn't "open a door"**: after binding, only your account can enter it; nobody else can see it or get in (unless you share it yourself);
- **Everything in transit is encrypted** — the chats and files you view and operate remotely are ciphertext; the relay service can't read the content;
- **You can add a lock on the computer itself** — a host access password that belongs to you alone (optional, on/off anytime): nobody else, including the service provider, can get past it;
- **You can turn it off anytime** — pause the connection when not in use; unbind it completely when you no longer want it, and the computer instantly belongs to just you again. Whether it is connected is always your call.

## A few plain words about the token

- **Shown once**: the plaintext appears only at generation time; the service keeps no copy — treat it like a temporary password: use it right away, and generate a new one if you lose it;
- **Belongs to your account**: computers joined with it appear in your list; nobody else can see them;
- **Has a validity period**: 30 days by default, adjustable; after it expires, generate a new one;
- **Can be revoked anytime**: deleting the token in the list affects only computers that **haven't joined with it yet** — already-joined computers are unaffected;
- **One token, several computers**: you can use the same token to introduce both your home and office computers; they are managed independently.

## Quick questions

- What are "Option 1 / Option 2" on the page? They map to plugin vs. command-line access — plugin: copy the URL + token; command line: copy the whole command. Pick one;
- The command says the token is invalid/expired? Generate a new one and try again;
- Can't remember which computer a token was for? Check the name in the list — you can rename anytime.

## Next: pick an access mode

With the token in hand, follow the mode you chose (each has its own guide — just follow it in order):

- [Plugin access](01-05-plugin-mode.md) — easiest when the DSH web UI already runs on the computer; a few clicks in the UI;
- [Command-line access](01-06-cli-mode.md) — you prefer a terminal and visible logs;
- [Background-service access (Linux)](01-07-host-service-mode-linux.md) — always online and starting on boot (macOS / Windows have their own posts).

## About the project

- GitHub: [github.com/floatinghotpot/remote-dsh](https://github.com/floatinghotpot/remote-dsh)
- CLI: `npm i -g remote-dsh` (MIT license, open source)
