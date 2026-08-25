# 07-multi-tenant — 需求讨论记录（discussion.md）

> **日期**: 2026-08-24
> **状态**: 讨论记录（req.md 定稿后本文档转为 READ-ONLY 需求来源）
> **来源**: `doc/overview/roadmap.md`（M5 多租户增强）+ `doc/overview/proposal.md`（§4.1 hub 控制面职责、§5.3 阶段三、§10 Q4）+ `doc/feature/05-join-easy/req.md`（R10 审计事件预留）+ 2026-08-24 需求讨论（邮件服务决策）
> **范围**: M5 —— 邮箱验证、2FA、共享授权（owner/member）、审计日志、登录风控

---

## 1. 背景与目标

产品演进到"多用户"阶段：05-join-easy 已让 hub 用户**自助添加主机**（join token），账号体系（users/hosts/join_tokens）已成型；M5 是把这套体系从"可用"加固到"可作为团队/半公开服务"：

1. **账号可信度**：目前建号即用，无邮箱验证、无找回密码、无第二因子 —— 密码泄露=账号失守；
2. **协作能力**：host 目前**单 owner**，团队场景需要"一台机器多人可用"（共享授权）；
3. **可追溯**：登录、注册、token 吊销等关键操作无留痕 —— 出问题无法审计；
4. **防爆破**：限流只有 IP 维度，无账户维度锁定。

**定位**：M5 全部落在 **rdsh-hub 控制面**（proposal §4.1：hub 职责=注册/登录/访问授权/令牌/审计）；**rdsh-gateway 零改动**（"gateway 永不需要改动"承诺）。

## 2. 查档事实（hub 现状代码核查，非猜测）

| 事实 | 出处 |
|---|---|
| `users` 表：`id/name/password_hash/ver/must_change/created_at` —— **无 email 列、无 2FA 列** | `packages/hub/src/db.ts:61-67` |
| `hosts` 表：`id/owner_id/name/token_hash/created_at` —— **单 owner**，无共享表 | `db.ts:69-74` |
| `refresh_tokens`：`id/user_id/token_hash/expires_at/revoked`（轮换+吊销已有） | `db.ts:76-82` |
| `join_tokens`：`id/label/owner_id/token_hash/expires_at/revoked`（05 新增） | `db.ts:84-88` |
| JWT：access(1h, 含 ver) + refresh(7d)；**改密/吊销 → ver+1 全会话失效**（版本化会话已就绪，2FA 关闭可复用） | `auth.ts`（ver 校验） |
| 登录：`POST /api/auth/login {name, password}`；`first-password` 激活流程（must_change=1 仅一次） | `api.ts:83-90,194` |
| 限流：登录 5 次/10 分钟（IP 维度）；register 10 次/分钟 —— **均无账户维度** | `api.ts`（loginLimiters/registerRate） |
| 05 R10 预留：结构化审计事件（token 创建/吊销、register 成败）—— **M5 审计日志的输入** | `05-join-easy/req.md` R10 |
| portal 已有：登录/host 列表/添加主机(join token)/改密/吊销 | `packages/portal/src/pages.tsx` |

**推论**：M5 是**增量**而非重构 —— 版本化会话（ver）、令牌哈希存储、限流框架、结构化事件预留都已就位，各功能在此之上加字段/表/端点即可。

## 3. 需求拆解（五项，含 2026-08-24 已定决策）

### 3.1 邮箱验证与找回密码

