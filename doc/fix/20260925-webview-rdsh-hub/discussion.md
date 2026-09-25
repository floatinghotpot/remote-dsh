# WebView（garsync App）内 hub 登录态不持久：根因与处置建议（discussion）

> **日期**: 2026-09-25
> **上报方**: garsync App（iOS，WKWebView）真机实测；处置方 = 本仓（remote-dsh）
> **现象**: 在 garsync「语音助理」页里完成门户登录、进入主机页，DSH 使用一切正常；但从 DSH 页点右上角注入的「返回」回到门户（`/portal/hosts`）时，被要求重新输入用户名/密码。**同一台机器上的浏览器里点同一个「返回」，直接回到主机列表。**
> **结论**: **不是 App 破坏了登录态**（garsync 侧无任何清 cookie/storage 的代码，且实测登录态跨页面重建存活）。根因**判断**（高置信，区分实验见 §6-D2）是门户把 **7 天续期令牌放在 `sessionStorage`**（页面会话级存储），而 WebView 每次进入助理页都是**新的页面会话** ⇒ 页面重建后只剩那张 **1 小时**的访问 cookie ⇒ 一过期就只能回登录页。浏览器之所以看不出差别，是因为标签页常驻（续期令牌一直在），且 Back 可能直接命中 bfcache —— **浏览器不是有效对照组**。
> **建议**: 主方案 = 续期令牌改由 hub 下发 **HttpOnly 续期 cookie**（`Path=/api/auth; Max-Age=<REFRESH_TTL_MS>`），门户不再碰 `sessionStorage`（§4.1）；附带修 `/login` 在已登录时不跳走（§4.3）；另发现 hub 与 gateway **同名 cookie `rdsh_session`** 的独立隐患（§5，本症状不由此触发）。
> **状态**: **已评审**（2026-09-25，决议见 §8）—— 根因已由用户确认"重新登录发生在门户登录 **>1 小时** 后"；实现方案见 [solution.md](solution.md)。本文档只记录事实与建议，**未改任何代码**。

---

## 0. 一句话链路

```
登录（门户）
  ← Set-Cookie: rdsh_session=<access JWT>  (HttpOnly, Path=/, Max-Age=3600)   ← 1 小时
  ← JSON: { refreshToken }                                                    ← 7 天，交给 JS
门户：sessionStorage["rdsh_refresh"] = refreshToken      ← 页面会话级：关页面/换页面实例即消失

任意时刻（1 小时后）：GET /api/account → 401
  silentRefresh()
    ├─ sessionStorage 有令牌 → POST /api/auth/refresh {refreshToken} → 新 cookie → 重试 → 主机列表 ✅
    └─ sessionStorage 无令牌 → redirectToLogin() → /portal/login                      ❌ 登录页
```

**WebView（garsync）每次都落在下面那条分支；浏览器标签页一直落在上面那条。** 差别只有一个：`sessionStorage` 的存活时间（高置信推断，区分实验见 §6-D2）。

---

## 1. 现象、复现与已做实验

### 1.1 用户报告（原话要点）

1. 在助理页完成门户登录 → 进入主机列表；
2. 在助手页里选中一台主机进入 DSH 界面，DSH 使用正常；
3. 浏览器里点 DSH 右上角的「返回」→ **主机列表**（网页状态）；**App 里点同一个「返回」→ 最外层登录界面，要求输入用户名和密码**。

### 1.2 已做实验（真机，2026-09-25）

| # | 实验 | 结果 | 推论 |
|---|---|---|---|
| **X1** | 在助理页完成门户登录 → 关闭助理页 → **1 分钟内**重进 | **仍是登录态** | ① **登录态本身跨页面实例存活**（`RdshPage` 已销毁重建，见 §2.3-F19）② 但**谁在支撑它尚不能由此判定**：可能是 `rdsh_session` cookie 被持久保存，也可能是 WebView 的 `sessionStorage` 未被清（两者都由 §6-D2 的只读日志区分）。注意：能确定的是 garsync **没有**主动清 cookie/storage（X3） |
| **X2** | 浏览器 vs App 点「返回」 | 浏览器 → 主机列表；App → 登录页 | 见 §3.3：两者的**页面会话寿命**不同，不能据此定责 |
| **X3** | `lib/rdsh/` 全目录 grep：`cookie` / `clearCookies` / `clearCache` / `clearLocalStorage` | **无任何命中** | 排除"App 主动清登录态" |

