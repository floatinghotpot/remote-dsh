# WebView（garsync App）内 hub 登录态不持久（verification）

> **日期**: 2026-09-25 ｜ 关联: [discussion.md](./discussion.md) · [solution.md](./solution.md)

## 1. 根因与修复落点复核

| 项 | 结论 |
|---|---|
| 根因 | 7 天续期令牌存 `sessionStorage`（页面实例级介质）；garsync 每次 `new WebViewController` 即丢失；1h 访问票过期后无令牌可续 → 强制重登 |
| 修复 | 续期令牌改 **HttpOnly cookie `rdsh_hub_refresh`**（`Path=/api/auth`）；会话 cookie `rdsh_session` → **`rdsh_hub_session`**（解除与 gateway 同名） |
| 代码确在生效 | hub 7 处签发点（登录/TOTP/验证码登录/注册验证/续期/注册/微信 302）都下发 `refreshCookie`；`handleRefresh` cookie 优先 + body 回退；`handleLogout`/`handlePassword` 读 cookie 吊销并清两枚 cookie |
| 调用链完整 | portal `jsonFetch` → 401 → `silentRefresh`（**空 body** POST）→ hub `handleRefresh`（读 cookie）→ 轮换下发两枚 → portal 重试一次 |

## 2. 自动化测试

| 套件 | 结果 |
|---|---|
| hub（`node --test`） | **126 / 126**。新增 6：登录下发续期 cookie（属性断言）、仅 cookie 续期、body 回退、两者皆无 **401**、登出清两枚 + 吊销、改密清两枚 |
| portal（`vitest`） | **5 / 5**。新增 `silent-refresh.test.ts`：续期走空 body POST、无 `refreshToken`、成功后重试一次 |
| 构建 | tunnel / gateway / hub / cli / web-remote 全仓 `tsc` **零 issue** |
| 残留 | hub 侧 `rdsh_session` **零残留**（gateway 侧保留）；portal `sessionStorage` / `REFRESH_KEY` **零残留**；微信交接 cookie 已清除 |

## 3. 真机 / 浏览器验证（用户 hub host 实测）

| 项 | 结果 |
|---|---|
| cookie 下发 | Chrome DevTools Application 可见 `rdsh_hub_session` + `rdsh_hub_refresh` |
| 静默续期 | 删除 `rdsh_hub_session` → 刷新 `/portal/hosts` → 门户经 `rdsh_hub_refresh` 静默续期、重新下发两枚 cookie、页面正常（**不再要求登录**） |
| `Path=/api/auth` 作用域 | `rdsh_hub_refresh` 不出现在 `/portal/hosts` 的 cookie 列表——**符合预期**：该凭证只应出现在续期/登出/改密请求，普通页面与中继不携带，缩小暴露面。非 bug |

## 4. 验收标准对照（solution §7）

| # | 验收 | 状态 |
|---|---|---|
| 1 | 门户登录 → 进 DSH → >1h → 点「返回」回主机列表 | ✅ 机制已验（删 session cookie 模拟过期 → 静默续期成功）；⏭️ garsync 真机 >1h 待 App 侧复测 |
| 2 | 杀 App 重启 → 仍登录 | ⏭️ 待 garsync 真机（`rdsh_hub_refresh` 为带 `Max-Age` 的持久 cookie，标准行为支持） |
| 3 | 已登录访问 `/portal/login` → 跳 `/hosts` | ✅ 代码核对（Login 挂载 `accountInfo({probe:true})` 探测）；⏭️ 真机点选复测 |
| 4 | 登出/改密清两枚 cookie、旧令牌不能续期 | ✅ hub 测试覆盖；⏭️ 真机复测 |
| 5 | hub/portal 构建 + 测试全绿 | ✅ |
| 6 | cookie 属性（HttpOnly / Path / Max-Age） | ✅ hub 测试断言（`Max-Age` 由 `REFRESH_TTL_MS` 换算，不写死） |

## 5. 审查

- **自审**抓出并修掉两处：① 续期端点"无令牌返回 **400**"的错误码 bug——门户把非 401/403 当作 transient（网络错误），未登录用户会报"刷新失败"而非跳登录，已改为 **401**；② 测试顺序污染——登录限流按 IP 锁死后续测试，已把限流测试移到末尾。
- 调用点审计见 [solution.md](./solution.md) §4；commit `a54168a`。

## 6. 未覆盖 / 遗留

见 [TODO.md](./TODO.md)。
