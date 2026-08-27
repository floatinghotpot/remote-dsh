# rdsh-hub 层 1 API 契约（API.md）

> **协议先行纪律**：层 1 是 rdsh-app / rdsh-weapp / 第三方接入的依据；任何端点/字段/错误码变更必须先改本文件，再改实现，并补 conformance/单测。
> 既有端点（login/refresh/logout/password/hosts/join-token/events 等）在 M3 已冻结，见各自实现；本文档记录 **08-saas 新增端点**（注册/验证/手机号/计费/删除）。

约定：请求/响应均 `application/json`；错误统一 `{ "error": { "code", "message" } }`（`retry-after` 秒数用于限流）。认证 = `Authorization: Bearer <access>` 或 Cookie `rdsh_session`。

## 1. 注册（S1）

### POST /api/auth/register —— 发起注册（发码）
请求：`{ "channel": "email" | "phone", "identifier": string, "password": string }`
- email：合法邮箱（trim + 小写）；phone：+86 11 位（`/^1[3-9]\d{9}$/`）。
- password ≥ 8 位。
- 前置：`config.registration === "open"`，否则 404 `REGISTRATION_DISABLED`（防 bot 探测）；`channel=phone` 时 `config.sms` 必须配置，否则 400 `SMS_DISABLED`；`channel=email` 时 `config.email` 必须配置，否则 400 `EMAIL_DISABLED`。
- 发码限流：IP 10 次/分钟；重发 60s；防轰炸（phone ≤3/天，email ≤5/天）。
- 行为：identifier 已存在且已激活 → 409 `ALREADY_EXISTS`（防枚举则统一 ok？——注册场景返回明确错误，见 §7 待定）；否则建 `account_status=pending` 用户（`name = identifier`）+ 发 6 位码。
响应：`200 { "ok": true }`（不返回是否已存在，防枚举）

### POST /api/auth/register/resend —— 重发验证码
请求：`{ "channel", "identifier" }`；约束同 register 的重发限流。

### POST /api/auth/verify —— 验证并激活
请求：`{ "channel", "identifier", "code" }`
- 校验码（一次性、10 分钟、attempts≤5）；成功 → `account_status=active` + `plan_status=trial` + `trial_started_at=now` + `plan_expires_at=now+3d`，自动登录。
响应：`200 { "accessToken", "refreshToken", "user": { "id", "name" } }`
错误：`400 BAD_CODE` / `429 RATE_LIMITED`

## 2. 手机号管理（S1，`config.sms` 关闭时整体 400 `SMS_DISABLED`）

### POST /api/account/phone —— 绑定/换绑（发短信码）
认证：需要。请求 `{ "phone": "+86 11 位" }`；换绑重验；解绑后 24h 内不能重绑（`429 UNBIND_COOLDOWN`）。

### POST /api/account/phone/verify —— 验证
认证：需要。请求 `{ "phone", "code" }` → `phone_verified=1`。

### POST /api/account/phone/unbind —— 解绑
认证：需要。清 phone + verified。

## 3. 计费（S2）

### GET /api/billing/plans —— 套餐列表
响应：`{ "plans": [ { "id", "name", "hosts", "priceCny", "intervalDays" } ] }`（来源 `config.billing.plans`）

### POST /api/billing/subscribe —— 订阅
认证：需要。请求 `{ "planId" }` → 建 order（`status=created`）→ PaymentProvider 发起 → 回调/mock 支付 → `status=paid` → 激活 `plan_status=subscribed` + `plan_expires_at`。
响应：`200 { "orderId", "payUrl" | "qrCode" | ... }`（形态按 PaymentProvider 自适应）

### GET /api/billing/subscription —— 当前订阅状态
认证：需要。响应 `{ "planStatus", "plan", "planExpiresAt", "graceUntil", "hostsInUse", "hostQuota" }`

### POST /api/billing/cancel —— 取消订阅（到期不续）
认证：需要。标记 `subscriptions.status=canceled`；当前周期仍有效至到期。

### POST /api/billing/callback —— 支付异步回调（幂等）
未认证 + 验签（S3 接招行 SM2/SM3；S2 mock 直通）。同一 `channel_order_id` 只入账一次（幂等）；验签失败 400 `BAD_SIGNATURE`。
响应：`200 { "ok": true }`（渠道要求固定格式时按渠道）

## 4. 账号信息与删除（S2，R7）

### GET /api/account —— 当前账号信息（绑定状态）
认证：需要。响应：`{ "name", "email": string|null, "emailVerified": bool, "phone": string|null, "phoneVerified": bool, "totpEnabled": bool, "smsEnabled": bool, "planStatus": string|null, "planExpiresAt": number|null, "planId": string|null }`
（email/phone 为完整值，客户端自行脱敏显示；`smsEnabled` = `config.sms` 是否配置，供前端隐藏手机号入口。）

### DELETE /api/account —— 自助删除
认证：需要。请求 `{ "password" }`（二次确认）。行为：立即断全部隧道 + 删个人数据（邮箱/手机号/hosts/隧道/refresh/join/共享/审计），`payments`+`orders` 保留脱敏账务字段（金额/时间/渠道单号）；审计留痕。
响应：`200 { "ok": true }`

## 5. 配额钩子（S1，/api/hosts/register 内）

`/api/hosts/register` 建 host 前按 `plan_status` 检查 host 数上限：`NULL` 不限；`trial`=1；`subscribed`=plan.hosts；`free`/`grace`（grace 保留原配额，按原 plan.hosts）。超限 → `403 QUOTA_EXCEEDED`。

## 6. 状态机语义（req §2.5，非端点）

`account_status`: pending → active → banned | deleted（封禁/删除）。
`plan_status`: NULL → trial → subscribed | grace → free；grace 3 天；free 离线 host 数据保留 30 天。

## 7. 客户端能力（公开，未认证）

### GET /api/capabilities
认证：不需要。响应：`{ "registration": "open"|"closed", "emailEnabled": bool, "smsEnabled": bool, "captchaProvider": "arithmetic"|"none"|"aliyun", "site": {...}, "beian": {...} }`
（供注册页/找回密码页显隐手机号通道等入口；`smsEnabled` = `config.sms` 是否配置，`emailEnabled` = `config.email` 是否配置。）
- `site`：来自 `config.site`（`name/url/productUrl/termsUrl/privacyUrl` 可选字符串 + `footer` 可选数组 `[{text, href?}]`）——页脚公司导航与信息行（地址/版权/许可/备案等，运营方自定义，`href` 可选外链）；
- `beian`：来自 `config.beian`（`icp/icpUrl/gongan/gonganUrl`，全部可选）——兼容保留（页脚渲染由 `site.footer` 承担）。

## 8. 待定/备注（实现期标注）

- 注册 identifier 已存在：**已定（2026-08-26 用户拍板 A）**——返回 `409 ALREADY_EXISTS`（公开注册场景，用户需知晓"该邮箱/手机号已被占用"；不做防枚举的统一 ok）。
- 短信真发依赖阿里云签名/模板审核；`config.sms` 缺省关闭（log provider 用于测试）。
