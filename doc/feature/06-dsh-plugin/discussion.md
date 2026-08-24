# 06-dsh-plugin — 讨论（discussion.md）

> **日期**: 2026-08-24
> **范围**: M4 —— DSH 插件形态的 rdsh-gateway：`dsh plugin add` 一个插件即获网关/join，免装 CLI
> **来源**: `doc/overview/roadmap.md`（M4）；04-cli-refactor / 05-join-easy 讨论中留的钩子（05 §2.6、D13）
> **状态**: 讨论记录（草稿；前置调研进行中；命名未定稿）

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
  - `dsh.bundle.client` → 客户端 UI 补丁（`inject` 依赖 + `platform: "web"`）——DSH 界面里的面板/设置页就是这种（如 `dsh-client-ui-settings`）。
- 插件装在 **profile 目录**（按 profile 隔离；`INSTALL_ANCHOR` + `resolveProfileDir` 定位）；manifest（`dsh.profile.bundles`）记录层列表。

### 2.2 运行环境与能力

- DSH 应用本体基于 **Cordis**（deps 含 cordis-plugin-loader 等）——插件可注册 service / command / 路由；
- 插件代码在 **dsh 进程内**（Node）→ **可以 spawn 子进程、监听端口、访问文件系统**（`node:child_process` / `node:net` / `node:http` 都是 Node 能力）——这是「spawn rdsh host 子进程 + 面板管理」的可行性依据；
- 既有第三方插件佐证：`dsh-plugin-remote`（远程网关+投射）、`dsh-remote-access`（LAN 绑定）、`dsh-remote-gateway`（白名单网关）都已用该机制实现远程访问——**赛道拥挤，命名需避雷**（见 §4）。

### 2.3 可复用的 rdsh 资产（04/05 已定）

| 资产 | 位置 | 插件复用点 |
|---|---|---|
| host 核心（join/serve 转发内核） | `packages/gateway/src/{join,serve,proxy,server}.ts`（D13：数据进、进程出） | 插件 spawn `rdsh host serve` 子进程，或直接库调用 |
| session 文件（host token 持久化） | `~/.rdsh/join-<host>.token`（0600） | 插件与 CLI/service 共享，重启免配 |
| host.json（04） | `~/.rdsh/host.json` | 插件读同一配置（mode: join/lan/cloud） |
| 证书自动检测 / self-revoke / 服务名对齐（04） | — | 插件直接继承 |

## 3. 前置调研清单（进行中，进 solution 前需结论）

| # | 调研项 | 现状 |
|---|---|---|
| P1 | `dsh plugin add` 完整流程与 profile 初始化细节（`dsh-app-boot` 的 initProfile/readProfileManifest） | 部分查证（§2.1） |
| P2 | **插件能否挂到 DSH 进程内的 HTTP server**（转发目标 = 本进程 dsh，而非再 spawn 一个 dsh）——决定「同进程内嵌转发」还是「spawn 独立子进程」 | ⚠️ 未查证（见 D1） |
| P3 | 插件能否贡献客户端 UI 面板（`dsh.bundle.client` 的路由/入口形态） | 已确认存在（§2.1），细节待查 |
| P4 | 与 CLI 版共存策略（同一 host 是否同时跑 CLI service + 插件；冲突检测） | 未定 |
| P5 | 插件版本与 rdsh 包版本的依赖（插件内嵌 rdsh-gateway？还是依赖 npm 上的 remote-dsh 包？） | 未定 |
| P6 | **创建 npm org 锁定 scope**：`remote-dsh` 或 `rdsh`（先到先得，§4.1） | 待办 |

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

### 4.2 候选（裸名 + scoped 两套）

裸名（开放空间，可预留多个但**不防未来抢注**）：

