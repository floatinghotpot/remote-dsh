# 07-multi-tenant — 总结（summary.md）

> **日期**: 2026-08-24
> **范围**: M5 多租户增强（R1–R10，rdsh-hub 0.4.0）

## 完成内容

- **db.ts**：users 加 email/email_verified/totp_secret/failed_attempts/locked_until（含迁移守卫）；新表 host_share / audit_events / email_codes + 全套方法。
- **totp.ts**：RFC 6238（node:crypto，官方向量单测通过）。
- **email/**：EmailSender 抽象 + smtp(nodemailer)/aliyun(手写 RPC 签名)/log 三 provider。
- **captcha.ts**：算术验证码（零依赖，一次性）。
- **ratelimit.ts**：DailyWindowLimiter（发信三层限流）。
- **auth.ts**：登录 returns LoginOutcome（locked/bad-credentials/requires-totp/ok）+ 2FA 二次校验 + 账户锁定。
- **api.ts**：新增 13 个端点（2FA/验证码/找回密码/邮箱/共享）+ 反枚举 + 发信防刷 + 审计埋点。
- **server.ts**：member 可进入 host；email/captcha/security 传入 runtime。
- **cli/bin.ts**：`rdsh hub audit ls` / `user unlock` / `user reset-2fa`。
- **portal**：登录 TOTP、账户与安全页（邮箱+2FA）、找回密码页、host 共享管理。
- **测试**：42 hub 测试（含 totp/aliyun 签名/多租户 e2e/user rm 全表清理）；全量 **128 通过 / 0 失败**。

## 状态

**M5 全部验证完成**（2026-08-24）：实现 + 单测/构建 + 真机验收（portal 走查 + 真实邮件发送）全部通过。[TODO.md](TODO.md) 为空。

*关联文档：req.md | solution.md | plan.md | verification.md*
