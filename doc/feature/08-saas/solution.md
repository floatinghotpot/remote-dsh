# 08-saas — 方案（solution.md）

> **日期**: 2026-08-26
> **状态**: 草稿（本轮自主推进；req 已定稿级更新，本方案待用户晨间审阅）
> **来源**: [req.md](req.md)（R1–R11 + §2.5 状态机 + §2.6 UI 稿）+ [discussion.md](discussion.md)（§7/§8 定案与预研）
> **范围**: 本方案覆盖 S1（注册/试用/配额）+ S2（订阅状态机/计费 mock）+ 层 1 契约 + portal；S3 真实招行支付交付 mock+契约（资质阻塞）；S4 部分（算术码兜底/限流/审计）

---

## 1. Goal（目标架构）

在既有 M5 hub 上叠加商业化 SaaS 能力，目标形态：

- **注册双通道**：邮箱（PIN，复用 M5 邮件基建）+ +86 手机号（短信码，新增 `SmsSender` 抽象，开关 = hub.json `sms` 缺省关闭）；
- **两维状态机**：`account_status`（pending/active/banned/deleted）× `plan_status`（NULL/trial/subscribed/grace/free），配额钩子只读 plan、封禁只读 account（req §2.5）；
- **试用/订阅**：验证后自动进 trial（1 host × 3 天）→ 到期 grace 3 天 → 免费档 0 台（数据保留 30 天）→ 订阅激活恢复套餐配额；`PaymentProvider` 抽象（mock 先行，复用 EmailSender 模式）；
- **登录**：标识符统一输入（邮箱/手机号/自托管用户名智能解析）+ 密码；
- **协议先行**：层 1 新增端点契约文档先于实现。

## 2. Facts（代码审计，全部已读确认）

| 事实 | 出处 |
|---|---|
| 注册端点已存在但**硬编码 404**（`registration is disabled`），无实现、无 config 开关 | `packages/hub/src/api.ts:107-111` |
| 登录键 = `name`（`getUserByName`），`users.name TEXT UNIQUE NOT NULL`；`email` 可空 + 唯一索引；无 phone 字段 | `auth.ts:90` / `db.ts:100-107,176` |
| 配额钩子预留点：`/api/hosts/register` 内注释「预留账号配额检查点」（join token 主机注册） | `api.ts:544` |
| M5 邮件验证码可复用：`sendEmailCode`（purpose verify\|reset、6 位、TTL 10min、重发 60s、attempts≤5、四级限流）+ `verifyEmailCode`；`email_codes` 表（user_id NOT NULL） | `api.ts:563-629` / `db.ts:151-160,558-581` |
| `EmailSender` 工厂 + provider 模式（smtp/aliyun/log）；aliyun = 手写 RPC V1 签名（`percentEncode`/`rpcSignature`，可复用于短信） | `email/index.ts` / `email/aliyun.ts:14-33` / `email/types.ts` |
| 找回密码流程带算术验证码（`/api/captcha/arithmetic` + `captcha.ts`），响应不区分邮箱存在与否 | `api.ts:117-120,671-694` |
| config 现状：`email?`/`captcha?`/`security?` 均缺省禁用/默认；无 `sms`/`registration`/`billing` | `config.ts` |
| db 迁移守卫模式：PRAGMA table_info + ALTER ADD COLUMN + 独立唯一索引（SQLite 不支持 ADD COLUMN UNIQUE） | `db.ts:162-176` |
| `removeUser` 按 FK 依赖顺序级联删除（邮箱码→审计→共享→join→refresh→hosts→users）——R7 删除复用+扩展 | `db.ts:293-310` |
| `api.ts` 导出 `writeError`/`authenticate`/`sessionCookie`/`clientIp`/`readJsonBody`；`handleApi` 为统一路由 | `api.ts:39-79,557-559` |
| portal = React 单文件路由（`pages.tsx` + `api.ts` + `main.tsx`），登录页传 `name`（用户名） | `packages/portal/src/*` |
| 测试 = `node --test`，7 个测试文件（含 `multi-tenant.test.ts`/`config.test.ts`/`aliyun-signature.test.ts`） | `packages/hub/test/*` |
| 层 2 协议有 `PROTOCOL.md`；层 1 契约目前散在 req/api 注释，无独立契约文档 | `packages/tunnel/PROTOCOL.md` |

