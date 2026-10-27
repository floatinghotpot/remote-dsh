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
响应：`{ "plans": [ { "id", "name", "hosts", "priceCny", "priceUsd?", "intervalMonths", "vipTier?" } ] }`（来源 `config.billing.plans`；`priceUsd` 可选，美元，缺省时客户端按人民币展示；`intervalMonths` 为周期月数，订阅到期按日历月顺延）

- **`hosts`** = 该档**可接入云端中转的主机数**（⚠️ 术语见 §13.3 —— **不是**"用户拥有几台主机"；客户端档位对比表显示的就是它）。
- **`vipTier`** = 档位：`1` 标准版 / `2` 专业版 / `3` 旗舰版（可扩展）。客户端据此显示用户在**哪一档**（见 §13）。**缺省按 `plans[]` 声明顺序推导为 1/2/3**（向后兼容存量配置；`vipTier` 只影响展示/对比表，权益与配额由 `hosts` 决定）；同一 `billing.plans` 内**不可重复**（重复会在启动时报错）。
  > 客户端不要用"价格排序"或"数组下标"猜档位 —— 必须用本字段。

### GET /api/billing/subscription —— 当前订阅状态
认证：需要。响应 `{ "planStatus", "plan", "planExpiresAt", "graceUntil", "hostsInUse", "hostQuota" }`

### POST /api/billing/cancel —— 取消订阅（到期不续）
认证：需要。标记 `subscriptions.status=canceled`；当前周期仍有效至到期。

### GET /api/credits/balance —— 点数余额
认证：需要。响应 `{ "purchased", "bonusCarried", "bonusCurrent", "total" }`（**微单位**，客户端 ÷10000 转点数；分桶语义见 §3 点数段）。

### GET /api/credits/usage?from=YYYY-MM-DD&to=YYYY-MM-DD —— 中转消耗查询（31-relay-billing）
认证：需要。`from`/`to` **必填**（`YYYY-MM-DD`），`from ≤ to` 且 `to - from ≤ 366` 天。响应：

```json
{ "totalMicro": 1234567, "days": [{ "date": "YYYY-MM-DD", "micro": 12345 }] }
```

- `totalMicro` = 累计消耗（**微单位**，全部 relay 中转消耗，含历史）；`days` = 按日序列（**微单位**），按节点区域日切日，`date` 升序只含有消耗的日。
- 数据口径 = 中转流量扣减（`reason=consume_relay`）的水位聚合；与 `GET /api/credits/balance`（实时余额）职责分开。

### GET /api/credits/spend-daily?from=YYYY-MM-DD&to=YYYY-MM-DD —— 每日总点数消耗（relay + LLM + voice）
认证：需要。`from`/`to` **必填**（`YYYY-MM-DD`），`from ≤ to` 且 `to - from ≤ 366` 天。响应：

```json
{ "totalMicro": 1234567, "days": [{ "date": "YYYY-MM-DD", "micro": 12345 }] }
```

- `totalMicro` = 所选区间内三来源（中转 relay + LLM token + 语音 ASR/TTS）**扣点之和**（**微单位**，客户端 ÷10000 转点数）；`days` = 按日序列，`date` 升序只含有消耗的日。
- 数据口径 = `relay_charge` / `llm_usage_daily` / `voice_usage_daily` 三张日累计表的 `charged_micro` 按天 UNION 聚合（不含逐笔 credits_ledger）。

### GET /api/credits/tiers —— 点数充值档位（公开）
响应 `{ "tiers": [{ "id", "credits", "priceCny", "priceUsd"? }] }` —— 档位即 `config.billing.credits`（商品清单的 `products.consumable[]`）。
portal 后台充值页据此渲染档位（不再前端写死；与 `/api/billing/plans` 同为公开营销信息）。

### POST /api/credits/recharge —— 点数充值下单（unicpay consumable）
认证：需要。请求 `{ "goodsId", "scene"? }` → 经 unicpay 下单（`goodsId` **由平台定价**，见下）→ 返回支付参数。
- `goodsId` 必须在 **`config.billing.credits[]`** 里；否则 `400 BAD_REQUEST`（未知 goodsId）。
- unicpay 未配置时 `404 NOT_CONFIGURED`。

