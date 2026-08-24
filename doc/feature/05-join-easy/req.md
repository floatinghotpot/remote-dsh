# 05-join-easy — 需求（req.md）

> **日期**: 2026-08-24
> **状态**: 草稿，**待用户批准**
> **范围**: join 接入体验 —— portal 自助生成**用户级 join token**、`host join` 交互注册免配对、`service install --token`、portal「添加主机」页；**前置依赖：04-cli-refactor（命令树 `rdsh host *` + host.json）**
> **来源**: [discussion.md](discussion.md)（D1–D17 定案）；用户拍板：token=用户级认证凭证、账号层配额留钩子、TTL 30 天默认可配、`host join` 交互粘贴 token、主机名默认 hostname 可改、不做「已注册 N 台」、插件只留钩子
> **命令面**: 遵循 04-cli-refactor 新树（本文命令写作 `rdsh host join <hub>` / `rdsh host service install`，即原 `rdsh join` / `rdsh join service install` 在新树下的形态）

---

## 1. 目标

消除「配对码必须有人在浏览器前输码」与服务化/headless 部署的矛盾，让接入一台新主机变成「portal 生成 → 机器上粘贴」两步：

```
hub portal「添加主机」→ 生成 join token（用户级，可注册多台）
  → 机器上：rdsh host join <hub>（交互粘贴 token / --token）→ 注册 → session 落盘
  → rdsh host serve（前台）或 rdsh host service install（常驻）→ 重启免配
```

- join token = **用户级认证凭证**（属 owner 账号，可注册多台主机；次数限制在账号层——SaaS 时在 register 加钩子）；
- 首次注册成功后 host token 持久化，重启/服务化自动复用（**重启免配**）；
- 配对码流程**保留**（浏览器在场场景，`--code` 显式路径）；
- 安全底线：短效（默认 30 天）、可吊销、只显示一次、哈希存储；
- **API key 由 DSH 自管**（前置 paste-box 修复后），rdsh 无需配置 key。

## 2. 范围

### 2.1 包含（In Scope）

| 编号 | 需求 | 验收标准 |
|---|---|---|
| R1 | **join token 创建**（hub）：`POST /api/hosts/join-token`（需登录）`{label?, ttlSeconds?}` → 返回 `{token, expiresAt}`（**明文只显示一次**）；默认 30 天，可选 1d/7d/30d/90d/1y（上限 1 年）；服务端**只存 SHA-256** | 创建成功返回明文一次；DB 无明文（grep 断言）；过期时间正确；非法 ttl 拒绝 |
| R2 | **join token 列表/吊销**（hub）：`GET /api/hosts/join-tokens`（label/expiresAt/revoked）、`DELETE /api/hosts/join-tokens/:id`（吊销 → **只阻止未来注册**） | 列表正确；吊销后 register 用该 token 被拒；已注册主机不受影响 |
| R3 | **register 端点**：`POST /api/hosts/register {token, name?}`（**无 session**，持 token 认证，**IP 限流**对齐 pending）：校验 join token（未吊销/未过期）→ 在 owner 名下建 host（name 或回退 `host-xxxx`）→ 签发 host token → 返回 `{hostId, hostToken}`；**对已是 host token 的输入幂等返回**（兼容旧直填）；**预留账号配额检查点** | 注册成功返回 hostId+hostToken；重复用同一 join token 注册多台 host 均成功；host token 输入幂等；无效/过期/吊销 token 401；限流生效 |
| R4 | **join_tokens 表**（db）：`id/label/owner_id/token_hash/expires_at/revoked/created_at`；创建/吊销/列表/按哈希查询 | schema 正确；只存哈希 |
| R5 | **`rdsh host join <hub>` 交互注册**：无持久 session 时交互提示粘贴 join token（或 `--token`）、name 默认 hostname 可改（`--name`）、证书自动检测（04）→ 调 register → 持久化 host token（session 文件）→ 写 host.json（mode: join）→ **退出**；**非 TTY 且无 --token → 明确报错不 hang** | 交互全流程走通；非 TTY 报错；注册后 `host serve` 可起隧道 |
| R6 | **凭证解析顺序**：持久化 host token > `--token`（注册）> 配对码（`--code` 显式） | 重启复用 session 免配；吊销后 401 回退；`--code` 走配对码 |
| R7 | **`rdsh host service install <hub> --token <t> [--name <n>]`**：当场注册 + 持久化 session 后写 unit（unit **永不含 token**）；无 `--token` 则要求 session 已存在 | 一行接入常驻；unit 无 token；服务启动复用 session |
| R8 | **portal「添加主机」页**：机器名输入（占位提示 hostname）+「常驻服务」开关 + 有效期选择（默认 30 天）+「生成接入命令」**一键复制**；命令按开关生成 `rdsh host join <hub> --token … [--name …]` 或 `rdsh host service install <hub> --token …`；**明文只显示一次**；自签 hub 开关（命令带 `--insecure`——04 证书自动检测后此开关可移除）；未安装提示 `npm i -g remote-dsh`；join token 列表（label/到期/吊销） | 全流程：生成 → 复制 → 机器粘贴 → 注册 → portal 列表见 host 在线；刷新后明文消失 |
| R9 | **配对码保留**：现有 pending/bind 流程不删，`--code` 显式走 | `rdsh host join <hub> --code` 打印配对码 → 绑定成功 |
| R10 | **安全基线**：join token / host token 只存 SHA-256；register 与 join-token 创建端点限流；日志脱敏（不记明文 token）；**结构化审计事件**（token 创建/吊销、register 成功失败——M5 审计的输入） | 代码审查 + 测试：无明文落盘、无敏感日志、限流生效、事件可消费 |
| R11 | **join 核心可复用**（M4 钩子）：register/persist/connect 保持「数据进、进程出」干净接口（JoinOptions 数据、session 文件共享） | 代码审查：CLI/service/未来插件共用同一核心 |
| R12 | **文档**：usage.md §8、博客（zh/en）、README 更新（新命令 `rdsh host join` 等 + join token 流程）；CHANGELOG | 文档无旧命令残留；发布说明含升级指引 |

