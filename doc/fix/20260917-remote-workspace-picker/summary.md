# 远程浏览器无法选择宿主目录（summary）

> **日期**: 2026-09-17
> **结果**: 远端浏览器「添加工作区」现在弹出**浏览器内**目录浏览器（列宿主文件系统，可浏览 + 新建目录），不再出现弹在宿主屏幕上的原生对话框。两条入口（插件 / CLI）都已覆盖，且两通道叠加时启动干净。**2026-09-17 用户实测通过（浏览器内目录选择器可用）**。
> **文档**: [discussion.md](discussion.md)（F1–F24 事实与实测）｜ [bug-report.md](bug-report.md) ｜ [solution.md](solution.md) ｜ [plan.md](plan.md) ｜ [verification.md](verification.md) ｜ [TODO.md](TODO.md)

---

## 1. 做了什么

| 层 | 改动 | 文件 |
|---|---|---|
| 根因修复（插件） | 插件自己的 bundle patch 里禁用 DSH 的启动期自适应选择器行，直接组合 `browse` 后端（`dsh-host-directory-picker-browse`）+ 浏览器半（`dsh-client-ui-directory-picker-browse`）——**无条件**，与隧道状态无关 | `packages/web-remote/cordis.patch.yml` |
| 根因修复（CLI） | spawn `dsh web` 时注入上游判定所用的远端会话信号 `SSH_TTY=rdsh-remote`（已有真实 SSH 信号则保留原值；只设 `SSH_TTY`，不伪造有固定格式的 `SSH_CONNECTION`） | `packages/gateway/src/spawn-dsh.ts`（`dshSpawnEnv`） |
| 护栏 | spawn 后自检：取首页检查 boot graph 是否含浏览器内选择器，缺失时告警（上游判定变更的唯一可见信号） | `spawn-dsh.ts`（`checkRemotePickerGraph` / `remotePickerWarning`）+ `serve.ts` / `join.ts` 接线 |
| 可观测 | 远程访问面板显示当前实际生效的目录选择器形态，异常时给出排查提示（中英） | `packages/web-remote/src/index.ts`（`pickerDiagnostics` + `state` 返回字段）、`client.js` |
| 测试 | 新增/扩展 4 个测试文件，共 11 条新测例 | 见下 |
| 文档 | 使用手册故障排查 + 新增「只允许一个 pin 通道」小节；README 双语说明；CHANGELOG 双语 `[Unreleased]` | `doc/overview/usage.md`、`README.md`、`README.zh.md`、`CHANGELOG.md`、`CHANGELOG.zh.md` |

## 2. 关键事实（决定了方案形态）

1. DSH 的目录选择器在 **boot 时一次性**解析（`native` / `browse`），0.1.5-rc.2 **无 per-client 自适应**。
2. 判定输入只有 bindHost（死路：`--host 0.0.0.0` 被上游拒绝）、SSH 信号、platform、Linux DISPLAY+chooser ⇒ **只能**靠"注入信号"或"patch 层钉住"。
3. 插件的 loader 是**子树作用域**的：拿不到兄弟行 ⇒ **运行时热替换不可能**（本轮实测四种取法）。
4. `directory-picker` 是**单占用**的：任何第二个插入者都会让 dsh **启动失败**（`duplicate loader entry id` / 重复注册 `directoryPicker`）⇒ CLI 侧必须选"不插行"的通道（用户决策 D2 = 注入 `SSH_TTY`）。
5. profile 的用户 patch 层是 **live** 的（实测同进程 `native → browse`，无需重启 dsh）——本轮未采用（用户决策 D1 为无条件 pin），但事实已存档，供将来"按状态切换"复用。

## 3. 验证（详见 verification.md）

- **基线复现**：本机 macOS 未注入信号 → `native_hits=1`（复现用户现象）；修复后 → `browse_hits=1 native_hits=0`。
- **插件交付路径 E2E**：隔离 `DSH_HOME` 真机启动，boot graph = browse；`--dump-config` 显示 `patched by dsh-web-remote` + `disabled: true` 与两条 browse 行。
- **CLI 路径 E2E**：`rdsh host serve --config <临时配置>` 正常启动且未告警；自检函数真机双向验证（注入 → `true`，未注入 → `false`）。
- **共存**：两通道叠加 → 正常启动且为 browse。
- **回归**：`pnpm build` 零 issue；`pnpm test` 全绿（hub 120 / gateway 141 / web-remote 25 / tunnel 12 / agent-mesh 1，`EXIT=0`）。

## 4. 用户需要知道的

- **你的机器已就地热修并验证**：`~/.dsh/profiles/web/node_modules/dsh-web-remote/cordis.patch.yml` 已替换为带 pin 的版本（备份 `cordis.patch.yml.bak-20260917`，可一键回退），真实 profile 启动实测 `browse_hits=1 native_hits=0`。**重启一次 `dsh web` 即生效**（选择器在启动时解析）。
- **装了插件后，宿主本机浏览器也用浏览器内选目录**——预期行为（选择器是 boot 级单一实现，本插件按"远程优先"固定为 browse）。
- **不要手工 pin 目录选择器**：会与插件冲突导致 dsh 启动失败（已写入 CHANGELOG 与 usage §10.1）。
- **正式发布后建议重装**：`dsh plugin --profile web add dsh-web-remote@latest`，让安装副本与 npm 版本重新一致（内容相同）；发布需你显式确认（TODO T9）。
