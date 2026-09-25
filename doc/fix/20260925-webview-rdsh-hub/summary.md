# WebView（garsync App）内 hub 登录态不持久（summary）

> **日期**: 2026-09-25 ｜ 关联: [discussion.md](./discussion.md) · [solution.md](./solution.md) · [verification.md](./verification.md)

## 做了什么

| 层 | 改动 |
|---|---|
| hub | 续期令牌改 **HttpOnly cookie `rdsh_hub_refresh`**（`Path=/api/auth`，`Max-Age` 由 `REFRESH_TTL_MS` 换算）；`handleRefresh` cookie 优先 + body 回退（向后兼容）；`handleLogout`/`handlePassword` 读 cookie 吊销并清两枚 cookie；微信 302 直发续期 cookie（删一次性交接 cookie）；会话 cookie `rdsh_session` → **`rdsh_hub_session`** |
| portal | `silentRefresh` 空 body POST（令牌在 HttpOnly cookie，不再进 sessionStorage / JS）；`redirectToLogin` 去 sessionStorage；`/login` 已登录跳 `/hosts`；删微信交接消费 |
| 协议 | `packages/hub/API.md` 认证段补续期 cookie + 会话改名（协议先行） |
| 测试 | hub +6（cookie 续期 / body 回退 / 缺失 401 / 登出改密清 cookie）、portal +1（`silent-refresh.test.ts`） |

## 结果

- hub 测试 **126/126**、portal 测试 **5/5**、全仓 `tsc` 零 issue。
- 用户 hub host 实测：Chrome DevTools 删除 `rdsh_hub_session` 后刷新 `/portal/hosts`，经 `rdsh_hub_refresh` 静默续期成功，不再要求登录。

## 生效方式

改动落在 **hub**（服务端）与 **portal**（hub 门户静态产物，随 hub 一起分发）⇒ 线上生效需**重新部署 hub**。`rdsh-gateway` / `dsh-web-remote` / CLI 不受影响（gateway 侧 cookie 名未动）。

## 关键设计（一句话）

把 7 天"续期钥匙"从最短命的页面会话介质（`sessionStorage`）搬到持久 cookie 仓（HttpOnly、`Path=/api/auth`），访问令牌仍保持 1h 短命；同时把 hub 会话 cookie 改名，与 gateway 同名 cookie 解耦。

## 遗留

见 [TODO.md](./TODO.md)。
