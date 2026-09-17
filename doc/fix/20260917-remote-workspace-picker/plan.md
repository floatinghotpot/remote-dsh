# 远程浏览器无法选择宿主目录（plan）

> **日期**: 2026-09-17
> **状态**: 已实施并验证（见 [verification.md](verification.md)）
> **需求**: [bug-report.md](bug-report.md) ｜ **方案**: [solution.md](solution.md) ｜ **事实**: [discussion.md](discussion.md)

---

## RTTM（需求 → 任务追溯）

| # | 需求（AC） | 来源 | 任务 | 状态 |
|---|---|---|---|---|
| R1 | 装了插件的 profile 任何 boot 都解析为 `browse`（AC1） | 用户 D1 决策 | T1、T6、T7 | ✅ |
| R2 | CLI spawn 的 dsh 也解析为 `browse`（AC2） | 用户 D2 决策 | T3、T4、T7 | ✅ |
| R3 | 两条通道共存不冲突、不重复注册（AC3） | discussion F14/F17 | T1、T3、T5、T7 | ✅ |
| R4 | 面板可观测选择器类型并告警（AC4） | 用户 D3 决策 | T2、T5 | ✅ |
| R5 | 既有能力零回归（join/断开/注销/E2EE/LAN/文件面板）（AC5） | 存量承诺 | T2、T3、T5、T7 | ✅ |
| R6 | 构建/测试零 issue（AC6） | CLAUDE.md §2 | T5、T7 | ✅ |
| R7 | 文档与变更日志（AC6） | CLAUDE.md §7 | T6 | ✅ |
| R8 | 上游判定失效时有兜底信号（AC2 的可运维性） | solution §6 | T4 | ✅ |
| R9 | 不做 per-client 自适应 / 不做按状态切换 / 不做 CLI `--patch` | 非目标 | —（明确不做） | ⏭️ |
| R10 | 版本提升 + npm 发布 + 真机重装验证 | 发布纪律（需显式确认） | T9 | ⏭️ |

## 任务清单

| # | 任务 | 文件 | 状态 |
|---|---|---|---|
| T1 | `cordis.patch.yml` 追加 `disabled: directory-picker` + insert browse 双面（含"唯一插入者"注释） | `packages/web-remote/cordis.patch.yml` | ✅ |
| T2a | `state` RPC 新增 `pickerKind` / `expected` / `pickerOk`（用 `ctx.get` 读取，不硬依赖） | `packages/web-remote/src/index.ts` | ✅ |
| T2b | 面板显示选择器类型 + 异常告警（中英文案） | `packages/web-remote/client.js` | ✅ |
| T3a | 纯函数 `dshSpawnEnv()`（保留真实 SSH 信号，否则注入 `SSH_TTY=rdsh-remote`） | `packages/gateway/src/spawn-dsh.ts` | ✅ |
| T3b | `spawnDsh` 使用该 env（签名不变，两个调用点无改动） | 同上 | ✅ |
| T4 | spawn 后自检：GET 首页检查 boot graph 是否含 `directory-picker-browse`，缺失则告警 | `packages/gateway/src/spawn-dsh.ts`（导出）+ `serve.ts` / `join.ts` 接线 | ✅ |
| T5a | 假 dsh 脚本打印 `SSH_TTY`，断言注入与"不覆盖真实值" | `packages/gateway/test/spawn-dsh.test.ts` | ✅ |
| T5b | `dshSpawnEnv` 单测（4 种 env 组合） | `packages/gateway/test/spawn-env.test.ts`（新增） | ✅ |
| T5c | patch 文件结构单测（disable 行 + 两行 browse + name 精确匹配） | `packages/web-remote/test/picker-patch.test.ts`（新增） | ✅ |
| T5d | `pickerDiagnostics` 单测（browse / native / 服务缺席 / capability 抛错 / 无 capability） | `packages/web-remote/test/picker-diagnostics.test.ts`（新增；实现时取此形态——`state` 分支逻辑与文件系统耦合，纯函数更可测） | ✅ |
| T6a | 故障排查表 + FAQ（现象、原因、处理、"禁止手工 pin"） | `doc/overview/usage.md` | ✅ |
| T6b | 插件安装说明补"目录选择恒为浏览器内" + 升级注意 | `doc/feature/06-dsh-plugin/`（及对外 README/博客对应处） | ✅ |
| T6c | 变更日志（修复 + 唯一 pin 通道契约） | `CHANGELOG.md` / `CHANGELOG.zh.md` | ✅ |
| T7 | 真机验证（AC1/AC2/AC3/AC5）并产出 `verification.md` | 本目录 | ✅ |
| T8 | `plan.md` 回填状态 + `summary.md` + 机械抽取 `TODO.md` | 本目录 | ✅ |

## 执行顺序与门槛

1. **T1 + T3**（两处根因，先让"现象消失"）→ 立刻用 T7 的 AC1/AC2/AC3 冒烟。
2. **T2**（可观测性）→ **T5**（测例，与实现同步而非事后补）。
3. **T4**（兜底自检）→ **T6**（文档）→ **T7**（完整验证）→ **T8**（收尾）。
4. 每 2–3 个任务做一次对照 bug-report 的轻量自审（CLAUDE.md §7 implementation 阶段要求）。
5. `pnpm build`（tsc strict）+ `pnpm test` 必须零 issue；两个包都涉及，**全量 `pnpm build`**。
6. **不做 git commit / 不发布 npm**（除非用户显式确认）。

| T9 | 版本号提升 + 发布 npm + 真机重装后复验 AC1/AC4 | `packages/gateway/package.json`、`packages/web-remote/package.json`、CHANGELOG | ⏭️ 需用户显式确认发布 |

## 验证环境备忘（本次实测已用过的真实手段，T7 直接复用）

- `dsh web --dump-config --patch <file>`：静态检查 patch 层结果（含 `disabled: true` 与插入行）。
- 真机启动后用 `/?token=<launch token>` 换 cookie，GET 首页并 grep `directory-picker[a-z-]*`：可直接断言 boot graph 里是 `browse` 而不是 native（本轮 spike 用的就是这个方法）。
- 已在 `~/.dsh/profiles/web` 上实测过 pin 的两种注入方式；**插件形态的验证建议直接在真实 profile 上做**（T1 生效后不需要改用户文件，风险低）。