- **已定（2026-08-24 讨论）**：**不发本地邮件**。理由：阿里云 ECS 出站 25 端口默认封禁（需工单解封）；本地 MTA 无 SPF/DKIM/DMARC、IP 信誉差 → 送达率灾难。**抽象 `EmailSender` 接口，hub.json `email.provider` 多提供方**：
  ```json
  "email": { "provider": "smtp"|"aliyun"|"log", "from": "noreply@<域>",
             "aliyun": { "accessKeyId": "...", "accessKeySecret": "...", "endpoint": "https://dm.aliyuncs.com/" } }
  ```
  - **M5 实现**：
    - `smtp`（nodemailer，端口 465/587/TLS）——通用，任何服务商（阿里云/腾讯/国际）都提供 SMTP；
    - `aliyun`（DirectMail **HTTP API**，走 443 天然绕开 25 端口问题）——阿里云备选通道；**TS 侧定案：手写 RPC 签名**（`node:crypto` HMAC-SHA1 + 内置 fetch；参考 Logto `@logto/connector-aliyun-dm` 生产实现 + 官方文档测试向量单测锁正确性；不采用 SDK：`pop-core` 已过时、`dm20151123` 解包 2.1MB 过重）；
      - **无需 `region_id`**（查档 2026-08-24）：PHP 用官方 SDK 才必须传 `regionId`（SDK 按区域解析 endpoint + 定位区域资源；DirectMail 国内为单区域 cn-hangzhou）；手写签名**直接写死 endpoint**：默认国内 `https://dm.aliyuncs.com/`（华东1·杭州），海外实例用 `dm.ap-southeast-1.aliyuncs.com`（新加坡，官方 API 服务地址文档）；hub.json 只留**可选 `endpoint`**，不放 region 字段；
    - `log`（只落日志/不真发）——测试、本地开发、无邮件服务的自托管；
  - **sendgrid 后置**（08-saas 国际化时补；接口已就位，只加一个实现）；
  - 阿里云前置（一次性，控制台 + DNS）：验证**发信域名**（SPF/DKIM）、设置 **SMTP 独立密码**（SMTP 模式用）或 **AccessKey**（HTTP API 模式用）；
  - **hub 不内置 MTA、不 spawn postfix**（依赖最小化）；无 email 配置 = 邮件功能禁用（自托管无邮件服务也可用，只是没有邮箱验证/找回密码）。
  - **发信防刷（分层，2026-08-24 定案）**：① 触发侧——绑定/换绑必须登录，找回密码匿名但受以下限流；② 限流三层——每触发者（用户/IP）、每收件人（同邮箱验证码/重置码 ≤5 次/天）、**全局每日发信上限**（可配置，防配额烧钱）；③ 反枚举——找回密码响应统一（**不区分邮箱是否存在**，防枚举注册邮箱）；④ 验证环节——6 位码 + TTL + 一次性 + 错误限流（已有）；⑤ 验证码防 bot——找回密码触发页带**算术验证码**（D8，零依赖；08-saas 换阿里云验证码）；⑥ 审计——每次发信入 audit（触发者/收件人/结果）。
- **待决 → 已定（2026-08-24）**：邮箱**自助绑定**（D2）；找回密码 = **临时重置码**（一次性、10 分钟），与 first-password 首次激活**共用「设新密码 → ver+1」路径**；**换绑走同一验证流程，解绑后 24h 内不能重绑**（防刷）。

### 3.2 2FA

- **倾向（待定 D3）**：**TOTP**（无邮件依赖、node:crypto HMAC 手写可行、零依赖）vs passkey/WebAuthn（体验好但实现重、需前端与浏览器生态配合）。
- 与现有机制衔接：2FA 关闭/重置 → 复用 `ver+1` 语义（全部会话失效）；admin 可重置用户 2FA。
- 登录流程：密码通过 → 若用户开了 2FA → 要求 TOTP → 签发会话；限流覆盖两个阶段。

### 3.3 共享授权（owner/member）

- 现状：host 单 owner（`hosts.owner_id`），仅 owner 可见可管（R9）。
- 目标（proposal §5.2）：用户↔host **多对多**；新增共享表：
  ```
  host_share (host_id, user_id, role: 'owner'|'member', created_at)
  ```
- **关键安全决策（待定 D4）**：member 进入 host 后能做什么？DSH 无会话级权限、能执行任意命令 —— 若 member 进入 host = 与 owner 同权（整实例授权 Q4），则共享 = 把机器完全交给对方。**建议边界**：member 可进入 DSH 使用，但**不能管理 host**（改名/吊销/共享/删除）；owner 专属管理操作。需在 req.md 明确"member 的 DSH 内能力 = 全权"这一事实与用户告知义务（共享即交权）。

### 3.4 审计日志

- 事件源（对齐 05 R10 预留 + M5 新增）：login 成败、refresh、改密、first-password、join-token 创建/吊销、register 成败、host 进入、host 共享变更（share/revoke）。
- 存储：`audit_events (id, user_id?, event, detail_json, ip, created_at)` —— 控制面量级小，表内足够；**不落盘业务流量**（转发仍用即用即弃）。
- 查询入口（D5 已定）：先 CLI（`rdsh hub audit ls` 过滤）够用，portal 只读列表可后置；**默认保留 90 天、到期自动清理（可配置）**。

