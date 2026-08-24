# 06-dsh-plugin — 讨论（discussion.md）

> **日期**: 2026-08-24
> **范围**: M4 —— DSH 插件形态的 rdsh-gateway：`dsh plugin add dsh-web-remote` 即获网关/join，免装 CLI
> **来源**: `doc/overview/roadmap.md`（M4）；04-cli-refactor / 05-join-easy 讨论中留的钩子（05 §2.6、D13）
> **状态**: 讨论记录（主名已定稿 `dsh-web-remote`；D1–D6 已决议，P1–P5 已查证；P6 推迟到将来）

---

## 1. 目标

让用户**不装 rdsh CLI**，直接在 DSH 里获得远程访问能力：

```
dsh plugin --profile default add <plugin>
→ DSH 界面出现「远程访问」面板：连 hub（join）或开局域网网关（serve），
  状态/启停/日志都在面板里，复用 04/05 已验证的 host 核心。
```

- 插件 = npm 包（声明 `dsh.bundle`），随 DSH 插件生态分发（`dsh plugin add`）；
- **复用** 04 的 host 核心（`host serve`/`host join` 可 spawn 或库调用）+ 05 的 session 文件共享（token 持久化）；
- CLI 保留（**双通道分发**：CLI 与插件并存，同一 host 核心）。

## 2. 查档事实（2026-08-24，dsh 插件机制）

> 事实源：安装的 `@deepseek-ai/dsh`（v0.1.1-rc.2）源码。

### 2.1 `dsh plugin` 命令 = 薄 pnpm 转发器

- `dsh plugin --profile <name> <pnpm args...>`（`lib/bin.js`）：**必须带 `--profile`**；首次使用初始化 profile 目录，然后在 profile 目录里跑 `pnpm <args>`（`add <pkg>` / `remove` / `why`…），最后按「安装态」对账 `dsh.profile.bundles` 层列表（`lib/plugin-9h8shc4d.js`）。
- **成为插件的关键 = 包的 package.json 声明 `dsh.bundle`**：
  - `dsh.bundle.patch` 存在 → 加入 profile 层栈（服务端补丁，profile-boot 加载）；
  - `dsh.client` → 客户端 UI 补丁（`inject` 依赖 + `platform: "web"`）——DSH 界面里的面板/设置页就是这种（如 `dsh-client-ui-settings`）。
- 插件装在 **profile 目录**（按 profile 隔离；`INSTALL_ANCHOR` + `resolveProfileDir` 定位）；manifest（`dsh.profile.bundles`）记录层列表。

### 2.2 运行环境与能力

- DSH 应用本体基于 **Cordis**（deps 含 cordis-plugin-loader 等）——插件可注册 service / command / 路由；
- 插件代码在 **dsh 进程内**（Node）→ **可以 spawn 子进程、监听端口、访问文件系统**（`node:child_process` / `node:net` / `node:http` 都是 Node 能力）——这是「spawn rdsh host 子进程 + 面板管理」的可行性依据；
- 既有第三方插件佐证：`dsh-plugin-remote`（远程网关+投射）、`dsh-remote-access`（LAN 绑定）、`dsh-remote-gateway`（白名单网关）都已用该机制实现远程访问——**赛道拥挤，命名需避雷**（见 §4）。

### 2.3 可复用的 rdsh 资产（04/05 已定）

| 资产 | 位置 | 插件复用点 |
|---|---|---|
| host 核心（join/serve 转发内核） | `packages/gateway/src/{join,serve,proxy,server}.ts`（D13：数据进、进程出） | 插件**库调用** join 核心（no-spawn，D1），转发到本进程 dsh |
| session 文件（host token 持久化） | `~/.rdsh/join-<host>.token`（0600） | 插件与 CLI/service 共享，重启免配 |
| host.json（04） | `~/.rdsh/host.json` | 插件读同一配置（mode: join/lan/cloud） |
| 证书自动检测 / self-revoke / 服务名对齐（04） | — | 插件直接继承 |

### 2.4 插件 bundle 的具体结构（P1/P3/P5 查证，2026-08-24）

- **服务端**：`dsh.bundle.patch = "./cordis.patch.yml"`（Cordis patch YAML），声明/插入 Cordis 插件：
  ```yaml
  - insert:
      - id: remote-access
        name: 'dsh-web-remote/server'   # 按 npm 包名/子路径引用
        inject: [ ... ]                 # Cordis 服务注入
        config: { ... }
  ```
  例证：`dsh-headless` / `dsh-base` / `dsh-web-app` 的 `cordis.patch.yml` 都用 `insert: name: '@deepseek-ai/...'` 按包名插插件。