### POST /api/billing/order/check —— 主动查单 + 幂等补发（34-payment-order-check）
认证：需要。请求 `{ "appOrderId" }` → 先读本地订单，未 `paid` 则**主动向平台查**（`GET /v1/pay/order`），若平台已支付而本地未入账则**幂等补发**。
- 响应 `{ "status": "paid" | "pending" | "closed" | "refunded", "delivered": boolean }`。
- **归属校验**：不存在或非本人订单一律 `404`（不泄露他人订单是否存在）。
- 补发复用 webhook 的 `deliverUnicpayPaidOrder`（同一 `created→paid` 守卫 + 幂等键 `unicpay:<paymentId>`），**绝不重复发放**。
- 平台已支付但**金额不符** ⇒ `502 AMOUNT_MISMATCH`（不入账）；平台调用失败 ⇒ `502 UPSTREAM_ERROR`。
- 依赖下单时落库的 `orders.ticket` / `orders.payment_id`（旧订单无这两列则不可查）。

### POST /api/billing/unicpay/initiate —— A 类（微信）下单代理
认证：需要。请求 `{ "goodsId", "scene"? }`（`scene` ∈ `app|native|miniapp|alipay|h5|jsapi`，缺省 `app`）→ 转发 unicpay `initiate` + `prepay` → 返回 `{ "appOrderId", "ticket", "payParams" }`。
- `goodsId` **同时接受订阅与点数档位**：命中 `config.billing.plans[]` ⇒ 转发 `orderType=subscription`；命中 `config.billing.credits[]` ⇒ 转发 `orderType=payment`（与 `/api/credits/recharge` 一致）。
  App 的 `shop_page`（点数）与 `vip_page`（订阅）都走本端点（`payWechat` → `createUnicpayOrder`）；portal 网页订阅 native/h5/jsapi 也走本端点。
- `scene=h5`：`prepay` 带 `clientIp`，返回 `payParams={kind:"h5", h5Url}`；`scene=jsapi`：`prepay` 带公众号 `openid`（经 OAuth 换取的签名 Cookie，须与登录用户一致），返回 `payParams={kind:"jsapi", prepay:{appId,timeStamp,nonceStr,package,signType,paySign}}`。
- 两个列表都不命中 ⇒ `400 BAD_REQUEST`（`unknown goodsId`）。id 不会跨段重复（配置校验保证），故不会歧义。
- `jsapi` 缺 openid ⇒ `400 JSAPI_OPENID_REQUIRED`；unicpay 未配置时 `404 NOT_CONFIGURED`。

### 点数档位配置：`config.billing.productsFile`
```json
"billing": {
  "productsFile": "/abs/path/to/iap_products.json"
}
```
**单一真相** = App 仓库的 `assets/iap_products.json`（App 展示、商店商品导出、hub 记账**三方共用一份**）。
**格式规范（normative）**：私有仓 `doc/overview/iap-products-spec.md` —— 字段语义、约束与各消费方映射以它为准。
部署：`scp` 该文件到服务器 + 在 `hub.json` 写**绝对路径**；hub 启动时读 `products.consumable[]`。

| 文件字段 | 说明 |
|---|---|
| `id` | 商品 id（= unicpay 登记的 `goodsId`）；同一文件内**不可重复**（也**不可跨段重复**：同一个 id 不能既是点数又是套餐） |
| `package.credits` | 该档**送多少点数**（正整数，非微单位；嵌套在 `package` 对象里） |
| `priceCNY` | 下单记账金额（元） |
| `priceUSD` | 美元锚定价（仅元数据，hub 逻辑不读） |

- **配置错误要吵**：路径写了但**读不到 / JSON 坏 / 缺 `products.consumable`** ⇒ **启动失败**（不会静默变成"不卖点数"）。
- 未配 `productsFile` 时可用 `billing.credits[]` 内联（字段同表，拼写 `priceCny`/`priceUsd` 亦可）作为自托管/测试兜底；**两者都给时以文件为准**。
- **都不给 ⇒ 空数组 ⇒ 不卖点数**（充值下单与入账都拒绝未知 goodsId）。

同一份文件的 **`products.subscription[]` → 套餐（`billing.plans`）**，hub 不再手工配置套餐：

| 文件字段 | → hub | 说明 |
|---|---|---|
| `id` | `plans[].id` | 下单/订阅/权限匹配 |
| `l10nName["zh-CN"]` | `plans[].name` | **键缺失时回落 `en`**；键存在但为空 ⇒ 启动失败；**只用于支付订单主题**（App 显示套餐名用 App 自己的本地化文案） |
| `package.hosts` | `plans[].hosts` | host 配额（正整数） |
| `priceCNY` / `priceUSD` | `plans[].priceCny` / `priceUsd` | 下单金额 / 展示元数据 |
| `duration {unit, count}` | `plans[].intervalMonths` | `month`→count、`year`→12×count；**只接受 month/year**（hub 按日历月顺延到期日，`day`/`week` 会启动失败） |
| `package.vip_tier` | `plans[].vipTier` | 缺省按声明顺序 1,2,3…；同档不可重复 |
| `package.credits` | `plans[].bonusCredits` | 每月赠点数（缺省 0） |