**关键结论**：08 不是从零建账号体系——是在 M5（邮件/2FA/审计/限流）之上加 **注册双通道 + phone/sms + 两维状态机 + billing 三表 + PaymentProvider**；唯一需要新建的「横向能力」是 `SmsSender`（镜像 EmailSender）与 `PaymentProvider`（镜像 EmailSender），其余都是复用。

## 3. Gap（Goal − Facts）

1. **注册**：404 桩 → 双通道真实流程（R1/R2）；
2. **标识符**：`name` 单键 → name=identifier 落库 + login 智能解析（R1 隐含、R10）；
3. **手机号**：无 phone 字段/唯一索引/短信码表/SmsSender/开关（R1/R8/R11）；
4. **状态机**：无 account_status/plan_status/到期字段 → 两维状态机 + 迁移（R6 + §2.5）；
5. **计费**：无 subscriptions/orders/payments/plans → 三表 + PaymentProvider mock（R4/R5/R7）；
6. **配额**：钩子点已留 → 接 plan 检查（R3）；
7. **portal**：无注册/验证/试用/订阅页，登录页单 username → 双 tab + 商业页（R10）；
8. **契约**：层 1 新增端点无契约文档（协议先行缺口）。

## 4. Call-site Audit（共享契约变更的调用点）

| 变更 | 调用点 | 分类 |
|---|---|---|
| `users` 加列（phone/account_status/plan_status/…） | `mapUser`（db.ts:182）读列；`createUser`（db.ts:270）；`handleRegister`（新增）；`authenticate`→`auth.verifyAccess`→`getUserById` | 兼容：加列 + mapUser 补字段，旧行为不变 |
| login 标识符解析（name→identifier） | `handleLogin`（api.ts:213）；`HubAuth.login`（auth.ts:89，按 name 查）；portal `pages.tsx` 登录页 | 兼容：保留 `name` 字段，新增 email/phone 解析，自托管用户名登录不变 |
| `/api/hosts/register` 配额钩子 | `handleRegister`（api.ts:516）；05 join-easy 调用方（gateway `host join`） | 兼容：超配额返回明确错误码，不影响存量 NULL plan 用户 |
| `config.ts` 加 `sms`/`registration`/`billing` | `normalizeHubConfig`（config.ts:77）；`loadHubConfig`；`serve.ts` 消费 config | 新增可选字段，缺省禁用，旧配置不受影响 |
| `index.ts` 导出 | 所有 `rdsh-hub` 外部消费方（`packages/cli` `rdsh hub`） | 新增导出，不删旧导出 |

## 5. Tasks（实现任务，路径 + 变更点）

> 任务编号 T1–T12，与 plan.md RTTM 对齐。**协议先行：T1 契约文档先于 T4/T5 端点实现。**

### T1 层 1 API 契约文档（协议先行）
- 新建 `packages/hub/API.md`：冻结层 1 全部端点（含新增 register/verify/phone/billing），字段/错误码/幂等语义。

### T2 SmsSender 抽象（镜像 EmailSender）
- 新建 `packages/hub/src/sms/types.ts`：`SmsMessage`/`SmsConfig`/`AliyunSmsConfig`/`SmsSender`；
- 新建 `packages/hub/src/sms/aliyun.ts`：`Action=SendSms`、`Version=2017-05-25`、endpoint `dysmsapi.aliyuncs.com`，**复用 `email/aliyun.ts` 的 `percentEncode`/`rpcSignature`**；
- 新建 `packages/hub/src/sms/log.ts`：落 `~/.rdsh/hub-sms.log` + console（含码，便于验证）；
- 新建 `packages/hub/src/sms/index.ts`：`createSmsSender(config?)` → 无 `sms` 配置返回 null（禁用）。

### T3 config + db 迁移
- `config.ts`：加 `sms?: SmsConfig`、`registration?: "open"|"closed"`（默认 closed）、`billing?: { plans: PlanSpec[]; trialDays?; graceDays?; retentionDays? }`；
- `db.ts`：users 加列 `phone`/`phone_verified`/`account_status`(default 'active')/`plan_status`(NULL)/`plan_expires_at`/`trial_started_at`；`idx_users_phone` 唯一索引；新表 `sms_codes`（镜像 email_codes，phone 键）、`subscriptions`、`orders`、`payments`；`mapUser` 补字段。

