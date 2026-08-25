# 07-multi-tenant — 方案（solution.md）

> **日期**: 2026-08-24
> **状态**: ✅ 已批准（2026-08-24，用户「start plan to implement」）
> **范围**: M5 多租户增强 —— 邮箱验证/找回密码、2FA(TOTP)、共享授权、审计、账户锁定、发信防刷（R1–R10）
> **来源**: [req.md](req.md)（R1–R10）+ 查档（hub db/api/auth/config/portal/cli 现状）
> **组件**: 仅 rdsh-hub（控制面）+ rdsh-portal + rdsh CLI；**rdsh-gateway 零改动**

---

## 1. Goal（目标架构）

```
hub 控制面新增能力（全部在 rdsh-hub，gateway 不动）：
  邮箱：EmailSender 抽象（smtp/aliyun/log）+ 绑定/验证/找回密码 + 发信防刷
  2FA：TOTP（node:crypto RFC 6238）+ 登录二次校验 + admin 重置
  共享：host_share 表（owner/member）+ 权限矩阵
  审计：audit_events 表 + 事件记录 + rdsh hub audit ls
  风控：账户锁定（10次/15分钟）+ 发信三层限流 + 找回密码算术验证码
  captcha：算术码（M5，零依赖）；08-saas 换 aliyun（复用 AccessKey 签名）
```

## 2. Facts（查档事实，2026-08-24）

### 2.1 db.ts（`HubDb`，node:sqlite）

- 表：`users(id,name,password_hash,ver,created_at,must_change)` / `hosts(id,owner_id,name,token_hash,created_at)` / `refresh_tokens` / `join_tokens`——**均无 email/2FA/共享/审计/锁定列**（db.ts:61-92）。
- 既有：`setPassword`（改密 ver+1 + 清 must_change）、`bumpVersion`、`revokeAllRefreshForUser`、`listHostsByOwner`、`getUserByName/ById` —— 全部可复用。

### 2.2 api.ts（层 1 路由 + 认证 + 限流）

- `handleApi` 大 if 链路由（api.ts:75-150）；错误统一 `{error:{code,message}}`；`authenticate`（Bearer/Cookie）；`clientIp`（behindProxy XFF）。
- 认证端点：login / first-password / refresh / logout / password；**register 显式 404**（注册关闭）。
- 限流：`loginLimiters`（IP 维度，5次/10分钟，`createLoginLimiter`）+ `registerRate`/`selfRevokeRate`（手写 Map 窗口）——**均无账户维度、无收件人/全局维度**。
- `revokeHost` 是 host 删除统一出口（删表+断隧道+offline 事件）；`sessionCookie` HttpOnly。

### 2.3 auth.ts（`HubAuth`）

- access JWT(1h, 带 ver) + refresh(7d 轮换, DB 存哈希)；**ver+1 = 全端失效**（改密/吊销复用）。
- `login(name,password)` 返回 `{tokens, mustChangePassword}`；`verifyAccess` 校验 ver。
- `createLoginLimiter`（IP 限流器工厂，可配 max/lockMs）。
- **无 2FA、无账户锁定、无 TOTP**。

### 2.4 config.ts（`HubConfig`）

- `host/port/tls/dbPath/jwtKeyPath/behindProxy`；`normalizeHubConfig` 严格校验。
- **无 email / captcha 字段**（R1 新增）。

### 2.5 portal（pages.tsx）

- 手写路由（`App` switch：login/settings/password/add-host/hosts）；`Shell/btnStyle/inputStyle/field` 通用组件；`api.ts` 封装 fetch。
- **无设置页（邮箱/2FA）、无共享管理 UI、无找回密码页**。

### 2.6 CLI（bin.ts）

- `handleHub` → `handleHubUser`(add/passwd/rm/ls) / `handleHubHost`；**无 `audit` / `unlock` / `reset-2fa` 子命令**。

### 2.7 依赖现状

- hub 依赖：仅 `ws`（服务器）+ 内部 `rdsh-tunnel`；**零第三方业务依赖**。
- M5 新增：`nodemailer`（smtp provider，须在 solution 说明理由——见 §3.3）；aliyun provider 手写签名（零依赖）；TOTP/算术码/限流全 node:crypto 内置。