- **文件优先**：配了 `productsFile` 时，`billing.plans[]` 内联配置**被忽略**（两者都给以文件为准）；未配 `productsFile` 时仍可用内联 `billing.plans[]`（自托管/测试）。
- 订阅条目字段缺失/非法（无 `l10nName`、`duration.unit` 不是 month/year、`package.hosts` 非正整数…）⇒ **启动失败并指出字段**。
- hub **不硬编码档位**，也**不在运行时向收款平台拉目录**（清单随部署一起放）。

### 订阅赠点数：`config.billing.plans[].bonusCredits`
每月按档位赠点数（正整数，单位**点数**；缺省 `0` = 不赠）。入 `bonus_current` 桶，每月 1 号按「结转一次」结算（`bonus_current` 剩余 → `bonus_carried`，旧 `bonus_carried` 清零）。数值见 09 R14。

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

`/api/hosts/register` 建 host 前按 `plan_status` 检查 **可接入云端中转的主机数**（⚠️ 语义与术语见 §13.3 —— **不是**「用户拥有几台主机」）：`internal` 不限；`NULL`=0（无权限）；`trial`=1；`subscribed`=plan.hosts；`free`/`grace`（grace 保留原配额，按原 plan.hosts）。超限 → `403 QUOTA_EXCEEDED`。

## 6. 状态机语义（req §2.5，非端点）

`account_status`: pending → active → banned | deleted（封禁/删除）。
`plan_status`: NULL（pending/deleted，无权限）→ trial → subscribed | grace → free；grace 3 天；free 离线 host 数据保留 30 天；`internal` 为永久专属档（不参与状态机）。

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
错误：`400 OAUTH_FAILED`；`config.billing.wechatOauth.appSecret` 未配置时 authorize 返回 `400 WECHAT_OAUTH_DISABLED`。

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
- `plan`（收紧）：`planStatus` ∈ internal/subscribed/grace/free/trial + 可选 `expiresAtMs`；`subscribed` 必须已有有效订阅（否则 `400`）；`internal` 不得携带 `expiresAtMs`（否则 `400`，永久）；`null` **拒绝**（要清空计费用 `free`）。
- 其余：`reset-password` 另需 `password`（≥8 位）；`set-role` 另需 `role`（user/readonly/operator/admin）。
- RBAC：`operator` 可 ban/unban/reset-password/unlock/reset-2fa/plan/grant-trial；`admin` 可 set-role/delete/grant-subscription。
- **自我保护**：不能删除自己 / 修改自己角色 / 移除自己（`403 FORBIDDEN`）。

### POST /api/admin/users —— 管理台建号
`{ identifier: string, password: string(≥8), role?: user|readonly|operator|admin(默认 user), mustChange?: bool(默认 true), trialDays?: number(1..3650) | expiresAtMs?: number(遗留), reason }`
- `trialDays` 与 `expiresAtMs` 二选一（同给 → 400）；都不给 → **永久无限**（`plan=internal`、无到期，专属账号）。
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

用量（中转/直连流量字节、本地/云端语音时长、云端/本地朗读字符数、中转时长、会话数）端侧统计 → 上报 `usage_daily`（user×day 聚合，幂等 UPSERT 按字段 `MAX` 合并）。本期**全部端侧、仅展示**；服务端可信计量后置到 30-relay-node。

### POST /api/usage/report —— 上报一天用量（用户会话认证，App 语音用）

请求（`date` 与 8 个既有数值字段**全部必填**，缺任一字段即 `400`；数值均为**非负整数**；`date` 为客户端所在区域时区的日界）。`cloudTtsChars`/`localTtsChars` 为 **32-tts-usage 新增、可选、缺省 0**（向后兼容：旧客户端不上报这两个字段也照常受理）：

```json
{ "date": "YYYY-MM-DD", "relaySeconds": 0, "relayBytesUp": 0, "relayBytesDown": 0, "directBytesUp": 0, "directBytesDown": 0, "cloudAsrSeconds": 0, "localAsrSeconds": 0, "sessions": 0, "cloudTtsChars": 0, "localTtsChars": 0 }
```

语义：**当天累计值**；UPSERT 按字段 `MAX` 合并（网关字节与 App 语音/朗读各源只影响自己的字段，重复上报结果一致）。响应 `200 {"ok":true, "creditsBalance": <微单位>}`（`creditsBalance` 为 **31-relay-billing 新增**的总余额，微单位，客户端 ÷10000 转点数）；`400 BAD_REQUEST`（字段非法）；`401 UNAUTHORIZED`。

### GET /api/usage?from=YYYY-MM-DD&to=YYYY-MM-DD —— 查询日序列（用户会话认证）