### 1.3 尚未跑完的实验（建议补，1 小时）

1. App 内登录门户（t=0）→ 关闭助理页；
2. **等待 > 60 分钟**（访问 cookie 到期）；
3. 重进助理页 → 进主机（应仍可进，靠 7 天 `rdsh_host`）；
4. 点「返回」→ **预测：登录页**；浏览器在一直开着的标签里做同样操作 → **预测：主机列表**。

### 1.4 目前无法用一个实验区分的地方（**必须诚实标注**）

- **"1 小时已过"** 与 **"页面会话被重建"** 两个条件，用户侧无法精确计时确认（用户自述"没注意时间"）。
- 若在**登录后 1 小时内**点「返回」也会落到登录页，则 cookie 过期解释不成立，需改用 §6-D2 的只读日志实验钉死（打印 URL + cookie 名集合 + `sessionStorage` key 集合）。
- 依据 `sessionStorage` 规范与页面生命周期，"关闭页面实例即丢失"是高置信推断，但 **WebView 具体实现差异未逐台验证**（见 §6-D2）。

---

## 2. 代码事实（逐条 grep/read 核对，改前状态）

### 2.1 凭证与寿命

| # | 事实 | 证据 |
|---|---|---|
| **F1** | 访问令牌 = **`rdsh_session`** cookie，`HttpOnly; SameSite=Lax; Path=/; Max-Age=3600`（**1 小时**） | `packages/hub/src/api.ts:33`、`:1473-1475` |
| **F2** | 访问 JWT 的 TTL 常量 = 1 小时；续期令牌 TTL = **7 天**（DB 存 SHA-256 摘要，轮换） | `packages/hub/src/auth.ts:54-55`、`:162-173` |
| **F3** | 续期令牌**下发方式 = JSON 响应体**，由门户存进 `sessionStorage` | `packages/hub/src/api.ts:883`、`:1199`、`:1687`；`packages/portal/src/api.ts:5-6` |
| **F4** | `silentRefresh()` 读 `sessionStorage`；**读不到直接判 "invalid"** | `packages/portal/src/api.ts:14-16` |
| **F5** | 401 → `silentRefresh()`：`ok` 重试一次；`invalid` → `redirectToLogin()`（清 sessionStorage + `location.assign("/portal/login?next=…")`）；`transient` 只报网络错误 | `packages/portal/src/api.ts:126-145`、`:48-54` |
| **F6** | 进门用的 `rdsh_host` cookie = 签名 HMAC，**7 天**（与访问令牌寿命解耦） | `packages/hub/src/server.ts:85`、`:108`、`:315` |
| **F7** | "记住此设备 30 天" 只影响 **TOTP**，不影响登录持久性 | `packages/hub/src/api.ts:1477-1480`、`:999` |

### 2.2 签发 / 读取 / 清除点（方案①的改动面，共 7 处签发）

| # | 位置 | 说明 |
|---|---|---|
| **F8** | `packages/hub/src/api.ts:809`、`:882`、`:999`、`:1022`、`:1198`、`:1215`、`:1681` | 全部 `sessionCookie(...)` 调用点（微信交接 / 登录 / TOTP / 验证码登录 / 续期 / 配对 / 注册） |
| **F9** | `packages/hub/src/api.ts:515`（路由）、`:1204`（读 `body.refreshToken`）、`:1208`（`auth.refresh`） | 续期入口：**目前只从 body 取令牌** |
| **F10** | `packages/hub/src/api.ts:519`、`:1222-1228` | 登出：清 `rdsh_session` + `rdsh_host`（未来需一并清续期 cookie） |
| **F11** | `packages/hub/src/api.ts:44`、`:810` | 微信 302 一次性交接 cookie `rdsh_wechat_refresh`（`Max-Age=60`）—— ①落地后可删 |
| **F12** | portal 侧 `REFRESH_KEY` 全部引用点：`api.ts:15/33/49`、`main.tsx:13`、`pages.tsx:499`（微信确认）、`:525`/`:532`（登录/TOTP）、`:1730`（验证码注册）、`:1436-1437`（登出）、`:1632`（改密） | **共 11 行引用**（api.ts 3 / main.tsx 1 / pages.tsx 7）——方案②的改动面比"3 处"大得多 |