- **客户端**：`dsh.client = { inject: [...客户端依赖], platform: "web" }` + `exports["./client"]` → `lib/client.js`（Cordis client 插件）。`client.js` 用 `ctx.settingsScope` / `ctx.settingsSchema` + React，把页面挂到 `uiRenderer` 呈现为设置页（`dsh-client-ui-settings` 系列即此模式）。
- **结论（P5 → D6）**：`dsh-web-remote` 是**薄包装**——`cordis.patch.yml` 插入自己的 server 插件（该插件 `import rdsh-gateway` 的 join 核心作为常规 npm 依赖），`dsh.client` 提供设置页 UI。

## 3. 前置调研清单（进行中，进 solution 前需结论）

| # | 调研项 | 现状 |
|---|---|---|
| P1 | `dsh plugin add` 完整流程与 profile 初始化细节 | ✅ 已查证（§2.1/§2.4） |
| P2 | 插件能否挂到 DSH 进程内的 HTTP server | ✅ 已定（D1：内嵌 + self-proxy 转发到 `127.0.0.1:<dsh 端口>`，无需挂载） |
| P3 | 客户端 UI 面板形态（`dsh.client` 路由/入口） | ✅ 已查证（§2.4：client.js 设置页） |
| P4 | 与 CLI 版共存策略（同 host 是否同时跑 CLI service + 插件） | ✅ 已定（D5 档1+2：单身份铁律 + mode 冲突确认 + pid 锁防双隧道） |
| P5 | 包依赖形态（内嵌 vs 依赖 npm 包） | ✅ 已查证（§2.4：依赖 `rdsh-gateway` npm 包，薄包装） |
| P6 | 创建 npm org 锁定 scope（`remote-dsh` / `rdsh`） | ⏭️ **推迟（2026-08-24）**：主名走裸名 `dsh-web-remote`（已预留 0.0.0），暂不建 org；将来需 scoped 路线时再建 |

## 4. 命名勘察（2026-08-24，命名未定稿，待继续讨论）

### 4.1 npm 命名空间事实（查档）

**`dsh-*` 前缀是开放命名空间，不是 DeepSeek 保留的**：

| 类别 | 例 | 说明 |
|---|---|---|
| 官方 | `@deepseek-ai/dsh`、`@deepseek-ai/dsh-web-frontend`…（约 20 个） | DeepSeek 官方全用 **scoped `@deepseek-ai/`** |
| 第三方裸名 | `dsh-gateway`、`dsh-host`、`dsh-remote`、`dsh-remote-access`、`dsh-remote-gateway`、`dsh-weixin-gateway`…（30+ 个） | **谁先注册谁占**；远程访问类近几天仍被第三方抢注（如 `dsh-plugin-remote` 2026-08-18） |

**npm scope 规则**：
- scope 来源二选一：npm **用户名**，或所加入的 npm **Organization**（组织名即 scope）；
- 一个账号可建**多个 org → 多个 scope**（互不冲突，与 GitHub 无关）；
- **用项目名做 scope = 创建同名 org**（org 名与用户名同一全局池，先到先得）；
- scoped 包在 npm 是**按账号/组织隔离的保留命名空间**，天然免疫抢注。

**实测**：`@remote-dsh`、`@rdsh`、`@floatinghotpot` 等 scope 下目前均无包（大概率可注册 org；**创建 org 才是真正的保留动作**——待办 P6）。

### 4.2 候选 + 预留状态

**已预留（2026-08-24 发布占位 0.0.0，脚本 `scripts/reserve-name.sh`）**：

| 候选 | 风格 |
|---|---|
| `dsh-plugin-rdsh` | 品牌 + `dsh-plugin-` 生态前缀 |
| `dsh-tunnel` | 描述·技术（核心是隧道） |
| `dsh-web-remote` | 描述·Web 视角（语义略偏「web UI」，作占位备选） |

其他空闲候选（未预留）：

| 候选 | 风格 |
|---|---|
| `dsh-remote-visit` | 描述·友好（"visit your DSH from anywhere"） |
| `dsh-remote-host` | 描述·host/gateway 角色 |
| `dsh-rdsh` | 短品牌（代号） |

被占（同类远程访问）：`dsh-plugin-remote` / `dsh-remote-access` / `dsh-remote-gateway` / `dsh-gateway` / `dsh-remote` / `dsh-host` / `dsh-anywhere` / `dsh-remote-tunnel` / `dsh-pocket`。

scoped（保留空间，免疫抢注，未做）：`@remote-dsh/…` / `@rdsh/…` —— 需先建 org（P6）。

### 4.3 决策状态

