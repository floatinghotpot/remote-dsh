# 06-dsh-plugin — 需求（req.md）

> **日期**: 2026-08-24
> **状态**: ✅ 已批准（2026-08-24）
> **范围**: M4 —— DSH 插件形态的 rdsh-gateway：`dsh plugin --profile <name> add dsh-web-remote` 即获网关/join，免装 CLI。DSH 界面出现「远程访问」面板：连 hub（join）、状态/启停。
> **来源**: [discussion.md](discussion.md)（D1–D6 定案、P1–P5 查证、P6 推迟）
> **主名**: `dsh-web-remote`（已预留 0.0.0；README/roadmap 在实现前不写全名，只写 `dsh plugin add`）

---

## 1. 目标

让用户**不装 rdsh CLI**，直接在 DSH 里获得远程访问能力：

```
dsh plugin --profile default add dsh-web-remote
  → DSH 界面出现「远程访问」面板
  → 粘贴 hub URL + join token → [接入] → 注册 + 持久化 + 隧道（转发到本进程 dsh）
  → 实时状态点（未接入/连接中/已连接/断线重连/外部托管）+ [断开][注销]
```

- **复用 04/05 已验证的 host 核心**（join 隧道、host.json、session token 文件、证书自动检测），插件是**薄包装**；
- **双通道分发**：CLI 与插件并存，同一 host 核心、同一 host 身份（单身份铁律）；
- 安全底线沿用 05：join token 一次性、host token 只落 session 文件（0600）、hub 侧只存哈希。

## 2. 面板 UI 草案（文本 demo）

> 面板 = DSH 界面里的「远程访问」设置页（`dsh.bundle.client` 呈现）。状态点含义：
> `○ 未接入`（灰）｜`● 连接中`（琥珀）｜`● 已连接`（绿）｜`◐ 断线重连`（红）｜`⚙ 外部托管`（灰·只读）。

**态 A — 未接入（表单）**：首次进入，或「注销/断开」后待填。状态点恒在面板顶部。

```text
┌─ 远程访问 ─────────────────────────────────┐
│  状态：○ 未接入                              │
│                                              │
│  Hub 地址    [ https://hub.example.com       ]│
│  Join Token  [ 粘贴一次性接入令牌…           ]│
│  主机名      [ my-mac                 ]       │
│                                              │
│  （自签证书自动检测，无需开关）              │
│                                              │
│  [ 接入 ]                                    │
└──────────────────────────────────────────────┘
```

**态 B — 连接中**：点[接入]后，注册 + 起隧道期间。

```text
│  状态：● 连接中…                            │
│                                              │
│  Hub 地址    https://hub.example.com          │
│  主机名      my-mac                          │
│                                              │
│  [ 断开 ]                                    │
```

**态 C — 已连接**：隧道建立，常态。

```text
│  状态：● 已连接                              │
│                                              │
│  Hub 地址    https://hub.example.com          │
│  主机名      my-mac                          │
│                                              │
│  [ 断开 ]   [ 注销 ]                         │
```

**态 D — 断线重连**：隧道丢失，自动指数退避重连（**无手动重连按钮**）。

```text
│  状态：◐ 断线，4 秒后自动重连…              │
│                                              │
│  Hub 地址    https://hub.example.com          │
│  主机名      my-mac                          │
│                                              │
│  [ 断开 ]                                    │
```

**态 E — 外部托管（只读）**：pid 锁 `role=cli`（CLI 前台 / `rdsh-join.service` 在跑）。插件不拥有隧道 → 只读、禁用三按钮。

```text
│  状态：⚙ 已接入（由 rdsh CLI / 服务托管）    │
│                                              │
│  请用 rdsh 命令管理：                        │
│    rdsh host join <hub> / rdsh host service …│
│                                              │
│  （接入 / 断开 / 注销 已禁用）               │
└──────────────────────────────────────────────┘
```

**态 F — 断开后（配置保留）**：显式[断开]后回到表单，hub/name 预填，点[接入]即复用持久 token 重连（无需重贴 join token）。

```text
│  状态：○ 未接入（已断开，配置保留）          │
│                                              │
│  Hub 地址    [ https://hub.example.com       ]│
│  主机名      [ my-mac                 ]       │
│                                              │
│  [ 接入 ]                                    │
└──────────────────────────────────────────────┘
```

