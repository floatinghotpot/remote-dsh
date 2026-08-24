# 04-cli-refactor — 讨论（discussion.md）

> **日期**: 2026-08-24
> **范围**: CLI 面重构 —— 组件化命令树（`rdsh host` / `rdsh hub`）、`host.json` 配置模型、self-revoke、证书自动检测；**`05-join-easy` 的前置**
> **来源**: `05-join-easy` 讨论中定型（CLI 按组件环境组织：本机 vs 服务器；用户定案：直接重构、config.json→host.json、加 self-revoke）
> **状态**: 讨论记录（READ-ONLY 后：需求进 req.md）

---

## 1. 目标

按**组件环境**重构 rdsh CLI，消除「动词（serve/join）与组件（hub）混排」的困惑：

- 本机（DSH 主机）任务统一归 **`rdsh host *`**：lan / join / serve / service / leave / user；
- 服务器任务保持 **`rdsh hub *`**（不变）；
- 配置模型统一为 **`~/.rdsh/host.json`**（唯一事实源），`config.json` 迁移并入；
- 新增 **`rdsh host leave`**（self-revoke，注销本机）；
- 证书处理**全自动**（用户路径不出现 `--insecure`）；
- 为 `05-join-easy`（`host join` 交互 UX、register）铺路。

## 2. 查档事实（现状 CLI，`packages/cli/src/bin.ts`）

### 2.1 当前命令树

```
rdsh serve [--config] [--port] [--host] [--pair-code] [--session-ttl] [--dsh] [--reset] [--no-code]
rdsh join <hub-url> [--token] [--reset] [--dsh] [--insecure]
rdsh join service install|status|uninstall <hub-url> [--dsh] [--insecure]
rdsh hub serve|user|host|service ...
rdsh user add|passwd|ls|rm
rdsh service install|status|uninstall
rdsh --version | --help
```

### 2.2 现状问题（本次重构动机）

- **语义混排**：`serve`/`join` 是动词（都是本机任务），`hub` 是组件（服务器）——顶层看不出「谁在哪个环境」；
- **配置分裂**：serve 用 `~/.rdsh/config.json`，join 用 session 文件（`~/.rdsh/join-<host>.token`），hub 用 `~/.rdsh/hub.json`——host 侧缺一个统一事实源；
- **join 常驻 vs serve 常驻**：都是常驻进程，但命令形态不同（join 带 hub-url、serve 带一堆 flag），用户心智负担重；
- **API key 配置复杂**：当前靠 env/join.env 注入，DSH 自带粘贴框经 portal 不显示（`doc/fix/20260824-portal-apikey-pastebox`，P1）——重构后 key 归 DSH 管理，rdsh 不再配置。

### 2.3 可复用基础

- `service.ts` 的 `installService(spec)` 已支持组件参数与独立服务名（`rdsh-join`）——重构只需改传参；
- `token-store.ts`（session 文件 0600）、`join()` 库函数（数据进、进程出）——CLI 只是换壳；
- `parseGlobal` / 子命令分发框架——重构分发逻辑。

## 3. 需求讨论记录（2026-08-24）

1. 组件化提议（用户）：`rdsh serve` / `rdsh join` 合并为 **`rdsh host xxx`**（都是 DSH 主机上的任务）；`rdsh hub xxx` 保持（服务器组件）。
2. 配置驱动（用户）：`rdsh host join <hub>` 交互收参 → 写 `host.json`；`rdsh host serve` 前台跑（读配置）；`rdsh host service install` 服务化（读配置，无长参数）；`rdsh host leave` 撤销。
3. 三定案（用户拍板）：① `config.json` → `host.json` 迁移（手动或 CLI 自动）；② 新增 **self-revoke 端点**（`host leave` 真正清掉 hub 死条目）；③ **直接重构不留别名**（breaking change）。
4. 证书自动检测（用户：让用户更省事）：`host join` 先按正常校验连接，证书失败自动用 insecure 重连并持久化到 host.json + 打印一行提示；用户路径不出现 `--insecure`。
5. configure/run 分离（用户确认）：`host join` / `host lan` 配置完**退出**；`host serve` 才是常驻前台。

## 4. 已达成决策

