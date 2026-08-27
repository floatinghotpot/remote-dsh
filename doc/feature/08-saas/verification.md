# 08-saas — 验收（verification.md）

> **日期**: 2026-08-26（通宵自主实现，晨间待用户复核）
> **范围**: S1 + S2 完整落地；S3 交付 mock+契约（资质阻塞）；S4 部分（限流/短信防轰炸/审计）

## 1. RTTM 覆盖核对（req → plan → 代码事实）

| 需求 | 任务 | 代码事实（存在 + 被调用） | 结论 |
|---|---|---|---|
| R1 注册双通道 + 验证 | T1/T2/T3/T4 | `handleAccountRegister`/`handleAccountResend`/`handleAccountVerify`（api.ts）+ 路由；`createSmsSender` 工厂 | ✅ |
| R2 试用 3 天 1 host | T4 | `startTrial`（db.ts）+ `handleAccountVerify` 内调用 | ✅ |
| R3 配额钩子 | T5 | `hostQuota` + `/api/hosts/register` 内配额检查 | ✅ |
| R4 订阅套餐 | T6 | `GET /api/billing/plans` + `handleSubscribe` + 三表 | ✅ |
| R5 支付（招行） | T6 | `PaymentProvider` mock（billing/mock.ts）；**招行真实通道 ⏭️ 资质阻塞** | ⏭️ |
| R6 到期/降级/保留 | T6 | `sweepBilling`（trial/subscribed→grace→free，server.ts 每分钟调用）；**30 天 host 数据清理 ⏭️** | ⏭️（部分） |
| R7 账号删除 | T6 | `handleDeleteAccount` + `db.deleteAccount`（墓碑化，保留 orders/payments/audit） | ✅ |
| R8 反滥用 | T4/T5 | 注册限流 + 短信防轰炸（`getSmsLimiters`）+ attempts≤5；**阿里云验证码 2.0 ⏭️**；**banned 封禁管理 ⏭️** | ⏭️（部分） |
| R9 安全强化 | 复用 M5 | 登录风控/2FA/审计已复用；付费操作审计（billing.subscribed/canceled） | ✅ |
| R10 portal 商业页 | T7 | 注册/验证/订阅/手机号绑定/删除页 + 登录标识符标签 | ✅（找回密码手机 tab ⏭️） |
| R11 手机号管理 + 找回 | T5 | 绑定/验证/解绑（api.ts）+ 找回双通道（后端） | ✅（portal 找回手机 tab ⏭️） |
| §2.5 状态机 | T3/T6 | `account_status`/`plan_status` 迁移 + sweepBilling | ✅ |

## 2. 自动化证据

- `pnpm build`：6 包 tsc strict 全绿（含 `info` 级）；
- `pnpm test`：tunnel 12/12、hub 50/50（新增 `saas.test.ts` 8 用例覆盖注册/验证/trial 配额/订阅/状态机/删除）、gateway 74/74、cli 0；
- 回归：既有 hub 测试仅 1 处因注册端点语义变更更新（`NOT_FOUND`→`REGISTRATION_DISABLED`），其余全绿；自托管形态（注册关闭默认）保持 404 防 bot。

## 3. 缺口清单（gap + severity + 建议）

> 第三轮后**全部剩余项均为纯配置/凭证 + 核对**，无 coding 阻塞。

| # | 缺口 | 严重度 | 性质/建议 |
|---|---|---|---|
| 1 | 招行聚合支付上线 | 中（上线 gate） | 代码已写（`billing/cmb.ts` SM2withSM3 签名 + provider 骨架 + 单测）；剩填商户号/密钥 + 核对下单/回调 exact 字段（[招行 API](https://openhome.cmbchina.com/PayNew/pay/doc/cell/H5/OneCardPayAPI)） |
| 2 | 微信支付上线 | 中 | 代码已写（`billing/wechatpay.ts` + 单测）；剩填 mchid/证书/AppID/APIv3 密钥 |
| 3 | 阿里云验证码 2.0 上线 | 中 | 前端 `CaptchaGate` + `/api/captcha/config` + 后端 `verifyCaptchaParam` 已写；剩填 sceneId + 签名/模板审核（未填用算术码兜底） |

> **已实现**：S1/S2 主闭环、30 天 host 清理、banned 管理、找回双通道、算术验证码、微信支付 provider、招行 SM2 签名、阿里云验证码前后端。

## 4. 结论

S1 + S2 已端到端可用（`saas.test.ts` 全绿 + build 绿）；S3/S4 缺口均为资质阻塞或后置项，已列入 TODO.md。本里程碑达到「可自行注册→试用→订阅（mock 支付）→配额→到期降级→删除」的闭环。