### 2.3 与本症状直接相关的页面/路由事实

| # | 事实 | 证据 |
|---|---|---|
| **F13** | DSH 页右上角的「返回」是 hub 中继**注入的普通链接** `/portal/hosts` | `packages/hub/src/relay.ts:44` |
| **F14** | 中继是**纯透传**：host 侧响应头（含 `Set-Cookie`）原样回写浏览器 | `packages/hub/src/relay.ts:88-104` |
| **F15** | 中继**只把 `rdsh_gate` 转发给 host**（D12：访问令牌不下发共享主机） | `packages/hub/src/relay.ts:169-183`；`packages/hub/test/relay-d12.test.ts:6-30` |
| **F16** | `/portal/*` 分支会**清掉 `rdsh_host`**（进门上下文退出），随后由门户 SPA 自行鉴权 | `packages/hub/src/server.ts:242-243` |
| **F17** | `/login` 路由**在已登录时不跳走**，直接渲染登录表单 | `packages/portal/src/pages.tsx:67` |
| **F18** | 门户 `navigate()` = `history.pushState` + 合成 `popstate`（登录成功后是**入栈**，登录页条目留在历史里） | `packages/portal/src/pages.tsx:19-22` |
| **F19**（garsync 侧） | `RdshPage` 每次进入都 **new `WebViewController`**，用默认持久存储；只在初始化与选网址时 `loadRequest`；无任何 cookie/storage 操作 | garsync `lib/rdsh/rdsh_page.dart:166-199`、`:212-220`、`:728-737` |
| **F20**（garsync 侧） | 102 需求**明令禁止**注入 Cookie/token ⇒ App 侧不能也不该"帮它记住登录" | garsync `doc/feature/102_remote_dsh/req.md:58` |

---

## 3. 根因分析

### 3.1 两条命，长短不同、存放介质不同

- **命一**：`rdsh_session`（1 小时，HttpOnly cookie）→ 存放介质 = 浏览器/WebView **持久 cookie 仓**（带 `Max-Age` 的 cookie 会落盘，这是标准行为；跨页面重建由 X1 实测支持，跨 App 重启未单独实测，见 §6-D4）。
- **命二**：续期令牌（7 天）→ 存放介质 = **`sessionStorage`**，即**页面会话**。

7 天的命二被放在"最短命"的介质里；命一虽然放对了地方，却只活 1 小时。**命二一断，命一过期即等于登出。**

### 3.2 为什么在 DSH 页里察觉不到

进门走的是 `rdsh_host`（**7 天**，F6），与访问令牌完全解耦（`relay.ts:29` 注释即写明"不依赖 `rdsh_session`"）。所以在 DSH 里用多久都不会被踢；**访问令牌过期这件事，只有在"回门户"的那一刻才第一次暴露**——也就是用户点「返回」的那一下。

### 3.3 为什么浏览器看起来正常（**浏览器不是有效对照组**）

| 因素 | 浏览器 | garsync WebView |
|---|---|---|
| 页面会话（`sessionStorage`）寿命 | 标签页一直开着 ⇒ 续期令牌一直在 | 每次进助理页 = 新页面会话（F19）⇒ 页面重建即丢失（高置信推断，见 §1.4） |
| Back/返回 | 可能直接命中 **bfcache**（不发请求、不走鉴权，显示的是缓存页） | 通常是新导航 + SPA 重新鉴权 |

