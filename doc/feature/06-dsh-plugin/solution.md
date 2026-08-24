# 06-dsh-plugin — 方案（solution.md）

> **日期**: 2026-08-24
> **状态**: ✅ 已批准（2026-08-24，用户「start plan and implement」）
> **范围**: M4 —— `dsh-web-remote` 插件（`dsh plugin add` 即获 join）+ gateway `join()` 核心重构（no-spawn/可停止/事件化）
> **来源**: [req.md](req.md)（R1–R9）+ 查档（dsh 安装源码 + 本仓库 gateway/hub/cli）
> **前置**: 04-cli-refactor、05-join-easy 已落地；本方案在 req 批准后进入 plan.md

---

## 1. Goal（目标架构）

```
dsh plugin --profile default add dsh-web-remote
  → dsh web 进程加载 server 插件（Cordis Service，注入 connection + webServer）
     · ctx.connection.rpc.handle("/remote-access", …) 挂 connect/disconnect/revoke/state
       （DSH 唯一可扩展的插件 RPC 通道，自带 loopback 围栏，channel 非 /api）
     · 转发目标 = 127.0.0.1:ctx.webServer.port（本进程 dsh，no-spawn）
     · 复用 rdsh-gateway 的 startJoin / registerJoin / selfRevoke / lock
  → 浏览器加载 client 插件（dsh.client → lib/client.js，React settings 页）
     · connection.rpc.call("/remote-access","state",…) 轮询 1s → 四态 + 外部托管
     · call("connect"|"disconnect"|"revoke")
```

- gateway 侧把 `join()` 拆成 **`startJoin(target, opts, hooks) → JoinHandle`**（no-spawn、可停止、`onState/onLog`）+ 保留 `join()` 作 CLI 薄封装（spawn + 信号退出）。
- 新增 **pid 锁** `~/.rdsh/join.lock`（`pid+role`），CLI 与插件共享单身份铁律。

## 2. Facts（查档事实，2026-08-24）

### 2.1 DSH 插件机制（安装源码 `@deepseek-ai/dsh` v0.1.1-rc.2）

| 事实 | 出处 | 对本方案的含义 |
|---|---|---|
| 服务端 bundle：`"dsh": {"bundle": {"patch": "./cordis.patch.yml"}}` | dsh-base/headless/web-app package.json | 我们的包声明 `dsh.bundle.patch` |
| `cordis.patch.yml` = 顶层 YAML 数组，`- insert: - id / name / inject / config`；`name` 为 npm 包名或子路径 | 三个 bundle 的 cordis.patch.yml | 插入自写 server 插件行 |
| **客户端声明是 `dsh.client`（非 `dsh.bundle.client`）**：`{"inject":[…], "platform":"web"}` + `exports["./client"]` → `lib/client.js` | 198 个 manifest 全量核对 | **已修正 req.md/discussion.md 笔误** |
| 客户端扫描 `dsh-client-modules` 只认「已作为 loader 行挂载的包」 | dsh-client-modules/lib/index.js | 我们的包必须在 cordis.patch.yml 里有服务端行 |
| server 插件 = 导出 Cordis `Service` 子类（`super(ctx,"xxx")`、`static inject=[…]`） | dsh-settings-file、dsh-user-questions | server 半用 `Service` + `static inject=["connection","webServer"]` |
| client 插件 = tsdown 编译的 `window.__ModuleLoader__.load({id, factory})`，导出 `{apply, inject}`；UI 用 `ctx.slots.inject("settings.section",…)` + React | dsh-client-ui-settings-plugins/lib/client.js | client 半写同格式 factory + React slots |
| **插件 RPC 通道**：服务端 `ctx.connection.rpc.handle(channel, handler, {authority:"loopback"})`（channel 匹配 `/^\/[A-Za-z0-9._~-]+$/` 且**非 `/api`**，自带 loopback/Host 围栏，wire=POST `channel/endpoint` JSON envelope）；客户端 `connection.rpc.call(channel, endpoint, payload, signal)` | dsh-client-connection/lib/index.js + client.js | **命令 + 状态轮询的唯一可扩展面**；`/api` 是内置契约、外部不可扩展 |
| **`webServer` 服务**（`@deepseek-ai/dsh-host-webserver`）：`register({kind:"exact"\|"prefix", path, handler(req,res)})`、`registerUpgrade`、`tapIndex`、**`port`（实际监听端口）**、`host` | dsh-host-webserver/lib/index.js | **端口发现**（`port`）+ 原始路由/SSE 备选；命令不直接走它 |
| Cordis 服务消费注入：`static inject = ["typert"]` 后 `this.ctx.typert` | dsh-api-gateway/lib/index.js | server 半 `static inject=["connection","webServer"]` → `this.ctx.connection` / `this.ctx.webServer` |

