# 直连候选端点只有 raw 路径提供：plain 页永远拿不到 `__rdshDirectInfo`（discussion）

> **日期**: 2026-10-04
> **现象**: app 打 `[rdsh] direct: no __rdshDirectInfo (bootstrap not ready?)`，**看不到主机内网 IP / 候选列表**，于是不再自动切内网直连、一直走服务器转发。
> **结论**: **根因已由代码 + 真机日志双重坐实。** 网关给 **plain 与 raw 两条路径都注入了直连 bootstrap 脚本**，但 `/__rdsh/direct-candidates` 端点**只写在 `rawGate` 块内**（仅 raw dispatcher 生效）；plain dispatcher 不传 `rawGate` ⇒ 整块跳过 ⇒ 该请求被转发给 `dsh web` → **404** ⇒ 页面里 `window.__rdshDirectInfo` 永不赋值。
> **本项已修复并补回归测试**（§4/§6）。
> **关联**: [20261004-raw-authorize-per-stream](../20261004-raw-authorize-per-stream/discussion.md)（同一族：都是"raw 路径有、plain 路径没有"的**双路径不一致**问题）

---

## 1. 事实链（均带 `file:line` / 真机证据）

| # | 事实 | 证据 |
|---|---|---|
| **F1** | 直连 bootstrap 脚本由**两条路径都注入** | `join.ts:908-911`（plain：`RDSH_WEBVIEW_API + pageAuthorizeScript`）、`join.ts:963`（raw：`pageAuthorizeScript`）|
| **F2** | 脚本第二步是 `fetch("/__rdsh/direct-candidates")`，成功后写 `window.__rdshDirectInfo`，**失败静默**（`.catch(()=>{})`）| `packages/gateway/src/direct.ts` `directBootstrapScript` |
| **F3** | 该端点原先只在 `rawGate` 块内处理 | `join.ts:643`（块起点 `join.ts:628` `if (dio?.rawGate !== undefined)`）|
| **F4** | plain dispatcher **不传** `rawGate` ⇒ F3 整块被跳过 | `join.ts:905-912`（opts 只有 `jsPatch`/`gate`/`htmlInject`）|
| **F5** | 故 plain 页的该请求被**转发给 `dsh web`** → 404 | F3+F4（该路径无拦截即落入下游转发，`join.ts:673+`）|
| **F6** | **真机日志坐实用户在 plain 路径** | app 打 `[rdsh] agent-api: {"version":1,"methods":[…]}` —— 而 `window.__rdshWebViewApi` **只有 plain 路径注入**（`rdsh-webview-api.ts` + `join.ts:908`），raw 路径只注入 `pageAuthorizeScript` |
| **F7** | app 侧读取有重试（3×500ms），不是"读太早" | `rdsh_page.dart:392-397` |
| **F8** | 代码注释本就写明 plain 页"只取候选" ⇒ 是**实现漏了**，不是设计不要 | `join.ts:909` 原注释：*"页面授权 token 仅设口令时生成（无口令则跳过 raw 授权、**只取候选**）"* |
| **F9** | 网关那条 `rdsh webview api injected` 日志**不能**区分路径（对任何 htmlInject 都打一次）| `join.ts:715-717`（`adapterInjectionLogged` 每个 dispatcher 只打一次，措辞与 raw 路径实际注入内容不符）→ 本次一并修正（§4.3）|

### 1.1 故障链

```
① plain 页（无 E2EE）加载 → 网关注入直连 bootstrap 脚本（F1）
② 脚本：fetch("/__rdsh/direct-candidates")            （无口令时跳过 authorize，直接取候选）
③ 网关 plain dispatcher 无该端点（F3+F4）→ 转发给 dsh web
④ dsh web 不认识该路径 → 404
⑤ r.json() 抛错 → .catch() 静默吞掉（F2）
⑥ window.__rdshDirectInfo 永不赋值
⑦ app 三次重试后放弃 → 日志 "no __rdshDirectInfo"，无候选 IP（F7）
```

---

## 2. 影响

1. **plain 路径永久失去内网直连加速**：用户在内网时也会一直绕服务器转发（延迟/流量双输）；
2. **触发面比想象大**：只要 E2EE 没生效（**首次访问、清过 WebView 数据、重装、登出擦除**等 pin 丢失场景）就落在 plain 路径；
3. **表现隐蔽**：`.catch()` 静默 + 日志措辞误导（F9），排查时容易误判为"注入失败"或"读太早"；
4. **同一族问题**：与 [raw-authorize-per-stream](../20261004-raw-authorize-per-stream/discussion.md) 同源 —— **raw/plain 双路径能力不对齐**。