⇒ 浏览器显示主机列表**不能**证明会话仍然有效；而 WebView 显示登录页**也不能**证明会话被谁破坏。真正的差别是介质寿命。

### 3.4 已排除项（含证据）

| # | 候选原因 | 结论 | 证据 |
|---|---|---|---|
| **R1** | garsync App 清理/未保存 cookie | **排除** | X1（跨页面重建仍登录）+ X3（`lib/rdsh/` 无任何 cookie/storage 代码）+ F19 |
| **R2** | hub `authenticate()` 顺手改了会话 | **排除**（只读：Bearer 或 cookie → `verifyAccess`） | `packages/hub/src/api.ts:65-82` |
| **R3** | 多端登录互相踢（版本号失效） | **排除**：`ver` 只在**改密 / 开停 2FA** 时 +1，登录不 +1 | `packages/hub/src/auth.ts:141-155`、`:201-206` |
| **R4** | hub/gateway 同名 cookie 冲突导致本次症状 | **本次不成立**：hub 中继只放行 `rdsh_gate`（F15），宿主走 join 隧道（`packages/gateway/src/session.ts` 的 `rdsh_session` 不在这条链路上） | `packages/hub/src/relay.ts:169-183`；`packages/gateway/src/join.ts:494`、`src/access-gate.ts:11` |
| **R5** | 访问令牌被他人覆盖（如 host 侧 `Set-Cookie`） | 在当前链路上**排除**（同上）；但若部署形态变化（同 origin 同时暴露 hub 与独立 gateway）则风险成立，见 §5 | F14 + F15 |

### 3.5 尚未确定

- 是否**每次**点「返回」都回登录页（= 会话更早就已失效），还是**只在 >1 小时后**出现 → 决定是否需要额外排查（§6-D2）。
- App 杀掉重启后的 cookie 落盘行为：标准 WKWebView 对带 `Max-Age` 的 cookie 会落盘，**未实测**（建议顺带验一次）。

---

## 4. 处置建议（待决策）

### 4.1 方案①（**推荐**）：续期令牌改由 hub 下发 HttpOnly 续期 cookie

**目标形态**

```diff
 登录 / TOTP / 续期 / 注册 / 配对的响应里，保留原来那张 1 小时的访问票，再补一张：
+ Set-Cookie: rdsh_refresh=<opaque token>; HttpOnly; SameSite=Lax; Path=/api/auth; Max-Age=<REFRESH_TTL_MS/1000>

 门户 silentRefresh() 不再碰任何 JS 存储：
+ POST /api/auth/refresh        // 空 body，credentials: "include"
+ 服务器从 cookie 取令牌（body 作兼容回退）→ 轮换 → 同时下发新的 rdsh_refresh + rdsh_session
```

**为什么这样能治本**：需要活 7 天的那把钥匙，从"页面会话级介质"搬到**持久 cookie 仓**——即 1 小时的访问票已经在用的那个仓（X1 已证明该仓中的登录态跨页面重建存活；cookie 的落盘行为由 `Max-Age` 决定，属标准行为）。页面重建、App 重启都不再影响登录态，而访问令牌仍保持 1 小时的短命设计。

**属性各自的必要性**

- `HttpOnly`：页面 JS（含被注入脚本）读不到 ⇒ **暴露面比现状更小**（现状把令牌明文交给 JS）。
- `Max-Age=<REFRESH_TTL_MS>`：带过期的持久 cookie ⇒ 跨页面/跨重启存活；`Max-Age` 由 `packages/hub/src/auth.ts:55` 换算，**不要再写死常量**（F1 与 F2 现在就是两个互不相干的数，已是漂移隐患）。
- `Path=/api/auth`：只有续期/登出接口会收到 ⇒ 浏览普通页面、加载 DSH、中继转发都不携带（叠加 F15 的双保险）。

**改动清单**

