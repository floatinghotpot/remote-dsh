# 04-cli-refactor — 方案（solution.md）

> **日期**: 2026-08-24
> **状态**: 草稿，**待批准**
> **来源**: [discussion.md](discussion.md)（D1–D9）、[req.md](req.md)（R1–R12）

---

## 1. Goal

把 CLI 从「动词/组件混排」重构为**组件化命令树**（`rdsh host *` vs `rdsh hub *`），并把 host 侧配置统一为 `~/.rdsh/host.json`（3 模式），加 self-revoke、证书自动检测、服务名对齐。

## 2. Facts（查档，2026-08-24）

### 2.1 CLI 现状（`packages/cli/src/bin.ts`）

- `main()` 顶层分发：`serve / join / hub / user / service`（`switch`）；
- `parseGlobal` 剥 `--config`；`parseServeArgs`/`parseJoinArgs`/`parseHubServeArgs` 手写解析；
- `handleUser`（gateway 用户）、`handleService`（serve 服务化）、`handleHub`（hub 分发：serve/user/host/service）、`handleJoinService`（join 服务化，已支持 `--dsh`/`--insecure`）；
- 顶层 `--help`/`SUB_HELP` 文案。

### 2.2 配置现状（`packages/gateway/src/config.ts`）

```ts
RdshConfig { host, port, sessionTtlSeconds, tls?, behindProxy, allowFrom, auth{mode,pairCode,version,users}, dshPath? }
DEFAULT_CONFIG_PATH = ~/.rdsh/config.json
resolveConfigPath(cliPath?, env) = cliPath ?? env.RDSH_CONFIG ?? DEFAULT_CONFIG_PATH
loadConfig(path)  // 不存在返回默认；校验
```

### 2.3 服务化现状（`packages/gateway/src/service.ts`）

- 已是 `ServiceSpec {name, args, configPath?, envFile?}` + `installService(spec)` / `serviceStatus(name)` / `uninstallService(name)`（**契约已就绪，无需改签名**）；
- `SERVICE_NAME="rdsh"`、`JOIN_SERVICE_NAME="rdsh-join"`；unit 路径/日志按 name 生成。

### 2.4 join 现状（`packages/gateway/src/join.ts`）

- `JoinOptions {hubUrl, token?, reset?, dshPath?, insecure?}`；`join()` 已含 token 持久化、fail-fast、WS text 帧；
- **证书**：`new WebSocket(url, {rejectUnauthorized: !insecure})` —— 尚未自动回退；
- **`--name`**：JoinOptions 无 name 字段（05 才用，但 04 先加字段/参数占位）。

### 2.5 hub 现状（`packages/hub/src/{api,server,db}.ts`）

- `handleRevokeHost`（需用户 session）删除 host + 断隧道 + 推送 offline；**无 self-revoke**（host 持 token 自注销）；
- `handleTunnelUpgrade` 用 `findHostByTokenHash(sha256(token))` 认证；
- 未认证端点限流：`PENDING_RATE_LIMIT`（10 次/分钟/IP）已有，可复用。

## 3. Gap

| 项 | 现状 | 目标 |
|---|---|---|
| 命令面 | 顶层 `serve/join/user/service` 混排 | `rdsh host {setup lan\|cloud, join, serve, service, leave, user}` + `rdsh hub *` |
| 配置 | `config.json`（单一 serve 配置，无 mode） | `host.json`（`mode: lan\|cloud\|join` 三态）+ 旧文件自动迁移 |
| 服务名 | serve/hub 共用 `rdsh.service`，join 用 `rdsh-join` | `rdsh-host` / `rdsh-join` / `rdsh-hub` 三独立 |
| 证书 | join 需手传 `--insecure` | join 自动检测并持久化 `insecure` |
| 注销 | 只能 portal 吊销 | `rdsh host leave` → self-revoke |

## 4. Call-site 审计（契约变更波及面）