---

## 3. 根因

**能力（端点）只在一条路径上实现，而使用者（注入的脚本）在两条路径上都存在。**
且该端点会**泄露内网候选地址**并**签发一次性直连票**，所以不能简单前移 —— 必须待在各自路径的**口令校验之后**。

---

## 4. 修复

### 4.1 端点搬出 `rawGate` 块，改由独立开关控制

- 新增 `dio.directCandidates`（可选）：`makeInnerDispatcher` 的 opts 字段，语义 = "提供直连候选端点"；
- `rawGate` 语义**保持不变**（仍 = "启用 raw 门禁"），两者解耦；
- 端点处理移到 **raw 门禁块之后、plain 口令 gate 块之后** ⇒ 两条路径都能到，且**都在口令校验之后**（不泄露候选、不未授权签票）。

```ts
// raw 门禁（仅 raw dispatcher）
if (dio?.rawGate !== undefined && gate.accessCode !== null && !rawAuthorized) { …authorize 或 403… }

// plain 口令 gate（仅 plain dispatcher）
if (dio?.gate === true && gate.accessCode !== null) { …ws/http + challenge… }

// ★ 两条路径共用：候选 + 一次性票（在两道门禁之后）
if (dio?.directCandidates !== undefined && path.startsWith("/__rdsh/direct-candidates")) { …200 JSON… }
```

### 4.2 两个调用点都传入

| dispatcher | 传入 |
|---|---|
| `plainDispatcher`（`join.ts:933`）| `directCandidates: rawGate` |
| raw dispatcher（`join.ts:987`）| `directCandidates: rawGate`（原有 `rawGate` 保留）|

两者都直接复用现成的 `rawGate` 变量（形状 `{candidates, mintTicket}` 完全匹配），未新建对象。未配置 `direct` 时 `rawGate === undefined` ⇒ 端点不提供，行为与之前一致。

### 4.3 顺带修正误导日志

注入日志原先一律打 `rdsh webview api injected (window.__rdshWebViewApi v1)`，而 **raw 路径只注入直连 bootstrap、不含 WebView API** ⇒ 该文案在 raw 路径上是假的，**本次排查即被它误导**。改为按实际注入内容区分：

```
[rdsh] html inject: webview api + direct bootstrap (plain path)
[rdsh] html inject: direct bootstrap only (raw/E2EE path)
```

---

## 5. 验收标准（AC）

| # | 标准 |
|---|---|
| **AC1** | **plain 路径**：`/__rdsh/direct-candidates` 由网关**直接应答 200 JSON**（`{candidates, ticket}`），不再被转发给 `dsh web` |
| **AC2** | **设了口令时仍在门禁之后**：未带 cookie 的请求拿到 **challenge 页**（`text/html`），响应体**不含**候选地址与直连票 |
| **AC3** | **设了口令 + 正确 cookie**：能取到候选 |
| **AC4** | **raw 路径无回归**：仍先过 raw 门禁（未授权 → `CLOSE 403 raw stream not authorized`），授权后可取候选 |
| **AC5** | 未配置 `direct` 时行为不变（不提供该端点）|
| **AC6** | `pnpm --filter rdsh-gateway build` 零 issue；全量测试通过 |

---

## 6. 交付状态

| # | 事项 | 状态 |
|---|---|---|
| 1 | 源码：端点搬移 + `directCandidates` 开关 + 两处传入 + 日志修正（`packages/gateway/src/join.ts`）| ✅ **已完成** |
| 2 | 回归测试 `packages/gateway/test/join-direct-candidates.test.ts`（AC1/AC2/AC3）| ✅ **已完成** |
| 3 | `build` + 全量 `test` | ✅ **build 零 issue；165/165 通过**（原 162 + 新增 3）|
| 4 | 测试自证 | ✅ 临时移除 plain 的 `directCandidates`（等价修复前）→ **AC1/AC3 精确变红、AC2 仍绿** ⇒ 用例真锁住了该回归 |
| 5 | 版本 bump + `npm publish` | ⏳ 待产品方确认 |
| 6 | 真机复测 | ⏳ 待发版装机：app 日志应重新出现 `[rdsh] direct: N candidates: <ip>:<port>` |

---

## 7. 非目标

- **不**让 plain 路径支持 `/__rdsh/authorize`（那是 raw 专属：raw 不转发 cookie，plain 走 cookie gate）；
- **不**改 E2EE / pin / 直连票的既有语义与 TTL；
- **不**动 `patchLoopbackJs` 失效问题（属[独立维护项](../20261004-raw-authorize-per-stream/discussion.md) §7.1）；
- 超时/重试策略不变。