### 2.2 hub 路由（本仓库 `packages/hub/src/server.ts`）

- `handleHttp`：**有 `rdsh_host` cookie → 全部根路径（含 `/api/*`）`handleRelay` 透传到 host**（L182–186）；无 cookie 才走 hub 自身 `handleApi`（L189）。
- → 插件面板经 hub 访问时，`/remote-access/*`（有 `rdsh_host` cookie）经隧道透传到 host 的 connection.rpc 路由；直连（loopback/LAN）直接命中。**两种访问路径下 RPC 通道都成立**。

### 2.3 gateway 现状（本仓库 `packages/gateway/src/join.ts` 等）

- `join(opts: JoinOptions): Promise<void>` 是 **CLI 形态**：`findDsh`→`spawnDsh`→target `127.0.0.1:<port>`→`registerJoin`→connect 循环→信号处理→`process.exit`+`keepAlive`（L153–451）。
- **唯一调用点**：`packages/cli/src/bin.ts:326`（`handleHostServe` join 分支）。
- 可复用：`registerJoin`（L113）、`selfRevoke`（L104）、`detectInsecure`（L52）、`token-store.ts`（read/persist/clear）、`config.ts`（load/save/normalize，join 字段 `mode/hub/name/insecure/dshPath` 已存在）。
- `ProxyTarget = {host, port}`（proxy.ts L12）；`rewriteHeadersForDsh` 已复用。
- gateway `index.ts` 已导出 join/registerJoin/selfRevoke/readPersistedToken/clearPersistedToken 等。

### 2.4 待 verify（进实现前补查）

- `@deepseek-ai/cordis` 是否在**公共 npm** 可安装（server 半 `Service` 的 peerDep 依赖它）。若否，server 半改用 `export {inject, apply}` 函数形态（Cordis 函数插件，不 import cordis 运行时，仅类型依赖）。
- `@deepseek-ai/schemastery`（可选，仅当 server 半要 Config schema；MVP 可不用）。

## 3. Gap（差距）

1. `join()` 无法「no-spawn、外部 target、可停止、状态事件化」——插件用不了。
2. 无 pid 锁（D5 档2：防同 hostId 双隧道 + 面板识别「外部托管」）。
3. 无插件包（server Service + client settings 页 + cordis.patch.yml）。
4. 无 server↔client 控制通道（状态查询 + 接入/断开/注销动作）。

## 4. Call-site Audit（共享函数契约变更）

`join()` 内部重构（拆 `startJoin`），但**保留 `join(opts)` 签名不变**：

| 符号 | 调用点 | 兼容性 |
|---|---|---|
| `join()` | `cli/src/bin.ts:326`（唯一） | ✅ 兼容：签名不变，内部改 spawn+`startJoin(role:"cli")` |
| `registerJoin()` | `bin.ts:307/376`、`join.ts:162` | ✅ 不动 |
| `selfRevoke()` | `bin.ts:397` | ✅ 不动 |
| `readPersistedToken/clearPersistedToken` | `bin.ts:296/393/400` | ✅ 不动 |
| **新增** `startJoin`/`JoinHandle`/`JoinHooks`/`JoinState`/lock | 无既有调用点 | ✅ 纯增量导出，零破坏 |

## 5. Tasks（文件改动清单）

### 5.1 gateway 核心重构（`packages/gateway/`）

**T1 — `src/join.ts` 拆出 `startJoin`**（改现有 L153–451 的 `join()`）
- 新增类型与函数（导出）：
  ```ts
  export type JoinState = "connecting" | "connected" | "reconnecting" | "rejected" | "stopped";
  export interface JoinHooks {
    onState?(state: JoinState, detail?: { message?: string; delayMs?: number }): void;
    onLog?(level: "info" | "warn" | "error", message: string): void;
  }
  export interface StartJoinOptions {
    hubUrl: string; token: string; insecure: boolean;
    target: ProxyTarget;            // 外部 target，不 spawn
    role: "cli" | "plugin";         // pid 锁 role
    hooks?: JoinHooks;
  }
  export interface JoinHandle { stop(): Promise<void>; }
  export function startJoin(opts: StartJoinOptions): JoinHandle;
  ```
