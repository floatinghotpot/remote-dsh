# 树莓派 / Linux 安装 dsh + remote-dsh：公共步骤与平台特化（discussion）

> **日期**: 2026-09-14
> **来源**: 用户在 Raspberry Pi 5（Ubuntu 24.04.3 LTS / aarch64）上的实测记录 —— `~/sysadmin/20260913-raspberry-fail-boot/docs/dsh-rdsh-install-extra-work.md`（本文只做**分类 + 代码审计 + 处置决策**，不改写那份记录；凭据值不进入本仓）
> **结论**: 那份记录里**真正树莓派专属的只有 6 条**，其余 **9 条是公共 Linux 问题**（ECS Ubuntu 同样会踩：装服务撞锁、凭据位置、`join.env` 不生效）⇒ **先修公共路径**（`01-07` 博客 + `usage.md` + 1 项代码加固），**再写树莓派篇**
> **范围**: 只覆盖"**用 CLI 命令**装对、配对、起来"（见 §0）；"在 DSH agent 会话里执行这些命令"**明确排除**。**含**：让 dsh 真正可用所必需的 **API key 配置入口**（远程 UI 设置页，见 §1 现象 3 / §4⑥）
> **关联**: [`doc/blog/zh/01-07-host-service-mode-linux.md`](../../blog/zh/01-07-host-service-mode-linux.md)、[`doc/overview/usage.md`](../../overview/usage.md) §8.5、`packages/gateway/src/service.ts`、[20260824-join-service-install](../20260824-join-service-install/bug-report.md)、[05-join-easy](../../feature/05-join-easy/discussion.md)（D17）

---

## 0. 本文范围（先定边界）

**覆盖**：用户**用 CLI 命令**在一台 Linux 主机上把 dsh + remote-dsh **装对、配对、起来** —— `npm i -g`、凭据配置、`rdsh host service install` 前后（配置落点、服务名、开机自启、前台→后台切换）、以及与之相关的文档（`01-07` 博客、`usage.md` §8.5）。

**不覆盖（明确排除）**：

1. **在 DSH agent 会话里执行这些命令** —— 那边会撞 DSH 的 landlock 沙箱（只允许写 `/tmp` 与工作区），属 **DSH 侧行为**，不是 remote-dsh 的安装路径问题（原记录 §5 因此移出本文）；
2. **dsh / DSH 自身的凭据机制内部实现** —— 本文只处理"文件在哪、权限多少、怎么操作"（F12）；
3. **树莓派专属环境事项** —— 单独成篇（§3 下半部分）。

> 排除第 1 条的理由：它混进来会把主题从"**怎么装对、怎么起来**"发散成"**DSH 沙箱怎么绕**"，而后者与本次要修的代码/文档无关。若将来需要，应由 DSH 侧文档或以 FAQ 一行带过。

---

## 1. 现象

在 Pi 5 上按博客走完：`npm i -g @deepseek-ai/dsh` + `npm i -g remote-dsh` + `rdsh host service install` 之后，出现了两类"装得上但用不起来"的情况：

1. **会话跑不起来**：`dsh` / `rdsh --version` 正常，但实际会话无法调用 LLM —— 缺 `~/.dsh/.credentials.yaml` 里的 `refs.DEEPSEEK_API_KEY`；
2. **服务起不来**：`service install` 装了 unit 但服务反复重启 —— 前台的 `rdsh host serve` 占着 `~/.rdsh/join.lock`。

> **已移交（不属于本记录主题）**：安装途中还顺带发现了"**远程 Web UI 进不去设置 / 配不了 key**"。那是一类**通用的远程会话问题**（与 OS、与 Pi 无关：任何 host 只要经 hub + E2EE 或经 LAN 代理访问都会遇到），已单独立项 —— [`doc/fix/20260914-remote-webui-settings`](../20260914-remote-webui-settings/discussion.md)（含三个阻碍因素与 AC1–AC3）。原先写在本记录的 F16–F26 与 §4⑥ 已随之迁出。

