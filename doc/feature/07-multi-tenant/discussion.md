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

- **已定（2026-08-24 讨论）**：**不发本地邮件**。理由：阿里云 ECS 出站 25 端口默认封禁（需工单解封）；本地 MTA 无 SPF/DKIM/DMARC、IP 信誉差 → 送达率灾难。**用外部邮件服务，hub 做成可配置 SMTP**：
  ```
  hub.json 增加: smtp: { host, port, user, password, from }
  ```
  - 国内收件人（163/QQ）：阿里云邮件推送 / 腾讯云 SES（免费额度对验证码场景足够）
  - 国际：SendGrid / AWS SES / Mailgun
  - **hub 不内置 MTA、不 spawn postfix**（依赖最小化）；无 smtp 配置 = 邮件功能禁用（自托管无邮件服务也可用，只是没有邮箱验证/找回密码）
- **待决**：邮箱绑定时机（见 D2）；找回密码形态（链接 vs 临时码）；验证码 TTL/重发限流。

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
- 查询入口（待定 D5）：先 CLI（`rdsh hub audit ls` 过滤）够用，portal 只读列表可后置。

### 3.5 登录风控

- 现有：IP 维度限流。增强：**账户维度**（N 次失败锁账户 X 分钟，admin 可解锁）+ 可选新设备通知（邮件，依赖 smtp 配置）。
- 与 2FA 的关系：限流先于 2FA（防密码爆破），2FA 阶段另有尝试限制（防 TOTP 爆破）。

## 4. 关键设计问题（进 req.md 前需定）

| # | 问题 | 现状/倾向 | 需确认 |
|---|---|---|---|
| D1 | 邮件服务 | **可配置 SMTP（外部服务），无 SMTP 则功能禁用**；国内推荐阿里云/腾讯 SES | 是否同时支持"找回密码邮件"与"验证码邮件"两态；SMTP 依赖选型（nodemailer vs 手写） |
| D2 | 邮箱绑定时机 | 注册关闭、管理员建号 —— 邮箱由 **admin 建号时指定**，还是用户**自助绑定**（登录后填邮箱→验证）？ | 建议自助绑定（不扩大 admin 职责） |
| D3 | 2FA 选型 | **TOTP**（零依赖优先）vs passkey | TOTP 是否足够（M5 范围）？passkey 后置？ |
| D4 | member 权限边界 | member 可进 DSH（=全权，Q4 整实例授权），但不可管理 host；共享即交权需告知 | 是否接受"进入即全权"；是否需要"只读"更细粒度（后置） |
| D5 | 审计查询入口 | CLI 先、portal 后 | 审计保留期限/轮转 |
| D6 | 账户锁定 | N 次失败锁 X 分钟 + admin 解锁 | 参数默认值（如 10 次/15 分钟）；是否锁 IP+账户双维度 |
| D7 | 找回密码流程 | 临时码/链接 → 新密码（ver+1 全端失效） | 与 first-password 激活流程的合并/区分 |

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
