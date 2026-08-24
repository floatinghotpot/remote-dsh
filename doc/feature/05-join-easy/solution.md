# 05-join-easy — 方案（solution.md）

> **日期**: 2026-08-24
> **状态**: 草稿
> **来源**: [discussion.md](discussion.md)（D1–D17）、[req.md](req.md)（R1–R12）；前置：04-cli-refactor（已实现）

---

## 1. Goal

用户级 join token（portal 自助生成）+ register 端点 + `host join` 交互注册免配对 + portal「添加主机」页。**命令面以 04 的 `rdsh host *` 为准。**

## 2. Facts（查档）

- 04 已落地：`rdsh host join <hub>`（`registerJoin`：token > 持久化 > 配对码 bind）、`host.json`（mode/hub/name/insecure/dshPath）、`self-revoke`、`saveConfig`、`readPersistedToken/clearPersistedToken`、服务名；
- hub `db.ts`：`hosts` 表 + `pending` 表；无 join_tokens 表；`randomToken(32)`、`sha256` 已备；
- hub `api.ts`：`handleBind`（pair-code → 建 host）、`handleRevokeHost`、`pendingRate`/`selfRevokeRate` 限流模式；`authenticate`（session）已备；
- gateway `join.ts`：`hubRequest`（已支持 body）、`registerJoin`（token 直填/持久化/bind）、`selfRevoke`；
- portal（React）：登录/host 列表/进入 DSH/改密/吊销已实现；无「添加主机」页、无 join-token 管理。

## 3. Gap

| 项 | 现状 | 目标 |
|---|---|---|
| 凭证来源 | 配对码（需浏览器输码）/ 无 portal 自助 | portal 生成 join token（多机复用、30 天、可吊销、哈希） |
| 注册 | `--token` 直填 = host token（不可从正常流程获得） | `--token` = join token → register 换 host token |
| portal | 无添加主机页 | 添加主机页 + token 列表/吊销 |

## 4. 任务

### 4.1 hub：join_tokens 表 + 端点

- `db.ts`：`join_tokens` 表 `(id, label, owner_id, token_hash, expires_at, revoked, created_at)` + `createJoinToken / listJoinTokens / getJoinTokenByHash / revokeJoinToken / pruneExpiredJoinTokens`；
- `api.ts`：
  - `POST /api/hosts/join-token`（需登录）`{label?, ttlSeconds?}` → 建 token（`randomToken(32)`，默认 30 天，1d/7d/30d/90d/1y）→ 返回 `{token, expiresAt}`（明文一次，服务端只存 sha256）；
  - `GET /api/hosts/join-tokens`（需登录）→ `[{id, label, expiresAt, revoked}]`；
  - `DELETE /api/hosts/join-tokens/:id`（需登录，owner）→ 吊销；
  - `POST /api/hosts/register`（未认证 + IP 限流）`{token, name?}` → 校验 join token（未吊销/未过期）→ 建 host（name 或 `host-xxxx`）→ 返回 `{hostId, hostToken}`；**对已是 host token 的输入幂等**（findHostByTokenHash → 返回 `{hostId, hostToken: token}`）；预留账号配额钩子；
- `server.ts`：注册路由。

### 4.2 gateway：`--token` 语义 = join token

- `join.ts`：`registerJoin` 的 `--token` 分支改为**调 register 端点**（`POST /api/hosts/register {token, name}` → 拿 hostToken）再持久化；新增 `register(hubUrl, joinToken, name, insecure)` helper；
- 交互：`host join <hub>` 无 `--token` 且无持久化且 TTY → **提示粘贴 join token**（读取一行），非 TTY 报错；
- 凭证解析顺序：`--token`(join token→register) > 持久化 host token > 配对码 bind。

### 4.3 CLI：service install --token

- `handleHostService install`：支持 `rdsh host service install <hub-url> --token <t> [--name <n>]` —— 先 `registerJoin`（注册 + 持久化）+ 写 host.json（mode join）+ 写 unit；无 `<hub>` 则走 04 的读 host.json 路径。

### 4.4 portal「添加主机」页 + token 列表

- 页面：机器名（占位 hostname）+「常驻服务」开关 + 有效期选择（默认 30 天）+「生成接入命令」一键复制 + 自签开关 + 未安装提示；命令 = `rdsh host join <hub> --token <t> [--name <n>]` 或 `rdsh host service install <hub> --token <t> [--name <n>]`；
- join-token 列表：label/到期/吊销；明文只显示一次（生成后刷新消失）。

### 4.5 测试 + 文档

- 单测：join_tokens CRUD、register（有效/过期/吊销/幂等/限流）、join token 哈希断言、service unit 无 token；
- e2e：hub + `host join --token` 注册 + 重启复用 + 吊销回退；
- 文档：usage.md、README、CHANGELOG。

## 5. 待定

- portal「生成命令」的 hub URL 来源（portal 自身 origin）；自签开关是否保留（04 证书自动检测后或可移除）；
- register 的账号配额钩子（留注释/结构，不实现）。

*关联文档：discussion.md | req.md | 前置：04-cli-refactor（solution.md）*
