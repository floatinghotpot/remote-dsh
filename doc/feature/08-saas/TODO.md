# 08-saas — TODO.md（人工配置/核对清单）

> **日期**: 2026-08-26（夜间第三轮：**全部编码已完成**，只剩配置与核对）
> **用途**: 本文档给**人**看——列出还剩什么**配置**要填、每项填什么、填完即可上线；以及已完成代码怎么验证。

---

## 0. 一句话状态

**代码全部写完 + 已提交推送**，`pnpm build` + `pnpm test` 全绿（tunnel 12 / hub 57 / gateway 74）。**阿里云验证码 2.0 已真实验签通过**（hub.unicgames.com）。剩余：**微信/招行支付凭证 + 开放注册业务决策**，无 coding 阻塞。

---

## 1. 剩余配置清单（只填配置，不改代码）

### ① 微信支付（填凭证即上线）
- **代码**：`billing/wechatpay.ts`（APIv3 Native + RSA 请求签名 + HMAC 回调验签 + AES-GCM 解密，单测覆盖）。
- **要填的配置**（`hub.json` → `billing.payment.wechatpay`）：
  ```jsonc
  { "provider": "wechatpay",
    "wechatpay": { "mchid": "…", "appid": "…", "certSerialNo": "…",
                    "privateKey": "…(PEM)…", "apiV3Key": "…", "notifyUrl": "https://…/api/billing/callback" } }
  ```
- **需要的凭证**：商户号 mchid、商户 API 证书（序列号 + 私钥 PEM）、APIv3 密钥、AppID。按需开通：Native 扫码（mchid+AppID）；JSAPI（公众号+openid）；H5（域名备案 + H5 产品）。

### ② 招商银行聚合支付（填凭证 + 核对字段）
- **代码**：`billing/cmb.ts`（SM2withSM3 签名/验签，单测覆盖）+ `createPaymentProvider` 的 `cmb` 分支。
- **要填的配置**（`billing.payment.cmb`）：
  ```jsonc
  { "provider": "cmb",
    "cmb": { "merchantNo": "…", "privateKey": "…(SM2 hex)…", "cmbPublicKey": "…(SM2 hex)…",
              "notifyUrl": "https://…/api/billing/callback" } }
  ```
- **要核对的**：下单/回调的**精确 endpoint 与字段**（依据[招行一网通支付 API](https://openhome.cmbchina.com/PayNew/pay/doc/cell/H5/OneCardPayAPI)）+ 客户经理确认「动态码 API / 手机端 H5 直唤起」——这是唯一需要"接入时核对"的点，不是大 coding。

### ✅ ③ 阿里云验证码 2.0（已真实验签通过，2026-08-27）
- **状态**：已在 **hub.unicgames.com** 真实验签通过（V3 web/H5 集成 + config-driven `prefix`），无需再动。

### ④ 开放注册业务决策（需《用户协议》《隐私政策》）
- **性质**：业务/合规 gate（非 coding、非配置）——上线把 `registration: "open"` 之前必须落地。
- **已具备**：数据删除入口（`DELETE /api/account`，R7 已实现）；注册页「☑ 同意《用户协议》与《隐私政策》」勾选（UI 占位）。
- **待办**：① 撰写《用户协议》+《隐私政策》（个保法：声明收集邮箱/手机号用途；短信含签名/退订指引）；② 注册勾选链接到真实文档页（portal 加 `/portal/terms` `/portal/privacy`）；③ 法务审阅。

---

## 2. 如何验证已完成代码

1. `git pull` + `pnpm install`（拉入 sm-crypto 等依赖）。
2. `pnpm build`（tsc strict 全绿）+ `pnpm test`（tunnel 12 / hub 57 / gateway 74）。
3. 冒烟：hub.json 开 `registration: "open"` + `email/sms: {provider:"log"}` + `billing.plans` + `payment: {provider:"mock"}`，浏览器走注册→验证→试用→套餐→订阅→删除。

## 3. 提交/推送

代码已提交并推送至 main（含 verifier 的 captcha V3 集成、邮箱/短信验证、`/api/capabilities` 能力端点等修复）。

---

*TODO 非空 = 特性未完全完成（此处剩余为纯配置/凭证/核对，非 coding）。人工复核后决定：close / defer / abandon。*
