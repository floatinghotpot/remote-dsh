# WebView（garsync App）内 hub 登录态不持久 —— 解决方案（solution.md）

> **日期**: 2026-09-25
> **上游**: [discussion.md](discussion.md)。根因**已确认**：7 天续期令牌存在 `sessionStorage`（页面实例级介质），而 garsync `RdshPage` 每次进入都 `new WebViewController`（F19）；用户已确认"被要求重新登录发生在门户登录 **>1 小时** 之后"，与"1h 访问票过期 + 续期令牌已丢"完全吻合。
> **范围**: **A** 根因修复（方案① 续期 cookie + 方案③ `/login` 已登录跳走）；**B** 独立设计债（hub 会话 cookie 改名，解除与 gateway 同名）。**A、B 分开提交**，A 不依赖 B。
> **不做**: 方案④（访问票 1h→7d，牺牲安全性，仅作战术后备）；方案②（localStorage，安全性低于①）。
> **状态**: 待评审 —— 本文档**未改任何代码**。

---

## 1. Goal

1. **登录态跨页面实例 / 跨 App 重启存活**：7 天续期凭证改由 hub 下发 **HttpOnly cookie**（`Path=/api/auth`），门户不再把任何令牌交给 JS 存储。DSH 页点「返回」不再要求重新登录。
2. **访问令牌仍保持 1 小时短命**（弃用方案④）。暴露面**不增大、反而更小**：续期凭证从"明文交给页面 JS"改为"JS 读不到的 HttpOnly cookie"。
3. **消除"假掉线"**：已登录访问 `/login` 自动跳主机列表（③）。
4. **消除 hub/gateway 同名 cookie 设计债**：hub 会话 cookie 改名，**gateway 侧完全不动**（B）。

---

## 2. Facts（改前代码事实，逐条 read/grep 核对）

### 2.1 hub 侧

| # | 事实 | 证据 |
|---|---|---|
| **H1** | 会话 cookie 常量 = `rdsh_session` | `packages/hub/src/api.ts:33` |
| **H2** | `sessionCookie()` 拼 `HttpOnly; SameSite=Lax; Path=/; Max-Age=3600`（**写死 3600**） | `packages/hub/src/api.ts:1473-1475` |
| **H3** | `sessionCookie(...)` 共 **7 个调用点**：微信交接 `:809`、登录 `:882`、TOTP `:999`、验证码登录 `:1022`、续期 `:1198`、注册验证登录 `:1215`、注册 `:1681` | grep `sessionCookie(` |
| **H4** | `handleRefresh`（`:1203-1219`）**只从 `body.refreshToken` 取令牌**；缺失即 400；成功只下发 `sessionCookie` | `packages/hub/src/api.ts:1203-1219` |
| **H5** | `handleLogout`（`:1221-1231`）吊销 body 令牌 + 清 `rdsh_session`（`Max-Age=0`）+ `clearHostCookie()` | `packages/hub/src/api.ts:1221-1231` |
| **H6** | `handlePassword`（`:1233-1258`）改密 = `ver+1` + `revokeAllRefreshForUser`；**但不下发任何 `set-cookie`**（旧会话 cookie 只是失效、不清理） | `packages/hub/src/api.ts:1233-1258`；`auth.ts:201-208` |
| **H7** | 微信 302 用一次性交接 cookie `rdsh_wechat_refresh`（`Max-Age=60`、**非 HttpOnly**、`Path=/`） | 常量 `api.ts:44`、下发 `api.ts:810` |
| **H8** | 已有 `parseCookies(header?)` 助手；`authenticate()` 以 `cookies[SESSION_COOKIE]` 读会话 | `packages/hub/src/api.ts:79-87`、`:65-77` |
| **H9** | `readJsonBody()` 对**空 body / 非 JSON** 返回 `null`（不抛） | `packages/hub/src/api.ts:2358-2372` |
| **H10** | `ACCESS_TTL_MS = 1h`、`REFRESH_TTL_MS = 7d`（两个独立常量） | `packages/hub/src/auth.ts:54-55` |
| **H11** | **所有**需要清会话的端点都在 `/api/auth/` 下：`refresh:515`、`logout:519`、`password:523`、`totp:561`、`password/reset:577`、`password/reset/confirm:581`、`register:527` | grep `path === "/api/auth/` |
| **H12** | `refresh()` 校验 **revoked / expired / account active**；改密会 `revokeAllRefreshForUser` ⇒ 令牌级吊销完整 | `packages/hub/src/auth.ts:186-193`、`:207` |

### 2.2 portal 侧

