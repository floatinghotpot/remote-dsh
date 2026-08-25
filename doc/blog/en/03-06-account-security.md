# Multi-user & team: email verification, 2FA, machine sharing, audit log

**English** | [中文](../zh/03-06-account-security.md)

> 2026-08-24 · remote-dsh 0.6.x / rdsh-hub 0.4.0 (M5, dev build unpublished)
> Server-relay series: ⑤ multi-machine + public hub → this: account security & team sharing

---

## The scenario

You already run your own hub (see [Deploy the hub on an ECS](03-01-hub-public.md)) and it works great for one person. Now you want it to work like a **team tool**:

1. Let a **colleague use a machine** — without letting them change its config;
2. Recover a lost password yourself (instead of begging the admin);
3. Add **two-factor auth** so a leaked password isn't game over;
4. Keep an **audit trail** of who did what, when.

That's **M5 multi-tenant hardening** — entirely in the hub control plane; the host-side `rdsh` doesn't change.

## One-time config (hub.json)

Edit `~/.rdsh/hub.json`. Pick one `email` provider (Example 1 = SMTP, Example 2 = Aliyun DirectMail HTTP API); `captcha` / `security` are common; without `email`, verification / password reset are disabled.

Overall structure (`email` / `captcha` / `security` are all **top-level keys**, each independently optional):

```jsonc
{
  "host": "0.0.0.0",
  "port": 8443,
  "tls": { "cert": "/path/cert.pem", "key": "/path/key.pem" },
  "behindProxy": false,               // true only behind a TLS-terminating reverse proxy

  "email": { /* …Example 1 or Example 2… */ },
  "captcha": { "provider": "arithmetic" },
  "security": { /* …"Common: captcha + rate limits"… */ }
}
```

### Example 1: SMTP (most universal — any mail provider)

```jsonc
"email": {
  "provider": "smtp",
  "from": "noreply@example.com",
  "fromAlias": "remote-dsh",            // optional, display name
  "smtp": {
    "host": "smtpdm.aliyun.com",        // Aliyun DirectMail SMTP endpoint (swap for any provider)
    "port": 465,                        // 465 = SSL (secure:true); 587 = STARTTLS (secure:false)
    "secure": true,
    "user": "noreply@example.com",      // sender address / account
    "password": "SMTP password"         // the dedicated SMTP password set in the console (not the AccessKey)
  }
}
```

### Example 2: Aliyun DirectMail HTTP API (port 443, no SMTP port issues)

```jsonc
"email": {
  "provider": "aliyun",
  "from": "noreply@example.com",        // the "sender address" in the Aliyun console
  "fromAlias": "remote-dsh",
  "aliyun": {
    "accessKeyId": "LTAI...",
    "accessKeySecret": "...",            // hand-written RPC signature, no region_id needed
    "endpoint": "https://dm.aliyuncs.com/"  // optional: mainland default; use dm.ap-southeast-1.aliyuncs.com abroad
  }
}
```

### Common: captcha + rate limits (optional, all have defaults)

```jsonc
"captcha": { "provider": "arithmetic" },   // anti-bot on the reset page
"security": {
  "emailDailyLimit": 5,              // per-recipient daily cap (anti-harassment)
  "globalEmailDailyLimit": 200,      // global daily cap (anti-quota-burn)
  "loginLockThreshold": 10,          // consecutive failures before lockout
  "loginLockMinutes": 15,
  "auditRetentionDays": 90           // keep audit events for 90 days
}
```

Restart the hub.

> **Aliyun prerequisites** (one-time, console + DNS): enable "DirectMail" → add & verify the sending domain (SPF/DKIM) → create the sender address `noreply@example.com`. For **SMTP**, set a "dedicated SMTP password" on that address; for the **HTTP API**, create a RAM AccessKey and grant it. Verification/reset mail volume is tiny — the free tier is enough. For local dev, use `provider: "log"` (writes a log instead of sending).

## User side: bind email + reset + 2FA

All self-service in the portal, no admin involved:

1. Sign in → "**Account**" (top right) → enter your email → "Send code" → verify;
2. After binding, "**Forgot password**" on the login page → email + arithmetic captcha → reset code → set a new password (**all old sessions are revoked**);
3. On the same page, "Enable 2FA" → copy the secret into Google Authenticator / 1Password → confirm with the current TOTP code. Logins then require password + code.

## Share a machine with a colleague

As owner, click "**Share**" on a machine in "My machines" → type the colleague's **username** → confirm:

- They see the machine in their list (marked "shared"); "Enter" gives the full DSH;
- They do **not** see the rename / share / revoke buttons — management stays owner-only;
- To revoke, remove them in the share manager.

> **Heads-up**: sharing hands the machine over completely (DSH authorizes the whole instance — a member can run arbitrary commands). Only share with people you trust.

## Admin: audit + unlock

```bash
# Audit: who did what, when (login ok/fail, password change, 2FA, sharing, email…)
rdsh hub audit ls
rdsh hub audit ls --user alice --event host.share
rdsh hub audit ls --since 24h

# Someone got locked out (10 wrong passwords):
rdsh hub user unlock alice

# Someone lost their 2FA secret:
rdsh hub user reset-2fa alice
```

## Notes / gotchas

- **Email is the prerequisite for password reset**: without `email`, a lost password means the admin resets it (`hub user passwd`);
- **Anti-enumeration**: the reset endpoint returns "sent" whether or not the email exists — no leaking who registered;
- **Anti-abuse**: three-tier send rate limits (recipient / trigger / global) + an arithmetic captcha on reset — scripts can't spam or burn your quota;
- **Hashes only**: PINs, reset codes, and TOTP secrets are stored hashed, never in plaintext.

## About the project

- GitHub: [github.com/floatinghotpot/remote-dsh](https://github.com/floatinghotpot/remote-dsh)
- Install: `npm i -g remote-dsh` (MIT, open source)