`from`/`to` **必填**（`YYYY-MM-DD`），`from ≤ to` 且 `to - from ≤ 366` 天。响应：

```json
{ "days": [{ "date", "relaySeconds", "relayBytesUp", "relayBytesDown", "directBytesUp", "directBytesDown", "cloudAsrSeconds", "localAsrSeconds", "sessions", "cloudTtsChars", "localTtsChars" }] }
```

按 `date` 升序，只含**有记录**的日（无数据日由客户端补「—」）。

### POST /api/host/usage/report —— gateway 上报一天用量（host token 认证）

请求 = `POST /api/usage/report` 的字段 **+** `"token": "<hostToken>"`（`rdsh host` 的 host token，≥16 字符，存哈希校验）。**归到 host owner**（`user_id = host.ownerId`）。

- `token` 缺失或 <16 字符 → `400 BAD_REQUEST`「invalid body (token required)」；`token` 查不到 → `401 UNAUTHORIZED`。
- 语音字段（cloudAsrSeconds/localAsrSeconds）与朗读字段（cloudTtsChars/localTtsChars）：**服务端不强制恒 0**（`parseUsageDay` 照收任意非负整数并按字段 `MAX` 合并），「恒 0」仅由 gateway 侧约定保证；本端上报时由 gateway 传 0。

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
- 认证：**每节点 token**（`Authorization: Bearer`，30 协议 B 目录）；无效则 `401`。共享 `reportToken` 已移除（31-relay-billing 收敛为单一 per-node token）。
- **计费副作用（31-relay-billing）**：hub 收到上报时**同时按累计值增量扣减点数**（`reason=consume_relay`），幂等（重复/重放不重复扣）；展示计量 `usage_daily` 与计费扣减 `credits_ledger` 两条链路并行。
- 响应：`200 { "ok": true, "applied": <行数> }`；`400 BAD_REQUEST`（行字段非法）；`401 UNAUTHORIZED`（节点凭据无效）。

### 直连归 owner 是兜底（F7）

直连票为匿名（无 `userId`）且直连免费、不占服务端带宽 ⇒ 直连字节归 `host.ownerId` 是「**访问者未知的兜底**」，**不是**「访问者=owner」；直连**永不进配额/计费**，仅作「节省」展示。

### sessions 与 relaySeconds 字段口径（预留字段，禁止用于计费/展示）

这两个字段当前**没有任何界面消费**，仅作 API/DB 预留。它们在不同上报来源上的含义**不同**，合并求和后既不是「会话数」也不是「时长」——**不得用于计费/配额，UI 上也不得命名为「会话数」或「时长」**。

| 字段 | 来源 `gateway` | 来源 `relay` |
|---|---|---|
| `sessions` | 该实例当日 **hub 隧道（重）连接次数**（≈ 网关重启/重连次数；`join` 的 `client.on("open")` 每次 +1） | 该实例当日**是否服务过**该 `(访问者, 主机)`（0/1；建行时写死 1） |
| `relaySeconds` | 该实例当日**隧道在线时长**（秒；`sessionStart→sessionEnd` 累加） | 恒 0（转发侧不测会话时长） |

合并规则为「同实例 `MAX`、跨实例 `SUM`」，因此查询侧得到的 `sessions` ≈ 网关重启次数 + hub 重启次数，`relaySeconds` ≈ 网关隧道在线时长之和；二者都不是访问者视角的「会话数/时长」。

> 真「会话数/时长」是访问者视角概念，只有 App 知道（它拥有会话生命周期）；hub/网关在链路上只见流与隧道，层 1/2 协议无会话边界信号。将来若需展示或计费，应由 **App 侧上报**（独立需求），届时替换本字段，而非在 hub 侧猜测。

## 13. 身份与权益矩阵（跨语言契约，2026-10-11）

> **唯一来源**：本节的矩阵是 **rdsh-hub（强制逻辑）/ rdsh-app（私有仓）/ rdsh-portal / rdsh-weapp / 第三方** 的共同依据。
> 任何一端新增或调整权益，**必须先改本节**，再改各端实现与测试（协议先行纪律，同文件头）。
> 各端实现：hub 见 §5；App 见私有仓 `rdsh-app/lib/rdsh/entitlements.dart`（含测试 `test/rdsh/entitlements_test.dart`）；Portal 见 `packages/portal/src/entitlements.ts`。

### 13.1 三个正交维度（不是一条身份阶梯）

| 维度 | 字段 | 取值 | 作用 |
|---|---|---|---|
| **计费档** | `plan_status`（可空）| `internal` / `trial` / `subscribed` / `grace` / `free` | **决定身份显示与配额** |
| 后台权限 | `role` | `user` / `readonly` / `operator` / `admin` | 管理面权限（§10）|
| 账号状态 | `account_status` | `active` / `pending` / `banned` / `deleted` | 账号是否可用 |

