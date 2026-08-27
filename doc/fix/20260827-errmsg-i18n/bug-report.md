# Bug Report: 后端英文错误消息被 portal 原样透传（i18n 不友好）

> **日期**: 2026-08-27
> **严重度**: P2（体验/多语言障碍，不阻塞功能）
> **涉及**: `packages/portal/src/pages.tsx`（`useError` / 错误显示层）
> **关联**: `doc/feature/08-saas/req.md` R10（portal 商业化页 i18n zh/en 验收项）

---

## 1. 问题描述

hub 层 1 API 的错误统一为 `{ error: { code, message } }`，其中 `message` 为**英文**（如 `invalid email`、`registration is disabled`、`too many attempts`）。portal 的 `useError` 捕获 `ApiError` 后**直接显示 `e.message`**（英文），导致：

- 中文界面下用户看到英文报错；
- 未来做 zh/en 多语言时，文案在服务端、客户端无法本地化；
- 服务端改文案需要发版，耦合了"契约"与"展示"。

## 2. 影响

- 14 个页面共用 `useError`，所有 API 错误（登录失败、验证码错误、配额超限、短信未启用等）都以英文呈现；
- 是 req R10「i18n zh/en」验收项的已知缺口（`08-saas` S4 收尾项未做）。

## 3. 根因（代码事实）

| 事实 | 出处 |
|---|---|
| hub 错误响应：`{ error: { code, message } }`，`message` 为英文 | `packages/hub/src/api.ts` `writeError` |
| portal 显示：`setErr(e instanceof ApiError ? e.message : ...)` | `packages/portal/src/pages.tsx:104`（`useError`） |
| `ApiError` 携带 `status`/`code`/`message`，但显示层只用 `message` | `packages/portal/src/api.ts:79` |

**结论**：契约层已有稳定 `code`（跨语言不变），问题在于显示层没有按 `code` 本地化。

## 4. 修复方案

**契约不变，客户端按 `code` 本地化**（i18n 友好设计）：

1. `pages.tsx` 新增 `ERROR_ZH` 字典（hub 高频错误码 → 中文文案，~22 条）+ `tError(code, fallback)`；
2. `useError` 显示改走 `tError(e.code, e.message)`：已知码显示中文，**未知码回退英文 message**（兜底）；
3. 后端 `message` 保留英文（契约/CLI/日志用），**不改后端**；
4. 字典集中在单处，未来扩 `en` 即完成多语言错误文案。

## 5. 验证

- `pnpm --filter rdsh-portal build` + `pnpm --filter rdsh-hub build`（tsc strict 全绿）；
- 部署后手动验证典型错误：错误密码（`BAD_CREDENTIALS` → 「用户名或密码错误」）、重复注册（`ALREADY_EXISTS` → 「该邮箱/手机号已被注册」）、限流（`RATE_LIMITED`）、未知码兜底英文。

## 6. 不做（Out of Scope）

- 不迁移后端 `message` 为中文（契约语义保留英文，避免 CLI/日志/第三方歧义）；
- 不引入完整 i18n 框架（`ERROR_ZH` 是 R10 全量 i18n 的第一块；其余页面文案多语言另行立项）。