| 包 | 位置 | 改动 |
|---|---|---|
| hub | `src/api.ts` | 新增 `refreshCookie()`；7 个签发点补 set-cookie（F8）；`:1204` 改为 cookie 优先、body 兼容；`:1222-1228` 登出、改密路径清 cookie |
| hub | `src/api.ts:44,810` | 微信一次性交接 cookie 可删（改为直接下发续期 cookie） |
| hub | `src/relay.ts` | **不需要改**（F15 已只放行 `rdsh_gate`） |
| portal | `src/api.ts:14-45,48-54` | `silentRefresh()` 改 `credentials:"include"` 空 POST，去掉 sessionStorage 读写；`redirectToLogin()` 去掉 remove |
| portal | `src/main.tsx:9-19` | 删除 `rdsh_wechat_refresh` 交接 |
| portal | `src/pages.tsx:499,525,532,1730` | 删除 `setItem`（**保留** `:1436-1437` 登出与 `:1632` 改密处的清理语义，改为服务端清 cookie） |
| 测试 | hub 侧的 `set-cookie` 断言、portal 侧 `REFRESH_KEY` 用例 | 同步更新 |

**必须保留的既有约束**：门户的**单飞续期**（`refreshPromise` + 8 秒超时，`packages/portal/src/api.ts:13-45`）——轮换会让旧令牌立即失效，并发续期必须仍只发一次；本次只换传输方式，这段逻辑原样保留。

**兼容 / 回滚**：续期接口"cookie 优先、body 回退" ⇒ 可**先发 hub、后发 portal**，不打断在线用户；旧会话里的 `sessionStorage` 令牌在下次登录前仍可用；回滚 = 直接回退该提交。

**安全边界（如实说明）**：不防"设备/浏览器配置被他人取得"（现状同样如此，且现状令牌已交给 JS）；用户手动清站点数据/重装仍需重登，属预期。

### 4.2 方案②（次选）：`sessionStorage` → `localStorage`

- 改动：F12 列出的 **11 行引用**（`api.ts:15/33/49`、`main.tsx:13`、`pages.tsx:499/525/532/1730/1436-1437/1632`）。
- 优点：不动服务端，跨页面重建/跨 App 重启都在。
- 代价：续期令牌暴露给页面 JS（XSS 可窃取），安全性低于①；且仍解决不了"清站点数据即登出"。

### 4.3 方案③（独立小坑，建议一并修）：`/login` 已登录时跳走

`packages/portal/src/pages.tsx:67` —— 已登录访问 `/login` 时跳 `/hosts`。治的是"把登录页存成网址""历史栈回退到登录页（F18）"造成的**假掉线**；与①/②不冲突。

### 4.4 方案④（治标，**不推荐**作为主方案）：访问令牌 1 小时 → 7 天

- 改动仅两处，但**必须成对**：`packages/hub/src/auth.ts:54`（`ACCESS_TTL_MS`）+ `packages/hub/src/api.ts:1473-1475`（写死的 `Max-Age=3600`）。
- 代价：访问 JWT 从"1 小时可自然失效"变成"**7 天不可撤销**"（只有改密 `ver+1` 能踢）；既然访问票能活 7 天，续期轮换/单会话吊销就失去意义；一张被拷走的 cookie 即 7 天通行证。
- 定位：可作**临时止血**（例如当天要出包），主方案仍应为①。

### 4.5 对比

| | ① HttpOnly 续期 cookie | ② localStorage | ④ 访问票 1h→7d |
|---|---|---|---|
| 跨页面重建 / 跨 App 重启 | ✅ | ✅ | ✅ |
| JS/XSS 可读走 | ❌ | ✅ | ❌ |
| 可吊销 / 可轮换 | ✅ | ✅（令牌可能已被窃） | ⚠️ 仅改密 |
| 服务端改动 | 需要（hub 重部署） | 不需要 | 需要（两处常量） |
| 失效窗口 | 1 小时 | 1 小时 | **7 天** |

---

## 5. 附带发现（独立隐患，建议另修）：hub 与 gateway 同名 cookie `rdsh_session`