**`plan_status = internal` 的对外显示名 = 「专属账号」（Exclusive account）。**
- **不要**叫「自托管」—— 自托管是**部署形态**（开源自建 hub vs 我方托管 hub），不是用户档次；
- **不要**叫「VIP」—— 会与付费档混淆。

**`plan_status = NULL` 表示「无计费档」**，一律**无权限**（配额 0、中转计费、客户端按 free 兜底），只出现在：
- `pending`：注册未验证（验证成功即 `startTrial` → `trial`）；
- `deleted`：删除账号的墓碑。

**⚠️ 客户端必须区分「无数据」与「`plan_status` 为空」**：
- 未登录 / `GET /api/billing/subscription` 失败 → **不得**显示为「专属账号」，应显示中性状态（"订阅状态暂不可用"）；
- 只有**成功取得响应且 `planStatus === "internal"`** 才是专属账号；
- `planStatus === null` → **无权限**（按 free 兜底，不得当作专属）。

### 13.2 档位 × 权益矩阵（**冻结**）

`✅` = 该档位可用。对比表**只列稳定的可选择档位**；`trial` / `grace` 是**访问者自身的临时状态**，只出现在"我的身份"卡；`internal`（专属）**永不进入对外对比表**。

| 权益 | internal（专属）| free | trial | grace | 标准版 | 专业版 | 旗舰版 |
|---|---|---|---|---|---|---|---|
| 可云端中转的主机数（见 13.3）| **不限** | 0 | 1 | 保留原配额 | `plans[].hosts` | `plans[].hosts` | `plans[].hosts` |
| 直连（局域网 IP / 公网域名）| ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 系统语音识别 / 合成 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 离线语音包下载（ASR + TTS）| ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 离线语音识别 / 合成 | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 云端语音识别 / 合成（BYO，自费 API Key）| ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| 专属人工客服 | ✅ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ |

**判据（贯穿全表）**
1. **消耗服务端成本**的能力（离线语音包走我方 CDN、云端中转走我方带宽与中继节点）→ **免费档不给**；
2. **端侧零成本**能力（直连、系统语音识别/合成）→ **全档开放**。
   云端语音识别/合成是 **BYO**（用户自备 API Key、费用自付给厂商），**零成本但按策略**只给**旗舰版 + 专属**，用于拉开价差。

**trial 为什么必须给离线语音包**：系统语音识别**并非所有设备可用**（Android 无 GMS、墨水屏设备等），此时离线包是**唯一**语音通路；不给试用 ⟹ 核心功能完全无法体验。

**free 的对外表达**：free 档并非"什么都没有"——它仍**拥有**直连与系统语音识别/合成。客户端对比表必须列出这些行，否则整列皆 ✗，用户误以为"免费等于不可用"。

### 13.3 ⚠️ 术语：`hostQuota` 是「**可云端中转的主机数**」

主机是**用户自己的**（他自己装 rdsh-gateway）。`hostQuota` 限制的**不是**"用户拥有几台主机"，而是"**有几台能接入我方云端中转**"。

| 接入方式 | 含义 | 走我方服务器 | 占 `hostQuota` |
|---|---|---|---|
| 「扫码添加」/ `POST /api/hosts/register` | 把主机接入**云端中转**（内网穿透）| ✅ | ✅ |
| 「添加站点」（客户端手输 URL）| **直连**该主机（局域网 / 公网）| ❌ | ❌ |

**⟹ 因此**：`hostQuota = 0` **不等于**"不能用" —— 用户仍可直连**不限台数**。
UI 文案必须写「**可云端中转主机数**」，**不要**写「主机配额 N 台」。

**「云端中转」的价值根因**：它是"**没有公网 IP 的主机**"的唯一外网通道（内网穿透/隧道）。

### 13.4 时长与状态机

`plan_status`：`NULL`（pending/deleted）→ `trial` → `subscribed` / `grace` → `free`（见 §6）；`internal` 为永久专属档。
`grace → free` 时 `dropHosts`（终止隧道）；`free` 后离线主机数据保留 `retentionDays`。

| 配置 | 代码默认（`BILLING_DEFAULTS`）| 产品政策 |
|---|---|---|
| `billing.trialDays` | 3 | **7 天**（须确认线上配置已覆盖）|
| `billing.graceDays` | 3 | **3 天**（宽限期本质是"未付费仍享付费档"，越长越亏）|
| `billing.retentionDays` | 30 | 30 天 |

### 13.5 各端实现与已知缺口（2026-10-11）