### 2.2 前置依赖（Prerequisites）

| 依赖 | 说明 |
|---|---|
| **04-cli-refactor** | 命令树（`rdsh host *`）、host.json、`--config`、证书自动检测、service 服务名对齐（`rdsh-join.service`）——05 建立其上 |
| **`doc/fix/20260824-portal-apikey-pastebox`（P1）** | 修复经 hub portal 显示 DSH API key 粘贴框 → API key 归 DSH 管理（D17）；若不修，05 其余功能不受影响，仅「API key 简化」目标不达成 |

### 2.3 不含（Out of Scope）

- ❌ 账号层主机数配额（SaaS 话题，register 仅留钩子，D2/D14）→ M5
- ❌ `rdsh hub join-token` CLI 建 token（本次 portal only，留作扩展）
- ❌ M4 插件 web UI 面板（仅留 D13 接口钩子）
- ❌ 邮箱验证 / 2FA / 审计后台（M5）
- ❌ 「该 token 已注册 N 台主机」统计（用户定案不做）

## 3. 端到端验收场景

> **场景**：hub 运营方 + 用户 + 两台无公网 IP 的机器。

1. **生成**：用户登录 portal →「添加主机」→ 填机器名 + 常驻服务开关 → 生成命令（一键复制）→ 明文只显示一次，列表出现 token（label/到期/吊销）。
2. **接入（交互）**：机器 A 粘贴 `rdsh host join <hub> --token <t>` → 注册 → `host serve` → hub 显示 A 在线；**重启 serve 复用 session 免配**。
3. **接入（服务化）**：机器 B `rdsh host service install <hub> --token <t> --name my-ecs` → 当场注册 → `rdsh-join.service` 启动 → hub 在线；unit 无 token。
4. **多机**：同一 token 在 A、B 均注册成功（各得独立 host token）。
5. **吊销**：portal 吊销 join token → 新机器 C 用该 token 注册被拒；A、B 已注册主机不受影响。
6. **过期**：过期 join token 注册 → 401。
7. **配对码回归**：`rdsh host join <hub> --code` → 配对码流程仍可用。
8. **API key**：无 key 的 DSH 经 hub portal 进入 → 显示粘贴框（依赖 paste-box 修复）→ 粘贴后 DSH 持久化，rdsh 未配置 key。

## 4. 验收执行方式

- 自动化：`node --test`（join_tokens CRUD、register 校验/幂等/限流、token 哈希断言、service unit 无 token）+ 本机双进程 e2e（hub + `host join` 注册 + 重启复用 + 吊销回退）
- 回归：04-cli-refactor 后全量 `pnpm test` + M3 e2e（配对码路径不受影响）
- 文档：`verification.md` 逐条对照 R1–R12 + RTTM

## 5. 待定项（留给 solution.md，不阻塞 req 批准）

- join_tokens 表与 register 端点的事务/并发（同 token 并发注册）
- portal 页组件结构与「生成命令」的 URL/自签检测逻辑
- register 幂等判定（host token vs join token 的分流实现）
- 结构化审计事件的具体格式（M5 消费方未定，先定义事件字段）

*关联文档：discussion.md | 前置依赖：04-cli-refactor（req.md）、doc/fix/20260824-portal-apikey-pastebox | 下一步：solution.md（待 req 批准后）*