## 3. Gap（差距）

1. users 表缺 email/2FA/锁定列；无 host_share / audit_events / email_codes 表。
2. 无 EmailSender（smtp/aliyun/log）与邮件功能端点；无发信防刷（收件人/全局限流、反枚举）。
3. 无 TOTP；登录流程无 2FA 二次校验。
4. 无 host 共享与 member 权限矩阵（owner 检查散布在 host 端点）。
5. 无审计记录/查询；无账户维度锁定与 admin 解锁。
6. 无找回密码端点与算术验证码；portal 无对应页面；CLI 无 audit/unlock。

## 4. Call-site Audit（共享函数契约变更）

| 变更 | 调用点 | 兼容性 |
|---|---|---|
| `users` 表加列（email/email_verified/totp_secret/failed_attempts/locked_until） | db.ts mapUser + 全部用户查询 | ✅ 增量：`ALTER TABLE ADD COLUMN` + 迁移守卫；`mapUser` 补字段，缺省 null/0 |
| `HubAuth.login` 加 2FA 分支（密码通过后若开了 TOTP → 返回 `requiresTotp` + 短效 pending token） | api.ts handleLogin | ✅ 兼容：无 2FA 用户行为不变；有 2FA 返回新字段（portal 处理） |
| `handleListHosts` / host 端点加 member 可见性 | portal/api.ts | ✅ 增量：`listHostsByOwner` → `listHostsForUser`（owner ∪ shared member） |
| 新增表/端点 | 无既有调用点 | ✅ 纯增量 |

**协议先行纪律**：新端点属层 1 扩展，本 solution 即契约文档（req R9 已要求）；实现前不改现有端点语义。

## 5. Tasks（文件改动清单）

### 5.1 数据库（`packages/hub/src/db.ts`）

**T1 — 迁移 + 新表**
- `users` 增列：`email TEXT UNIQUE`、`email_verified INTEGER DEFAULT 0`、`totp_secret TEXT`、`failed_attempts INTEGER DEFAULT 0`、`locked_until INTEGER`（迁移守卫：`PRAGMA table_info` 缺列才 `ALTER TABLE ADD COLUMN`，兼容既有库）。
- 新表：
  ```sql
  host_share  (host_id TEXT, user_id INTEGER, role TEXT DEFAULT 'member',
               created_at TEXT, PRIMARY KEY (host_id, user_id));
  audit_events(id INTEGER PRIMARY KEY, user_id INTEGER, event TEXT,
               detail_json TEXT, ip TEXT, created_at INTEGER);
  email_codes (id INTEGER PRIMARY KEY, user_id INTEGER, email TEXT,
               purpose TEXT, -- 'verify' | 'reset'
               code_hash TEXT, expires_at INTEGER, attempts INTEGER DEFAULT 0,
               created_at INTEGER);
  ```
- 方法：`setEmail/setEmailVerified/setTotpSecret/getByEmail`、`hostShare/revokeShare/listSharedHosts(role)`、`recordAudit/listAudit(filter)`、`createEmailCode/getEmailCode/consumeEmailCode`（attempts+一次性）、`accountLock/lockedUntil/resetLock`、`pruneAudit(days)`（R6 90 天清理）。

### 5.2 认证与 2FA（`packages/hub/src/auth.ts` + 新 `totp.ts`）

**T2 — TOTP（新 `packages/hub/src/totp.ts`）**
- RFC 6238：`generateSecret()` / `totp(secret, timeStep=30)` / `verifyTotp(secret, code, window=±1)`——`node:crypto` HMAC-SHA1，零依赖；单测用 RFC 6238 官方测试向量。

**T3 — 登录二次校验 + 账户锁定**
- `HubAuth.login`：① 账户锁定检查（`locked_until > now` → 拒）→ ② 密码 → ③ 若 `totp_secret`：签发**短效 pending access**（5 分钟，JWT 带 `2fa_pending` 标记），返回 `{requiresTotp:true, pendingToken}` → portal 输 TOTP → 新端点 `/api/auth/totp` 校验 + 发完整会话。
- 登录失败：`failed_attempts +1`；≥10 → `locked_until = now+15min`（R7，参数可配置）；成功清零。
- 自助关 2FA：需当前 TOTP 或 admin（复用 ver+1 全端失效）；admin 重置（新 CLI 子命令）。