| 端 | 状态 |
|---|---|
| **hub 强制** | ① 主机配额（注册口）✅ `/api/hosts/register`，§5。<br>**⛔ 离线语音包 CDN 无鉴权**：任何客户端可直连下载（单包数十 MB）—— 待处理 |
| **App**（私有仓）| ✅ 身份卡（简版/完整版）+「我的权益」清单 + 档位对比矩阵 + 专属账号视图 + 无数据态 + 开发者模式（仅 debug 构建）|
| **Portal** | ⏳ 本轮补齐（此前仍是"自托管 / 开源免费"旧口径，且无权益清单、无对比矩阵）|
| **weapp** | ⏭️ 未开始 |

> 上述两个 ⛔ 属**门禁缺口**，修复方案与验收标准见私有仓
> the internal fix record §5（S7a / S7b）。

### 13.6 超配额主机的处理（**UI 软提示**，非后端硬拦 —— 2026-10-11 决策）

超出租户套餐可中转台数的主机，**不在后端做访问门槛**。原因：
1. 后端门槛若做在"每请求"上，需 `listHostsByOwner`（`SELECT * … ORDER BY created_at`）全表扫描 —— 每个转发请求都扫一遍，纯属浪费；
2. 若做在"隧道连接"处拒绝，`gateway/src/join.ts` 是**指数退避自动重连**的（`JoinState` 含 `reconnecting`）→ 多台主机同时被拒即**重连风暴**。

**改为客户端 UI 软提示**：主机列表**按本地显示顺序**（`created_at`）数"前 N 台在配额内"，
用户点按**第 N 台之后**的云端主机时，弹提示「当前主机数已超出套餐配额，请升级或续费」，引导其进入套餐页。

**后果（已接受）**：这是**软提示而非硬拦** —— 隧道仍连着（避免风暴），若用户持有旧书签 / 共享链接直接访问，中继仍会转发。

## 14. 内部服务 API（/api/internal/*，49-llm-router，2026-10-21）

> 仅供 LLM Router（私有 `rdsh-cloud`）等内部服务调用；鉴权 = `Authorization: Bearer <service-token>`，
> 按 scope 校验，不走用户会话。token 由管理面发放（`service_tokens` 表）。

### 14.1 鉴权与错误

- 头：`Authorization: Bearer <service-token>`；
- 失败：401 `UNAUTHORIZED`（缺失/无效/吊销/scope 不足）；
- 错误体统一 `{error:{code,message}}`。

### 14.2 端点

| 方法 | 路径 | scope | 说明 |
|---|---|---|---|
| POST | `/api/internal/llm/keys` | `llm:key:create` | 签发 per-agent key；返回一次性 `token`（只存 hash） |
| POST | `/api/internal/llm/keys/{id}/revoke` | `llm:key:revoke` | 吊销 key |
| POST | `/api/internal/llm/authorize` | `llm:authorize` | 验 key + 模型白名单 + 预算 + `reserveCreditHold` → `holdId` |
| POST | `/api/internal/llm/holds/{id}/settle` | `llm:settle` | 按实际金额结算 + 累加 key spent + 按天聚合用量（同一事务） |
| POST | `/api/internal/llm/holds/{id}/release` | `llm:release` | 释放 hold，不扣费 |
| GET | `/api/internal/llm/usage?userId=&agentId=&from=&to=` | `llm:usage:read` | 查询按天聚合用量（`llm_usage_daily`） |

**authorize 请求**：`{token, model, requestId, estimateMicro, ttlMs?}`；返回 `{keyId, userId, agentId, holdId, availableMicro}`。
错误：401 `UNAUTHORIZED`（key 无效/吊销/过期/用户不活跃）、403 `MODEL_NOT_ALLOWED`、402 `QUOTA_EXCEEDED`/`INSUFFICIENT_CREDITS`。

**settle 请求**：`{keyId, actualMicro, requestId?, modelAlias?, provider?, upstreamModel?, usage?{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,reasoningTokens}, providerCostMicro?, latencyMs?, ttftMs?}`。
返回 `{chargedMicro, balance}`。幂等：同一 hold 重复 settle 返回 `already_settled`；`release` 后 settle 返回 409 `CONFLICT`。

## 15. 用户自助 LLM API Key（/api/account/llm/keys，2026-10-21）

