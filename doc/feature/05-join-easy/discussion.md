# 05-join-easy — 讨论（discussion.md）

> **日期**: 2026-08-24
> **范围**: M4 之前置特性 —— `rdsh host join` 接入体验：服务化/headless 场景免配对、portal 自助生成用户级 join token
> **来源**: 生产部署反馈（阿里云 ECS 上 join 作为 systemd 服务时配对码不可用）+ 关联 `doc/fix/*` 三个 bug 报告合并复盘
> **状态**: 讨论记录（READ-ONLY 后：需求进 req.md）
> **命令面**: 遵循 04-cli-refactor 新树（`rdsh host *`）；§3 查档事实为 04 重构前的现状

---

## 1. 目标

让 `rdsh join`（出站隧道 gateway）在**服务化 / headless 场景**下可自助接入，消除「配对码必须有人在浏览器前输码」与服务化部署的矛盾：

- 用户（hub 账号）在 portal 自助生成**用户级 join token**（一个 token 可注册多台主机）；
- 网关机 `rdsh host join <hub> --token <t>` / `rdsh host service install <hub> --token <t>` 直接接入，**无需配对码交互**；
- 首次注册成功后 host token 持久化（session 文件），重启/服务化自动复用，**重启免配**；
- 配对码流程**保留**（浏览器在场场景仍可用）；
- 安全底线：短效、可吊销、只显示一次、哈希存储；
- **API key 由 DSH 自管**：修复 paste-box 经 portal 显示后（`doc/fix/20260824-portal-apikey-pastebox`，P1 前置），key 由 DSH 界面粘贴/持久化，**rdsh join 无需配置 key**（无需 join.env / 环境注入）→ 进一步简化接入。

## 2. 用户体验：怎么让用户最省事地加一台主机（核心）

> 本节回答「用户视角的完整接入路径」——机制（token/接口）为它服务，不是反过来。

### 2.1 最佳实践参照（业界同类工具）

| 工具 | 模式 | 借鉴点 |
|---|---|---|
| GitHub self-hosted runner | Settings → New runner → 页面直接给**可复制命令**（`./config.sh --url … --token …`） | 门户生成整条命令，用户零组装 |
| Tailscale | auth key 可复用，`tailscale up --authkey <k>` 后设备自动出现 | 一个 key 多设备；登录即自动上线 |
| Cloudflare Tunnel / ngrok | dashboard 给一条可直接执行的命令 | 一行命令 = 全部配置 |

**共性**：门户负责「生成 + 复制」，用户只做「粘贴执行」，不读文档、不组装参数。

### 2.2 建议的用户流程（「添加主机」）

```
hub portal「添加主机」页：
1. 填机器名（可选）＋ 选「运行方式」：前台运行(开发机) / 常驻服务(服务器)
2. 点「生成接入命令」→ 自动复制到剪贴板（明文只显示一次，刷新后消失）
3. 到机器终端粘贴（未装 rdsh 时第一步 npm i -g remote-dsh）：
     # 前台运行（开发机）：
     rdsh host join https://hub.example.com --token <joinToken> --name my-laptop
     # 常驻服务（服务器，一行搞定）：
     rdsh host service install https://hub.example.com --token <joinToken> --name my-laptop
4. 注册成功 → portal host 列表立即出现该主机「在线」
```

### 2.3 命令设计（本次新增能力）

**交互式接入（推荐路径）**——CLI 尽量简单，`rdsh host join <hub>` 一个命令走完：

```
$ rdsh host join https://hub.example.com
No saved host session for this hub.
Paste your join token (hub portal → Add host): rdsh_xxxx    ← 提示粘贴 join token
Host name [my-ecs]:                                          ← 自动显示本机 hostname，可改（回车保留）
rdsh host: registered host 'my-ecs' (id: xxx) — session saved to ~/.rdsh/join-hub.example.com.token
rdsh host: connecting to https://hub.example.com...
```

- `--token <joinToken>`：脚本/非交互直接给（无持久 session 时注册，跳过粘贴提示）；
- `--name <机器名>`：跳过名称提示；**默认 = 本机 hostname**（自动探测、交互可改）；
- 无持久 session 且无 `--token` 且**非 TTY** → 明确报错（提示先交互注册或 `rdsh host service install --token`），不 hang；
- **配对码保留为显式可选路径**（`--code` 或提示内选项），默认交互 = 粘贴 token；
- 常驻服务 = `rdsh host service install <hub> --token <t> [--name <n>]`（注册 + 持久化 + 写 unit，unit 永不含 token）；
- 同一 token 复制给多台机器（各改 `--name`）即批量接入。