用户据此写了一份 8 类"额外工作"的实践记录，并提出切分：**哪些是 Linux 公共的（→ 修公共博客/代码）**、**哪些是树莓派专属的（→ 另写一篇）**。

## 2. 事实审计（代码与文档，均带 file:line）

| # | 事实 | 证据 |
|---|---|---|
| F1 | `installService()` 流程 = mkdir → 写 unit(0600) → `daemon-reload` → `enable --now`，**全程没有 `join.lock` 预检** | `packages/gateway/src/service.ts:134-144` |
| F2 | `ServiceSpec.envFile` **存在且可用**（会生成 `EnvironmentFile=-<path>`） | `service.ts:55-56,68`；测试 `packages/gateway/test/service.test.ts:42-50`（路径用的正是 `~/.rdsh/join.env`） |
| F3 | **CLI 两处调用都不传 `envFile`** ⇒ 用户自建的 `~/.rdsh/join.env` 被**静默忽略** | `packages/cli/src/bin.ts:343`（host）、`:529`（hub） |
| F4 | `join.env` 这个名字**有出处**：8-24 的设计明确要求 unit 带 `EnvironmentFile=-<homedir>/.rdsh/join.env` | `doc/fix/20260824-join-service-install/bug-report.md:46,59`、`doc/fix/20260824-join-service-path/bug-report.md:71` |
| F5 | 8-24 CLI 重构时契约"已就绪、无需改签名"，但新命令树不再传 `envFile` | `doc/feature/04-cli-refactor/solution.md:33`；`05-join-easy` **D17** 把 join.env 降级为"**可选逃生通道**，默认路径不需要" |
| F6 | `usage.md` 仍把 `EnvironmentFile` 当作注入环境变量的方式（与 F3 矛盾）；同节已写"API key 更推荐 DSH 自管" | `doc/overview/usage.md:383` |
| F7 | `run()` 只在**非零退出**时抛异常；带 `Restart=on-failure` 的 unit"起来又立刻退出"时 `systemctl start` 通常仍返回 0 ⇒ **install 报成功、服务在后台崩溃循环**（**推断，待 Linux 实测确认**） | `service.ts:124-131`（run）、`:77-78`（Restart/ RestartSec=3） |
| F8 | install 成功后 CLI 打印乐观文案"installed —— 开机自启 + 崩溃重启" | `packages/cli/src/bin.ts:344` |
| F9 | **全仓文档没有任何"装服务前先停前台 serve"的提醒** | `grep` `usage.md` / `01-07` / `01-06` 无匹配 |
| F10 | 锁的 stale 自动清除已实现；撞锁报错文案可读 | `packages/gateway/src/lock.ts:35-48`；`packages/gateway/src/join.ts:319`（`join lock held by <role> (pid N); stop it first`） |
| F11 | PATH 坑**已修**（unit 已生成 `Environment=PATH=…`）；只有 usage.md 那句"后续版本自动处理"是旧话 | `service.ts:69`；`usage.md:373` |
| F12 | 凭据归 DSH 自管：`~/.dsh/.credentials.yaml`（0600、`refs`/`records`、热重载、拒绝空值）；**环境提供的密钥只读、不可持久化** | 用户 Pi 实测（记录 §3）+ `05-join-easy` D17 + `doc/fix/20260824-portal-apikey-pastebox/bug-report.md` |
| F13 | linger 已文档化（服务是用户级，未 enable-linger 则"开机自启"是假的） | `doc/blog/zh/01-07-...:52-58`、`usage.md:359-363` |
| F14 | `01-07` 仍写"我们尚未在树莓派上实测" —— **已过期**（2026-09-13 实测跑通） | `doc/blog/zh/01-07-...:18` |
| F15 | 现有旗标只有 `--token` / `--name` / `--dsh` / `--insecure`；**没有** `--no-start`、`--env-file` | `bin.ts:290-293`、`:371-374` |
> **F16–F26 已迁出**：与"设置页/凭据 UI + loopback 门禁"有关的事实（DSH 的门禁与 `isLoopback` 判定、我们的 JS 补丁、LAN 缺补丁、E2EE shim 门面缺陷）现见 [`20260914-remote-webui-settings` §4](../20260914-remote-webui-settings/discussion.md)。那是一类**通用的远程会话问题**，与本记录的安装主题无关。