| # | 事实 | 证据 |
|---|---|---|
| **C1** | hub 的门户会话 cookie 名 = `rdsh_session`（`Path=/; HttpOnly; SameSite=Lax`） | `packages/hub/src/api.ts:33`、`:1473-1475` |
| **C2** | gateway 自己的准入会话 cookie **同名同属性** | `packages/gateway/src/session.ts:14`、`:93-96`；签发于 `packages/gateway/src/server.ts:284`、`:333` |
| **C3** | hub 中继对 host 响应**纯透传** ⇒ host 侧任何 `Set-Cookie` 都会落到 hub 的 origin 上 | `packages/hub/src/relay.ts:88-104` |
| **C4** | 本次链路**不触发**：hub→host 只放行 `rdsh_gate`，且宿主侧是 join 隧道（`rdsh_gate`）而非独立 gateway | `packages/hub/src/relay.ts:169-183`；`packages/gateway/src/join.ts:494`、`src/access-gate.ts:11` |

**触发条件（一旦成立即互相顶替）**：同一 origin 同时暴露 hub 门户与**独立 gateway**（`rdsh host setup lan|cloud`，默认 `authMode="pair"`，`packages/gateway/src/server.ts:110`）的配对/密码登录页。症状与本次报告一致：进主机页 → 回门户被要求重新登录；反向亦然。

**建议**：改 **gateway 侧**名称 `rdsh_session` → **`rdsh_gateway_session`**（语义 = "gateway 自己的准入会话"；与 `rdsh_gate` / `rdsh_host` 同族）。
- 理由：hub 的 `rdsh_session` 是**对外契约**（`packages/hub/API.md:6`、`:111` 明确写明，`hub/test/api.test.ts`、`multi-tenant.test.ts`、`relay-d12.test.ts` 均以它为准），gateway 侧仅在 `src/session.ts` 与 2 个测试中出现；两边都是 HttpOnly，**无任何前端 JS 依赖名字**。
- 改动点：`packages/gateway/src/session.ts:14`（常量）、`:93-96`（`cookieHeader`）、`:104-112`（`sessionTokenFromCookie`）；`packages/gateway/test/session.test.ts:75,79`、`packages/gateway/test/server.test.ts:113`。
- 过渡：先认新名、再认旧名（兼容一个版本），登录/配对成功时顺手清旧名（`rdsh_session=; Path=/; Max-Age=0`），避免老用户重新配对。

---

## 6. 待决策 / 未验证 / 不做

| # | 事项 | 类型 | 说明 |
|---|---|---|---|
| **D1** | 选①还是②（或①+③） | **待用户决策** | 建议 ① + ③；④ 仅在需要当天止血时使用 |
| **D2** | 只读日志实验（go/no-go 依据） | 未做 | 在 garsync `lib/rdsh/` 加 `kDebugMode` 门控日志：当前 URL + cookie **名**集合（`WebViewCookieManager().getCookies(url)`，HttpOnly 可见）+ `sessionStorage` key 集合（**不打印任何令牌值**）。一次复现即可确认"回退到登录页时 `rdsh_session`/`rdsh_refresh`/`sessionStorage` 三者的存在性" |
| **D3** | §1.3 的 1 小时复现 | 未做 | 用来确认"仅在 >1h 后复现"这一预测 |
| **D4** | App 杀掉重启后的 cookie 落盘 | 未验证 | 标准行为支持，但未实测；可与 D3 合并验证 |
| **D5** | §5 改名是否随本轮一起做 | 待定 | 与本症状无因果，但同属会话 cookie 设计债 |
| **D6** | garsync（App）侧动作 | **无** | 无代码可改：F20（禁止注入凭证）+ X3（无清理代码）。App 侧唯一可做的是 D2 的**只读诊断日志** |

---

## 7. 证据来源（跨仓索引）

**remote-dsh**