> 用户会话鉴权（`Authorization: Bearer <access>`）；仅供用户管理**自己的** key。
> token 仅创建时返回一次，之后只回元数据（永不回 token / hash）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/account/llm/keys` | 列出自己的 key：`{id,name,status,spentMicro,budgetMicro,createdAt,lastUsedAt}` |
| POST | `/api/account/llm/keys` | 创建，`{name?}` → `{keyId, token, name}`（token 前缀 `sk-rdsh-`，仅此一次） |
| POST | `/api/account/llm/keys/{id}/revoke` | 吊销自己的 key → `{ok}` |

- 未登录 401 `UNAUTHORIZED`；操作他人 key 404 `NOT_FOUND`；
- key 用于 DSH 的 `DEEPSEEK_API_KEY`（经 `rdsh-router`）；额度 = 用户钱包点数，余额不足时 Router 返回 402。

## 16. 内部 host invite（/api/internal/hosts/invite，50-hub-host-invite，2026-10-22）

> 仅供平台 / AI 以服务令牌调用，签发绑定 userId 的 host join token；消费端复用 `/api/hosts/register` + `rdsh join --token`。

| 方法 | 路径 | scope | 说明 |
|---|---|---|---|
| POST | `/api/internal/hosts/invite` | `host:invite` | 签发生成 `{id, token, expiresAt}` |

- 请求：`{userId, label?, ttlSeconds?}`；`userId` 必填正整数，用户不存在 404；
- `ttlSeconds` 默认 600、上限 3600；
- `label` 缺省自动填 `YYYYMMDDHHmmss`；token 只存 hash。

## 17. LLM 模型目录（/api/admin/llm/* + /api/internal/llm/routers|config，51-llm-model-catalog，2026-10-22）

> Hub 是模型目录与上游 key 池的唯一事实源；Router 经 join 注册/启用后拉取整段配置（密文密封）。
> 上游 key 加密入库（信封 KEK/DEK）；管理后台只显示掩码，永不返回明文。

### 17.1 Admin（管理员会话）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/admin/llm/models` | 模型目录列表（含 `enabled`/`nameSource`/价格/容量） |
| POST | `/api/admin/llm/models` | 新增，`{id, displayName, provider?, upstreamModel?, 价格?, 容量?, sortOrder?}` |
| PUT | `/api/admin/llm/models/{id}` | 编辑（含 `enabled`/`nameSource`） |
| DELETE | `/api/admin/llm/models/{id}` | 软删（`enabled=0`） |
| GET | `/api/admin/llm/upstream-keys` | 上游 key 列表（掩码，不含密文） |
| POST | `/api/admin/llm/upstream-keys` | 新增（明文 `apiKey` 仅本次输入，加密入库），`{apiKey, label?, provider?, weight?}` |
| PUT | `/api/admin/llm/upstream-keys/{id}` | 启停 / 改权重 |
| DELETE | `/api/admin/llm/upstream-keys/{id}` | 吊销（`revoked_at` + `enabled=0`） |
| GET | `/api/admin/llm/router-join-tokens` | join token 列表 |
| POST | `/api/admin/llm/router-join-tokens` | 生成一次性 join token，`{label?, ttlMs?}` → `{id, token, label, expiresAt}` |
| GET | `/api/admin/llm/routers` | Router 列表（`pending`/`active`/`disabled`/`revoked`） |
| POST | `/api/admin/llm/routers/{id}/approve` | 启用（`pending → active`，记审批人/时间） |
| POST | `/api/admin/llm/routers/{id}/enable` | 再启用（`disabled → active`，不改审批记录） |
| POST | `/api/admin/llm/routers/{id}/disable` | 禁用（`active → disabled`） |
| POST | `/api/admin/llm/routers/{id}/delete` | 删除（软删：置 `status=revoked` + 吊销其 service token，保留行做审计） |

写操作需 `operator`/`admin`（403 `FORBIDDEN`）；读操作 `readonly` 可读。

### 17.2 内部（Router，服务令牌）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/internal/llm/routers/join` | join token（`Bearer`） | 一次性注册 → `{routerId, token}`（唯一 token，只此一次） |
| GET | `/api/internal/llm/config` | 唯一 token + scope `llm:config:read` | 返回 `{v, payload}`（整段配置密文密封；`status=active` 才 200） |

- join token 一次性、短 TTL；已用/过期 401；
- config 未启用 Router → 403 `ROUTER_NOT_APPROVED`；
- config 响应体用该 Router 唯一 token 派生密钥（HKDF-SHA256 + AES-256-GCM）加密；解密后为 `{provider:{name,baseURL,apiKey,keyId,protocol}, models:[...]}`。

### 17.3 用户（会话）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/account/llm/models` | enabled 目录（`id`/`displayName`/`contextWindow`/`maxTokens`，不含价格） |
| GET | `/api/account/llm/usage?from=&to=` | 按模型聚合用量，每模型带 `displayName`（关联目录） |

## 18. 主机 LLM 自动配置（/api/hosts/llm-key，52-auto-provision-router，2026-10-22）

