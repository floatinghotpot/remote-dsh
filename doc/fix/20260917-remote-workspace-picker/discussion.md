# 远程浏览器无法选择宿主目录（discussion）

> **日期**: 2026-09-17
> **用户可见结果（本 fix 的唯一验收对象）**：经 remote-dsh（`rdsh host serve` / `rdsh host join` / `dsh-web-remote` 插件）从**远端浏览器**打开 DSH 后，点「添加工作区」**没有浏览器内的目录选择对话框**，而是一个原生 OS 对话框弹在**宿主机器自己的屏幕上** —— 浏览器端无法操作，也无法选择宿主上的目录。
> **结论**: DSH 的目录选择器是**启动时一次性解析**的（`native` = 宿主 OS 对话框 / `browse` = 浏览器内目录浏览器）。remote-dsh 目前 spawn `dsh web` 时不带任何信号，宿主是 macOS/Windows/带显示器的 Linux 时必然解析成 `native`。**修复必须走声明式 patch 层**：实测证明插件**无法**在运行时替换兄弟行（loader 作用域隔离），但 profile 的用户 patch 层是 **live 生效**的（改文件即换实现，无需重启 dsh）。
> **归类**: DSH 上游行为 + remote-dsh 未适配，**不是** 浏览器或网络问题；CLI 与插件两条入口的解法不同（见 §4）。

---

## 1. 用户可见问题

| # | 问题 | 触发 |
|---|---|---|
| P1 | 「添加工作区」弹出宿主机器屏幕上的原生对话框，远端浏览器无法操作 ⇒ 无法在宿主上建/选工作区 | 宿主为非无头桌面 OS 且 dsh 非 SSH 启动（macOS / Windows / 带 `DISPLAY`+zenity-kdialog 的 Linux） |
| P2 | `rdsh host serve`（局域网）/ `rdsh host join`（公网）与 `dsh-web-remote` 插件（自启 dsh）**两者都中招** | 同上 |

## 2. 事实（F —— 均带 file:line 或实测证据）

### 2.1 DSH 侧：选择器是 boot 时二选一

| # | 事实 | 证据 |
|---|---|---|
| F1 | DSH web 有两套选择器实现：`native`（宿主 OS 对话框）/ `browse`（浏览器内目录浏览器，读宿主文件系统）；由 `@deepseek-ai/dsh-host-directory-picker-auto` 在 boot 时**一次性**解析并只挂一套（后端 + 客户端面） | `dsh-host-directory-picker-auto/lib/types/resolve.js`（`resolveDirectoryPickerBackend`）；auto README §Use |
| F2 | 判定输入仅四个：`webServer.host`、SSH 信号、`process.platform`、Linux 的 `DISPLAY`/`WAYLAND_DISPLAY`+zenity/KDialog | 同上；auto README §Known limitations |
| F3 | `bindHost !== "127.0.0.1" → browse` 这条分支**永不成立**（web-app 明确拒绝 `--host 0.0.0.0`） | `dsh-web-app/README.md` Known Limitations："Binding all network interfaces is not supported — rejected at startup for safety" |
| F4 | SSH 信号 = **继承进程层**里的非空 `SSH_CONNECTION` 或 `SSH_TTY`（项目/用户 `.env` 不算） | `dsh-launch-environment/lib/index.js` `launchedThroughSsh`；launch-environment README |
| F5 | **采样每 boot 一次**，0.1.5-rc.2 无 per-client 适配（同一进程内"本地浏览器用 native、远端浏览器用 browse"需要 per-client capability + wire 通告，上游未做） | auto README §Known limitations "Boot-time only" |
| F6 | `browse` 后端**不渲染宿主显示**，专门服务原生对话框够不到的远端客户端；`list`/`createDirectory` 读宿主文件系统 | `dsh-host-directory-picker-browse/README.md` Summary |
| F7 | 「钉住某种交互」是文档化机制：patch 层里 `disabled` 掉 auto 行、直接组合 `-native`/`-browse` 行 | auto README §Use "Pinning is not a config field here…"；`dsh-web-app/cordis.patch.yml:94-98` 注释 "Mount -native or -browse directly in an overlay to pin the interaction" |
| F8 | 选目录 RPC 每次调用都重读能力对象，**不缓存** | `dsh-api-workspace-controller/lib/index.js:466-468`（`requireCapability` 内 `this.ctx.directoryPicker.capability()`） |
| F9 | 浏览器端的插件图**按页面加载冻结**：boot graph 由页面注入，客户端只认图内的行（`prefetch`/materialize 均查图）；host 侧 `onGraphChanged` 只被 dev-only 的 HMR 驱动消费 | `dsh-client-modules/lib/client.js`（`parseBootGraph`、`prefetch`）；`dsh-client-modules/lib/index.js:105`（`dsh-client-hmr` 是唯一订阅者） |

