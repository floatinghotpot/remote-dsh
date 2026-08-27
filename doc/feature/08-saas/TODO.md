# 08-saas — TODO.md（人工配置/核对清单）

> **日期**: 2026-08-26（夜间第三轮：**全部编码已完成**，只剩配置与核对）
> **用途**: 本文档给**人**看——列出还剩什么**配置**要填、每项填什么、填完即可上线；以及已完成代码怎么验证。

---

## 0. 一句话状态

**代码全部写完**（`pnpm build` + `pnpm test` 全绿）。剩下的是**纯配置/凭证 + 招行字段核对**，不再有 coding 阻塞。

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

### ③ 阿里云验证码 2.0（填 sceneId 即验签）
- **代码**：前端 `CaptchaGate`（加载 SDK + `initAliyunCaptcha` + 回传 `captchaVerifyParam`）+ `/api/captcha/config` 端点 + 后端 `verifyCaptchaParam` RPC。
- **要填的配置**（`hub.json` → `captcha`）：
  ```jsonc
  { "captcha": { "provider": "aliyun", "aliyun": { "accessKeyId": "…", "accessKeySecret": "…", "sceneId": "…" } } }
  ```
- **需要的凭证**：sceneId（阿里云验证码 2.0 控制台创建）+ 签名/模板审核通过。**未填时用算术验证码兜底**（`provider: "arithmetic"`，零依赖、已可用）。

---

## 2. 如何验证已完成代码

1. `git status` + `git diff --stat`（约 30 个新/改文件 + 3 个新测试；**未 commit/push/发布**）。
2. `pnpm build`（tsc strict 全绿）+ `pnpm test`（tunnel 12 / hub 55 / gateway 74）。
3. 冒烟：hub.json 开 `registration: "open"` + `email/sms: {provider:"log"}` + `billing.plans` + `payment: {provider:"mock"}`，浏览器走注册→验证→试用→套餐→订阅→删除。

## 3. 提交/推送

代码在工作区，等你复核后按 Batch Plan 提交（显式路径 + 英文 message）；push 需另行确认。

---

*TODO 非空 = 特性未完全完成（此处剩余为纯配置/凭证/核对，非 coding）。人工复核后决定：close / defer / abandon。*
