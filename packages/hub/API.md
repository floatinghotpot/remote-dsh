# rdsh-hub 层 1 API 契约（API.md）

> **协议先行纪律**：层 1 是 rdsh-app / rdsh-weapp / 第三方接入的依据；任何端点/字段/错误码变更必须先改本文件，再改实现，并补 conformance/单测。
> 既有端点（login/refresh/logout/password/hosts/join-token/events 等）在 M3 已冻结，见各自实现；本文档记录 **08-saas 新增端点**（注册/验证/手机号/计费/删除）。

约定：请求/响应均 `application/json`；错误统一 `{ "error": { "code", "message" } }`（`retry-after` 秒数用于限流）。认证 = `Authorization: Bearer <access>` 或 Cookie `rdsh_hub_session`。续期凭证 = HttpOnly cookie `rdsh_hub_refresh`（`Path=/api/auth`）；`POST /api/auth/refresh` 支持「cookie 优先、body `refreshToken` 回退」。

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
响应：`{ "plans": [ { "id", "name", "hosts", "priceCny", "priceUsd?", "intervalMonths" } ] }`（来源 `config.billing.plans`；`priceUsd` 可选，美元，缺省时客户端按人民币展示；`intervalMonths` 为周期月数，订阅到期按日历月顺延）

### POST /api/billing/subscribe —— 订阅
认证：需要。请求 `{ "planId", "form"?: "native" | "h5" | "jsapi" }`（`form` 缺省 `native`；`jsapi` 需先经 OAuth 取 openid 存于签名 Cookie，见 §9）→ 建 order（`status=created`）→ PaymentProvider 按 form 下单 → 回调/mock 支付 → `status=paid` → 激活 `plan_status=subscribed` + `plan_expires_at`。
响应：`200 { "orderId", "paid", "payInfo" }`：
- mock：`paid=true`，`payInfo={orderId, amountCny, subject}`；
- native：`paid=false`，`payInfo={ orderId, codeUrl }`（前端渲染二维码）；
- h5：`paid=false`，`payInfo={ orderId, h5Url }`（前端跳转唤起微信 App）；
- jsapi：`paid=false`，`payInfo={ orderId, appId, timeStamp, nonceStr, package, signType, paySign }`（前端 `WeixinJSBridge.chooseWXPay`）。
错误：`400 BAD_REQUEST`（未知 planId / form）/ `401` / `400 JSAPI_OPENID_REQUIRED`（jsapi 未取到 openid）。

### GET /api/billing/subscription —— 当前订阅状态
认证：需要。响应 `{ "planStatus", "plan", "planExpiresAt", "graceUntil", "hostsInUse", "hostQuota" }`

### POST /api/billing/cancel —— 取消订阅（到期不续）
认证：需要。标记 `subscriptions.status=canceled`；当前周期仍有效至到期。

### POST /api/billing/callback —— 支付异步回调（幂等）
未认证。`provider=wechatpay` 时按 **WeChat APIv3**：`Wechatpay-Timestamp` / `Wechatpay-Nonce` / `Wechatpay-Signature` 头做 **HMAC-SHA256 验签**（APIv3 密钥）+ `resource` **AES-256-GCM 解密**；`provider=mock` 直通（body 带 `channel` / `orderId` / `channelOrderId`）。同一 `channel_order_id` 只入账一次（幂等）；验签失败 400 `BAD_SIGNATURE`。
响应：`200 { "ok": true }`（渠道要求固定格式时按渠道）。

## 4. 账号信息与删除（S2，R7）

### GET /api/account —— 当前账号信息（绑定状态）
认证：需要。响应：`{ "name", "role", "email": string|null, "emailVerified": bool, "phone": string|null, "phoneVerified": bool, "totpEnabled": bool, "smsEnabled": bool, "planStatus": string|null, "planExpiresAt": number|null, "planId": string|null }`
（email/phone 为完整值，客户端自行脱敏显示；`smsEnabled` = `config.sms` 是否配置，供前端隐藏手机号入口；`role` = `user | readonly | operator | admin`，见 §10。）

### DELETE /api/account —— 自助删除
认证：需要。请求 `{ "password" }`（二次确认）。行为：立即断全部隧道 + 删个人数据（邮箱/手机号/hosts/隧道/refresh/join/共享/审计），`payments`+`orders` 保留脱敏账务字段（金额/时间/渠道单号）；审计留痕。
响应：`200 { "ok": true }`

