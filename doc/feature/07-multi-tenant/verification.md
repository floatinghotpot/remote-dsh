# 07-multi-tenant — 验收（verification.md）

> **日期**: 2026-08-24
> **范围**: M5 多租户增强（R1–R10）
> **依据**: [req.md](req.md)、[plan.md](plan.md)

## 1. RTTM 复核

| 需求 | 任务 | 状态 | 证据 |
|---|---|---|---|
| R1 邮件提供方可配置 | T4、T5 | ✅ | `email/{types,smtp,aliyun,log,index}.ts` + config `email` 字段 |
| R2 邮箱绑定/验证/换绑 | T1、T4、T7、T10 | ✅ | db email 列 + `/api/account/email{/verify,/unbind}` + portal 账户页 |
| R3 找回密码 + 算术验证码 + 反枚举 | T1、T4、T6、T7、T10 | ✅ | `/api/auth/password/reset{/confirm}` + captcha.ts + 统一响应 |
| R4 2FA（TOTP） | T2、T3、T7、T10 | ✅ | totp.ts + login requires-totp + `/api/auth/totp` + portal |
| R5 共享授权 + 权限矩阵 | T1、T8、T10 | ✅ | host_share 表 + share 端点 + member 进入/只读 |
| R6 审计 + 保留 90 天 | T1、T9 | ✅ | audit_events + recordAudit + `rdsh hub audit ls` + pruneAudit |
| R7 账户锁定 + admin 解锁 | T3、T9 | ✅ | 失败计数/锁定 + `rdsh hub user unlock` |
| R8 portal 页面 | T10 | ✅ | 登录 TOTP / 账户页 / 找回密码 / 共享管理 |
| R9 安全基线（哈希/脱敏/契约） | T1、T7、T11 | ✅ | 码只存 sha256、审计无敏感值 |
| R10 发信风控 | T6、T7、T9 | ✅ | DailyWindowLimiter 三层 + 发信入审计 |

## 2. 代码存在且被调用

- EmailSender 由 `getEmailSender`（api.ts）按 `config.email` 创建并调用；
- `verifyTotp`/`generateSecret` 由 auth.ts 登录二次校验 + 2FA 端点调用；
- `DailyWindowLimiter` 由 `sendEmailCode` 三层限流调用；
- 构建 `pnpm build` 全绿；测试 **126 通过 / 0 失败**（gateway 74、hub 40、tunnel 12）。

## 3. 差距

| # | 差距 | 严重度 | 处置 |
|---|---|---|---|
| G1 | portal 页面（T10）未经真实浏览器人工走查 | P2 | 用户手工验收（登录 TOTP / 账户 / 找回密码 / 共享） |
| G2 | aliyun DirectMail HTTP API 未真发（签名只过单测，未真发对拍） | P1 | 用户配真实 AccessKey 发一封验证码邮件验收 |
| G3 | smtp provider（nodemailer）未真发 | P1 | 同上（或用户用 log provider 先跑通） |
| G4 | 审计 `pruneAudit(90)` 启动接线 | ~~P2~~ ✅ | **已解决**：serve.ts 启动时清一次 + 每天 `setInterval` 清理；保留天数 `config.security.auditRetentionDays` 可配 |

## 4. 结论

核心（db 迁移、TOTP、EmailSender、限流、端点、共享、审计、CLI）已实现并单测/构建全绿；剩余为**真机验收**（portal 走查 + 真实邮件发送）+ pruneAudit 接线，见 TODO。

*关联文档：req.md | solution.md | plan.md*
