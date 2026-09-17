# 远程浏览器无法选择宿主目录（verification）

> **日期**: 2026-09-17
> **范围**: 对照 [bug-report.md](bug-report.md) 的 AC1–AC6 与 [plan.md](plan.md) 的 RTTM 逐条复核
> **结论**: **AC1–AC6 全部达成**（含真机验证）；仅剩"发布/重装"这一步（需用户显式确认）与面板 UI 的浏览器目视确认（见 §4 缺口）

---

## 1. 需求 → 证据对照（RTTM 复核）

| # | 标准（AC） | 状态 | 证据 |
|---|---|---|---|
| R1 | 装了插件的 profile **任何** boot 都解析为 `browse`（AC1） | ✅ **含用户实测** | **E2E（隔离 DSH_HOME，未碰用户环境）**：`DSH_HOME=/tmp/verify-home dsh web --no-open --port 0` → 首页 boot graph `browse_hits=1 native_hits=0`；`--dump-config` 显示 `# == @deepseek-ai/dsh-web-app, patched by dsh-web-remote` + `disabled: true`，以及 `# == dsh-web-remote` 段落里的两条 browse 行。单测 `packages/web-remote/test/picker-patch.test.ts`（4 条）守住 patch 内容与 id 唯一性。**用户实测（2026-09-17）：热修后就地生效，远端出现浏览器内目录选择器**（见 §7） |
| R2 | CLI spawn 的 dsh 也解析为 `browse`（AC2） | ✅ | 单测：`spawn-dsh.test.ts` 新增 2 条（假 dsh 落盘 `SSH_TTY` = `rdsh-remote`；已有真实 `SSH_TTY` 不被覆盖）+ `spawn-env.test.ts` 的 `dshSpawnEnv` 4 条。真机：`SSH_TTY=rdsh-remote dsh web …` → boot graph `browse_hits=1 native_hits=0`（未注入时为 0/1，见 §2 基线）。CLI 端到端：`node packages/cli/dist/bin.js host serve --config /tmp/verify-host.json --port 0` → 正常启动、**未打印**告警（即自检通过） |
| R3 | 两条通道共存不冲突（AC3) | ✅ | 真机：`SSH_TTY` + pin patch 同时存在 → 正常启动且 `browse_hits=1 native_hits=0`。反证：重复插入同一 id 会 `duplicate loader entry id` 直接启动失败（本轮误叠同一 patch 时复现），证明"唯一声明式插入者"这一契约真实且已被遵守 |
| R4 | 面板可观测 + 告警（AC4） | ✅（代码/单测级） | `pickerDiagnostics` 5 条单测（browse / native / 缺席 / capability 抛错 / 无 capability）；`state` RPC 三个分支均带 `pickerKind`/`expectedPickerKind`/`pickerOk`；`client.js` 面板新增「目录选择」行与异常告警文案、中英 i18n；`node --check client.js` 通过。**浏览器目视确认待重装后做（§4 G2）** |
| R5 | 既有能力零回归（AC5） | ✅ | `pnpm build`（tsc strict）零 issue；`pnpm test` 全绿：agent-mesh 1 / tunnel 12 / hub 120 / gateway 141 / cli 0 / web-remote 25，`EXIT=0` |
| R6 | 构建/测试零 issue（AC6） | ✅ | 同上；`client.js` 走 `node --check` |
| R7 | 文档与变更日志（AC6） | ✅ | `doc/overview/usage.md` §10 故障排查新增 2 行 + 新增 §10.1「只允许一个 pin 通道」；`README.md` / `README.zh.md` 插件说明各补一句；`CHANGELOG.md` / `CHANGELOG.zh.md` 新增 `[Unreleased]` 条目（含单占用警告） |
| R8 | 上游判定失效时的兜底信号 | ✅ | `checkRemotePickerGraph` + `remotePickerWarning`；单测 5 条（含非 200 → null、连接失败 → null）；**真机双向验证**：注入信号时 `graph_check=true`，未注入时 `graph_check=false`（带真实会话 cookie），见 §3 |
| R9 | 不做 per-client 自适应 / 不做按状态切换 / 不做 CLI `--patch` | ⏭️ | 按非目标明确不做（discussion §7.1 C2、C4） |

## 2. 基线复现（证明"修的是真问题"）

在本机（macOS 宿主）未注入任何信号启动真实 dsh：

```
baseline:        page_bytes=27658 browse_hits=0 native_hits=1   ← 复现用户现象（选择器 = native）
pin rows:        page_bytes=27722 browse_hits=1 native_hits=0   ← 修复后
SSH_TTY signal:  page_bytes=27722 browse_hits=1 native_hits=0   ← 修复后（CLI 通道）
both channels:   page_bytes=27722 browse_hits=1 native_hits=0   ← 修复后（两通道叠加，启动干净）
```