> 网关以 host token 领取该 host 的 LLM key + 公网 Router 地址 + 模型目录，用于自动写 DSH provider。

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/hosts/llm-key` | host token（`body.token`） | 重签该 host 的 `sk-rdsh-` key，返回 `{ key, baseURL, models }` |

- 请求：`{ token }`（host token，明文只此一次）；
- 校验：host 存在 + owner `accountStatus === "active"`；
- 每次调用**吊销旧的 host key**、签发新 key（hash-only，旧明文不可重发）；
- `baseURL` 取活跃 Router 上报的 `public_base_url`（无活跃 Router 则为 `""`）；
- `models` 为 enabled 目录的 `[{id, displayName, contextWindow, maxTokens}]`；
- 错误：401 `UNAUTHORIZED`（host token 无效）、403 `FORBIDDEN`（owner 失活）。

### 18.1 相关契约变更

- Router join（`POST /api/internal/llm/routers/join`）请求体新增可选 `publicBaseURL`；`llm_routers` 新增 `public_base_url`；
- `GET /api/admin/llm/routers` 每行新增 `publicBaseUrl`；
- `GET /api/account/llm/keys` 每行新增 `hostId`（`null`=用户自建；非空=主机自动，**只读**）；
- `POST /api/account/llm/keys/{id}/revoke` 对 `hostId != null` 的 key 返回 403 `FORBIDDEN`。

## 19. 产品分析事件上报（/api/analytics/event，57-retention-analytics，2026-10-25）

> App 端埋点上报产品分析事件（DAU / 留存 / 付费漏斗）。**仅登录用户**（用户会话认证）；匿名设备事件不走本端点。注册/订阅/收入/用量/绑定等其余指标均由服务端数据表聚合，客户端不埋。

### POST /api/analytics/event —— 上报一批事件（用户会话认证）

请求：单个事件对象，或事件对象数组（批量）：

```json
{ "event": "app_open | purchase_start", "deviceId": "<匿名设备ID>", "ts": 1750000000000, "props": { "kind": "subscription" }, "eventId": "<客户端 UUID>" }
```

- `event`：仅允许 `app_open` / `purchase_start`，其余忽略；
- `deviceId` / `eventId` **必填**；`ts` 为 epoch ms；
- `app_open`：`props.entry` 可选（`launch` / `resume` 等入口来源）；
- `purchase_start`：`props.kind` **必填**，取值 `subscription`（订阅尝试）或 `credit`（点数充值尝试），二者分别进入付费漏斗不同口径；
- **幂等语义**：`eventId` 全局唯一；重试同 `eventId` **只记一次**（明细表 `ON CONFLICT(event_id) DO NOTHING`，日聚合仅当明细真正插入才累加——不重复计数）；
- **日聚合副作用**：成功写入时同时累进 `analytics_daily`（按 `day/user_id/event` 计数），供管理面产品分析读侧使用（读 O(聚合行) 而非 O(明细)）；明细与聚合**同一事务**；
- **日界**：`ts` 按 **Asia/Shanghai（UTC+8）** 切日，与计费账期 R13 一致。

响应：`200 { "ok": true, "count": <真正插入数>, "skipped": <跳过非法事件数> }`；`401 UNAUTHORIZED`（未登录）。

### GET /api/admin/analytics —— 管理面产品分析快照（管理面认证）

返回 Phase 1（今日注册/付费留存/漏斗/收入/流失）+ Phase 2（DAU/MAU/留存 cohort/付费尝试）聚合结果，供 admin 门户「产品分析」页使用。详见 admin 页面实现。

## 语音（55-voice-router App 侧）

### POST /api/voice/session —— 换取语音票据（用户 JWT）

请求：无 body（登录态鉴权）。

响应 `200`：

```json
{
  "ticket": "<HS256 JWT，kid=voice-ticket-v1>",
  "expiresAt": 1750000000000,
  "balance": 1000,
  "floor": -100,
  "wsUrl": "wss://<host>/v1/asr",
  "ttsUrl": "https://<host>/v1/tts",
  "serverNow": 1750000000000
}
```

- `balance` / `floor` 单位：点数（1 点 = 10000 微）；`wsUrl`/`ttsUrl` 由 active voice router 上报的公网基址推导（`/v1/asr`、`/v1/tts`）。
- 票据短时效（≤5 分钟），内含余额快照与欠费下限；ASR 请求带 `X-Rdsh-Ticket`，TTS 请求带 `Authorization: Bearer <ticket>`。

### GET /api/voice/config —— 音色白名单（用户 JWT）

响应 `200`：

```json
{ "providers": [ { "provider": "volcengine", "voices": ["volc.zh_female_vv_uranus_bigtts", "..."] } ] }
```

- 来自供应商级配置（voice_provider_configs），不含机密；供设置页展示音色列表，音色按供应商分组。