| # | 事实 | 证据 |
|---|---|---|
| **P1** | `REFRESH_KEY = "rdsh_refresh"`；`silentRefresh()` 读 `sessionStorage`，**读不到直接判 `invalid`**（不发请求） | `packages/portal/src/api.ts:6`、`:14-16` |
| **P2** | `silentRefresh()` 以 body 传令牌；成功后 `sessionStorage.setItem` 存轮换后的新令牌；单飞（`refreshPromise`）+ 8s 超时 | `packages/portal/src/api.ts:17-45` |
| **P3** | `redirectToLogin()` = 清 sessionStorage + `location.assign("/portal/login?next=…")` | `packages/portal/src/api.ts:48-54` |
| **P4** | `REFRESH_KEY` 共 **11 行引用**：`api.ts:15/33/49`、`main.tsx:13`、`pages.tsx:499/525/532/1436-1437/1632/1730` | grep `REFRESH_KEY` |
| **P5** | 微信交接消费在 `main.tsx:9-19`：读 `document.cookie` → 存 sessionStorage → 清交接 cookie | `packages/portal/src/main.tsx:9-19` |
| **P6** | 路由 `/login` **无已登录判断**，直接渲染 `<Login />` | `packages/portal/src/pages.tsx:67` |

### 2.3 与 B 相关

| # | 事实 | 证据 |
|---|---|---|
| **B-F1** | gateway 的准入会话 cookie **同名** `rdsh_session`（`HttpOnly; SameSite=Lax`） | `packages/gateway/src/session.ts:14`、`:93-96` |
| **B-F2** | hub 中继 cookie 处理是**白名单**：只 `extractGateCookie` 取 `rdsh_gate`，其余全丢，**不按名匹配** | `packages/hub/src/relay.ts:169-183` |
| **B-F3** | ⇒ 改 hub 侧名字**不会**造成"hub 会话泄露给 host"（剥离逻辑与名字无关） | 同上 |
| **B-F4** | hub 侧 `rdsh_session` 只出现在：`api.ts:4/33/1473`、`API.md:6/111`、3 个 hub 测试 | grep `rdsh_session` |
| **B-F5** | 门户/原生壳**不依赖 cookie 名字**（门户同源自动带；原生壳用 `Authorization: Bearer`） | `packages/portal/src/api.ts`（无名字引用）；`doc/feature/03-hub/solution.md:164` |

---

## 3. Gap

| 目标 | 现状 | 差距 |
|---|---|---|
| 7 天凭证存"持久介质" | 存在 `sessionStorage`（页面实例级） | **缺**：续期凭证的 cookie 化（A1–A3） |
| 门户不把令牌交给 JS | `sessionStorage` 明文存 7 天令牌 | **缺**：删除全部 JS 存储读写（A6–A9） |
| 已登录访问 `/login` 跳走 | 直接渲染登录表单 | **缺**：已登录判断（A10） |
| hub/gateway 不同名 cookie | 两边都叫 `rdsh_session` | **缺**：hub 侧改名（B1–B3） |
| 对外 API 文档同步 | `API.md` 未描述续期 cookie | **缺**：协议先行更新（C1–C2） |

---

## 4. Call-site Audit

> 触发条件：改动共享函数的契约。

| 被改对象 | 调用点 / 消费者 | 兼容性判定 |
|---|---|---|
| `sessionCookie(accessToken)` | `api.ts` 7 处（H3） | **不改签名**；新增并列的 `refreshCookie(refreshToken)`，无既有调用者受影响 |
| `handleRefresh` 契约 | 1 路由（`api.ts:515`）；消费者 = portal `silentRefresh`（P2） | **向后兼容**：改为"cookie 优先、body 回退"。旧 portal（只发 body）继续可用 ⇒ **可先发 hub、后发 portal** |
| `handleLogout` 契约 | 路由 `:519`；消费者 portal `api.logout`（`api.ts:183-185`） | **向后兼容**：仍接受 body 令牌；额外清续期 cookie |
| `SESSION_COOKIE` 常量（B） | `authenticate()`（`:71`）、`sessionCookie`（`:1473`）、`handleLogout`（`:1228`）、3 个 hub 测试、`API.md` | 改**值**不改结构；**无前端 JS 依赖名字**（B-F5） |
| `REFRESH_KEY`（portal） | 11 行（P4） | **全量移除/改造**，无仓外消费者 |
| relay cookie 处理 | `normalizeHeaders`（`relay.ts:169-183`） | **不需要改**（白名单，与名字无关，B-F2/F3） |

---

## 5. Tasks

### A. 根因修复（方案① + ③）

