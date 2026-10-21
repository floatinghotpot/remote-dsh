# Create an rdsh.cn account: 3 minutes to your first remote-access step for DSH

> 2026-09-08 · rdsh.cn cloud service
> rdsh.cn onboarding series: **① create an account (this post)** → ② get an access token (join token) → ③ pick one of three access modes → ④ account security

---

## What is this account for?

The whole flow is simple — just follow it in order. **This post is step 1.**

You have a computer — at home or at the office — running a **DSH agent**, and you want to reach it from anywhere (your phone, a laptop, a work computer) in a browser. The cloud service at rdsh.cn connects "your computer" and "your browser" securely:

- Your computer **connects out to** the service — no public IP needed, no ports to open;
- From any browser, you can **enter your own computer** and drive the DSH from its web page;
- The service only **connects and relays** — it doesn't hold the keys to your computer: the chats, code and files it forwards are encrypted, so it can't read them, and what your computer does is always up to you.

Your **rdsh account** is your **sign-in identity**: once a computer joins, it belongs to your account — you sign in to claim and enter your own computers, and nobody else can see or get into them (unless you share them yourself).

All you need right now is one **everyday email address** — no public IP, no software to install, and no need to touch your computer yet.

## Create the account (about 3 minutes)

### ① Open the sign-up page

Open **[rdsh.cn](https://rdsh.cn)** in a browser → click "**Sign up**".

### ② Enter your email and choose a password

Use an **email you check regularly** — verification and "forgot password" both rely on it.

### ③ Verify your email

Check your inbox for the verification email and click its link. Didn't receive it? Check the spam folder, then resend after a minute.

### ④ Sign in and see "My hosts"

Back on the site, sign in with your email and password — seeing the **(empty) host list** means your account is ready.

> Tip: baseline security is on by default. If you want an extra layer later (two-factor auth / 2FA), the "Account security & team sharing" post of this series walks you through it.

## Done? Here's what's next

Step 1 is done. Only two steps remain:

1. Sign in to rdsh.cn → "**Add host**", follow the on-page hints, and copy an **access token (join token)**;
2. Give the token to your computer — prefer a graphical UI? Install the DSH plugin; prefer the command line? Run a small tool. The guide walks you through either one.

After that: a browser anywhere → sign in to rdsh.cn → click your computer → the full DSH.

## Security protections on your account

Ordered by what matters most to you:

- **Only you can read your content** — remote sessions are fully encrypted: chats, code and files are ciphertext even to rdsh.cn; it can't read them, and keys are renewed on every connection;
- **Login password** — the first lock on your account; only you know it;
- **Two-factor auth (optional)** — an extra lock: besides your password, login asks for a code from your phone. One more layer, one more peace of mind;
- **Login protection** — after a few wrong attempts, login pauses for a few minutes and then recovers on its own, so nobody can keep guessing your password;
- **Access isolation** — your computers are visible and enterable only by you; others can't (unless you share them yourself);
- **Host access password (optional)** — you can add a password on the computer that belongs to you alone: no one else — including the service provider — can get past it;
- **No plaintext passwords stored** — the service stores verification values, not your actual password; after a password change, old logins stop working immediately.

Everyday quick notes:

- Forgot your password? Use "Forgot password" on the login page and recover it via your bound email;
- Paused after too many attempts? Wait a few minutes — nothing else to do;
- Switching devices? Just sign in with your email and password; with 2FA enabled, enter the code once more;
- Want extra peace of mind? Enable the optional protections above at any time.

## Questions you might be asking

- **Is my computer / data safe?** Safety rests on two things: connections are fully encrypted (rdsh.cn can't read the content), and only your account can enter your computers.
- **Can I use something other than your service?** Yes. The software is open source — direct LAN access, a cloud server, or a relay you run yourself are all options. rdsh.cn is simply the zero-setup choice.
- **Does it cost money?** New accounts come with a trial (currently 7 days / 1 computer; check the website), then subscribe as needed.
- **Why does it cost money at all?** Because it's a service that keeps running: servers, bandwidth, security upkeep and support all need investment — charging keeps it running reliably. Prefer to control cost yourself? Host your own relay.

## Using a team-hosted service instead

- This post uses the official rdsh.cn cloud service: sign up and go;
- If your team runs its own relay service: accounts there are usually created by its admin (self-registration is closed by default). Once you have an account, click "Add host" on its website for an access token — everything after that is the same as this post.

## About the project

- GitHub: [github.com/floatinghotpot/remote-dsh](https://github.com/floatinghotpot/remote-dsh)
- CLI: `npm i -g remote-dsh` (MIT license, open source)