### 两步验证（2FA，S2）

#### POST /api/account/2fa/enable —— 开启 2FA 第一步
认证：需要。响应：`{ "secret": string, "otpauthUrl": string }`（**不落库**）。`otpauthUrl` 格式：`otpauth://totp/remote-dsh:<encodeURIComponent(账号名)>?secret=<secret>&issuer=remote-dsh&algorithm=SHA1&digits=6&period=30`——label 的账号名为当前登录账号名（URL 编码）；`secret` 为 base32，保持原样不编码；显式 `algorithm/digits/period` 与服务器算法一致。

#### POST /api/account/2fa/verify —— 激活 2FA（第二步）
认证：需要。请求 `{ "secret": string, "code": string }`；用 `secret` 校验当前 TOTP，通过才落库（`totpSecret`）。响应：`200 { "ok": true }`。

#### POST /api/account/2fa/disable —— 关闭 2FA
认证：需要。请求 `{ "code": string }`（当前 TOTP）。行为：清 `totpSecret` + `ver+1`（全端会话失效）。响应：`200 { "ok": true }`。

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
- **2026-08-30**：`POST /api/auth/totp` 新增可选 `trustDevice: bool`（true → 附带 30 天可信设备 cookie `rdsh_trusted`，30 天内该浏览器再登录免输 TOTP）；`POST /api/auth/login` 在可信设备有效时直接签发会话（跳过 requiresTotp）。可信设备 token 签名含 `ver`，改密即全体失效。

## 9. 微信 OAuth（JSAPI 前置，S3）

JSAPI 支付需用户 openid（公众号 OAuth2）。门户在微信内浏览器先跳授权，再由后端取 openid 存签名 Cookie：

### GET /api/wechat/oauth/authorize —— 发起授权
认证：需要。`?redirect=<path>`（站内相对路径，校验防开放重定向）→ 302 到微信 OAuth（`snsapi_base`，`state` 携带 redirect）。

### GET /api/wechat/oauth/callback —— 授权回调（code 换 openid）
微信回调 `?code=&state=` → 后端以 `appid`/`appSecret` 调 `api.weixin.qq.com/sns/oauth2/access_token` 换 openid → 签**短期 HttpOnly Cookie**（openid 短期有效）→ 302 回 `state.redirect`。
错误：`400 OAUTH_FAILED`；`config.billing.payment.wechatpay.appSecret` 未配置时 authorize 返回 `400 WECHAT_OAUTH_DISABLED`。

## 10. 管理面（/api/admin/*，2026-08-30 新增）

**认证模型**：
- 独立管理会话 cookie `rdsh_admin_session`（30 分钟短会话，HttpOnly，JWT 含 `admin` 标记 + ver 绑定）。
- 登录三步：有效门户会话（`rdsh_hub_session`）→ 角色 ∈ `{readonly, operator, admin}`（`HubAuth.isAdminRole`）→ 2FA（账号必须已开启 TOTP）。
- **免二次输入**：可信设备 cookie `rdsh_trusted`（30 天，ver 绑定）或门户 access token 的 `totpVerifiedAt` 距今 < 30 分钟 → 免输 TOTP 直接签发管理会话（仍要求账号已开 2FA）。
- 所有写操作需请求体 `reason`（原因，必填）+ 写审计（`source='admin'`、actor、reason）。
- 管理 UI 挂载在 `/portal/admin`（门户 SPA 内），旧 `/admin` 302 重定向。

### POST /api/admin/login
认证：门户会话。请求 `{ "totp": string, "trustDevice"?: bool }`；`totp` 在免二次输入窗口内可为空。
响应：`200 { "ok": true }` + `set-cookie: rdsh_admin_session`。
错误：`401 UNAUTHORIZED`（未登录门户）/ `403 TOTP_REQUIRED`（未开 2FA 或需 TOTP）。

### POST /api/admin/logout —— 清 `rdsh_admin_session` cookie。

### GET /api/admin/me —— `{ userId, name, role }`

### GET /api/admin/dashboard —— 运营总览统计。

### GET /api/admin/users?q=&limit=&offset=
分页 + 模糊搜索（name/email/phone）。响应 `{ "users": [{ ...UserRow, hostCount }], "total" }`；`limit` 默认 50、上限 200。