| # | 包 | 位置 | 改动 |
|---|---|---|---|
| **A1** | hub | `src/api.ts`（常量区 `:33` 附近、助手区 `:1473` 附近） | 新增 `export const REFRESH_COOKIE = "rdsh_hub_refresh";` 与 `refreshCookie(token)`：`${REFRESH_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/api/auth; Max-Age=${Math.floor(REFRESH_TTL_MS / 1000)}`。**`Max-Age` 由 `REFRESH_TTL_MS` 换算，禁止再写死常量**（消除 H2/H10 的漂移隐患） |
| **A2** | hub | 6 个签发点（H3 去掉微信 809，微信由 A6 专项处理） | 每处 `set-cookie` 追加 `refreshCookie(...)`：`:882`（登录）、`:999`（TOTP）、`:1022`（验证码登录）、`:1198`（注册验证登录）、`:1215`（续期）、`:1681`（注册） |
| **A3** | hub | `handleRefresh`（`:1203-1219`） | 改为 **cookie 优先、body 回退**：`const token = parseCookies(req.headers.cookie)[REFRESH_COOKIE] ?? (body && typeof body.refreshToken === "string" ? body.refreshToken : null);` 两者皆无返回 **401**（**必须 401 而非 400**：门户把非 401/403 当作 transient「网络错误」，只有 401 才判 invalid → 跳登录）；成功时**同时**下发新 `sessionCookie` + 新 `refreshCookie`（轮换），**JSON body 仍返回 `refreshToken`**（旧 portal 兼容期需要，见 §6） |
| **A4** | hub | `handleLogout`（`:1221-1231`） | **从 cookie 优先、body 回退读取令牌以吊销**（portal 改无 body 后必须依赖 cookie，否则登出不吊销）；`set-cookie` 数组追加清续期 cookie：`` `${REFRESH_COOKIE}=; HttpOnly; SameSite=Lax; Path=/api/auth; Max-Age=0` `` |
| **A5** | hub | `handlePassword`（`:1233-1258`） | 改密成功后追加 `set-cookie`：清 `SESSION_COOKIE` + 清 `REFRESH_COOKIE`（`ver+1` 已使两者失效，此处只做清理，避免死 cookie 残留） |
| **A6** | hub | 微信交接（`api.ts:44`、`:810`） | 302 分支直接下发 `refreshCookie(tokens.refreshToken)`；删除 `WECHAT_REFRESH_COOKIE` 常量与交接 cookie |
| **A7** | portal | `src/api.ts:14-45` | `silentRefresh()`：删除 `sessionStorage` 读；改为**空 body** POST（`credentials:"include"`）；删除成功后 `setItem`。**保留**单飞 `refreshPromise` + 8s 超时（轮换下并发续期必须仍只发一次） |
| **A8** | portal | `src/api.ts:48-54` | `redirectToLogin()` 删除 `sessionStorage.removeItem` |
| **A9** | portal | `src/pages.tsx:499/525/532/1730`、`:1436-1437`、`:1632` | 删除存/取 `REFRESH_KEY`；登出（`:1436-1437`）改为无 body 的 `logout()`，改密（`:1632`）只保留本地提示语义、由服务端清 cookie |
| **A10** | portal | `src/main.tsx:9-19` | 删除 `consumeWechatRefreshHandoff()`（交接 cookie 已不存在） |
| **A11** | portal | `src/pages.tsx:67`（③） | `Login` 组件挂载时用 `api.accountInfo({ probe: true })` 探测：未 401 ⇒ `navigate("/hosts")`（避免渲染登录表单后再跳的闪烁）；401 ⇒ 正常渲染登录表单。探测走 `probe:true`，不会触发 `redirectToLogin` |

### B. hub 会话 cookie 改名（独立设计债，独立提交）

| # | 包 | 位置 | 改动 |
|---|---|---|---|
| **B1** | hub | `src/api.ts:33` | `SESSION_COOKIE` 值 `rdsh_session` → **`rdsh_hub_session`**（与 B 一并，`REFRESH_COOKIE` 取 `rdsh_hub_refresh` 保持同族） |
| **B2** | hub | `test/api.test.ts`、`test/multi-tenant.test.ts`、`test/relay-d12.test.ts` | 硬编码的 `rdsh_session=` 字符串同步为 `rdsh_hub_session=` |
| **B3** | — | `packages/hub/API.md:6`、`:111` | 契约文本同步新名 |

> **B 不做的事**：`packages/gateway/**` 一行不改（B-F2/F3 已证剥离与名字无关）；hub 其它 cookie（`rdsh_trusted`/`rdsh_openid`/`rdsh_admin_session`）本轮不动。

