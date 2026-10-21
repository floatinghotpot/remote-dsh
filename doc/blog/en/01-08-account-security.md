# Account security: protections the service gives you, and extra locks you can add

> 2026-09-08 · rdsh.cn cloud service
> rdsh.cn onboarding series: ① create an account → ② get an access token → ③ access modes → **④ account security (this post)**

---

## What account security is, in one sentence

When you reach your computers through rdsh.cn, safety is guaranteed on two sides: a **set of protections that are on by default** (you barely have to do anything), plus **extra locks you can add when you want** (binding an email, two-factor auth, and more). Here's each one, starting with what matters most to you.

## Protections on by default

- **Content is encrypted — only you can read it** — the chats, code and files you view remotely are ciphertext in transit; rdsh.cn only relays them, and can neither read nor alter the content;
- **Access isolation** — your computers recognize only your account: people you haven't shared with can't see them, and can't get in;
- **Login rate-limiting** — after a few wrong password attempts, login pauses for a few minutes and recovers on its own, so nobody can keep guessing your password;
- **No plaintext passwords stored** — the service stores verification values, not your actual password; even in a data incident, your password never leaks in plaintext;
- **Old logins stop working instantly** — after you change your password, every previous login is invalidated and old devices must sign in again.

## Extra locks you can add

The protections above are on by default; the three locks below are optional — add the ones you want, for extra peace of mind. The first two take just a few minutes on the "Account" page.

### ① Bind an email (do this first — takes a minute)

Binding an email is your **"proof it's you" channel for password recovery**: sign in → "**Account**" → enter your email → receive a code → verify. Later, if you forget the password, use "Forgot password" on the login page to reset it yourself (old logins are invalidated after a reset).

### ② Two-factor auth (2FA — strongly recommended)

An extra lock beyond the password: install an authenticator app on your phone, enable 2FA at "**Account**", and scan the code to bind. From then on, login asks for a one-time code from the app in addition to your password — **your account effectively has two locks**.

Any authenticator that supports standard one-time codes (TOTP) works:

- **Microsoft Authenticator** (our top pick) — available from app stores or the official site on both Android and iPhone; no Google Play dependency;
- Google Authenticator — also works (Android via Google Play, iPhone via the App Store).

Got a new phone? Rebind it at "Account".

> For convenience: when signing in on a **device you use regularly**, tick "**Trust this device for 30 days**" — you'll skip the code on that device for 30 days; **don't tick it on shared or other people's devices**. Within the same browser session, the code isn't asked repeatedly.

### ③ Host access password (optional — a lock on the computer itself)

Set a password on the computer that belongs to you alone — **nobody else, including the service provider, can get past it**; on/off anytime. Where to set it is explained in the access-mode guide you're using (plugin panel / command line).

## Share a computer with someone you trust (and take it back anytime)

- The owner of the computer clicks "**Share**" in the host list → enters the colleague's username → confirms;
- The colleague sees the computer and can use it (the full DSH), but **cannot rename, re-share, or remove it** — management stays with you;
- To take it back: **remove** them from the sharing list — they lose access immediately.

> **Important**: sharing means handing the computer over for use (a member who enters can run anything on it). Only share with people you fully trust.

## Quick questions

- Forgot the password and haven't bound an email? — Support has to help you (so it's worth the minute to bind your email);
- Enabled 2FA but lost your phone? — Rebind at "Account"; contact support if stuck;
- Login got "paused"? — that's the rate-limiter doing its job: wait a few minutes, nothing else to do;
- Shared with the wrong person / want it all back? — Remove them from the sharing list; it takes effect immediately.

## About the project

- GitHub: [github.com/floatinghotpot/remote-dsh](https://github.com/floatinghotpot/remote-dsh)
- CLI: `npm i -g remote-dsh` (MIT license, open source)
