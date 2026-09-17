# 远程浏览器无法选择宿主目录（solution）

> **日期**: 2026-09-17
> **需求**: [bug-report.md](bug-report.md)（AC1–AC6）；事实依据 [discussion.md](discussion.md)（F1–F24）
> **决策**: discussion §7（D1 = 插件事无条件 pin browse；D2 = CLI 注入 `SSH_TTY`；D3 = 取消开关，仅保留只读诊断）

---

## 1. Goal（目标架构）

无论走哪条入口，**远端浏览器**拿到的目录选择器都必须是 DSH 的 `browse` 交互（浏览器内目录浏览器，读宿主文件系统）：

| 部署形态 | 目标行为 |
|---|---|
| 装了 `dsh-web-remote` 的 profile | 该 profile **任何** boot 都是 `browse`（与隧道状态无关） |
| CLI `rdsh host serve` / `rdsh host join` spawn 的 dsh（profile 可能没装插件） | 也是 `browse` |
| 两者叠加 | 正常启动，仍是 `browse`（不得重复注册/重复 id） |

## 2. Facts（已在 discussion 核实并实测的关键事实）

| # | 事实 | 依据 |
|---|---|---|
| F1 | DSH 选择器 boot 时二选一，`native`/`browse`；`browse` 后端不渲染宿主显示 | discussion F1/F6 |
| F2 | 判定输入只有 4 个：bindHost（死路）、SSH 信号、platform、Linux DISPLAY+chooser | F2/F3/F4 |
| F3 | 钉住交互 = patch 层 `disabled` 掉 auto 行 + 组合 `-browse` 双面 | F7/F13（实测） |
| F4 | 插件 bundle patch 层序在 `dsh-web-app` **之后** ⇒ 能覆盖它的 auto 行 | F23（实测 dump 层标记） |
| F5 | **重复插入同 id / 重复注册 service 都是启动期致命错误** | F14/F17（实测报错文本） |
| F6 | 插件的 loader 是**子树作用域**：拿不到兄弟行 ⇒ 运行时热替换不可能 | F15（实测 4 种取法） |
| F7 | 插件可以用 `ctx.get(name)` 读取服务而不建立硬依赖（缺席时返回 undefined，不会拖垮插件树） | `@deepseek-ai/cordis` `Context.get` 语义（lib/index.js:755） |
| F8 | SSH 信号 = 继承进程层里非空 `SSH_CONNECTION`/`SSH_TTY`（`.env` 不算） | F4 |
| F9 | CLI spawn 处尚无任何 env 注入；`spawnDsh` 是唯一入口（serve / join 都走它） | F10；`packages/gateway/src/serve.ts:52`、`join.ts:1042` |
| F10 | `--host 0.0.0.0` 被上游拒绝，不能靠放开绑定来触发 browse | F3 |
| F11 | 页面 boot graph 按页面加载冻结；patch 在 boot 层生效 ⇒ **无需刷新页面** | F9（客户端）+ F13 |
| F12 | 上游对 patch 文件是 fail-loud（非法 YAML 会导致启动失败）——本轮我们**不写任何用户文件**，规避该类风险 | F19/F22 相关说明 |

## 3. Gap

- **G1（插件）**：`packages/web-remote/cordis.patch.yml` 只插入了自己的行，没有钉住 browse ⇒ 装的 profile 仍解析 `native`。
- **G2（CLI）**：`packages/gateway/src/spawn-dsh.ts:66` 的 spawn 不注入 SSH 信号 ⇒ 没装插件的 profile 仍解析 `native`。
- **G3（可观测性）**：面板没有任何"当前选择器类型"信息 ⇒ 一旦上游判定变化或存在第二 pin 通道，用户无从察觉（只会看到"又是原生对话框"）。
- **G4（文档）**：没有"禁止手工 pin / 升级注意"的用户文档入口。

## 4. Call-site Audit（契约变更审计）

| 变更 | 调用点 | 兼容性 |
|---|---|---|
| `spawnDsh` 增加 spawn env（内部实现细节，签名不变） | `packages/gateway/src/serve.ts:52`、`join.ts:1042`、`packages/gateway/test/spawn-dsh.test.ts` | ✅ 签名不变；两个调用点无需改动 |
| `dsh-web-remote` 状态 RPC 返回值新增只读字段 `pickerKind` | `packages/web-remote/client.js`（面板）、`test/rpc-route.test.ts` | ✅ 仅新增字段；旧客户端忽略未知字段 |
| `cordis.patch.yml` 新增 patch 条目 | boot 时由 `dsh-app-boot` 消费（无代码调用点） | ✅ 纯声明式 |
| `Ctx`（web-remote 本地类型）新增 `get(name): unknown` | `src/index.ts` 内部 | ✅ 仅类型声明 |

## 5. Tasks（精确落点）

### T1 插件侧：钉住 browse（`packages/web-remote/cordis.patch.yml`）

在现有 `- insert:`（`remote-access` 行）之外，追加两个 patch 条目（**已验证可用的形态**，discussion F13）：

```yaml
# ── 钉住目录选择器：本插件就是为远程访问而生，远端浏览器够不到宿主 OS 对话框。
#    禁用 boot 期自适应行，直接组合 browse 后端与其浏览器半。
#    ⚠ 唯一声明式插入者：任何第二个 pin 通道（手工 patch / CLI --patch）都会
#      导致 duplicate loader entry id 或重复注册 directoryPicker → dsh 启动失败。
- id: directory-picker
  disabled: true

- insert:
    - id: directory-picker-browse
      name: '@deepseek-ai/dsh-host-directory-picker-browse'
    - id: ui-directory-picker-browse
      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'
```