### 3.5 登录风控

- 现有：IP 维度限流。增强：**账户维度**（N 次失败锁账户 X 分钟，admin 可解锁）+ 可选新设备通知（邮件，依赖 smtp 配置）。
- 与 2FA 的关系：限流先于 2FA（防密码爆破），2FA 阶段另有尝试限制（防 TOTP 爆破）。

## 4. 关键设计问题（进 req.md 前需定）

| # | 问题 | 现状/倾向 | 需确认 |
|---|---|---|---|
| D1 | 邮件服务 | ✅ **抽象 `EmailSender` 接口 + 多提供方**（2026-08-24 定案）：`email.provider` 配置；**M5 实现 `smtp`（nodemailer）+ `aliyun`（DirectMail HTTP API，手写 RPC 签名 node:crypto）+ `log`（测试/本地，不真发）**；sendgrid 后置（08-saas 国际化）；无 email 配置 = 邮件禁用 | SMTP 端口（465/587/TLS）与重试归 solution；aliyun 签名参照 Logto 生产实现 + 官方测试向量单测 |
| D2 | 邮箱绑定时机 | ✅ **自助绑定**（2026-08-24 定案）：登录后填邮箱→验证；admin 建号不要求邮箱；**支持换绑（同验证流程），解绑后 24h 内不能重绑（防刷）** | — |
| D3 | 2FA 选型 | ✅ **TOTP**（2026-08-24 定案，`node:crypto` HMAC 零依赖）；passkey 后置 | 时钟漂移窗口归 solution |
| D4 | member 权限边界 | ✅ **member 可进 DSH（整实例授权 Q4），不可管理 host**（2026-08-24 定案）；共享即交权需告知；只读细粒度后置 | — |
| D5 | 审计查询入口 | ✅ **CLI 先行；默认保留 90 天、到期自动清理（可配置）**（2026-08-24 定案）；portal 后置 | 清理实现形态归 solution |
| D6 | 账户锁定 | ✅ **10 次/15 分钟，账户维度叠加 IP 限流 + admin 解锁**（2026-08-24 定案） | admin 是否豁免归 solution |
| D7 | 找回密码流程 | ✅ **临时重置码（一次性、10 分钟）→ 设新密码 → ver+1**；**与 first-password 首次激活共用同一条设密路径**（2026-08-24 定案） | — |
| D8 | 验证码策略（防 bot） | ✅ **M5 = 找回密码页算术验证码（零依赖）**（2026-08-24 定案）：`captcha.provider` 抽象（M5 实现 `arithmetic` + `none`）；**阿里云验证码 → 08-saas**（复用 AccessKey RPC 签名，与 DirectMail 同机制；免费额度 + 按量；前端 SDK + 后端 VerifyCaptcha） | 算术码形态（如 3+5=?）与签名 token 归 solution |

## 5. 技术约束备忘（写 solution 时用）

- **依赖最小化**：TOTP 可用 `node:crypto` HMAC 手写（RFC 6238，几十行）；SMTP 客户端若手写需 node:net 实现协议（可行但繁琐）—— 倾向允许一个轻量 SMTP 依赖（须在 solution 说明理由）；禁止引入完整邮件框架。
- **版本化会话复用**：2FA 关闭、找回密码、账户锁定解锁，全部可用 `users.ver+1` 使旧会话失效 —— 不新增会话机制。
- **安全基线延续**：令牌/验证码只存哈希；日志脱敏（不记密码/TOTP/完整 token）；限流防枚举。
- **M7 约束**：层 1 API 契约若变更需文档先行（协议先行纪律）—— 邮箱验证/2FA/共享端点属层 1 扩展，需在 req/solution 定稿后冻结。

## 6. 参考

- `doc/overview/roadmap.md`（M5 定义）、`doc/overview/proposal.md`（§4.1 hub 职责、§5.3 阶段三、§10 Q4/Q6/Q8）
- `doc/feature/05-join-easy/req.md`（R10 审计事件预留、前置依赖）
- `doc/overview/architecture.md`（§4 安全模型分层防护）
- 代码：`packages/hub/src/{db,api,auth}.ts`、`packages/portal/src/pages.tsx`

*下一步：req.md（待讨论定案后）*
