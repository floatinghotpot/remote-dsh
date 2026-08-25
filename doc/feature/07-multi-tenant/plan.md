# 07-multi-tenant — 计划（plan.md）

> **日期**: 2026-08-24
> **状态**: 已批准（用户「start plan to implement」）
> **来源**: [solution.md](solution.md)（§5 Tasks）、[req.md](req.md)（R1–R10）

---

## 1. 任务清单

| # | 任务 | 涉及文件 | 状态 |
|---|---|---|---|
| T1 | db 迁移（users 加 5 列）+ 新表 host_share / audit_events / email_codes + 方法 | `packages/hub/src/db.ts` | ✅ |
| T2 | TOTP（RFC 6238，node:crypto 零依赖） | `packages/hub/src/totp.ts` | ✅ |
| T3 | 登录二次校验（2FA）+ 账户锁定（10 次/15 分钟） | `packages/hub/src/auth.ts` | ✅ |
| T4 | EmailSender 抽象 + smtp(nodemailer)/aliyun(手写签名)/log | `packages/hub/src/email/*` | ✅ |
| T5 | config 加 email/captcha/security 字段 | `packages/hub/src/config.ts` | ✅ |
| T6 | 发信风控三层限流（收件人/触发者/全局） | `packages/hub/src/ratelimit.ts` | ✅ |
| T7 | 邮件/验证码/找回密码/2FA 端点 + 算术验证码（反枚举） | `packages/hub/src/api.ts`、`captcha.ts`、`email/send.ts` | ✅ |
| T8 | host 共享 + 权限矩阵（member 可进入、owner-only 管理） | `packages/hub/src/api.ts`、`server.ts` | ✅ |
| T9 | 审计埋点 + 查询；CLI audit ls / user unlock / reset-2fa | `packages/hub/src/audit.ts`、`packages/cli/src/bin.ts` | ✅ |
| T10 | portal 页面（设置/找回密码/共享管理/2FA） | `packages/portal/src/{pages,api}.tsx` | ✅ |
| T11 | 单测（totp/签名/限流/多租户） | `packages/hub/test/*` | ✅ |
| T12 | 文档 + CHANGELOG + 发布 hub 0.4.0 说明 | `doc/`、`CHANGELOG*` | ✅ |

## 2. RTTM（req → 任务追溯）

| 需求 | 任务 |
|---|---|
| R1 邮件提供方可配置 | T4、T5 |
| R2 邮箱绑定/验证/换绑 | T1、T4、T7、T10 |
| R3 找回密码 + 算术验证码 + 反枚举 | T1、T4、T6、T7、T10 |
| R4 2FA（TOTP） | T2、T3、T7、T10 |
| R5 共享授权 + 权限矩阵 | T1、T8、T10 |
| R6 审计日志 + 保留 90 天 | T1、T9 |
| R7 账户锁定 + admin 解锁 | T3、T9 |
| R8 portal 页面 | T10 |
| R9 安全基线（哈希/脱敏/契约先行） | T1、T7、T11 |
| R10 发信风控（全局限流 + 审计） | T6、T7、T9 |

## 3. 执行顺序

```
T1（表）→ T2（TOTP）→ T4（EmailSender）→ T5（config）→ T6（限流）
  → T3（2FA/锁定）→ T7（端点）→ T8（共享）→ T9（审计/CLI）→ T10（portal）
  → T11（单测）→ T12（文档）
```

每任务后 `pnpm build`（tsc strict）+ 相关 `node --test`，全绿再进下一任务；T11 全量回归后本地 commit（不 push）。

*关联文档：discussion.md | req.md | solution.md*
