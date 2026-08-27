# 08-saas — 总结（summary.md）

> **日期**: 2026-08-26（通宵自主实现）

## 做了什么

按 req.md（R1–R11 + §2.5 状态机 + §2.6 UI 稿）实现 08-saas **S1 + S2**，S3 交付 mock+契约、S4 部分落地。

### 后端（`packages/hub/src/`）
- **SmsSender 抽象**（新 `sms/`）：`types.ts` / `aliyun.ts`（Action=SendSms 手写 RPC 签名，复用 `email/aliyun.ts` 的 `percentEncode`/`rpcSignature`）/ `log.ts` / `index.ts`；
- **PaymentProvider 抽象**（新 `billing/`）：`types.ts` / `mock.ts`（立即成功）/ `index.ts`；
- **config.ts**：加 `sms` / `registration`（默认 closed）/ `billing.plans` + `BILLING_DEFAULTS`；
- **db.ts**：users 加列 `phone/phone_verified/account_status/plan_status/plan_expires_at/trial_started_at` + 唯一索引；新表 `sms_codes/subscriptions/orders/payments`；`deleteAccount` 墓碑化；
- **auth.ts**：`issueSession`（验证后自动登录）+ login 拦截非 active；
- **api.ts**：注册双通道/验证/重发、登录标识符解析、手机号绑定/验证/解绑、找回密码双通道、配额钩子（`/api/hosts/register`）、计费五端点（plans/subscribe/subscription/cancel/callback）、`DELETE /api/account`、`sweepBilling`（状态机扫描）；
- **server.ts / serve.ts**：透传 sms/registration/billing + 每分钟计费扫描；
- **层 1 契约**（协议先行）：新 `packages/hub/API.md`。

### 前端（`packages/portal/src/`）
- `api.ts` 加 13 个 client 方法；`pages.tsx` 加注册/验证/套餐订阅页、登录页标识符标签 + 注册入口、账户页手机号绑定 + 删除账号。

### 测试与文档
- 新 `test/saas.test.ts`（8 用例）；既有 `api.test.ts` 注册断言更新；
- `solution.md` / `plan.md` / `verification.md` / `summary.md` / `TODO.md` 落档。

## 质量门

`pnpm build` 全绿（tsc strict）；`pnpm test` 全绿（tunnel 12 / hub 55 / gateway 74）。

## 未做（TODO.md）

招行真实支付（coding blocked）、微信支付上线验证（verifying blocked，provider 已写）、阿里云验证码前端 SDK（verifying blocked，后端 RPC 已写）、注册防枚举策略确认。

## 第二轮补充（非阻塞项全部实现，2026-08-26 夜）

- 30 天 host 数据清理（`free_since_at` + `purgeExpiredFreeHosts` + sweepBilling 接入）；
- banned 封禁管理（`rdsh hub user ban/unban` + relay/host-cookie `account_status` 拦截）；
- portal 找回密码手机号 tab（ResetPasswordPage 双通道）；
- 注册发码前置算术验证码（`verifyCaptchaBody` 分发 arithmetic/aliyun/none）；
- 阿里云验证码 2.0 后端 `verifyCaptchaParam` RPC（复用 rpcSignature）；
- 微信支付 `wechatpay` provider（APIv3 Native + RSA 请求签名 + HMAC 回调验签 + AES-GCM 解密，`test/wechatpay.test.ts` 3 用例）；
- 质量门：`pnpm build` 全绿 + `pnpm test` 全绿（tunnel 12 / hub 55 / gateway 74）。

## 第三轮补充（全部编码完成，仅剩配置，2026-08-26 晨）

- 阿里云验证码 2.0 前端 SDK 集成（`CaptchaGate` 组件 arithmetic/aliyun/none 三态 + `/api/captcha/config` 端点 + `initAliyunCaptcha` SDK 加载）；
- 招行聚合支付 `billing/cmb.ts`（SM2withSM3 签名/验签，`sm-crypto` 合理例外依赖 + `@types/sm-crypto`，`test/cmb.test.ts` 覆盖）；
- `createPaymentProvider` 支持 mock / wechatpay / cmb 三通道切换；
- 质量门：`pnpm build` 全绿 + `pnpm test` 全绿（tunnel 12 / hub 55 / gateway 74）。

## 未推送

代码留在工作区（未 git commit/push、未 npm publish），待晨间复核。