### POST /api/admin/users/{id}/{action}
`action` ∈ `ban | unban | reset-password | unlock | reset-2fa | plan | set-role | delete | grant-trial | grant-subscription`
- 均需 `reason`。
- `grant-trial`：`{ days: number(1..3650), reason }` → 写 `trial`，到期 = `max(now, 当前到期) + days`；若账号已有有效订阅 → `409 CONFLICT`。RBAC：`operator`。
- `grant-subscription`：`{ planId: string, days?: number, expiresAtMs?: number, amountCny?: number(默认 0), reason }`（`days` 与 `expiresAtMs` 二选一）→ 建订单(paid/manual) + **停用旧有效订阅** + 建新订阅 + `subscribed`。`planId` 必须在 `billing.plans`。RBAC：`admin`。
- `plan`（收紧）：`planStatus` ∈ subscribed/grace/free/null + 可选 `expiresAtMs`；`subscribed` 必须已有有效订阅（否则 `400`）；`null` 不得携带 `expiresAtMs`（否则 `400`）。
- 其余：`reset-password` 另需 `password`（≥8 位）；`set-role` 另需 `role`（user/readonly/operator/admin）。
- RBAC：`operator` 可 ban/unban/reset-password/unlock/reset-2fa/plan/grant-trial；`admin` 可 set-role/delete/grant-subscription。
- **自我保护**：不能删除自己 / 修改自己角色 / 移除自己（`403 FORBIDDEN`）。

### POST /api/admin/users —— 管理台建号
`{ identifier: string, password: string(≥8), role?: user|readonly|operator|admin(默认 user), mustChange?: bool(默认 true), trialDays?: number(1..3650) | expiresAtMs?: number(遗留), reason }`
- `trialDays` 与 `expiresAtMs` 二选一（同给 → 400）；都不给 → **永久无限**（`plan=null`、无到期）。
- 带试用时写 `plan=trial` + 到期时间（**不再写 `null`+到期**）；`expiresAtMs` 为遗留字段，等价"试用到该时刻"。

### GET /api/admin/hosts?q=&limit=&offset=
分页 + 模糊搜索（主机名/归属用户名，JOIN users）。响应 `{ "hosts": [{ ...HostRow, ownerName, online }], "total" }`。

### POST /api/admin/hosts/{id}/revoke —— 吊销主机（需 `reason`）。

### GET /api/admin/orders / payments / audit / audit.csv
订单/支付/审计列表；audit 支持 `?userId=&event=&since=&source=`；audit.csv 全量导出（90 天保留）。

### POST /api/admin/orders/{id}/refund —— 人工退款（`operator`；仅 `paid` 订单；置 refunded + 取消订阅降免费档）。

### POST /api/admin/credit —— 手动补单入账（`admin` only）：`{ userId, planId, amountCny, expiresAtMs }` + `reason`。`planId` 必须在 `billing.plans`；重复补单会停用旧有效订阅（单有效订阅）。

### GET /api/admin/health —— `{ uptimeSeconds, tunnelCount, onlineHosts, dbSize, version, lastBackupAt }`

### GET /api/admin/config —— 脱敏后的运行时配置。

### GET /api/admin/admins；POST /api/admin/admins/{id}/role|remove —— 管理员管理（`admin` only；`role` 请求体 `{ role, reason }`；不能操作自己）。

## 11. 用量统计（11-usage-analytics，2026-10-10 新增）

四类用量（中转/直连流量字节、本地/云端语音时长、中转时长、会话数）端侧统计 → 上报 `usage_daily`（user×day 聚合，幂等 UPSERT 按字段 `MAX` 合并）。本期**全部端侧、仅展示**；服务端可信计量后置到 30-relay-node。

### POST /api/usage/report —— 上报一天用量（用户会话认证，App 语音用）

请求（`date` 与 8 个数值字段**全部必填**，缺任一字段即 `400`；数值均为**非负整数**；`date` 为客户端所在区域时区的日界）：

```json
{ "date": "YYYY-MM-DD", "relaySeconds": 0, "relayBytesUp": 0, "relayBytesDown": 0, "directBytesUp": 0, "directBytesDown": 0, "cloudAsrSeconds": 0, "localAsrSeconds": 0, "sessions": 0 }
```