## 3. 范围

### 3.1 包含（In Scope）

| 编号 | 需求 | 验收标准 |
|---|---|---|
| R1 | **分发形态（npm 插件）**：`dsh-web-remote` 声明 `dsh.bundle`——服务端 `dsh.bundle.patch = "./cordis.patch.yml"` 插入自写 server 插件（`import rdsh-gateway` 的 join 核心）；客户端 `dsh.client = { inject:[…], platform:"web" }` + `exports["./client"]` → `lib/client.js`（设置页）。依赖 `rdsh-gateway`（常规 npm 依赖，D6）；客户端发现要求包已作为 loader 行挂载（cordis.patch.yml 的服务端行即满足） | `dsh plugin --profile <name> add dsh-web-remote` 后 profile 层列表出现该 bundle；DSH 界面出现「远程访问」面板 |
| R2 | **内嵌 join 核心（D1/D4/D13 钩子落地）**：`join()` 支持「不 spawn、外部 target」模式——转发目标 = 本进程 dsh（`127.0.0.1:<dsh 端口>`），不 spawn 第二个 dsh；暴露可停止句柄 `stop()`（关 WS、清 heartbeat、**不** `process.exit`）+ 状态/日志事件钩子 `onState` / `onLog` | 插件路径不 spawn、可停止、状态事件驱动 UI；CLI 原路径（spawn dsh + 信号退出）回归不变（05 全量测试通过） |
| R3 | **面板四态 + 外部托管（D2）**：接入表单（hub URL + join token + name + [接入]）、实时状态点（未接入/连接中/已连接/断线重连）、[断开][注销]、外部托管只读态。**无手动重连**（断线自动退避重连）；**MVP 不做面板内日志区**（`onLog` 先落钩子不渲染） | 五态切换与 §2 demo 一致；断线自动重连无需按钮；CLI 在跑时面板只读且禁三按钮 |
| R4 | **配置记忆（D3）**：接入 = 写 `~/.rdsh/host.json` `{mode:"join", hub, name, insecure}`（字段已存在）+ `registerJoin` 落 host token 到 `~/.rdsh/join-<host>.token`（0600）。复用 `loadConfig`/`saveConfig`/`normalizeConfig`/`registerJoin` | host.json 含 join 字段且**无 token**；token 只在 session 文件；dsh 重启后复用 token 自动重连（免重贴） |
| R5 | **进程托管（D4）**：无 spawn、无守护；崩溃重启交给 dsh 自己的 supervisor（`dsh web` 的 systemd/前台）。插件卸载 / dsh 关停时经 Cordis dispose 钩子调 `stop()` | dsh 关停后无悬空 WS / heartbeat / 定时器；dsh 重启后插件重载自动重连 |
| R6 | **与 CLI 共存（D5 档1+2）**：档1——接入前读 host.json，`mode` 存在且 ≠ join → 显式确认才覆盖（防静默 clobber lan/cloud）；档2——join 核心加 pid 锁文件 `~/.rdsh/join.lock`（`pid + role`，启动写/退出清/stale 清理），接入前检测 CLI join 在跑则拒绝。**不越权杀服务** | 档1 冲突时面板提示需确认；档2 CLI join 在跑时拒绝接入；stale 锁（pid 已死）自动清理 |
| R7 | **断开 / 注销语义**：断开 = `stop()` 停隧道，**保留** host.json + token（态 F 可一键再接）；注销 = `stop()` + hub `self-revoke` + `clearPersistedToken` + 清 host.json join 字段（回默认 mode） | 断开后状态回「未接入」、可复用 token 再接；注销后 hub 侧 host 移除、本地 token/join 配置清除、面板回「未接入」空表单 |
| R8 | **安全**：join token 一次性（不落 host.json / session / 日志）；host token 仅 session 文件 0600；hub 侧只存哈希（05 已有）；日志脱敏 | 代码审查 + 测试断言：host.json 无 token、日志无明文 token、session 文件 0600 |
| R9 | **文档 / 发布纪律**：实现前 README/roadmap **只写 `dsh plugin add`，不写全名**；发布后补 CHANGELOG、博客（zh/en）、README 双语（`dsh plugin add dsh-web-remote` 流程） | 文档无提前泄名；发布说明含插件安装 + 面板操作指引 |