### C. 协议先行（层 1，必须先于实现）

| # | 位置 | 改动 |
|---|---|---|
| **C1** | `packages/hub/API.md:6` | 认证段补：续期凭证 = **HttpOnly cookie `rdsh_hub_refresh`**（`Path=/api/auth`）；`POST /api/auth/refresh` 支持"**cookie 优先、body `refreshToken` 回退**" |
| **C2** | `packages/hub/API.md:111` | 门户会话 cookie 名改为 `rdsh_hub_session`（B）；登出/改密会清除会话与续期 cookie |

### D. 测试

| # | 位置 | 覆盖 |
|---|---|---|
| **D1** | hub `test/api.test.ts` | 续期：**仅带 cookie** 可续期（轮换后 `Set-Cookie` 同时含两枚）；**仅带 body** 仍可用（兼容）；两者皆无 → **401**（门户据此判 invalid） |
| **D2** | hub `test/api.test.ts` | 登出 / 改密后响应含两枚 cookie 的 `Max-Age=0` |
| **D3** | hub `test/api.test.ts` | 登录类响应含 `rdsh_hub_refresh`，且属性为 `HttpOnly; Path=/api/auth`、`Max-Age` = `REFRESH_TTL_MS/1000`（**断言由常量换算，不写死**） |
| **D4** | portal | `silentRefresh()` 不再读写 `sessionStorage`；401 → 空 POST → 重试一次；并发 401 只发一次（单飞保留）。portal 已有 `vitest`（`packages/portal/test/`），用 `fetch` + `sessionStorage` stub 测，**勿**只靠 `--passWithNoTests` 空过 |

---

## 6. 兼容 / 回滚 / 发布顺序

- **A 的兼容**：`handleRefresh` cookie 优先 + body 回退 ⇒ **先发 hub、后发 portal** 不打断在线用户。旧 portal 的 sessionStorage 令牌在新 hub 上仍可续期一次以上（下次登录起改为 cookie 承载）。
- **B 的兼容**：hub 改名后，旧 `rdsh_session` cookie 被忽略 ⇒ 门户 401 → 静默续期（A 已落地时，续期 cookie 仍在）⇒ **对"续期凭证尚存"的用户无感**；仅历史会话（续期凭证已丢）需重登一次。这正是"中心改一次全体生效"的代价，用户已接受。
- **回滚**：A、B 各自独立提交，直接回退对应提交即可。
- **发布顺序建议**：① 先发 **A**（hub 续期 cookie + portal）→ 新登录即持续期 cookie；② 再发 **B**（hub 改名）→ 此时续期 cookie 已在，改名对用户**无感**（旧会话由静默续期兜底）。若必须同版本，则 hub 同时含 A+B、门户发 A7–A11，旧 portal 靠 body 回退过渡。**关键：B 依赖 A 的续期 cookie 才能做到"改名零重登"，故 A 应在 B 之前（或至少同一版本）落地。**

## 7. 验收标准

1. garsync 真机：门户登录 → 进 DSH → **静置 >1 小时** → 点「返回」→ **直接回主机列表**（不再要求登录）。
2. garsync 真机：**杀掉 App 重启** → 进助理页 → 仍是登录态。
3. 浏览器与 App 表现一致（消除"浏览器是有效对照组"的误导）。
4. 已登录直接在地址栏访问 `/portal/login` → 自动跳 `/hosts`（③）。
5. `hub`/`portal` 构建零 issue、全量测试通过。
6. 登出/改密后，`rdsh_hub_session` 与 `rdsh_hub_refresh` 均被清除；旧 token 无法续期。

## 8. 非目标（明确不做）

- **方案④**（`ACCESS_TTL_MS` 1h→7d）：不改。仅在"某天必须出包止血"时才考虑，且必须成对改 `auth.ts:54` + 写死处。
- **方案②**（`localStorage`）：不采用（XSS 可读走 7 天令牌）。
- **gateway 侧 cookie 改名**：不做（B-F2/F3 已证不必要，且分布式升级成本高）。
- **`rdsh_host` / `rdsh_gate` 语义调整**：不涉及。
- **中继 `relay.ts`**：不改（白名单逻辑与 cookie 名无关）。
- **`Secure` 属性**：续期 cookie 与既有 session cookie 保持一致（不加 `Secure`，兼容自托管 http）；若 hub 恒为 HTTPS，可后续统一加 `Secure`，本轮不做。
- **portal `api.refresh` 死代码**：当前无调用（`silentRefresh` 自建 fetch）；A7 后可顺手删 `api.refresh`，属可选清理，不阻塞主流程。