### 5.3 邮件（新 `packages/hub/src/email/` + config）

**T4 — EmailSender 抽象 + 三 provider**
- `email/types.ts`：`EmailMessage{to,subject,text?,html?}`、`EmailSender{send(msg):Promise<void>}`、`createEmailSender(config)` 工厂（按 `config.email.provider` 返回实现；无 email 配置 → 返回「未启用」标记）。
- `email/smtp.ts`：**nodemailer**（理由：SMTP 客户端成熟、465/587/TLS 开箱即用、体积小；唯一新增第三方依赖——M5 首个外部服务依赖，req §2.3 已声明）。
- `email/aliyun.ts`：**手写 RPC 签名**（`node:crypto` HMAC-SHA1 + 内置 fetch，POST `dm.aliyuncs.com`；参考 Logto `@logto/connector-aliyun-dm` 生产实现 + 官方文档测试向量单测；`endpoint` 可配，默认国内）。
- `email/log.ts`：只写 `~/.rdsh/hub-email.log` + 返回成功（测试/本地/无邮件自托管）。

**T5 — config.ts 加 email/captcha 字段 + 校验**
- `HubConfig` 增 `email?: {provider, from, fromAlias?, smtp?, aliyun?}`、`captcha?: {provider: "arithmetic"|"none"}`、`security?: {emailDailyLimit?, globalEmailDailyLimit?}`；`normalizeHubConfig` 严格校验（R1/R10）。

### 5.4 邮件功能端点 + 防刷（`packages/hub/src/api.ts` + 新 `email/send.ts`、`ratelimit.ts`）

**T6 — 发信风控（新 `ratelimit.ts`）**
- 复用 `createLoginLimiter` 模式，新增维度：每**收件人**（`<email>` 窗口计数，≤5/天）、每**触发者**（匿名按 IP ≤3/天、登录按 userId）、**全局**（≤可配置，默认 200/天，超限拒绝+审计告警）。

**T7 — 邮件端点（api.ts 增路由 + handler）**
- 匿名：`POST /api/captcha/arithmetic`（发题，HMAC 签名答案 + 一次性 token，零依赖）、`POST /api/auth/password/reset` {email, captchaToken, captchaAnswer} → 校验验证码 → **响应统一**（邮箱存在才真发码，不存在也返回「已发送」，防枚举，R3）→ `POST /api/auth/password/reset/confirm` {email, code, newPassword} → 校验 → `setPassword`（ver+1 全端失效，R3）。
- 登录后：`POST /api/account/email`（绑定/换绑，发 PIN）、`POST /api/account/email/verify`（校验 PIN，`email_verified=1`）、`POST /api/account/email/unbind`（解绑，24h 重绑限制，R2）；`POST /api/account/2fa/enable`（生成 secret）、`POST /api/account/2fa/verify`（激活）、`POST /api/account/2fa/disable`（需当前 TOTP）。
- 发信统一走 `email.send`（smtp/aliyun/log）；所有发信入审计（R10）。

### 5.5 共享授权（api.ts + db.ts）

**T8 — 共享端点 + 权限矩阵**
- `POST /api/hosts/:id/share` {userId, role} / `DELETE /api/hosts/:id/share/:userId` / `GET /api/hosts/:id/shares`——仅 owner（R5）。
- 可见性：`handleListHosts` 改 `listHostsForUser`（owner ∪ member 共享）；进入 host 的 `/h/:id` 校验 owner **或** member（server.ts `handleEnterHost` 归属校验加 member 分支）；host 管理操作（rename/revoke/share/join-token 不共享）保持 **owner-only 403**（R5）。

### 5.6 审计（db.ts + api.ts + CLI）

**T9 — 审计记录 + 查询**
- 埋点：login 成败、refresh、改密、first-password、join-token 创建/吊销、register 成败、host 进入、host 共享变更、发信（R10）、锁定/解锁（对齐 05 R10 预留事件）。
- 清理：启动 + 每日 `pruneAudit(90)`（R6，可配置）。
- CLI（bin.ts）：`rdsh hub audit ls [--user] [--event] [--since]`（JSON 行）、`rdsh hub user unlock <name>`（R7）、`rdsh hub user reset-2fa <name>`（admin 重置）。