### 3.2 前置依赖（Prerequisites）

| 依赖 | 说明 |
|---|---|
| **04-cli-refactor** | `join()` 核心、host.json（3 模式含 join 字段）、session token 文件、证书自动检测、`self-revoke` |
| **05-join-easy** | register/join-token 流程、`registerJoin`（token 注册→持久化→复用）、portal 生成 join token —— 插件接入直接消费 |
| **D13 钩子落地**（gateway `join()` 重构） | R2 的「no-spawn、外部 target + `stop()` + `onState`/`onLog`」是 05 预留的接口钩子 |

### 3.3 不含（Out of Scope）

- ❌ lan/cloud 网关面板（插件只管 join；lan/cloud 归 CLI/service，D5 职责切分）
- ❌ 面板内日志查看区（`onLog` 仅落钩子，MVP 不渲染）
- ❌ 面板「一键重启」dsh（D4：重启交给 supervisor）
- ❌ hub 侧同 hostId 第二条隧道「顶替/拒绝」（D5 档3，deferred，需 hub 改动）
- ❌ npm org 锁 scope / scoped 路线（P6 推迟；主名走裸名 `dsh-web-remote`）
- ❌ 多 profile 多主机身份（host.json 单身份铁律，D3/D5）

## 4. 端到端验收场景

> **场景**：用户有一台跑着 DSH 的机器 + 一个已上线的 hub（portal 已登录）。

1. **安装**：`dsh plugin --profile default add dsh-web-remote` → 重启 DSH web → 界面出现「远程访问」面板（态 A）。
2. **接入**：portal「添加主机」生成 join token → 面板粘贴 hub URL + token + 主机名 → [接入] → 态 B → 态 C（已连接）；hub portal 见该主机在线。
3. **免配重连**：重启 dsh web → 插件重载 → 复用 session token 自动重连（态 C，无需重贴 join token）。
4. **断线自动重连**：hub 临时不可达 → 态 D（退避重连）→ 恢复后态 C；全程无手动重连按钮。
5. **断开**：[断开] → 态 F（配置保留）→ [接入] 一键复用 token 回态 C。
6. **注销**：[注销] → hub 侧主机移除、本地 token/join 配置清除 → 面板回态 A 空表单；再次接入需新 join token。
7. **CLI 共存（档1）**：已有 `rdsh host setup lan` + `rdsh-host.service` → 面板接入时提示「将覆盖 lan/cloud 配置」，需显式确认才继续。
8. **CLI 共存（档2）**：`rdsh host join`（前台或 `rdsh-join.service`）在跑 → 面板显示态 E（外部托管，只读），拒绝重复接入。
9. **安全**：接入后 `~/.rdsh/host.json` 无 token；`join-<host>.token` 0600；DSH 前端/日志无明文 token。

## 5. 验收执行方式

- 自动化：`node --test`（join 核心 no-spawn/stop/onState 单元、host.json 无 token 断言、pid 锁写/清/stale 清理、档1 mode 冲突判定）
- e2e：本机 hub + DSH（`dsh web`）+ 插件安装 → 面板接入/断开/注销全流程；CLI 回归（05 全量不回归）
- 文档：`verification.md` 逐条对照 R1–R9 + RTTM

## 6. 待定项（留给 solution.md，不阻塞 req 批准）

- `cordis.patch.yml` 的精确 `insert`/`inject`/`config` 结构（对照 `dsh-client-ui-settings` 等实例落地）
- `onState`/`onLog` 钩子的具体签名与状态机枚举（未接入/connecting/connected/reconnecting/外部托管）
- pid 锁的精确格式与 stale 判定（pid 存活检测跨平台实现）
- 注销后 host.json 的精确回退（`mode` 回 `lan` 还是仅清 hub/name/insecure）
- 面板状态在 DSH 前端的持久化/刷新策略（`ctx.settingsSchema` vs 运行时状态的分界）

*关联文档：discussion.md | 前置依赖：04-cli-refactor（req.md）、05-join-easy（req.md）| 下一步：solution.md（待 req 批准后）*