## 3. 分类：公共 Linux vs 树莓派专属

**公共（→ 修 `01-07` / `usage.md`，其中 1 项要改代码）**

| 项 | 归属 | 处置 |
|---|---|---|
| 凭据 / API key 位置与"别在服务环境注入 key" | 公共 | 文档：`01-07` 增一节；`usage.md` 立 canonical 段（跨 CLI / 插件 / 服务三种接入） |
| `usage.md:383` 的 `EnvironmentFile` 措辞（F6） | 公共 | **文档必改**：正确写法是 systemd drop-in（同节 PATH 就是范例）；drop-in 本身即是 D17 的"逃生通道"，零代码可自洽 |
| `service install` 撞锁 → 崩溃循环（F1/F7/F8/F9） | 公共 | **代码加固（建议）** + 博客补一句 |
| 别用 `sudo` 跑 rdsh（`homedir()` 变 `/root` ⇒ unit 落到 `/root/.config/systemd/user/`，与用户的 user manager 无关） | 公共 | 文档：`01-07` 补一句 |
| 服务名由 mode 决定（`join`→`rdsh-join`；`host`→`rdsh-host`） | 公共 | 文档：`01-07` 补一句（"用 `rdsh host service status` 查，不要猜"） |
| nvm/自装 Node 的 PATH 坑 | 公共 | 文档：`01-07` 指向 `usage.md` §8.5（不复制第二份） |
| linger（F13） | 公共 | ✅ 已覆盖，不动 |
| `01-07:18` 的"尚未实测"（F14） | 公共 | 文档：Pi 篇上线后回填 |

**树莓派专属（→ 新博客，只写 delta）**：apt 禁区（Pi 上 apt 事务牵动 `flash-kernel` → 可能重刷 `/boot/firmware`，用户上次引导故障即由此触发；NodeSource 加源同样排除）；官方 tarball 装 Node（`chown -R root:root` 修 tar 保留 uid 1001 的坑 + `/usr/local` 软链，及其在四种上下文都优先）；npm 落点坑（`npm config get globalconfig` 报告路径 ≠ 实际读取路径；npm 11 起 `disturl` 非法 → 只能 `NODEJS_ORG_MIRROR`）；arm64 原生模块镜像与系统自带 node v18 的取舍；桌面版自启真相（user unit 依赖 session，Pi 上靠 GDM autologin 才起来；登出+关 SSH → user manager 退出 → 隧道断；`enable-linger` 是**解耦**而非"修自启"）；四种上下文的验证清单。

## 4. 处置建议

**① 代码：安装服务前预检 `join.lock`（建议做）**

失败模式是"命令报成功（F8）、服务静默崩溃循环（F1/F7）"，且文档无提醒（F9）—— 属稳健性缺陷。**但不能简单写成"有活锁就拒绝"**，否则会打断我们自己文档里的流程（`01-07` 日常操作明确写着"升级 Node / 重装 remote-dsh 后重跑 `service install` 即可"，那时锁正是**已装服务自己**持有的）。正确判据：

```
存在活锁（readJoinLock() 非 null；stale 会自动清除，F10）
  且 systemctl --user is-active <服务名> != active
⇒ 失败并给出可读指引（复用 F10 文案）
否则照常安装（重装场景放行）
```

可选一并加 `--no-start`（只 `enable` 不 `--now`）—— Pi 记录里为此手写了 `rdsh-install-only.mjs`，属"用户被迫写 workaround"的信号。

**② 代码：`envFile` / `join.env`（建议不做自动接回）**