### 2.2 remote-dsh 侧：现状

| # | 事实 | 证据 |
|---|---|---|
| F10 | CLI 路径 spawn `dsh web --port 0 --no-open`，**不注入任何 picker 相关命令行或环境信号** | `packages/gateway/src/spawn-dsh.ts:66` |
| F11 | 插件路径 `dsh-web-remote` 是**运行在用户自己那台 dsh 进程里**的行；同一个 dsh 往往同时服务"人就在宿主屏幕前"和"远端浏览器" | `packages/web-remote/src/index.ts`（进程内 join，`inject = ['connection','webServer']`）；`packages/web-remote/cordis.patch.yml` |
| F12 | 插件以 **bundle** 形态装入 profile（`dsh plugin --profile web add …` 后进 `dsh.profile.bundles`），其 `cordis.patch.yml` 是 boot 时的 bundle patch 层 | `~/.dsh/profiles/web/package.json`（`dsh.profile.bundles` 含 `dsh-web-remote`）；`06-dsh-plugin/discussion.md:30-34` |

### 2.3 机制层（本次实测，非推断）

| # | 事实 | 证据 |
|---|---|---|
| F13 | 上面 F7 的 pin patch 可用：`disabled: true` + insert 后端与客户端面两行 → `--dump-config` 里 auto 行 `disabled: true`、两行 browse 入树；**真机启动**后页面 boot graph 含 `@deepseek-ai/dsh-client-ui-directory-picker-browse/client.js`、不含 native | 实测（`dsh web --dump-config --patch …`；启动后取 `/?token=` 页面 grep `directory-picker*`） |
| F14 | **重复 insert 同一个 id 是致命错误**：两层 patch 都 insert `directory-picker-browse` → `duplicate loader entry id`，dsh **启动失败**（不是降级） | 实测两次 `--patch` 同一文件启动即抛 `failed to apply loader entry include (cordis:include): duplicate loader entry id: directory-picker-browse` |
| F15 | **插件拿不到兄弟行**：插件 ctx 的 loader 是作用域隔离的（只含自己子树创建的行）。`remove('directory-picker')` → `cannot resolve entry directory-picker`；`ctx.root.loader` / `ctx.loader.root` / `ctx.get('loader').root` 四种取法都看不到该行 | 实测探针插件（delay 后执行）四种取法 `sees directory-picker = false` |
| F16 | 行 id 缺省时是**随机**的（`ensureId` 生成 `Math.random().toString(16).slice(2,10)`），所以 auto 插件动态挂的两个子行 id 形如 `69e3b002`，与配置行 id（`directory-picker`）不在一个命名空间 | `cordis-plugin-loader/lib/index.js:199-203`；启动 trace 中 `failed to apply loader entry 69e3b002 (@deepseek-ai/dsh-host-directory-picker-native)` |
| F17 | **apply 期**（boot 中）插件插 browse 后端必然炸：include 并发挂载，auto 的 native 在我们之后注册 → `service "directoryPicker" has been registered at <BrowseDirectoryPicker>`，启动失败；且此刻 `directory-picker` 行尚未进 store | 实测探针（delay=0） |
| F18 | **运行期**（boot 完成后）也一样做不到热切换：`remove` 兄弟行仍是 `cannot resolve entry directory-picker`，而直接 insert 撞 `service "directoryPicker" has been registered at <NativeDirectoryPicker>` | 实测探针（delay=8s） |
| F19 | **profile 用户 patch 层是 live 的**：`web` 模板与用户 profile 都是 `patchReload: "live"`；boot 后用 `watchUserPatches` 通过 Cordis HMR 注册该文件，变更时事务性重放**整层** patch 到根 include | `dsh-app-boot/lib/index.js:333-335, 1109-1135`；`dsh/lib/profile-boot-Dk-7KqJc.js:322-338`；`~/.dsh/profiles/web/package.json`（`patchReload: "live"`） |
| F20 | **因此插件可以在运行期让 pin 生效、无需重启 dsh**：向 `$DSH_HOME/profiles/web/cordis.patch.yml` 写入那几行后，**同一进程内** `capability().kind` 从 `native` 变为 `browse`（约 +3~4s），随后**新加载的页面** boot graph 变为 browse（客户端面需刷新页面，见 F9） | 实测：写入 → 探针日志 `t=12s kind=browse`；重新取 `/?token=` 页面 → graph 只有 `directory-picker-browse`；**随后已把该文件按字节回滚**（md5 与备份一致） |
| F21 | patch 里 **id 找不到**只告警不致命：`patch: entry "…" not found`（退出码 0） | 实测 `--dump-config --patch <bogus-id>` |
| F22 | patch 文件方言 = `yaml.JSON_SCHEMA` + 自建 `!!js` Type（`tag:yaml.org,2002:js`），`dump-config` 用**同一 schema** 输出 ⇒ 读改写可安全往返（`!!js` 原样保留）；`@deepseek-ai/dsh-atomic-write` 提供原子写/文件锁 | `dsh-app-boot/lib/index.js:22-31, 1292`；`isJsExpr` 由 `@deepseek-ai/cordis-plugin-loader` 导出 |
| F23 | patch 层序 = `dsh.profile.bundles` 顺序，`dsh-web-remote` 在 `dsh-web-app` **之后** ⇒ 插件自己的 bundle patch 能覆盖 web-app 的 `directory-picker` 行 | `app-boot` 文档注释 "applying each bundle's patch list in `dsh.profile.bundles` order"；实测 dump 层标记 `# == dsh-web-remote` 在 `# == @deepseek-ai/dsh-web-app` 之后 |
| F24 | `dsh web --patch` 必须排在 app 自己的参数**之前**：`dsh web --patch X --no-open --port 0` ✅；`dsh web --no-open --port 0 --patch X` ❌ `error: unknown option '--patch'`（launcher `passThroughOptions`） | 实测 |

