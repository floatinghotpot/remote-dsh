# Bug 报告：hub portal 内 DSH 界面不显示 API key 粘贴框（onboarding 提示缺失）

> **日期**: 2026-08-24
> **严重度**: P1（功能缺口 —— **阻塞 join-easy 的「API key 由 DSH 自管、rdsh 无需配置」简化目标**；无安全漏洞；workaround：本机粘贴或主机侧 env）
> **影响组件**: rdsh relay/portal 数据面（`packages/hub/src/relay.ts`）+ DSH 前端（`@deepseek-ai/dsh-client-ui-settings-models`，第三方，不可改）
> **发现环境**: 经 hub portal 进入 DSH（`/h/<hostId>` iframe 透传）；主机侧 DSH 未配置 API key
> **来源**: 用户生产观察：本地打开 `dsh web` 时无 key 会显示粘贴框；经 hub portal 打开同一 DSH 不显示
> **性质**: 第三方 DSH 前端行为在 rdsh 透传链路上的表现差异（根因可能在本方或 DSH 侧）

---

## 1. 现象（症状）

- 主机上 DSH 未配置 API key（未设 env）时，**本机浏览器**打开 `dsh web`：界面显示「粘贴 API key」的输入框（DSH 自带 onboarding，**由 DSH 管理，不是 rdsh 功能**）；
- 同一台 DSH **经 hub portal 进入**（`/h/<hostId>/` 302 → 根路径 → 隧道透传）：**该粘贴框不出现**，用户无法在远程界面直接粘贴 key，只能 SSH 到主机配 env（当前体验复杂）。

## 2. 复现步骤

1. 主机运行 `dsh web`（不设 `DEEPSEEK_API_KEY`）；
2. 本机浏览器打开 `http://127.0.0.1:<port>` → 应出现 API key 粘贴框（对照）；
3. 经 hub portal 进入同一 host（`/h/<hostId>/`）→ 观察：无 API key 粘贴框。

## 3. 机制（DSH 前端源码事实，`dsh-client-ui-settings-models`）

**粘贴框显示条件**：`onboardingReadiness(state)` 仅当返回 `credential-missing` 时显示，需**全部**满足：

```js
function onboardingReadiness(state) {
  if ((idle||loading) && rows.length===0) return { kind: "loading" };
  if (state.status === "error") return { kind: "unavailable", reason: "load-failed" };   // ← RPC 失败则不显示
  if (rows.some(providerUsable)) return { kind: "provider-ready" };
  // 找 deepseek-official / llm-deepseek 行
  if (row === undefined) return { kind: "adapter-absent" };
  if (!row.entry.active) return { kind: "unavailable", reason: "provider-inactive" };
  if (credentialError !== null || row.credential === undefined) return { kind: "unavailable", reason: "credentials-unavailable" };
  if (!state.writable) return { kind: "unavailable", reason: "settings-read-only" };      // ← writable=false 则不显示
  if (!row.credential.writable) return { kind: "unavailable", reason: "credential-read-only" };
  return { kind: "credential-missing" };                                                  // ← 显示粘贴框
}
```

状态来源（`store.js`）：`api.llm.providers({})` + `credentials.describe({refs})` 两个 RPC（经 events.mux WebSocket，text/JSON）；`writable` 由 hosts 侧 settings 快照给出。

**结论**：经 hub portal 不显示 = 以下分支之一触发：
- `load-failed`（两个 RPC 之一经隧道失败/报错）；
- `settings-read-only` / `credential-read-only`（`writable` 经隧道变 false）。

**待验证（需线上复现区分）**：打开经 portal 的 DSH，看 Models 页面/网络面板，判断是 RPC 报错还是 read-only。

## 4. 影响

| 项 | 影响 |
|---|---|
| 远程首用 | 新装 DSH（无 key）经 hub 无法远程粘贴 key，必须先 SSH/本机配 env —— 与「join-easy」的远程接入体验目标冲突 |
| 范围 | 仅影响「未配置 key 的 DSH 经 hub 访问」场景；已配置 key 的主机无感 |
| 安全 | 无（粘贴框只是输入 UI；key 走加密通道） |

## 5. 修复方向（候选 + 推荐）

### 方案 A（推荐，先定位再修）：复现并定位失败分支

1. 复现：无 key 的 DSH + hub + join + 浏览器经 portal 进入；在 DevTools 看 `llm.providers` / `credentials.describe` 的响应与 `writable`；
2. 若 `load-failed` → 查 relay 对该 RPC（WS 帧/JSON 大小/特定字段）的透传是否破坏（对齐既往 WS text 帧修复）→ 我方修复；
3. 若 read-only → 查 writable 判定来源（DSH 侧配置/环境）在透传链路上是否被改 → 决定我方还是 DSH 侧问题。

### 方案 B（缓解，不依赖根因）：文档 + join-easy 联动

- 在「添加主机」/portal 进入页提示：未配置 API key 的主机需先在主机侧配置（env 或 `~/.dsh` 配置），或经本机 UI 粘贴一次；
- 与 `05-join-easy` 的「API key 配置简化」需求联动（见 §7）。

## 6. 验收标准

1. 复现定位：确认是 `load-failed` 还是 read-only 分支（附 DevTools 证据）；
2. 若为本方问题：修复后无 key 的 DSH 经 hub portal 能显示 API key 粘贴框并成功粘贴生效；
3. 回归：已配置 key 的 DSH 经 hub 访问行为不变；本机访问不受影响。

## 7. 关联

- **策略（2026-08-24 定案）**：**修复本 bug = 简化 API key 配置** —— 经 portal 能显示粘贴框后，DSH 自行管理 key（粘贴一次、持久化），rdsh join 无需任何 key 配置（不再需要 join.env / DEEPSEEK_API_KEY 注入）→ 本 bug 是 `05-join-easy` 的核心前置；
- **相关需求**：`05-join-easy`（D17：API key 归 DSH 管理）
- **相关修复**：`77446c8`（WS text 帧 —— events.mux 依赖，若本次为 RPC 透传问题则同域）
- **代码**：`packages/hub/src/relay.ts`（透传）、`packages/gateway/src/join.ts`（隧道转发）、DSH 前端 `@deepseek-ai/dsh-client-ui-settings-models`（不可改，事实源）
- **DSH 事实核查源**：`~/.nvm/versions/node/v22.23.2/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-models/lib/client.js`