- `packages/hub/src/api.ts`：`:33`（cookie 名）、`:44`/`:810`（微信交接）、`:65-82`（`authenticate`）、`:515`/`:519`（refresh/logout 路由）、`:809`/`:882`/`:999`/`:1022`/`:1198`/`:1215`/`:1681`（签发点）、`:1204`/`:1208`（续期读 body）、`:1222-1228`（登出清 cookie）、`:1473-1475`（`sessionCookie`）、`:1477-1480`（可信设备）
- `packages/hub/src/auth.ts`：`:54-55`（TTL）、`:141-155`（`ver` 变动条件）、`:162-173`（签发+轮换）、`:201-206`（改密吊销）
- `packages/hub/src/server.ts`：`:84`、`:108`、`:242-243`、`:290-320`（`rdsh_host`、portal 分支清 host cookie、进主机）
- `packages/hub/src/relay.ts`：`:29`、`:44`、`:88-104`、`:169-183`
- `packages/hub/API.md`：`:6`、`:111`
- `packages/hub/test/relay-d12.test.ts`：`:6-30`
- `packages/portal/src/api.ts`：`:5-6`、`:13-45`、`:48-54`、`:126-145`
- `packages/portal/src/main.tsx`：`:5`、`:9-19`
- `packages/portal/src/pages.tsx`：`:19-22`、`:67`、`:499`、`:525`、`:532`、`:1436-1437`、`:1632`、`:1730`
- `packages/gateway/src/session.ts`：`:14`、`:93-96`、`:104-112`
- `packages/gateway/src/server.ts`：`:110`、`:284`、`:333`
- `packages/gateway/src/join.ts`：`:494`；`packages/gateway/src/access-gate.ts`：`:11`
- `packages/gateway/test/session.test.ts`：`:75,79`；`packages/gateway/test/server.test.ts`：`:113`

**garsync（App，仅作排除证据，无改动）**

- `lib/rdsh/rdsh_page.dart`：`:166-199`（`WebViewController` 初始化）、`:212-220`（`_loadWebContent`）、`:728-737`（`_handleBack` → `goBack`）
- `lib/rdsh/`（全目录）：无 `cookie` / `clearCookies` / `clearCache` / `clearLocalStorage` 命中
- `doc/feature/102_remote_dsh/req.md`：`:58`（禁止注入 Cookie/token）

---

## 8. 决议（2026-09-25）

| # | 事项 | 决议 | 依据 |
|---|---|---|---|
| **D1** | 方案选择 | **① + ③**（续期令牌改 HttpOnly cookie + `/login` 已登录跳走） | ① 治本且**安全性优于现状**（令牌不再明文交给 JS）；② 安全性更低（XSS 可读 7 天令牌）；④ 牺牲安全性（7 天不可撤销）、仅作战术后备 |
| **D2** | 只读诊断日志实验 | **降级为可选** | 用户已确认"重新登录发生在门户登录 **>1 小时** 后" ⇒ 时序 + 机制自洽（`sessionStorage` 丢 ⇒ `silentRefresh()` 不发请求即判 `invalid` ⇒ `redirectToLogin`），D2 不再是 go/no-go 门槛 |
| **D3** | §1.3 的 1 小时复现 | **不再需要**（用户侧已直接确认同一结论） | 同上 |
| **D4** | App 重启后 cookie 落盘 | **并入验收项**（solution §7-2） | 标准行为支持；真机验证时顺带确认 |
| **D5** | §5 hub/gateway 同名 cookie | **改 hub 侧**：`rdsh_session` → **`rdsh_hub_session`**，**独立提交**（gateway 一行不动） | ① 中心部署改一次全体生效，改 gateway 需每台 host 逐个升级；② 经核实 hub 中继是**白名单**（`relay.ts:169-183` 与 cookie 名无关）⇒ 改 hub 名**无会话泄露风险**；③ 门户同源自动带 cookie、原生壳用 Bearer ⇒ **无前端依赖名字**；④「对外契约」的真实成本仅 `API.md:6/111` + 3 个 hub 测试；⑤ 对用户影响上限 = 历史会话重登一次 |
| **D6** | garsync（App）侧动作 | **无** | F20（禁止注入凭证）+ X3（无清理代码），App 无需改代码 |

**实现范围**：见 [solution.md](solution.md) —— A 根因修复（A1–A11）、B hub 改名（B1–B3）、C 协议先行（C1–C2）、D 测试（D1–D4）。