| 变更 | 波及调用点 | 分类 |
|---|---|---|
| `config.ts`：`RdshConfig`→`HostConfig`（+`mode`、join 字段），`DEFAULT_CONFIG_PATH`→`~/.rdsh/host.json`，`loadConfig` 加迁移 | `serve.ts`(serve)、`bin.ts`(parseServeArgs→ServeOptions、UserManager、installService)、`test/config.test.ts`、`test/server*.test.ts` | 兼容改造（字段增/改名，默认路径改） |
| `bin.ts` 顶层命令移除 | `doc/blog/*`、`doc/overview/usage.md`、`README`、`spike/e2e-*.sh` | 文档/e2e 同步 |
| `service.ts` 服务名：新增 `HOST_SERVICE_NAME="rdsh-host"`、hub 用 `"rdsh-hub"` | `bin.ts`（serve/hub 的 installService 调用传 name）、`test/service.test.ts` | 传参改 |
| `join.ts`：`JoinOptions` + `name`；证书自动检测 | `bin.ts`(parseJoinArgs→handleJoin)、`test/`（新增） | 增字段/逻辑 |
| hub `api.ts`：新增 self-revoke | `server.ts`（路由）、`db.ts`（复用 removeHost）、`test/api.test.ts` | 新增端点 |

## 5. Tasks（实现清单）

### 5.1 config（host.json + 迁移）
- `config.ts`：定义 `HostMode = "lan"|"cloud"|"join"`、`HostConfig`（= 原 RdshConfig + `mode` + `hub/name/insecure`）；`DEFAULT_HOST_CONFIG_PATH = ~/.rdsh/host.json`；`loadHostConfig` 读取并**迁移**：文件无 `mode` 字段 → 按 `tls 存在 || auth.mode==="password"` 推断 `cloud`，否则 `lan`，写回 host.json（原文件保留）；`resolveHostConfigPath`（`--config` > `$RDSH_HOST_CONFIG` > 默认）。

### 5.2 CLI 命令树（`bin.ts` 重写分发）
- 顶层：`serve/join/user/service` 移除 → 新增 `host` 分发（`handleHost`），`hub` 保持；
- `handleHost`：`setup lan|cloud`（交互向导写 host.json）、`join <hub>`（注册→写 host.json+session，退出）、`serve`（读 host.json 按 mode 分发）、`service install|status|uninstall`（读 mode 装对应服务）、`leave`（self-revoke + 清理）、`user ...`；
- help/SUB_HELP 全量更新。

### 5.3 serve 分发 + join 增强
- `serve.ts` 复用（standalone）；新增「按 mode 分发」入口（`serve`/`join` 二选一，`mode: join` → 调 `join()`，否则 `serve()`）；
- `join.ts`：`JoinOptions` + `name`；`host join` 无 token 且无 session 时**交互提示粘贴 token**（TTY 检测，非 TTY 报错）；证书自动检测：连接失败且为证书错误 → 以 `insecure:true` 重连并写回 host.json（打印提示）。

### 5.4 服务名对齐（`service.ts` + `bin.ts`）
- `service.ts`：新增 `HOST_SERVICE_NAME="rdsh-host"`；hub 的 install 传 `name:"rdsh-hub"`；join 传 `JOIN_SERVICE_NAME="rdsh-join"`。

### 5.5 self-revoke（hub）
- `api.ts`：`POST /api/hosts/self-revoke {token}` —— 未认证 + IP 限流；`findHostByTokenHash` 校验 → `removeHost` + 断隧道 + offline 推送；复用 `handleRevokeHost` 逻辑抽公共函数。
- `server.ts`：注册路由 `/api/hosts/self-revoke`。

### 5.6 测试 + 文档
- 单测：config 迁移、host.json 3 模式、service 服务名、self-revoke 限流、证书检测、CLI 解析；
- e2e：`spike/e2e-*.sh` 命令更新；`usage.md` §8 / 博客 / README 命令同步。

## 6. 待定（实现中可微调）

- `setup lan/cloud` 交互提问项与默认值；
- 证书错误 vs 网络错误的判定方式（`error.code` 如 `CERT_HAS_EXPIRED`/`UNABLE_TO_VERIFY_LEAF_SIGNATURE` 等）；
- 迁移是否删旧 `config.json`（本次：保留，不删）。

*关联文档：discussion.md | req.md | 下一步：plan.md（待 solution 批准后）*