| # | 决策 | 说明 |
|---|---|---|
| D1 | **命令树** | `rdsh host {setup lan\|cloud, join, serve, service, leave, user}`；`rdsh hub {serve,user,host,service}` 不变（见 §4.1） |
| D2 | **host.json 唯一事实源 + 3 模式** | `{ mode: "lan"\|"cloud"\|"join", ... }`：lan/cloud = 独立服务（均暴露 IP，云需更强保护），join = 出站隧道（不暴露 IP）；auth.users 内嵌；token 不进配置，只进 0600 session 文件 |
| D3 | **config.json → host.json 迁移** | `rdsh host serve` 启动检测旧文件自动迁移，或 `rdsh host migrate` 手动；同步更新全部文档 |
| D4 | **self-revoke 端点** | `POST /api/hosts/self-revoke {token}`：host 持自己的 host token 注销自己（断隧道 + 删条目）；`rdsh host leave` 调用 |
| D5 | **证书自动检测** | `host join` 先正规校验，失败自动回退 insecure 并持久化 + 一行提示；用户路径无 `--insecure`（保留高级覆盖） |
| D6 | **configure/run 分离** | `setup lan/cloud`、`join <hub>` 配置完退出；`host serve` 常驻前台（读 host.json 按 mode 分发） |
| D7 | **leave → 未配置** | `leave` = self-revoke + 清 session + **删 host.json**（回到全新未配置，`serve` 报「未配置，请先 setup 或 join」）；非 join 模式跑 leave 报错 |
| D8 | **直接重构不留别名** | 移除顶层 `serve/join/user/service`；breaking change，影响文档/博客/e2e/既有 unit（重装） |
| D9 | **执行顺序** | 04-cli-refactor **先于** 05-join-easy；05 的 `host join` 交互 UX 叠加在本重构之上 |

### 4.1 目标命令树

```
rdsh host                          # 本机（DSH 主机）
├── setup lan                      # 独立服务 LAN 预设：pair + http（交互向导）
├── setup cloud                    # 独立服务云预设：password + tls + allowFrom（交互向导）
├── join <hub-url>                 # 连 hub：交互 token/name → 注册 → 写 host.json + session，退出
│     [--token <t>] [--name <n>] [--dsh <p>]     # 证书自动检测，无 --insecure
├── serve                          # 前台常驻：读 host.json，按 mode 分发 lan/cloud/join
├── service install|status|uninstall    # 服务化：读 host.json（无长参数）
├── leave                          # 注销：self-revoke + 清 session + 删 host.json（未配置）
└── user add|passwd|ls|rm          # 本机网关用户
rdsh hub serve|user|host|service … # 不变
```

## 5. 与 05-join-easy 的关系

- **04 是 05 的前置**：05 的 `host join` 交互粘贴 token + register 换 host token + `--name`，全部跑在新命令树与 host.json 之上；
- 04 阶段的 `host join` **先用现有配对码/--token 流程**（写配置后退出），05 再改写为 register + 交互 prompt；
- **paste-box 修复**（`doc/fix/20260824-portal-apikey-pastebox`，P1）独立于两者，可并行。

## 6. 待定 / 留钩子

> ✅ 已闭合（2026-08-24）：host.json 字段集 —— **3 模式**（lan/cloud/join），lan/cloud 为独立服务字段（host/port/sessionTtlSeconds/tls/auth/behindProxy/allowFrom），join 为 hub 字段（hub/name/insecure），auth.users 内嵌；leave → 未配置（删 host.json）。

- **高级云部署**是否保留 `--config <path>` 覆盖 ✅ 已闭合：保留（默认 `~/.rdsh/host.json`，setup/serve/service 都接受）；
- **迁移触发** ✅ 已闭合：**自动迁移**（配置加载层检测旧 config.json → 转 host.json，原文件保留；无显式 migrate 命令）；
- **self-revoke 限流** ✅ 已闭合：IP 限流 10 次/分钟（复用 pending 限流模式）；
- **旧 service unit 迁移 + 服务名对齐** ✅ 已闭合：升级后重跑 `rdsh host service install` 覆盖（不做自动迁移）；服务名独立——host 独立服务 `rdsh-host.service`、join `rdsh-join.service`、hub `rdsh-hub.service`（原 `rdsh.service` 改名）。

## 7. 参考

- 相关代码：`packages/cli/src/bin.ts`、`packages/gateway/src/{service,join,token-store}.ts`、`packages/hub/src/{api,server,db}.ts`
- 下游依赖：`doc/feature/05-join-easy/discussion.md`（本重构是其后置依赖）
- 关联修复：`doc/fix/20260824-portal-apikey-pastebox/`（P1，独立并行）
- 既有文档：`doc/overview/usage.md` §8、`doc/blog/{zh,en}/`（命令引用需随重构更新）