## 3. 结论：机制为什么只能是"声明式 patch"

- F16–F18 排除了「插件运行时热替换」：loader 作用域隔离是**设计**（配置层权威），插件只能管自己创建的行。
- F5 排除了「按客户端自适应」。
- 剩下能改变解析结果的只有两种：**（a）boot 前注入信号/命令行（CLI 拥有 spawn）**、**（b）boot 时/运行时的 patch 层**。
- F14 给出一条硬约束：**同一 boot 内只能有一个"声明式插入者"**，否则启动失败。

## 4. 两条入口的解法（机制候选）

| 机制 | 适用于 | 生效方式 | 优点 | 代价/风险 |
|---|---|---|---|---|
| **M1** 插件面板开关 → 写 profile 用户 patch 层（`cordis.patch.yml`） | 插件路径 | **live**（F19/F20）：写文件即换实现，无需重启 dsh；浏览器需刷新一次（F9） | opt-in，保留"人在宿主屏幕前"的原生对话框；用文档化的用户 patch 层，不碰 loader 内部 | 需读改写用户自己的 YAML（F22 有可安全往返的证据 + atomic-write）；外部编辑器并发需加锁；文件权限/失败要可见 |
| **M2** 插件 bundle patch 里无条件 pin（F7/F13/F23） | 插件路径 | boot 时 | 实现最简单，装插件即生效，无需刷新 | 一刀切：本地桌面也失去原生对话框；**与任何其它 insert 通道互斥**（F14）；插件一装就影响所有 boot |
| **M3** 只检测 + 面板提示（不改任何东西） | 插件路径兜底 | 用户手动 | 零风险 | 用户要自己动手（给出精确命令/文件内容） |
| **M4** CLI 侧：`--patch <包内 pin.yml>` | CLI 路径 | spawn 时 | 语义明确：这个 dsh 只服务远端；CLI 拥有 argv | 必须排在 app 参数前（F24）；**与插件侧的 M1/M2 互斥**（F14）——装了插件又用 CLI 就会启动失败 |
| **M5** CLI 侧：spawn 时注入 `SSH_TTY`/`SSH_CONNECTION` | CLI 路径 | spawn 时 | 不插任何行 ⇒ **与 M1/M2 天然无冲突**；语义与上游判定一致（"操作者看不到宿主显示"，正是 rdsh 的场景） | 依赖上游启发式，未来上游改信号会静默失效（需版本/自检兜底）；会一并关掉 browser handoff 与 Open In（对纯远程是想要的） |

**互斥矩阵（关键）**：M4 与 M1/M2 任一同时存在 ⇒ 启动失败（F14）；M5 与 M1/M2 可共存（M5 不插行）。
CLI 侧检测自身结果的低成本手段：boot 后经网关会话 cookie 调 `directoryPicker/list`（F8/B1 面）做一次自检并在日志/面板告警。