### 2.4 portal「添加主机」页

- 机器名输入（占位符提示默认取 hostname）＋「常驻服务」开关＋有效期选择（默认 30 天）；
- 「生成接入命令」按钮 → 展示 + **一键复制**；生成后仅显示「标签/到期/吊销」，不再显示明文；
- 自签 hub 开关 → 命令追加 `--insecure`；
- 未安装提示：命令上方一行 `npm i -g remote-dsh`（检测到未装时/始终展示皆可）。

### 2.5 注册后反馈

- CLI 侧：打印 `registered host '<name>' (id: <hostId>)` + `session saved to ~/.rdsh/join-<host>.token`；
- portal 侧：host 列表实时「在线」。
- 「该 token 已注册 N 台主机」**不做**（2026-08-24 定案：避免 register 记录 tokenId→hostId 的额外关联）。

### 2.6 插件路径（M4 dsh-plugin-rdsh，web UI 接入）

**场景**：用户在本机打开 `dsh web`（127.0.0.1:3080），rdsh 插件面板粘贴 hub URL + join token → 点「接入」→ 隧道建立；面板常驻显示状态，无需开终端、无需 SSH。

**对本次设计的要求（留钩子，不在本次实现）**：

1. **join 核心可复用**：register + persist + connect 必须是可 spawn 的进程 / 可调用的库函数，不能埋在 CLI 参数解析里——插件 spawn `rdsh host join <hub>`（注册）或 `rdsh host serve`（读 host.json + session 自动复用），或直接调用 gateway 库；
2. **接入参数就是 JoinOptions 数据**：插件面板输入（hubUrl / token / name / insecure）即本次 `--token`/`--name` 的字段集（本次把 `--name` 纳入 join 即为此铺垫）；
3. **session 文件共享**：插件与 CLI/service 共用 `~/.rdsh/join-<host>.token`（同一台机器不会同时跑多个 join，但文件格式一致，插件可读状态/复用）；
4. **插件专属（M4，不在本次范围）**：面板 UI（token 粘贴、状态、断开/重连、日志）、join 子进程托管（spawn/守护/崩溃重启）、插件配置记忆（hubUrl/name/insecure 存 `~/.rdsh/join-config.json`，token 只进 session 文件不进配置）。

**结论**：05-join-easy 的产出（join token + register + session 持久化 + `--name`）是 M4 插件的地基；实现时保持「数据进、进程出」的干净接口即可无缝对接。

## 3. 查档事实（2026-08-24 代码审计）

### 3.1 现状：join 接入路径（`packages/gateway/src/join.ts` + `token-store.ts`）

- token 来源优先级：**`--token` 直填 > 持久化复用 > 配对码绑定**；
- 配对码流程：`POST /api/hosts/pending` → 打印 6 位码（10 分钟有效）→ 轮询 `GET /api/hosts/pending/:id` → hub 在 bind 时生成 host token（`randomToken()`）→ gateway 落盘后建隧道；
- 持久化（`token-store.ts`）：`~/.rdsh/join-<host>[-<port>].token`，0600；重启复用；被吊销（401）删旧文件回退配对；
- fail-fast：显式 `--token` 被拒（401/403）→ 明确报错 + 非零退出，不无限重连；
- **关键缺口**：`--token` 目前语义 = **直接当 host token 用**（`/tunnel?token=`），但正常流程**无法获得**这种 token（绑定响应中的 token 只进 join 进程，不打印、portal 不展示、`hub host ls` 不输出）——即本次要补的核心。

### 3.2 现状：hub 侧（`packages/hub/src/{api,server,db,jwt}.ts`）

- 绑定：`handleBind` 无条件新建 host（`randomUUID` + `randomToken`，**只存 SHA-256 摘要**）；`pending` 表存配对码与临时明文 token（轮询取走即清）；
- 隧道认证：`handleTunnelUpgrade` 用 `findHostByTokenHash(sha256(token))` 查 `hosts` 表，查不到 → 401；
- **无「用户级注册凭证」概念**：host 必须经配对码绑定产生；无 portal 自助生成 token 的端点，无 register 端点。

### 3.3 现状：服务化（`packages/gateway/src/service.ts` + `packages/cli/src/bin.ts`）

- `rdsh join service install <hub> [--dsh <abs>] [--insecure]` 已实现（独立 `rdsh-join` 服务名，unit 含 `EnvironmentFile=-~/.rdsh/join.env`、`Restart=on-failure`）；
- **当前 service install 拒绝 `--token`**（只支持 `--dsh`/`--insecure`）——本次要放开并透传 `--name`；
- unit 设计上**不含任何 token**；服务启动时 join 进程读 session 文件。