语义：**当天累计值**；UPSERT 按字段 `MAX` 合并（网关字节与 App 语音各源只影响自己的字段，重复上报结果一致）。响应 `200 {"ok":true}`；`400 BAD_REQUEST`（字段非法）；`401 UNAUTHORIZED`。

### GET /api/usage?from=YYYY-MM-DD&to=YYYY-MM-DD —— 查询日序列（用户会话认证）

`from`/`to` **必填**（`YYYY-MM-DD`），`from ≤ to` 且 `to - from ≤ 366` 天。响应：

```json
{ "days": [{ "date", "relaySeconds", "relayBytesUp", "relayBytesDown", "directBytesUp", "directBytesDown", "cloudAsrSeconds", "localAsrSeconds", "sessions" }] }
```

按 `date` 升序，只含**有记录**的日（无数据日由客户端补「—」）。

### POST /api/host/usage/report —— gateway 上报一天用量（host token 认证）

请求 = `POST /api/usage/report` 的字段 **+** `"token": "<hostToken>"`（`rdsh host` 的 host token，≥16 字符，存哈希校验）。**归到 host owner**（`user_id = host.ownerId`）。

- `token` 缺失或 <16 字符 → `400 BAD_REQUEST`「invalid body (token required)」；`token` 查不到 → `401 UNAUTHORIZED`。
- 语音字段（cloudAsrSeconds/localAsrSeconds）：**服务端不强制恒 0**（`parseUsageDay` 照收任意非负整数并按字段 `MAX` 合并），「恒 0」仅由 gateway 侧约定保证；本端上报时由 gateway 传 0。

### GET /api/admin/usage?userId=&from=&to= —— 管理面查任意用户日用量

管理面认证（`authenticateAdmin`）。`userId` 必须为正整数；`from`/`to` 同 `GET /api/usage` 约束。响应同 `GET /api/usage`（查指定 `userId`）。

## 12. 转发侧用量上报（11-usage-analytics 第二轮，2026-10-10）

> 中转字节改由 **relay 转发侧**按「访问者 × 主机 × 天」计量（hub 内进程直调，未来独立节点走 HTTP）。网关侧仅保留直连字节。

### 表结构变更（`usage_daily`）

新增 `host_id`（默认 `''`，relay 行=被访问主机）、`instance_id`（默认 `''`，随上报进程重启变化）、`source`（`app`/`gateway`/`relay`）；唯一键由 `(user_id, date)` 改为 `(user_id, host_id, date, instance_id)`。

**合并语义**：同一 `(user_id, host_id, date, instance_id)` 内按字段 `MAX`（单实例累计值单调递增、幂等）；**跨实例（重启 = 新 instanceId）由查询侧 `SUM` 聚合**。用户视图 `GROUP BY user_id,date`；主机 owner 视图 `GROUP BY host_id,date`（= 各访问者求和）。

### POST /api/relay/usage/report —— 转发点上报一批行（节点 token 认证）

请求：

```json
{ "instanceId": "<instanceId>", "rows": [
  { "date": "YYYY-MM-DD", "userId": 1, "hostId": "host-1", "relayBytesUp": 0, "relayBytesDown": 0, "relaySeconds": 0, "sessions": 1 }
] }
```

- `userId` = **访问者**（不是 host owner）；`hostId` = 被访问主机；`relaySeconds` 本阶段转发侧为 0（不测会话时长）。
- `sessions` 语义：**每实例每 `(user, host)` 最多计 1**（本阶段转发侧不跟踪会话数，只记录“该日是否访问过”），跨实例由查询侧 `SUM` 求和。
- 认证：`nodeToken`（`Authorization: Bearer` 或 body `nodeToken`；由 30-relay-node 的节点凭据决定，hub 内进程直调不经过此端点）。
- 响应：`200 { "ok": true, "applied": <行数> }`；`400 BAD_REQUEST`（行字段非法）；`401 UNAUTHORIZED`（节点凭据无效）。

### 直连归 owner 是兜底（F7）

直连票为匿名（无 `userId`）且直连免费、不占服务端带宽 ⇒ 直连字节归 `host.ownerId` 是「**访问者未知的兜底**」，**不是**「访问者=owner」；直连**永不进配额/计费**，仅作「节省」展示。