### 5.7 portal（pages.tsx + api.ts）

**T10 — 页面**
- 设置页 `/settings/account`：绑定/换绑邮箱（PIN 输入）、解绑、开/关 2FA（secret 展示 + 激活码输入）、改密入口。
- 找回密码页 `/reset-password`：邮箱 + 算术验证码 → 收码 → 设新密码。
- host 列表：member 可见共享 host（标记）；owner 的 host 增加「共享管理」弹层（邀请/移除 member）。
- 登录页：`requiresTotp` → TOTP 输入页。
- 全部 i18n zh/en（对齐 req R8）。

### 5.8 测试 + 文档

**T11 — 单测/e2e**
- `test/totp.test.ts`（RFC 6238 向量）、`test/aliyun-signature.test.ts`（官方测试向量）、`test/email-providers.test.ts`（smtp 用 log 替身、aliyun 签名断言、log provider）、`test/ratelimit.test.ts`（收件人/全局上限）、`test/multi-tenant.test.ts`（绑定/验证/找回/2FA/共享权限矩阵/锁定/审计断言/反枚举响应）。
- 回归：全量 `pnpm test`；M1–M4 不回归。

**T12 — 文档/发布**
- 层 1 API 契约扩展文档（新端点清单——本 solution §5.4/5.5 即契约）；usage.md §8 更新；CHANGELOG；roadmap M5 进度。
- 发布 `rdsh-hub@0.4.0`（新增能力 = minor）。

## 6. 数据契约（层 1 API 扩展，新端点）

| 方法+路径 | 认证 | 请求 | 响应 |
|---|---|---|---|
| `POST /api/captcha/arithmetic` | 无 | — | `{token, question}`（HMAC 签名） |
| `POST /api/auth/password/reset` | 无 | `{email, captchaToken, captchaAnswer}` | 统一 `{ok:true}`（防枚举；邮箱存在才真发） |
| `POST /api/auth/password/reset/confirm` | 无 | `{email, code, newPassword}` | `{ok:true}` \| 400（码错/过期/限流） |
| `POST /api/auth/totp` | pending token | `{code}` | `{accessToken, refreshToken}` |
| `POST /api/account/email` | 登录 | `{email}` | `{ok:true}`（发 PIN） |
| `POST /api/account/email/verify` | 登录 | `{email, code}` | `{ok:true}` |
| `POST /api/account/email/unbind` | 登录 | — | `{ok:true}`（24h 重绑限制） |
| `POST /api/account/2fa/enable` | 登录 | — | `{secret, otpauthUrl}` |
| `POST /api/account/2fa/verify` | 登录 | `{code}` | `{ok:true}`（激活） |
| `POST /api/account/2fa/disable` | 登录 | `{code}` | `{ok:true}`（需当前 TOTP；ver+1） |
| `POST /api/hosts/:id/share` | 登录(owner) | `{userId, role}` | `{ok:true}` |
| `DELETE /api/hosts/:id/share/:userId` | 登录(owner) | — | `{ok:true}` |
| `GET /api/hosts/:id/shares` | 登录(owner) | — | `{shares:[{userId,name,role}]}` |

- 错误统一 `{error:{code,message}}`；限流 429 + `retry-after`；i18n 由 portal 端处理。

## 7. 待定项（留给 plan.md，不阻塞 solution 批准）

- users 表迁移守卫的精确实现（PRAGMA table_info 循环 ADD COLUMN）与 `:memory:` 测试兼容
- pending access token 的载体（JWT 带 `2fa_pending` vs 独立短效串）——选型进 plan
- 算术验证码 token 的 HMAC 签名/一次性/过期细节
- 共享后 host 的 `hosts` 列表返回结构（是否带 `sharedBy` 标记）与 portal 展示
- 审计 detail_json 字段 schema 定稿（对齐 05 R10 预留）

*关联文档：req.md | discussion.md | roadmap（M5）| 08-saas（下游）| 下一步：plan.md（待 solution 批准后）*
