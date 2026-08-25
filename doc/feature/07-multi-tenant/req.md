# 07-multi-tenant — 需求（req.md）

> **日期**: 2026-08-24
> **状态**: 草稿，**待用户批准**
> **范围**: M5 多租户增强 —— 邮箱验证与找回密码、2FA（TOTP）、共享授权（owner/member）、审计日志、登录风控
> **来源**: [discussion.md](discussion.md)（D1–D7 定案）：SMTP 可配置（外部邮件服务）、邮箱自助绑定、TOTP、member 可进 DSH 但不可管理 host、审计 CLI 先行、账户锁定 10 次/15 分钟+admin 解锁、找回密码临时码+ver+1
> **组件**: 仅 rdsh-hub（控制面）；rdsh-gateway 零改动（"gateway 永不需要改动"承诺）

---

## 1. 目标

把 hub 账号体系从"可用"加固到"可作为团队/半公开服务"：账号可信（邮箱+2FA）、可协作（共享授权）、可追溯（审计）、防爆破（账户锁定）。**全部在 hub 控制面**；M5 的 email/认证基础设施是 08-saas（商业化）的前置。

## 2. 范围

### 2.1 包含（In Scope）

| 编号 | 需求 | 验收标准 |
|---|---|---|
| R1 | **SMTP 可配置**：hub.json 增 `smtp: {host, port, user, password, from}`；无 smtp 配置 = 邮件功能禁用（不影响其他功能） | 配置后能发邮件；无配置时相关功能返回"未启用"；依赖说明（轻量 SMTP 客户端，理由在 solution） |
| R2 | **邮箱自助绑定 + 验证**：用户登录后绑定邮箱 → 发 6 位 PIN（10 分钟 TTL，重发限流 60s）→ 验证通过（`users.email/email_verified`）；admin 建号不要求邮箱 | 绑定→收 PIN→验证成功；错误 PIN 限流；未验证邮箱不可用于找回密码 |
| R3 | **找回密码**：验证邮箱 → 发临时重置码（一次性、10 分钟）→ 设新密码 → **ver+1 全部会话失效** | 全流程走通；码一次性；改密后旧会话 401 |
| R4 | **2FA（TOTP）**：用户自助开启（生成 secret → portal 扫码/输入验证码激活）；登录时密码通过后要求 TOTP；关闭/重置需当前 TOTP 或 admin（复用 ver+1） | TOTP 校验正确；错误码拒绝并计数；admin 可重置；关闭后旧会话失效 |
| R5 | **共享授权（owner/member）**：新表 `host_share (host_id, user_id, role)`；owner 可将 host 共享给其他用户（member）；member 可进入 host 使用 DSH（整实例授权，Q4），但**不可管理**（改名/吊销/共享/删除） | 共享后 member 列表可见可进入；member 管理操作被拒（403）；owner 解除共享即时生效 |
| R6 | **审计日志**：`audit_events (id, user_id, event, detail, ip, created_at)`；记录 login 成败/refresh/改密/first-password/join-token 创建吊销/register 成败/host 进入/host 共享变更；**结构化事件**（对齐 05 R10 预留） | 关键操作均有事件；查询 `rdsh hub audit ls [--user] [--event]`；日志脱敏（无密码/TOTP/token 明文） |
| R7 | **登录风控（账户维度锁定）**：连续失败 10 次锁 15 分钟（账户维度，叠加现有 IP 限流）；`rdsh hub user unlock <name>` | 锁定期正确密码也拒绝；解锁后恢复；参数可配置 |
| R8 | **portal 页面**：设置页（绑定邮箱/开启 2FA/改密）；host 列表共享管理（邀请/移除 member）；共享后 host 对 member 可见 | 全流程浏览器可操作；i18n zh/en |
| R9 | **安全基线**：PIN/重置码/TOTP secret 只存哈希（或加密）不落明文；审计不含敏感值；层 1 API 契约扩展文档先行 | 代码审查 + 单测断言；无明文落盘 |

### 2.2 不含（Out of Scope）

- ❌ 开放注册（邮箱自助注册）→ **08-saas**
- ❌ passkey/WebAuthn（2FA 先行 TOTP）→ 后续
- ❌ 账号配额/套餐/计费 → **08-saas**
- ❌ member 细粒度权限（只读/限制命令）→ 后置（Q4 整实例授权前提下）
- ❌ 审计后台 portal 化（CLI 先行，portal 只读列表可后置）

### 2.3 前置依赖

- 05-join-easy（join token/register）已发布 ✅；结构化审计事件预留（R10）由本里程碑消费
- 无阻塞性前置（SMTP 依赖是 M5 首个外部服务依赖，需 solution 说明选型）

## 3. 端到端验收场景

1. **邮箱绑定 + 找回密码**：新用户登录 → 绑定邮箱 → 收 PIN 验证 → 忘记密码 → 用验证邮箱收码 → 重置密码 → 旧会话全部失效 → 新密码登录成功
2. **2FA**：用户开 TOTP（扫码）→ 退出 → 登录输密码 → 输 TOTP → 进入；错误码 3 次被限；admin 重置后重新登录无需 TOTP（但旧会话失效）
3. **共享**：owner 共享 host 给 member → member 登录后列表可见该 host → 进入完整 DSH；member 尝试改名/吊销 → 403；owner 解除共享 → member 立即不可见
4. **审计**：完成上述操作后 `rdsh hub audit ls` 可查到对应事件（含 IP、时间、事件类型），无敏感值
5. **锁定**：错误密码 10 次 → 锁 15 分钟（正确密码也拒）→ `rdsh hub user unlock` → 恢复
6. **回归**：M1–M4 全量测试 + 现有 portal 流程不破坏

## 4. 验收执行方式

- 自动化：`node --test`（TOTP 生成/校验、PIN/重置码 TTL 与一次性、共享权限矩阵、锁定/解锁、审计事件断言、哈希断言）+ 本机双进程 e2e（hub + join）
- 回归：`pnpm test` 全量
- 文档：`verification.md` 逐条对照 R1–R9 + RTTM

## 5. 待定项（留给 solution.md，不阻塞 req 批准）

- SMTP 客户端选型（轻量依赖 vs 手写 node:net 协议）与失败重试策略
- TOTP 实现细节（RFC 6238，node:crypto HMAC）与时钟漂移容忍窗口
- 审计事件 schema 字段定稿（05 R10 预留事件 + 本里程碑新增）
- 找回密码码与邮箱验证 PIN 的存储（哈希 vs 加密，TTL 清理）

*关联文档：discussion.md | roadmap.md（M5）| 08-saas（下游依赖本里程碑）| 下一步：solution.md（待 req 批准后）*