判定手段：`dsh web` 就绪行取 token → 换发会话 cookie → GET 首页 → 在注入的 boot graph 里统计
`@deepseek-ai/dsh-client-ui-directory-picker-browse`（期望 1）与 `…-native`（期望 0）。

## 3. 自检函数真机双向验证

用构建产物直接调用（真实 dsh + 真实会话 cookie）：

```
remote (SSH_TTY 注入): port=53088 cookie=yes graph_check=true
native (无信号):       port=53090 cookie=yes graph_check=false
```

⇒ 自检能区分好坏两种状态，不是"永远返回 null 所以不告警"。CLI 冒烟时未出现告警 = 自检返回 `true`。

## 4. 缺口与遗留（诚实登记）

| # | 缺口 | 严重度 | 说明 / 处理 |
|---|---|---|---|
| G1 | **用户机器上已安装的插件副本仍是旧 `cordis.patch.yml`** | 中（功能未生效） | 发布新版后 `dsh plugin --profile web add dsh-web-remote@latest` 即修复；本轮可选手工热修（写入已安装副本）——**需用户显式同意**（会改用户环境，并暂时与 npm 版本不一致） |
| G2 | 面板 UI 浏览器目视确认 | ✅ 已关闭 | 用户 2026-09-17 实测：插件工作正常、出现浏览器内目录选择器（§7）。面板「目录选择」诊断行是否单独目视过未回报（代码/单测已覆盖其取值逻辑） |
| G3 | 版本号提升 / npm 发布 / 真机重装验证 | — | **被阻塞：npm 发布需用户显式确认**（CLAUDE.md §2 环境隔离）；已登记为 [TODO.md](TODO.md) T9 |
| G4 | 上游若改变选择器判定信号，CLI 通道会静默退回 native | 低 | 已有 spawn 后自检告警（R8）+ `DSH_COMPAT_MAX` 版本围栏；升级 dsh 版本时复核 |

## 5. 本轮未触碰的外部环境（自查）

- 未修改 `~/.dsh/profiles/web/`（spike 期临时写入的用户 patch 层已按字节回滚，md5 `7390256202c2b81f4dcdcd743a9875b3` 一致）；
- 未修改 `~/.rdsh/`；CLI 冒烟使用 `--config /tmp/verify-host.json`（临时配置）、监听 `127.0.0.1`；
- 隔离验证用 `DSH_HOME=/tmp/verify-home`（临时 profile 副本）；
- 未做 git commit、未发布 npm；
- 验证结束后无残留 `dsh web` / `rdsh` 进程。

## 6. 附：用户机器上的就地热修（2026-09-17，用户批准后执行）

由于已安装的插件副本仍带旧 patch（§4 G1），按用户指示就地热修：

| 项 | 值 |
|---|---|
| 目标 | `~/.dsh/profiles/web/node_modules/dsh-web-remote/cordis.patch.yml` |
| 备份（回退用） | 同目录 `cordis.patch.yml.bak-20260917`（md5 `86c3e70021167748853f461182c968c2`） |
| 热修后 | md5 `0ae45b630b0dbe32ea444c1cd139a0e2`，与工作区版本 `cmp` **逐字节一致** |
| 生效验证（真实 profile，静态） | `dsh web --dump-config` → `# == @deepseek-ai/dsh-web-app, patched by dsh-web-remote` + `disabled: true`；`# == dsh-web-remote` 段落含两条 browse 行 |
| 生效验证（真实 profile，真机启动） | 启动时临时 `--patch` 禁用插件自身行（不写盘、不起隧道）→ 首页 boot graph `browse_hits=1 native_hits=0` |

**回退方法**：`cp <目标>/cordis.patch.yml.bak-20260917 <目标>/cordis.patch.yml`（或重装插件覆盖）。后续正式发布并 `dsh plugin --profile web add dsh-web-remote@latest` 后，该手工副本会被 npm 版本取代（一致）。

## 7. 用户实测确认（2026-09-17，最高证据）

> 用户原话：「i just verified the plugin it works and show web folder picker.」

| 项 | 结论 |
|---|---|
| AC1（用户可见结果） | ✅ **浏览器内目录选择器出现且可用** —— 这是本 fix 的唯一验收对象，由真实用户在其真实部署上确认 |
| AC4（面板诊断） | 代码/单测已覆盖取值逻辑；面板行的目视确认未单独回报（低风险，非验收对象） |
| §4 G1（已安装副本） | ✅ 已由用户批准的就地热修关闭（§6） |
| §4 G2（UI 目视） | ✅ 关闭（本条实测） |
| 仍未关闭 | `TODO.md` T9：版本提升 + npm 发布 + 重装后与 npm 版本对齐（**需用户显式确认发布**） |