| 候选 | 状态 | 风格 |
|---|---|---|
| `dsh-plugin-rdsh` | ✅ 空闲 | 品牌 + `dsh-plugin-` 生态前缀 |
| `dsh-remote-visit` | ✅ 空闲 | 描述·友好（"visit your DSH from anywhere"，正确英语） |
| `dsh-remote-host` | ✅ 空闲 | 描述·贴合 host/gateway 角色 |
| `dsh-tunnel` | ✅ 空闲 | 描述·技术 |
| `dsh-rdsh` | ✅ 空闲 | 短品牌（代号） |
| `dsh-remote-dsh` | ✅ 空闲 | 冗余（dsh 叠词），不推荐 |

被占（同类远程访问）：`dsh-plugin-remote` / `dsh-remote-access` / `dsh-remote-gateway` / `dsh-gateway` / `dsh-remote` / `dsh-host` / `dsh-anywhere` / `dsh-remote-tunnel` / `dsh-pocket`。

scoped（保留空间，免疫抢注）：

```
@remote-dsh/dsh-remote-visit
@remote-dsh/plugin-rdsh
@rdsh/dsh-...                # 或短代号 scope
```

### 4.3 决策状态

- **未定稿**：主名（裸名 vs scoped；品牌 vs 描述）待继续讨论；
- **待办 P6**：尽快创建 `remote-dsh`（或 `rdsh`）npm org，锁定 scope（先到先得）；
- **文档纪律**：README / roadmap 在定稿前不写全名（只写 `dsh plugin add`）；本 discussion 持续记录命名决策。

## 5. 关键设计问题（待决，进 req/solution）

| # | 问题 | 倾向 |
|---|---|---|
| D1 | **插件与 dsh 进程的关系**：a) 内嵌（挂到 dsh 的 HTTP/WS 层，转发目标=本进程 dsh，零额外 dsh 实例）vs b) spawn 独立 `rdsh host serve` 子进程（进程隔离、crash 兜底，但 spawn 的 gateway 默认会再 spawn 一个 dsh → 需「不 spawn、转发到本机现有 dsh」模式） | b) spawn 子进程 + 转发到 `127.0.0.1:<本进程 dsh 端口>`（需 04 增加「no-spawn / target 直连」能力）——隔离性好，复用现成 CLI |
| D2 | **面板 UI 范围**：hub URL + join token 粘贴、状态（连接中/已连接/断线重连）、断开/重连、日志查看（05 §2.6 已定范围） | 全做，复用 `dsh.bundle.client` |
| D3 | **配置记忆**：hubUrl/name/insecure 存哪（`~/.rdsh/join-config.json` vs dsh 设置） | 复用 `~/.rdsh/host.json`（04 统一配置），token 只进 session 文件 |
| D4 | **进程托管**：spawn/守护/崩溃重启 join 子进程 | 插件内做最小托管（spawn + 退出码监听 + 一键重启），复杂托管交给 systemd（已有 service 能力） |
| D5 | **与 CLI 共存**：插件与 `rdsh host service install` 是否可并存 | 冲突检测（同 host.json 时提示二选一）或文档说明；P4 调研后定 |
| D6 | **包依赖形态**：插件内嵌 rdsh-gateway 代码 vs 依赖 npm `remote-dsh`/`rdsh-gateway` 包 | P5 调研后定（倾向依赖 npm 包，避免重复维护） |

## 6. 参考

- 事实源：`~/.nvm/versions/node/v22.23.2/lib/node_modules/@deepseek-ai/dsh/lib/{bin,plugin-9h8shc4d}.js`、`dsh-app-boot`、`dsh-client-ui-*` 的 `dsh.bundle` 声明
- 命名空间：npm registry 勘察（官方 `@deepseek-ai/` scoped vs 第三方裸 `dsh-*`；scope 规则 = 用户名/org；§4.1）
- 依赖：`doc/feature/04-cli-refactor/`、`doc/feature/05-join-easy/`（D13 / §2.6 钩子）
- 路线图：`doc/overview/roadmap.md`（M4）
