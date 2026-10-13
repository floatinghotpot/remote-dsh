# Record — Portal 注册/找回密码缺「重发验证码」入口

> **日期**: 2026-10-13
> **状态**: 根因已定位，待实施
> **关联**: 与 App 侧同源缺陷（App 侧已修复，其 fix 文档 §5 已预告本问题）。
> **结论**: Portal 网页端在"验证码已发送"之后**没有重发入口**：注册后跳转的 `VerifyPage` 只有「验证并登录」；找回密码页 `sent=true` 态只有「重置密码」。用户没收到验证码只能刷新页面从头再来。这与服务端「每次发码都要重新过人机验证」的契约脱节——补入口时必须**同时挂 `CaptchaGate` 且消费后清票**，否则会复刻 App 侧的 `BAD_CAPTCHA` 缺陷。

---

## 1. 现象

- **注册**：提交注册 → 跳转 `/verify?channel=...&identifier=...`，页面只有「6 位验证码」输入框 + 「验证并登录」。**没有"重发验证码"**。
- **找回密码**：提交邮箱/手机号 → 进入 `sent=true` 态，页面只有「重置码」「新密码」输入 + 「重置密码」。**没有"重发重置码"**。
- 用户没收到验证码时，只能**刷新页面重新走一遍**（会重新取算术题，所以不会报错，但体验是"没有重发能力"）。

## 2. 根因（代码定位）

`packages/portal/src/pages.tsx`：

| 位置 | 事实 |
|---|---|
| `VerifyPage`（`:2009-2036`） | 注册后验证页：只有 `verifyAccount`（验证并登录），**无重发按钮、无 `CaptchaGate`** |
| `ResetPasswordPage`（`:1322-1385`） | `sent=true` 分支（`:1374-1381`）只有 `resetConfirm`，**无重发按钮、无 `CaptchaGate`**；且 `:1367` 成功后 `setSent(true)` **未清票** |

服务端契约（与 App 侧同一结论）：
- `POST /api/auth/register/resend`（`api.ts` 的 `registerResend`）→ 需要 captcha；
- `POST /api/auth/password/reset`（`api.ts` 的 `resetRequest`）→ 需要 captcha；
- 票据一次性（`CaptchaGate` 注释 `:318-379`）。

**即**：`registerResend` 已在 `api.ts:259` 定义、`CaptchaGate` 已存在、`SendCodeButton`/`useCountdown`/`useToast` 均已存在——**缺的只是两个页面把"重发按钮 + CaptchaGate + 清票"串起来**。

## 3. 修复方案

**文件**：`packages/portal/src/pages.tsx`（2 个页面）+ `packages/portal/src/i18n.ts`（新增 2 个文案）

### 3.1 `VerifyPage`（注册后验证，`:2009`）

1. 新增状态：`captchaPayload`、`useCountdown`、`useToast`；
2. 新增 `resend()`：`api.registerResend(channel, identifier, captchaPayload)`，成功后 `setCaptchaPayload({})` + `startCountdown()` + `show("ok", ...)`；失败也 `setCaptchaPayload({})` 再抛错；
3. 在「6 位验证码」输入框下方加 `<CaptchaGate captcha={captchaPayload} onCaptcha={setCaptchaPayload} />` + `<SendCodeButton label={t("重发验证码")} seconds={seconds} onClick={resend} />`。

### 3.2 `ResetPasswordPage`（找回密码，`:1322`）

1. 新增 `useCountdown`、`useToast`；
2. 阶段 1 成功后（`:1367`）：`setSent(true)` 前**清票** `setCaptchaPayload({})`，并 `startCountdown()`；
3. 新增 `resend()`：`api.resetRequest(channel, identifier.trim(), captchaPayload)`，成功/失败均清票，成功 `startCountdown()` + toast；
4. `sent=true` 分支（`:1374`）加 `<CaptchaGate>` + `<SendCodeButton label={t("重发重置码")} ...>`。

### 3.3 i18n（`i18n.ts`）

新增 key：
- `"重发验证码": "Resend code"`
- `"重发重置码": "Resend reset code"`

（倒计时文案复用现有 `"重新发送 {s}s"`。）

**不改服务端**：与 App 侧一致，服务端"每次发码都验证"是安全设计，本次补的是客户端入口 + 遵守该契约。

**代码审查修复**（独立 review 后采纳，共 4 项）：
1. **找回密码 sent 态隐藏 channel 切换**（正确性问题）：channel 切换按钮原在 `!sent` 三元之外，sent 态仍可切换 channel 但 `identifier` 已是旧值 → 重发/resetConfirm 会 channel+identifier 错配。已把切换按钮移入 `!sent` 分支。
2. **VerifyPage 初始倒计时**：进入验证页即 `startCountdown()`，与 ResetPasswordPage 对称，重发与首次发送保持同一 60s 间隔。
3. **`SendCodeButton` 加 `disabled={pending}`**：防 in-flight 期间并发重发（否则一次性 token 复用被拒、none/aliyun 可能多发短信）。
4. **术语统一**：找回密码成功 toast 用「重置码已重新发送」（区分验证码与重置码）。

## 4. 验证方式

- `pnpm --filter rdsh-portal build`（tsc strict）零错误。
- 手动路径：
  1. **注册**：提交 → `/verify` 页出现算术题 → 不做题点重发被拦截/提示 → 做题后重发成功（toast）；
  2. **找回密码**：提交 → `sent` 态出现算术题 → 重发成功；
  3. 反向：连续重发两次 → 第二次换新题；不做题不得发出。

## 5. 遗留 / 关联

- App 侧同一缺陷已修复（App 仓内部 fix 文档，见顶部关联）。
- 若未来给更多页面加重发入口，务必遵循同一模式：**重发按钮旁边必须挂 `CaptchaGate`，且提交后清票**，否则复刻 `BAD_CAPTCHA`。