## 5. 待决策（Q —— 需用户拍板）

| # | 问题 | 备选 |
|---|---|---|
| Q1 | 插件侧走哪个机制？ | M1（live 开关，推荐）/ M2（一刀切）/ M3（仅提示）+ 可选后续升级 |
| Q2 | CLI 侧走哪个通道？ | M5（信号，与 M1/M2 无冲突，推荐）/ M4（`--patch`，则插件侧必须退回 M3） |
| Q3 | 开关语义 | 手动 opt-in 开关（推荐）／join 隧道连接时自动切换／两者都有 |
| Q4 | 若采用 M1，写入目标 | `$DSH_HOME/profiles/web/cordis.patch.yml`（只影响 web profile，推荐）／`$DSH_HOME/cordis.patch.yml`（影响所有 profile：未知 id 仅告警 F21，但会向 headless 等也插入 browse 行 —— 不推荐） |

## 6. 未验证/未决（诚实登记）

- M1 的"用户 YAML 读改写"在**外部编辑器并发**、文件被改成非法 YAML、文件被删除等异常下的行为，需要专门测例（atomic-write + 锁）。
- M1 生效后，**已经打开的页面**里的旧流程占位（native 面）如何表现（预期：仍渲染旧面、调用 browse RPC 会得到 `directory-picker/unavailable`），需要实测并在面板文案里提示"刷新页面"。
- M5 注入信号后，Open In / browser handoff 的具体变化需实测确认（预期：两者关闭，对远程访问有利）。
- 上游若在未来版本支持 per-client 选择器，M1/M2/M5 都应能被删除（登记为 TODO，而非本轮范围）。

## 7. 决策记录（2026-09-17，用户拍板）

| # | 决策 | 结论 | 影响 |
|---|---|---|---|
| **D1** | 插件路径机制 | **无条件 pin browse**——用户原话：「dsh-web-remote 就是为远程而生的，无论隧道是否连接，都必须是 browse」 | 采用 **M2**（插件 bundle patch 声明式 pin）。**M1（写用户 patch 层 + live reload）作废**：不再需要 `js-yaml` 依赖、不再改写用户文件、不再需要"请刷新页面"提示 |
| **D2** | CLI 侧通道 | **M5**：spawn 时注入 `SSH_TTY`（不插任何 patch 行） | 与 M2 无冲突（M2 是唯一的声明式插入者）；M4 明确**不做** |
| **D3** | 开关语义 | **取消开关**（D1 已让语义恒为 browse） | 面板只保留**只读诊断**（当前解析出的选择器类型），用于发现"pin 未生效"的异常 |

### 7.1 D1 的直接后果（必须写进文档/CHANGELOG）

| # | 后果 | 说明 |
|---|---|---|
| C1 | **宿主本机浏览器也用浏览器内选择器** | 选择器是 boot 级单一实现（F5），装了插件的 profile 恒为 browse。用户已知悉并接受（远程优先） |
| C2 | **"唯一声明式插入者"成为契约** | 任何第二个 pin 通道（用户手工 patch 层、未来若做 M4）都会触发 `duplicate loader entry id`（F14）或 `service "directoryPicker" has been registered`（F17）→ **dsh 启动失败**。必须在 README / usage 故障排查 / CHANGELOG 写明"不要手工 pin" |
| C3 | **页面无需刷新** | patch 在 boot 层生效，页面 boot graph 一开始就含 browse（优于 M1 的"host 即时生效、浏览器需刷新"，见 F9/F20） |
| C4 | M1 的实测证据（F19/F20）保留在本文档 | 作为"将来若真需要按状态切换"的已证事实，不在本轮实现 |

### 7.2 由此确定的完整覆盖矩阵

| 部署形态 | 谁保证是 browse | 机制 |
|---|---|---|
| 装了 `dsh-web-remote` 插件的 profile（无论隧道连没连） | 插件 bundle patch（M2） | patch 层：`disabled: directory-picker` + insert browse 双面 |
| 用 `rdsh host serve` / `rdsh host join`（CLI spawn，可能没装插件） | CLI 注入 `SSH_TTY`（M5） | 上游 auto 判定 `facts.ssh → browse`（F4） |
| 两者同时存在（装了插件又用 CLI spawn） | 两条同时成立，结果一致 | **无冲突**：M5 不插行，M2 是唯一插入者 |