### 3.4 关联 bug 报告（`doc/fix/*`，合并复盘）

| 报告 | 状态 | 与本次的关系 |
|---|---|---|
| `20260824-join-token-persist` | ✅ 已修 | host token 持久化 = 本次「重启免配」的基础 |
| `20260824-join-token-reject` | ✅ 已修 | 显式 `--token` fail-fast = 本次「坏凭证」错误处理基础 |
| `20260824-join-service-install` | ✅ 已修 | join 服务化 = 本次的部署形态；本次补 `--token`/`--name` 支持 |

合并考虑：persist + reject + service-install 已解决「重启」「坏 token」「常驻部署」，但**首次接入的凭证从哪来、怎么到网关机**仍是断的——这正是本次范围（join-easy）。

## 4. 需求讨论记录（2026-08-24，交互式讨论要点）

1. 原始诉求：portal 自助生成一次性 join token（绑账号、可设机器名、短效、只显示一次、可吊销、哈希存储）；`rdsh join --token` 免配对接入；配对码保留。
2. 澄清 1（token 定位）：token 是**用户级认证凭证**——不绑主机、不是 host token；**一个 token 可注册多台主机**（"bind host with user account"）。
3. 澄清 2（次数归属）：主机数限制属于**账号层**（未来 SaaS：trial=1 台 + 试用期、付费=主机数配额），**不在 token 层**；token 不设次数上限。
4. 澄清 3（接入时序）：`rdsh host join --token` 由 CLI 完成注册并持久化 session 文件；服务化时自动复用该文件，unit 不含 token。
5. 有效期讨论（参考 GitHub fine-grained PAT 默认 30 天、classic/npm 默认永久、`gh auth` 长期）→ 结论：**默认 30 天，可配置 1d/7d/30d/90d/1y，上限 1 年**；过期重新生成。
6. 主机名：gateway 注册时 `--name <机器名>`（默认取本机 hostname），回退 `host-xxxx`；portal 已有改名功能兜底。
7. 用户体验（核心补充）：参照 GitHub runner / Tailscale / Cloudflare Tunnel —— **门户生成一行可复制命令，用户粘贴即用**；portal「添加主机」页 + `--name`/`--insecure`/常驻服务开关（见 §2）。
8. UX 定案（2026-08-24 用户拍板）：① CLI 尽量简单 —— `rdsh join <hub>` 交互式**提示粘贴 token**；② 主机名**默认取 hostname、允许改**；③ 「已注册 N 台」不做；④ 插件**只留钩子接口**，web UI 属 dsh-plugin（M4）范围，不并入本次。
9. API key 策略（2026-08-24 定案）：**修复 paste-box 经 portal 显示 = 简化 API key 配置** —— DSH 自行管理 key（界面粘贴一次、DSH 持久化），rdsh 无需配置（无需 join.env）；对应 bug `doc/fix/20260824-portal-apikey-pastebox`（P1）是 join-easy 的核心前置。

## 5. 已达成决策