- `package.json` 的 `files`/`dsh.bundle.patch` 已包含该文件，无需改动（已核实）。
- 不改 `packages/web-remote/src/index.ts` 的隧道业务。

### T2 插件侧：面板只读诊断（`src/index.ts` + `client.js`）

- `src/index.ts`：把 `pickerKind` 加入 `state` RPC 返回值，取值：
  `ctx.get("directoryPicker")?.capability?.().kind ?? "none"`（用 `get` 避免硬依赖，F7），并附 `expected: "browse"` 与布尔 `pickerOk`。
- `client.js`：在远程访问面板显示一行状态，例如「目录选择：浏览器内（browse）」；若非 `browse` 显示告警文案（含"可能被其它 patch 层覆盖，请检查 profile 的 cordis.patch.yml"）。
- i18n 文案与现有面板风格一致（中英）。

### T3 CLI 侧：注入 SSH 信号（`packages/gateway/src/spawn-dsh.ts`）

- 抽出纯函数（便于单测）：`dshSpawnEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv`
  - 若 `base.SSH_TTY`/`base.SSH_CONNECTION` **已有非空值** → 原样保留（用户真在 SSH 里启动）；
  - 否则设 `SSH_TTY = "rdsh-remote"`（**只设 `SSH_TTY`**：`SSH_CONNECTION` 有固定 `"ip port ip port"` 格式，写假值会误导解析它的工具）；
  - 值取可读字面量而非 `/dev/...`，让 `env` 里一眼看出这是 rdsh 注入的。
- spawn 调用改为 `spawn(dshPath, ["web", "--port", "0", "--no-open"], { stdio: [...], env: dshSpawnEnv(process.env) })`。
- 注释写清：这是上游 `resolveDirectoryPickerBackend` 的**文档化输入**（"操作者看不到宿主显示"正是 rdsh 场景），并登记"上游改信号即失效"的风险。

### T4 CLI 侧：spawn 后的自检告警（`serve.ts` / `join.ts` 共用小函数）

- 复用既有的会话 cookie 换发（`exchangeDshSessionCookie`），GET 一次 DSH 首页，检查注入的 boot graph 是否含 `directory-picker-browse`；
- 缺失则打印一行**警告**（不阻断服务）：「远端浏览器的目录选择可能退化为宿主原生对话框（DSH 判定信号可能已变更）」。
- 该检查是"上游启发式失效"的兜底；纯只读、一次 HTTP。

### T5 测试

| 文件 | 覆盖 |
|---|---|
| `packages/gateway/test/spawn-dsh.test.ts`（扩展假 dsh 脚本打印 `SSH_TTY`） | `spawnDsh` 真的把 `SSH_TTY` 传给子进程；已有真实 SSH_TTY 时不覆盖 |
| 新增 `packages/gateway/test/spawn-env.test.ts` | `dshSpawnEnv` 纯函数：空 env / 已有 SSH_TTY / 已有 SSH_CONNECTION / 两者都有 |
| `packages/web-remote/test/picker-patch.test.ts` | 解析 `cordis.patch.yml`：含 `id: directory-picker / disabled: true`、含且仅含两个 browse 行且 `name` 精确匹配；行 id 不与自身 `remote-access` 冲突 |
| `packages/web-remote/test/rpc-route.test.ts`（扩展） | `state` 返回含 `pickerKind`/`pickerOk`；`ctx.get` 缺席时给 `"none"` 而不抛 |

### T6 文档与变更日志

- `doc/overview/usage.md`：故障排查表新增两行（"远端点添加工作区弹在宿主屏幕" → 原因 + 处理；"装了插件后本机也用浏览器内选择" → 预期行为）；FAQ 补"不要手工 pin 目录选择器"。
- `packages/web-remote` 的安装说明（`doc/feature/06-dsh-plugin/` + 对外 README/博客所在处）：写明插件装好后**目录选择恒为浏览器内**，以及升级注意（若曾手工 pin，先删）。
- `CHANGELOG.md` / `CHANGELOG.zh.md`：修复条目 + 兼容说明（pin 的唯一通道契约）。

### T7 真机验证（产出 verification.md 的证据）

- AC1：装了插件的 profile 启动 dsh web → 取页面 boot graph 断言含 `directory-picker-browse`、不含 native；浏览器实测选目录 + 新建目录。
- AC2：CLI spawn（未装插件的 profile 或临时 profile）→ 同样检查。
- AC3：装插件 + CLI spawn 同时存在 → dsh 正常启动（无重复 id / 无重复 service）。
- AC5：`pnpm build` + `pnpm test` 全绿；join 面板连通/断开冒烟。

## 6. 风险与回退

| 风险 | 影响 | 缓解/回退 |
|---|---|---|
| 上游改变选择器判定（去掉 SSH 信号或改默认） | CLI 路径（未装插件）静默退回 native | T4 自检告警；`DSH_COMPAT_MAX` 版本围栏升级时复核 |
| 用户按旧文档手工 pin 过 | 与插件 patch 冲突 → **dsh 启动失败** | T6 文档明写；面板诊断文案给出排查指引 |
| 插件 patch 在未来上游版本里行 id/包名变化 | patch 找不到 id（仅告警）或找不到包（加载失败） | 版本围栏 + 真机冒烟；上游 CHANGELOG 复核 |
| 注入 `SSH_TTY` 让 agent 子进程以为在 SSH 会话 | 模型可能误判环境 | 值用 `rdsh-remote` 自解释；文档登记；若不可接受则改回 M4（需同时放弃插件 pin） |

**回退方式**：删除 `packages/web-remote/cordis.patch.yml` 中新增的两个 patch 条目 + 撤掉 `spawnDsh` 的 env 注入，即回到当前行为（无数据/协议破坏，纯声明式 + 一行 spawn 选项）。