- 把现 `join()` 的「connect 循环 + 心跳 + 退避重连 + token-rejected 处理」搬进 `startJoin`；`console.log` → `hooks.onLog`/`hooks.onState`；`process.exit`/`dsh.stop`/信号注册**移除**（留给调用方）。
- `stop()`：设 `shuttingDown`、清 heartbeat、关活跃 WS/http 流、`releaseJoinLock()`，**不** `process.exit`。
- 保留 `join(opts)`：`findDsh`+`spawnDsh` → `startJoin(..., target:{127.0.0.1,dsh.port}, role:"cli")` → 注册信号 → `handle.stop()` 后 `dsh.stop()`+`process.exit`。行为等价 CLI。

**T2 — 新增 `src/lock.ts`**（pid 锁，D5 档2）
```ts
export interface JoinLock { pid: number; role: "cli" | "plugin"; }
export function acquireJoinLock(role: "cli"|"plugin"): { ok: true } | { ok: false; heldBy: JoinLock };
export function releaseJoinLock(): void;   // 仅当锁是自己 pid 时删
export function readJoinLock(): JoinLock | null; // stale（pid 死）→ 视为 null 并可清除
```
- 锁文件 `~/.rdsh/join.lock`，内容 `{pid, role}`（0600）；stale 判定用 `process.kill(pid, 0)`（跨平台：win 用 tasklist 或直接按 pid 存活试探，见 plan）。
- `startJoin` 内：`acquireJoinLock(opts.role)` 失败 → 抛错（外部已在跑）；`stop()` → `releaseJoinLock()`。

**T3 — `src/index.ts` 导出 + 版本**
- 导出 `startJoin`、`JoinHandle`、`JoinHooks`、`JoinState`、`StartJoinOptions`、`acquireJoinLock`、`releaseJoinLock`、`readJoinLock`、`JoinLock`。
- `package.json` version `0.3.0` → `0.4.0`（增量导出 + 内部重构；0.x 按惯例 minor）。

**T4 — 回归**
- `cli/src/bin.ts` 不改（`join()` 签名不变）。全量 `pnpm -r build` + `pnpm -r test`（含 05 e2e join 路径）。

### 5.2 新插件包（`packages/web-remote/`，npm 名 `dsh-web-remote`）

**T5 — `package.json`**
```json
{
  "name": "dsh-web-remote", "version": "0.1.0", "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" },
    "./client": { "default": "./lib/client.js" },
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml"],
  "dependencies": { "rdsh-gateway": "^0.4.0" },
  "peerDependencies": { "@deepseek-ai/cordis": "^4.0.1" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "inject": ["@deepseek-ai/dsh-client-connection", "@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-ui-slots", "@deepseek-ai/dsh-client-locale"], "platform": "web" }
  }
}
```

**T6 — `cordis.patch.yml`**
```yaml
- insert:
    - id: remote-access
      name: 'dsh-web-remote'
```
（该服务端行既是 server 插件挂载，也让 `dsh-client-modules` 扫描到 `dsh.client`。）

**T7 — `src/index.ts`（server 半，编译到 lib/index.js）**
- Cordis `Service` 子类：`static inject = ["connection","webServer"]`，`super(ctx, "remoteAccess")`。
- 注册命令通道：`ctx.connection.rpc.handle("/remote-access", handler, { authority: "loopback" })`——handler(endpoint, payload, signal) 按 endpoint 分发 `connect|disconnect|revoke|state`，返回 `{ok:true, value}` 或 `{ok:false, error:{code,message,details}}`（§6 wire）。
- 端口：`target = { host: "127.0.0.1", port: ctx.webServer.port }`。
- 状态机（内存 + `onState` 驱动）：`unconfigured / disconnected / connecting / connected / reconnecting / external`（`external` 由 `readJoinLock().role==="cli"` 判定）。
- 动作：
  - `connect`：读 host.json mode 冲突（D5 档1，≠join 需显式确认）→ `readJoinLock` 非空且 role=cli → 返回 `{ok:false, error:{code:"lock-busy"}}` → `registerJoin`（join token→host token）→ `saveConfig`(mode join/hub/name/insecure) → `startJoin(role:"plugin", target, hooks)`。
  - `disconnect`：`handle.stop()`（留配置+token）。
  - `revoke`：`handle.stop()` + `selfRevoke` + `clearPersistedToken` + 清 host.json join 字段。
  - `state`：读内存状态 + host.json + `readJoinLock` → 返回 `{status, hub, name, message}`。
- `ctx.on("dispose", …)` → `handle.stop()`（D4/R5 干净停止）。

