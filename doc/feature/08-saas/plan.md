# 08-saas — 计划（plan.md）

> **日期**: 2026-08-26
> **状态**: 实施中（本轮自主推进）
> **来源**: [req.md](req.md)（R1–R11）+ [solution.md](solution.md)（T1–T8）
> **里程碑**: 覆盖 S1 + S2；S3 交付 mock+契约（资质阻塞）；S4 部分

## 1. RTTM（req → task 追溯矩阵）

| 需求 | 任务 | 状态 |
|---|---|---|
| R1 注册双通道 + 验证 | T1/T2/T3/T4 | ⏭️ 待实现 |
| R2 试用 3 天 1 host | T4 | ⏭️ |
| R3 配额钩子 | T5 | ⏭️ |
| R4 订阅与套餐 | T6 | ⏭️ |
| R5 支付（招行，mock） | T6 | ⏭️ |
| R6 到期/降级/数据保留 | T6 | ⏭️ |
| R7 账号删除 | T6 | ⏭️ |
| R8 反滥用（算术码兜底 + 限流） | T4/T5 | ⏭️ |
| R9 安全强化（复用 M5） | —（复用） | ✅ 依赖已具备 |
| R10 portal 商业页 | T7 | ⏭️ |
| R11 手机号管理 + 找回 | T5 | ⏭️ |
| §2.5 状态机两维分离 | T3/T6 | ⏭️ |
| §2.6 UI 稿 | T7 | ⏭️ |
| 协议先行（层 1 契约） | T1 | ⏭️ |

## 2. 任务清单

### 阶段 A：契约与基础设施
- [x] ✅ T1 层 1 API 契约文档 `packages/hub/API.md`（协议先行）
- [x] ✅ T2 `sms/types.ts` + `sms/aliyun.ts` + `sms/log.ts` + `sms/index.ts`
- [x] ✅ T3 `config.ts`（sms/registration/billing）+ `db.ts`（users 加列 + sms_codes/subscriptions/orders/payments）

### 阶段 B：S1 后端
- [x] ✅ T4 注册/验证/登录解析/发码（`api.ts` + `db.ts`）
- [x] ✅ T5 手机号管理 + 找回双通道 + 配额钩子

### 阶段 C：S2 后端
- [x] ✅ T6 `billing/*`（PaymentProvider mock）+ 订阅/状态机/降级/删除

### 阶段 D：前端
- [x] ✅ T7 portal 注册/验证/登录/试用/订阅/设置页

### 阶段 E：质量门
- [x] ✅ T8 测试 + `pnpm build`（tsc strict）+ `pnpm test` 全绿

### 后置项（⏭️）
- [x] ✅ 30 天 host 数据清理（grace→free 后超期删除）
- [x] ✅ banned 封禁管理（admin ban/unban + relay 拦截）
- [x] ✅ portal 找回密码手机号 tab
- [x] ✅ 注册发码前置算术验证码 + 阿里云验证码 2.0 后端 VerifyCaptcha RPC
- [x] ✅ 微信支付 wechatpay provider（APIv3 Native + 回调验签/解密，单测覆盖）
- [ ] ⏭️ 招行聚合收款真实通道（coding blocked：缺 API 规范）
- [ ] ⏭️ 微信支付上线验证（verifying blocked：缺商户号/证书/AppID）
- [ ] ⏭️ 阿里云验证码 2.0 前端 SDK + 真实验签（verifying blocked：缺 sceneId + 审核）
- [x] ✅ 注册 identifier 防枚举策略（2026-08-26 拍板 A：保持 409，无改动）

## 3. 验收基准（对齐 req §3）

1. 邮箱注册→PIN→验证→试用 3 天 1 host→第 2 台被拒；手机号通道同（`sms` 关闭时手机号通道提示"未启用"）；
2. 订阅→mock 支付→paid→配额升级；到期→grace 3 天→免费档 0 台→数据保留 30 天；
3. 删除账号→隧道立停→可重新注册→审计留痕；
4. 自托管形态（注册关闭）回归不受影响。