| # | 决策 | 说明 |
|---|---|---|
| D1 | **两段式凭证** | join token（用户级、短效、一次性展示）→ register → 每台主机独立的 host token（持久，gateway 落盘） |
| D2 | **join token = 用户级认证 token** | 属 owner 账号；可注册多台主机；次数限制在账号层（SaaS 时在 register 加钩子，本次不实现） |
| D3 | **注册端点** | `POST /api/hosts/register {token, name?}`（无 session，持 token 认证，需限流）：校验 join token（未吊销/未过期）→ 在 owner 名下建 host → 签发 host token → 返回 `{hostId, hostToken}`；对已是 host token 的输入幂等返回（兼容旧 `--token <hostToken>`） |
| D4 | **有效期** | 默认 30 天；创建时可选 1d/7d/30d/90d/1y；上限 1 年；过期需重新生成 |
| D5 | **token 标签** | portal 创建时可给 token 一个名字（列表标识用） |
| D6 | **主机名** | gateway 注册时 `--name <名字>`（默认本机 hostname）；回退 `host-xxxx` |
| D7 | **吊销语义** | 吊销 join token = 只阻止未来注册；已注册主机不受影响（各自 host token 走已有 host 吊销） |
| D8 | **只显示一次 + 哈希存储** | portal 生成时展示明文一次；hub 只存 SHA-256；之后仅「列表 + 吊销」 |
| D9 | **gateway 凭证解析顺序** | 持久化 host token > `--token`（注册）> 配对码 |
| D10 | **service install 支持 --token/--name** | `rdsh host service install <hub> --token <t> [--name <n>]`：当场注册 + 持久化 session 后写 unit（unit 永不含 token）；无 `--token` 则要求 session 文件已存在 |
| D11 | **配对码保留** | 浏览器在场场景继续可用，不删 |
| D12 | **portal「添加主机」页** | 机器名 + 运行方式（前台/常驻）+ 有效期 + 生成/复制命令（§2.4） |
| D13 | **join 核心可复用** | register/persist/connect 保持「数据进、进程出」的干净接口，可被 CLI / service / **M4 插件**共同调用（§2.6） |
| D14 | **敏感端点可审计/可配额/可限流** | register / join-token 创建是安全敏感端点：输出结构化事件（M5 审计可消费）、register 预留账号配额检查点（M5/SaaS）、未认证端点配限流（§6） |
| D15 | **交互式 prompt token** | `rdsh host join <hub>` 无持久 session 且无 `--token` 时，交互提示粘贴 join token；非 TTY 明确报错不 hang；`--token` 供脚本（§2.3） |
| D16 | **主机名默认 hostname 可改** | 自动探测本机 hostname 为默认名，交互提示可改；`--name` 显式覆盖；回退 `host-xxxx`（§2.3） |
| D17 | **API key 归 DSH 管理** | 前置修复 paste-box 经 portal 显示（`doc/fix/20260824-portal-apikey-pastebox`，P1）；之后 key 由 DSH 界面粘贴/持久化，rdsh join 不配置 key（join.env 降级为可选逃生通道，默认路径不需要） |

## 6. 与 M5 多租户增强的衔接（2026-08-24 新增）

> 依据 `doc/overview/roadmap.md` M5（多租户增强）：邮箱验证、2FA（TOTP/passkey）、共享授权（owner/member）、审计日志、登录风控。

### 6.1 结论

**M5 无硬性阻塞依赖**（不需要等本特性才能启动）——M5 作用于 hub 账号/安全模型，本特性作用于 host 接入；但本特性**新增了 M5 必须覆盖的对象与钩子**。

### 6.2 耦合点（M5 应覆盖/复用本特性）

1. **审计日志**：本特性新增安全事件（join token 创建 / register 成功与失败 / token 吊销 / host 注册归属），是 M5 审计的自然对象 → 设计上 register 与 token 端点输出**结构化事件**，M5 直接消费，不返工；
2. **账号配额**：用户规划的「账号层主机数限制」（SaaS：trial=1 台 + 试用期、付费=配额）**执行点就是 register 端点**（它负责建 host）→ 本特性已留钩子（D3/D14）；
3. **登录风控**：register 是**持 token、无 session** 的未认证端点，天然是滥用目标 → 本特性计划给其限流（对齐 pending 的 IP 限流），M5 风控可纳入同一体系。

### 6.3 反向（M5 → 本特性设计约束）

M5 的**邮箱验证 / 2FA** 未来可能门禁敏感操作（如「创建 join token 前需已验证邮箱/二次确认」）→ 本特性把 token 创建做成**可审计、可加策略的普通端点**（而非特例），M5 即可无缝叠加策略，无需改结构。

## 7. 待定 / 留钩子

- **账号层主机数限制**：register 端点为未来「账号配额」留钩子（本次不实现，SaaS 话题；执行点见 §6.2-2）；
- **token 生成途径**：本次只做 portal；`rdsh hub join-token` CLI 留作后续扩展；
- **限流/防滥用**：register 与 join-token 创建端点的限流策略（对齐 pending 的 IP 限流）；
- **结构化审计事件**：register / token 端点的日志事件格式（M5 审计的输入，§6.2-1）；
- **token 格式/长度**：复用 `randomToken(32)` base64url（≥16 校验沿用）；
- **portal UI 细节**：一键复制、自签开关、未安装提示、常驻服务开关（§2.4）；
- **M4 插件**：仅留钩子接口（D13）；web UI 面板属 dsh-plugin（M4）范围，本次不实现（§2.6）。

## 8. 参考

- 关联修复：`doc/fix/20260824-join-token-persist/`、`doc/fix/20260824-join-token-reject/`、`doc/fix/20260824-join-service-install/`
- 相关代码：`packages/gateway/src/{join,service,token-store}.ts`、`packages/hub/src/{api,server,db,jwt}.ts`、`packages/cli/src/bin.ts`、`packages/portal`
- 既有文档：`doc/feature/03-hub/`（层 1 API / host 生命周期 / pending 绑定）、`doc/overview/usage.md` §8