### T4 S1 后端：注册双通道 + 验证 + 登录解析
- `api.ts`：替换 register 404 桩 → `handleRegister`（channel email|phone，校验 +86 格式，建 pending 用户 name=identifier，发码）+ `handleVerify`（激活 → account_status=active + plan_status=trial + trial_started_at，自动登录）+ `handleRegisterResend`；`handleLogin` 标识符解析（email→getUserByEmail / phone→getUserByPhone / else name）；
- 新增 `sendSmsCode`/`verifySmsCode`（镜像 `sendEmailCode`/`verifyEmailCode`，复用 sms_codes 表 + SmsSender + 防轰炸限流）；email 通道复用现有 `sendEmailCode`（注册场景 purpose 扩展或复用 "verify"）。

### T5 S1 后端：手机号管理 + 找回密码双通道 + 配额钩子
- `api.ts` + `db.ts`：`POST /api/account/phone`（绑定/换绑）、`/api/account/phone/verify`、`/api/account/phone/unbind`（镜像 email，解绑 24h 限制）；找回密码扩展 phone 通道（复用「设新密码→ver+1」路径 + 算术码防 bot）；
- `handleRegister`（hosts）：消费配额钩子——按 `plan_status` 检查 host 数上限（NULL 不限、trial=1、subscribed=plan.hosts、free=0），超限返回 `QUOTA_EXCEEDED`。

### T6 S2 后端：billing 三表 + 状态机 + PaymentProvider mock
- 新建 `packages/hub/src/billing/types.ts` + `index.ts` + `mock.ts`（`PaymentProvider` 抽象镜像 EmailSender，mock 返回假支付单）；
- `api.ts` + `db.ts`：`GET /api/billing/plans`（config 读）、`POST /api/billing/subscribe`（建 order→mock 支付→paid→激活 subscribed + plan_expires_at）、`GET /api/billing/subscription`、`POST /api/billing/cancel`（到期不续）、`POST /api/billing/callback`（幂等入账 stub，S3 接招行验签）；
- 到期任务：`serve.ts` 定时扫描 trial/subscribed/grace 到期 → grace→free（保留最早 N 台在线、其余离线）→ 30 天数据清理；`DELETE /api/account`（R7 删除，扩展 `removeUser` 保留 payments/orders 脱敏）。

### T7 portal UI（R10）
- `portal/src/api.ts`：加 register/verify/phone/billing/delete 客户端方法；
- `portal/src/pages.tsx`：注册页（双 tab + 滑块占位）、验证页、登录页（标识符统一输入 + 找回双通道）、试用倒计时 + 配额提示、套餐选择、订阅状态（grace 提示）、设置页（手机号绑定/退款占位/账号删除）。`sms` 关闭时手机号 tab/入口隐藏（读后端 capabilities）。

### T8 测试 + 构建（零缺陷门）
- 新建 `packages/hub/test/register.test.ts`（注册双通道/验证/限流/开关）、`sms.test.ts`（SmsSender log/aliyun 签名）、`billing.test.ts`（状态机/订阅/降级/删除）、`quota.test.ts`（配额钩子）；扩展 `config.test.ts`（sms/registration/billing 归一化）；
- `pnpm build`（tsc strict，含 info）+ `pnpm test`（node --test）全绿。

## 6. 不做（本轮 Out of Scope，对齐 req 2.2）

- E2E 加密（并行 P0，独立立项）；发票开票；自研图形验证码（S4 用算术码兜底，阿里云验证码 2.0 后置）；PostgreSQL；优惠券；带宽计量计费；短信码免密登录；国际手机号；海外卡支付；招行真实支付（S3，资质阻塞）。

## 7. 风险与备注

- **短信真发**：aliyun provider 实现但 `sms` 缺省关闭，签名/模板审核通过前不真发（log/mock 可测）；
- **存量用户**：plan_status 缺省 NULL（不受限），迁移不改变既有行为；
- **portal 视觉**：沿用现有单文件 React 风格，不引入新依赖。
