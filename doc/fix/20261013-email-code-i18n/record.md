# Record — 验证码邮件固定英文，应跟随用户界面语言（中/英）

> **日期**: 2026-10-13
> **状态**: 已实施（hub + portal + app 三端代码完成，`pnpm build` / `flutter analyze` 零错误；待部署服务器配置 + 验证）
> **结论**: 邮件正文/主题/品牌名**全部硬编码英文**（`sendEmailCode`），客户端发码请求也不带语言 → 中文界面用户收到英文邮件是必然。短信内容在阿里云模板侧（服务端只传 code + templateCode），本次不动。

---

## 1. 现象

用户界面是中文，但注册/找回密码收到的验证码邮件是英文（`Your remote-dsh code is ...`），与界面语言不符。

## 2. 根因（代码定位）

`packages/hub/src/api.ts`：

| 位置 | 事实 |
|---|---|
| `sendEmailCode`（`:2739-2769`） | 正文硬编码：`text: \`Your remote-dsh code is ${code} (valid 10 minutes).\``；品牌名 "remote-dsh" 写死 |
| 调用点（`:1946`/`:1990`/`:2981`/`:3034`） | 传入的 `subject` 也是写死英文（`"remote-dsh email verification"` 等），且**不传语言** |
| `sendSmsCode`（`:2772-2795`） | 只传 `{ to, code }`；正文在阿里云 `templateCode` 模板里（`sms/aliyun.ts:28-30`）|

`packages/hub/src/email/types.ts`：`EmailMessage { to, subject, text?, html? }` 无语言字段；`EmailConfig` 无模板字段。
`packages/hub/src/config.ts`：`SiteConfig.brand?: string`（`:91`）为单字符串，非 zh/en 对象。
客户端：Portal / App 发码请求不带 `lang` 或 `Accept-Language`。

## 3. 方案（数据契约）

### 3.1 品牌名对象化 —— `site.brand`

```jsonc
"site": { "brand": { "zh": "鲸语通", "en": "WhaleLink" } }
```

- `SiteConfig.brand` 类型从 `string` 改为 `{ zh?: string; en?: string }`；
- 缺省兜底：`zh` → `鲸语通`、`en` → `WhaleLink`（代码里仅作未配置时的默认值，配置了即用配置）；
- Portal 登录页眉标按界面语言取 `brand.zh` / `brand.en`。

### 3.2 邮件验证码模板 —— `email.codeTemplates`（与现有 `email` 配置同级）

```jsonc
"email": {
  "provider": "smtp", "from": "noreply@...", "fromAlias": "鲸语通",
  "codeTemplates": {
    "verify": {
      "subject": { "zh": "{brand} 验证码", "en": "{brand} verification code" },
      "text": { "zh": "【{brand}】您的验证码是 {code}（10 分钟内有效）。", "en": "[{brand}] Your verification code is {code} (valid 10 minutes)." }
    },
    "reset": {
      "subject": { "zh": "{brand} 重置码", "en": "{brand} password reset" },
      "text": { "zh": "【{brand}】您的重置码是 {code}（10 分钟内有效）。", "en": "[{brand}] Your password reset code is {code} (valid 10 minutes)." }
    }
  }
}
```

- 新类型 `EmailCodeTemplate { subject: {zh,en}; text: {zh,en} }`，挂在 `EmailConfig.codeTemplates?: { verify?; reset? }`；
- 占位符：`{code}` = 6 位验证码，`{brand}` = 按语言取的品牌名；
- 未配置 `codeTemplates` 时用**内置中英文模板**（与上面 JSON 相同，作为默认值）；
- `sendEmailCode` 按 `lang`（`"zh"` → zh，其他 → en 兜底）选 subject/text，再替换 `{code}`/`{brand}`。

### 3.3 语言传递 —— 客户端 body 加 `lang`

- Portal / App 发码请求 body 增加 `lang: "zh" | "en"`（中文界面传 `zh`，其余 `en`）；
- 涉及端点：`POST /api/auth/register`、`/api/auth/register/resend`、`/api/auth/password/reset`（及 `bindEmail` 场景）；
- 服务端从 body 读 `lang`，传给 `sendEmailCode`。

### 3.4 改动文件清单

| 文件 | 改动 |
|---|---|
| `packages/hub/src/email/types.ts` | 新增 `EmailCodeTemplate`；`EmailConfig.codeTemplates?` |
| `packages/hub/src/config.ts` | `SiteConfig.brand` 对象化；`normalizeSite` / `normalizeEmail` 解析新字段 |
| `packages/hub/src/api.ts` | `sendEmailCode` 接收 `lang` 并按模板渲染；4 个调用点传 `lang` |
| `packages/portal/src/api.ts` | `register`/`registerResend`/`resetRequest`/`bindEmail` 加 `lang` 参数 |
| `packages/portal/src/pages.tsx` | 调用点传 `lang`；登录页眉标按语言取 `brand.zh/en` |
| App（私有仓） | `rdsh_hub_api_http.dart` 发码方法加 `lang`；`login_page.dart` 传当前语言 |
| 服务器 `hub.json` | `site.brand` 改对象 + `email.codeTemplates` 配置 |

## 4. 验证方式

- `pnpm --filter rdsh-hub build` + `pnpm --filter rdsh-portal build`（tsc strict）零错误；
- `flutter analyze`（App 改动的 5 个文件）零 issue；
- `node --test test/config.test.ts`：新增 `site.brand` 对象校验 + `email.codeTemplates` 解析/部分配置/非法报错断言，15/15 通过；
- `node --test test/email-code.test.ts`：`renderEmailCode` 渲染断言（zh/en 分支、`{code}`/`{brand}` 替换、lang 缺省→en、自定义模板覆盖、brand 缺项兜底、占位符多次出现），9/9 通过；
- 手动：中文界面注册 → 收到中文邮件（含 `鲸语通`）；英文界面 → 英文邮件（含 `WhaleLink`）。

## 4.1 代码审查修复（独立 review 后采纳）

| 级别 | 问题 | 修复 |
|---|---|---|
| P1 | portal 眉标在 `site.brand` 缺省时回退遗留 `RDSH.CN`，与服务端邮件兜底 `鲸语通/WhaleLink` 不一致 | `brandText` 统一为 `lang==="en" ? brand?.en ?? "WhaleLink" : brand?.zh ?? "鲸语通"` |
| P1 | App `_lang` 在 `LocaleProvider.locale` 为 null（首次启动未选语言）时恒返回 `en`，与 MaterialApp 按系统语言解析脱节 | `_lang` 回退 `WidgetsBinding.instance.platformDispatcher.locale.languageCode` |
| P2 | config 注释写"缺省 zh/en"但 normalizeSite 不写默认值（默认在渲染层兜底） | 修正注释措辞 |
| P2 | 缺单测 | 补 `config.test.ts`（brand/codeTemplates）|

## 5. 遗留 / 关联

- **短信**：内容在阿里云模板侧，本次不动（服务端只传 code；要中英文需在阿里云配两套模板）。
- **hub.json 明文 AccessKey**：`email/captcha/sms` 三处 `accessKeySecret` 明文且共用同一对 Key，属独立安全议题，本次不混入。
