# Fix Record: 会话过期后 portal 卡死「加载中…」（无续期机制）

> **日期**: 2026-08-30
> **严重度**: P1（阻塞性体验——会话过期即卡死，用户只能手动重新登录）
> **涉及**: `packages/portal/src/api.ts`（`jsonFetch` + 静默续期）、`packages/portal/src/pages.tsx`（落地页探测 / `ERROR_ZH`）
> **现象上报**: 「`← rdsh 返回` 无响应」「页面一直加载中」

---

## 1. 问题描述

hub 会话为双令牌：access（JWT，httpOnly cookie，**1h**）+ refresh（sessionStorage，7d，轮换）。portal 此前**没有任何续期逻辑**：

- access 1 小时后过期 → 下一次 API 调用返回 401；
- `jsonFetch` 直接抛 `UNAUTHORIZED` → 页面只显示错误横幅，`loading` 永远不置 false → **页面无限转圈**（「加载中…」）；
- 用户感知 = 「点了没反应 / 卡死」，只能手动跳登录页重新登录。

## 2. 影响

- 所有受保护页面（我的主机 / 账户 / 添加主机 / 计费等）在 access 过期后全部卡死；
- 移动端（iPhone Safari）下尤其明显：定时器/网络抖动使续期窗口更易出现挂起。

## 3. 根因（代码事实 + 生产日志证据）

| 事实 | 出处 |
|---|---|
| `ACCESS_TTL_MS = 1h`，access 为无状态 JWT | `packages/hub/src/auth.ts:54` |
| portal 从不调用 `api.refresh()`，access 过期无任何续期 | `packages/portal/src/api.ts`（`refresh` 已定义但零调用） |
| `jsonFetch` 401 → 直接 `throw`，页面 `loading` 不置 false | `packages/portal/src/api.ts`、`pages.tsx` `HostsPage.load` |

**日志证据**（用户 iPhone `111.55.35.210`）：
```
06:18:36  index-DIqrZB5m.js（旧版）→ GET /api/hosts 401 → 卡「加载中…」（旧 bug 现场）
06:24:18  index-NIsbTNbl.js（初版 silent refresh 上线）
06:41–06:59  无任何 /portal 请求 —— 用户点「← 返回」无请求产生（网络抖动 + refresh 无超时 → 挂起）
07:00+  回退后一切正常
```

**初版 silent refresh 的两个缺陷**（本次审计定位）：
1. **`silentRefresh` 无超时**：`fetch("/api/auth/refresh")` 无 `AbortController`，网络抖动时永久挂起 → `jsonFetch` 永远等待 → 「无响应」；
2. **失败不分级**：refresh 的 401（令牌真过期）与网络超时（瞬时抖动）统一 `location.assign` 踢登录，误登出。

## 4. 修复方案（P0，最小正确集）

**契约不变，客户端集中续期**：

1. `api.ts` 新增 `silentRefresh()`：单飞 + **8s 超时**（`AbortController`），返回分级结果 `"ok" | "invalid" | "transient"`；
2. `jsonFetch` 401 处理：
   - `ok` → 重试原请求一次；
   - `invalid`（refresh 401/403 = 令牌真过期）→ 清 refresh → 整页跳 `/portal/login?next=<原路径>`（`probe` 除外）；
   - `transient`（网络/超时/5xx）→ **不跳登录**，抛 `REFRESH_FAILED`，页面提示「会话续期失败（网络异常），请稍后重试」；
3. `probe` 语义修正：公开页登录态探测（落地页 `accountInfo`）401 时**仍先尝试续期**，续期成功算已登录、失败才算未登录；只是不跳转；
4. `Login` 支持 `?next` 回跳（只接受站内 `/` 开头相对路径，防开放跳转）；
5. `ERROR_ZH` 新增 `REFRESH_FAILED` 文案。

## 5. 验证

- `pnpm --filter rdsh-portal build` + `pnpm --filter rdsh-hub build`（tsc strict 全绿）；
- 三种场景（浏览器）：
  1. 删 `rdsh_session` cookie（模拟 1h 过期）→ 操作 → 静默续期，不跳转；
  2. 再删 `sessionStorage.rdsh_refresh` + cookie → 操作 → 跳登录页（令牌真失效）；
  3. 断网点操作 → 显示「会话续期失败（网络异常），请稍后重试」，不跳不卡。

## 6. 不做 / 后续（Out of Scope）

- **P1 主动续期（定时器提前 refresh）挂起**：`setTimeout` 在 iOS Safari 会被挂起，移动端不可靠；且 P0 已把残余成本降到每小时一次几百毫秒的 401 往返，收益极薄。
- **跨标签并发轮换边界**：refresh 在 sessionStorage（每标签页独立），多标签同时 refresh 同一 token 会因轮换导致后到者 INVALID。已知边界，暂不处理（当前单用户单标签为主场景）。
- 备选「活跃时续期」（`visibilitychange`/`focus` 检查 exp）如需进一步抠掉那几百毫秒可再做，优先级低。