- **主名已定稿：`dsh-web-remote`**（2026-08-24 定案；已预留 0.0.0）；
- 其余已预留（占位/备胎）：`dsh-plugin-rdsh` / `dsh-tunnel`；
- **待办 P6**：创建 `remote-dsh`（或 `rdsh`）npm org 锁 scope（若走 scoped 路线）；
- **文档纪律**：README / roadmap 在**实现前**不写全名（只写 `dsh plugin add`）。

## 5. 关键设计问题（待决，进 req/solution）

| # | 问题 | 决议/倾向 |
|---|---|---|
| D1 | **插件与 dsh 进程的关系** | ✅ **内嵌，不 spawn**：插件被 dsh 加载、跑在 dsh web 进程内部，dsh 本来就在跑（127.0.0.1:3080）→ 无需 spawn 第二个 dsh。插件复用 join 隧道核心，转发目标指到**本进程 dsh**（`127.0.0.1:<dsh 端口>`）。要求 gateway `join()` 支持「不 spawn、外部 target」模式（D13 钩子落地） |
| D2 | **面板 UI 范围**：hub URL + join token 粘贴、状态、断开/重连、日志（05 §2.6） | ✅ **MVP 四态**（2026-08-24 定案）：①接入表单（hub URL + join token + name + [接入]）②实时状态点（未接入/连接中/已连接/断线重连/**已接入·外部托管**）③[断开][注销]。**无手动重连**（重连交给自动）；**MVP 不做面板内日志区**。join 核心加 `onState`（实时状态所需）+ `onLog`（日志预留）事件钩子，`onLog` 先落钩子不渲染。**外部托管态**：pid 锁 `role=cli`（CLI/`rdsh-join.service` 在跑）→ 面板只读显示「已接入（由 rdsh CLI/服务托管，请用 rdsh 命令管理）」，禁用 接入/断开/注销（插件不跨进程窥探/控制其隧道状态） |
| D3 | **配置记忆**：hubUrl/name/insecure 存哪 | ✅ **复用 `~/.rdsh/host.json`（A，2026-08-24 定案）**：接入 = 写 `{mode:"join", hub, name, insecure}`（字段已存在，config.ts 无需新增）+ `registerJoin` 落 token 到 `~/.rdsh/join-<host>.token`（0600）。单文件单 mode 的 clobber/多 profile 冲突规则 → 挪 D5 |
| D4 | **进程托管**：spawn/守护/崩溃重启 | ✅ **无守护 + 可停止句柄（2026-08-24 定案）**：join 核心是 dsh 进程内异步任务（D1 内嵌），无独立进程可守护；崩溃重启交给 dsh 自己的 supervisor（`dsh web` 的 systemd/前台），dsh 重启后插件重载、join 复用 token 自动重连（重连已内置）。插件唯一要补：join 核心暴露 `stop()` 句柄（关 WS、清 heartbeat、不 `process.exit`），Cordis dispose 钩子挂上。不做面板「一键重启」 |
| D5 | **与 CLI 共存**：插件与 `rdsh host service install` 是否可并存 | ✅ **档1+2（2026-08-24 定案）**：①接入前读 host.json，`mode` 存在且 ≠ join → 显式确认才覆盖（防静默 clobber lan/cloud 配置）；②join 核心加 pid 锁文件 `~/.rdsh/join.lock`（记 `pid + role`，启动写/退出清/stale 清理），插件接入前检测已有 CLI join 在跑则拒绝（防同 hostId 双隧道）。插件不越权杀服务。hub 顶替（档3）列 deferred（需 hub 改动，非 M4）。锁的 `role` 区分「plugin 自持 vs cli 托管」→ 面板据此显示「外部托管」只读态（见 D2） |
| D6 | **包依赖形态**：插件内嵌 rdsh-gateway vs 依赖 npm 包 | ✅ **依赖 npm 包 `rdsh-gateway`**（薄包装，P5/§2.4）：`cordis.patch.yml` 插入自写 server 插件，该插件 `import rdsh-gateway` 的 join 核心作常规依赖 |

## 6. 参考

- 事实源：`~/.nvm/versions/node/v22.23.2/lib/node_modules/@deepseek-ai/dsh/lib/{bin,plugin-9h8shc4d}.js`、`dsh-app-boot`、`dsh-client-ui-*` 的 `dsh.bundle` 声明
- 命名空间：npm registry 勘察（官方 `@deepseek-ai/` scoped vs 第三方裸 `dsh-*`；scope 规则 = 用户名/org；§4.1）
- 依赖：`doc/feature/04-cli-refactor/`、`doc/feature/05-join-easy/`（D13 / §2.6 钩子）
- 路线图：`doc/overview/roadmap.md`（M4）