不做"恢复自动读取"：Pi 上那个陈旧的 `~/.rdsh/join.env` 会**突然生效**，若内含 `DEEPSEEK_API_KEY`，DSH 会视其为启动环境提供的密钥（只读、拒绝持久化，F12）⇒ 可能顶掉用户后来在界面里保存的 key，症状极难排查。若确有需求，只做**显式 `--env-file <path>`**（库能力现成，F2）。

**③ 可选加固**：装机时若 `Linger=no` 打一行提示（F13）—— 用户级服务未 enable-linger 时"开机自启"是假的，而这正是 Pi 上待办的第 3 项。

**④ 文档**：`usage.md` §8.5 两处措辞修正（F6/F11）；`01-07` 中英各补 4 段（凭据、撞锁提示、`sudo`、服务名）并回填 F14。

**⑤ 树莓派篇**：待公共篇定稿后写，只写 §3 下半部分的 delta，并在开头链接公共篇。

**⑥（已迁出）** 原"远程 UI 进不去设置 / 配不了 key"的代码处置 —— E2EE shim 门面（已修）、host 侧补丁落地（待端到端定性）、LAN 补丁（待决）—— 见 [`20260914-remote-webui-settings`](../20260914-remote-webui-settings/solution.md)。那是一个**通用的远程会话问题**，不属于本记录的安装主题。

## 5. 待确认决策

| # | 决策 | 我的建议 |
|---|---|---|
| D1 | 是否做 **① 锁预检**（+ `--no-start`） | **做**（小、消除"报成功却崩溃循环"；须含"重装放行"测试） |
| D2 | 是否做 **② `--env-file` flag** | **暂不做**（YAGNI；drop-in 已能满足逃生通道）。若你要保留 D17 的显式通道，就只做 flag、绝不自动接回 |
| D3 | 是否做 **③ 加固**（装机时 `Linger=no` 提示） | **做**（3–5 行，直接对应"开机自启是假的"这个真实卡点） |
| D4 | 文档改动范围 | `usage.md` §8.5 + `01-07` 中英各 4 段 + 回填"已实测"；Pi 篇另立 |
| D5 | 树莓派篇的编号与位置 | `doc/blog/{zh,en}/01-09-raspberry-pi.md`（01 系列续号，紧跟 `01-07`/`01-08`） |
| D6 | 是否把 Pi 内部记录改造进仓库 | **改造**（去掉 uid/内核/凭据/主机细节），不原样拷贝 |
| ~~D7/D8~~ | ~~⑥ 修复 / LAN 补丁~~ | **已迁出** → [`20260914-remote-webui-settings`](../20260914-remote-webui-settings/solution.md)（含 AC1–AC3 与因素① 已修的事实） |

## 6. 风险

1. **①的误拒风险**：若判据漏掉"服务已 active"，会打断文档化的重装流程 ⇒ 必须写测试覆盖（服务 active 时放行）。
2. **②若自动接回的风险**见 §4②：陈旧 env 文件突然生效并顶掉 DSH 自管 key ⇒ 只走显式 opt-in。
3. **F7 是推断**（`systemctl start` 在 auto-restart 场景的返回码），需在真实 Linux（ECS 或 Pi）实测确认；若实测发现 install 本来就报错，则①的优先级下调为"改成更可读的报错"。
4. **文档顺序风险**：公共篇没修完就发 Pi 篇，会把过期做法复制到新文章 ⇒ 严格按"公共 → Pi"顺序。
5. **范围外场景仍会有人踩**：用户若在 DSH agent 会话里执行 `service install`，会撞沙箱 —— 本文不覆盖（§0），需要时由 DSH 侧文档或 FAQ 一行带过。
6. **⑥ 的风险已随记录迁出**（E2EE shim 改动需成对验证密文语义 + 设置页恢复）→ 见 [`20260914-remote-webui-settings`](../20260914-remote-webui-settings/solution.md) §5。

## 7. 下一步

待 §5 决策确认 → 写 `solution.md`（改动清单/文件/测试/文档段落）→ `plan.md` → 实施 → `verification.md`。
本文件不涉及任何代码或博客改动。