**T8 — `lib/client.js`（client 半，settings 页）**
- 同 `dsh-client-ui-settings-plugins` 的 module-loader 工厂格式：`window.__ModuleLoader__.load({id:"dsh-web-remote", factory:(require)=>{… return {apply, inject};}})`；`const inject = ["connection","slots","locale"]`。
- `apply(ctx)`：`ctx.slots.inject("settings.section", () => ctx.slots.register({name:"settings.section", id:"remote-access", order:99, label:()=>t("nav")}, Section))`。
- 通信：`const rpc = ctx.get("connection").rpc`；`rpc.call("/remote-access","state",{args:{}})` 1s 轮询；`rpc.call("/remote-access","connect",{args:{hub,token,name}})` / `disconnect` / `revoke`。
- 态映射 UI：§2 req 的五态（未接入/连接中/已连接/断线重连/外部托管）+ 断开后态 F；表单 hub/token/name；按钮 接入/断开/注销；`external` 态禁用三按钮。
- 是否用 tsdown：MVP **手写**工厂格式（纯 JS + `require("react")`/`require("react/jsx-runtime")`，与 dsh 客户端注入一致）；不引入 tsdown（DSH 内部工具）。

### 5.3 测试 + 文档

**T9 — 测试**
- gateway：`test/join-core.test.ts`（`startJoin` no-spawn 对假 hub 的 onState 状态迁移、`stop()` 无残留）、`test/lock.test.ts`（acquire/release/stale/异 pid 拒绝）。
- e2e：本机 hub + 假 dsh（`node` 起一个 127.0.0.1 http）+ `startJoin(role:"plugin")` 隧道建立/重连；CLI 路径回归。
- 插件冒烟（人工）：`dsh plugin --profile default add <本地 file:` 路径`>` → 面板出现 → 接入/断开/注销。

**T10 — 文档 + 发布**
- CHANGELOG（zh/en）：rdsh-gateway 0.4.0（startJoin/lock）+ dsh-web-remote 0.1.0。
- README（双语）+ 博客（zh/en）：`dsh plugin add dsh-web-remote` 流程（实现后才写全名）。
- `scripts/reserve-name.sh`：发布 `dsh-web-remote@0.1.0`（覆盖 0.0.0 占位）。

## 6. 数据契约（server ↔ client，`connection.rpc` 通道 `/remote-access`）

- **wire（DSH 约定）**：客户端 `rpc.call("/remote-access", endpoint, {args}, signal)` → `POST /remote-access/<endpoint>`，body `{type:"client-request", rpcId, method:<endpoint>, payload:{args}}`；响应 `{type:"server-response", rpcId, result:{ok:true,value} | {ok:false,error:{code,message,details}}}`。
- channel `/remote-access` 匹配 `/^\/[A-Za-z0-9._~-]+$/`（**非 `/api`**——`/api` 是内置契约、外部不可扩展）。

| endpoint | `payload.args` | `result.value` |
|---|---|---|
| `state` | `{}` | `{ status, hub?, name?, message? }` |
| `connect` | `{ hub, token, name }` | `{ status }` |
| `disconnect` | `{}` | `{ status }` |
| `revoke` | `{}` | `{ status }` |

- `status` ∈ `unconfigured`（无 join 配置）\| `disconnected`（配置留、隧道停）\| `connecting` \| `connected` \| `reconnecting` \| `external`（锁 role=cli）。
- `connect` 失败 → `result.error = { code: "mode-conflict" | "lock-busy" | "register-failed", message, details }`。
- 认证：`authority:"loopback"` 围栏（同 DSH `/api` 的 Host 围栏）；直连与经 hub 隧道（gateway 把 Host 重写为 loopback）均满足。

## 7. 待定项（留给 plan.md，不阻塞 solution 批准）

- pid 存活探测的跨平台实现（`process.kill(pid,0)` 在 Windows 的语义）→ 选型进 plan。
- client.js 手写工厂 vs 引入轻量构建的取舍（含 React/jsx-runtime 的 require 解析验证）。
- `@deepseek-ai/cordis` 公共 npm 可安装性（§2.4）；不可用则 server 半改函数插件形态。
- host.json「注销后回退」精确行为（`mode` 回 `lan` vs 仅清 hub/name/insecure）→ plan 定。
- 实时状态推送：MVP 用 1s 轮询 `state`；如需无轮询可升级为插件自有 SSE 路由（`webServer.register` + `data: …\n\n`，同平台 `readSse` 帧格式）。

*关联文档：req.md | 前置：04-cli-refactor（solution.md）、05-join-easy（solution.md）| 下一步：plan.md（待 solution 批准后）*
