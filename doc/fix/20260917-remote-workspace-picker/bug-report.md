# Bug 报告：远程浏览器无法选择宿主目录（原生对话框弹在宿主屏幕上）

> **日期**: 2026-09-17
> **严重度**: P2（核心功能在远程场景不可用：装好了也无法添加/切换工作区）
> **影响组件**: `dsh-web-remote`（插件路径）、`rdsh-gateway`（CLI `rdsh host serve` / `rdsh host join` 的 spawn）
> **发现环境**: 用户真机报告（远端浏览器连接宿主的 DSH，点「添加工作区」）
> **事实依据**: [discussion.md](discussion.md) §2（F1–F24：源码 file:line + 实测证据）

---

## 1. 现象（症状）

经 remote-dsh 从**远端浏览器**打开 DSH 后，点「添加工作区 / 切换工作区」：

- ❌ 浏览器里**没有**目录选择对话框；
- ❌ 宿主机器的**屏幕上**弹出一个原生 OS 对话框；
- ⇒ 远端用户既看不到、也无法操作，**无法选择宿主上的目录**，功能等效不可用。

## 2. 复现步骤

1. 宿主（macOS / Windows / 带 `DISPLAY`+zenity|kdialog 的 Linux 桌面）上启动 remote-dsh：
   - CLI 形态：`rdsh host serve`（局域网）或 `rdsh host join <hub>`（公网）；或
   - 插件形态：在宿主自己的 `dsh web` 里装好 `dsh-web-remote` 并接入 hub；
   - 关键：**不是**在 SSH 会话里启动的（本机终端 / tmux / launchd / systemd 用户服务 / 插件自启）。
2. 从另一台机器（或手机）的浏览器打开 DSH 界面；
3. 点「添加工作区」→ 原生对话框弹在**宿主屏幕**上（现象成立）。

## 3. 根因（代码事实）

DSH 的目录选择器由 `@deepseek-ai/dsh-host-directory-picker-auto` 在 **boot 时一次性**解析成 `native`（宿主 OS 对话框）或 `browse`（浏览器内目录浏览器）：

```
bindHost ≠ 127.0.0.1        → browse   （死路：web-app 拒绝 --host 0.0.0.0）
SSH_CONNECTION / SSH_TTY 非空 → browse
darwin / win32              → native   ← 命中的分支
linux 且有 DISPLAY + zenity  → native
```

- remote-dsh 目前 spawn `dsh web --port 0 --no-open`，**不注入任何信号**（`packages/gateway/src/spawn-dsh.ts:66`），插件形态更是运行在用户自己启动的 dsh 里 —— 于是宿主是桌面 OS 时必然解析成 `native`。
- 采样每 boot 一次，0.1.5-rc.2 **无 per-client 自适应**（discussion F5）；
- 「钉住交互」的唯一文档化手段是 **patch 层**：`disabled` 掉 auto 行 + 直接组合 `-browse` 后端与客户端面（F7，已实测 F13）。

## 4. 影响

| 项 | 影响 |
|---|---|
| 功能 | 远端浏览器**无法**添加/切换工作区（P2）；宿主本机浏览器反而是好的 |
| 覆盖面 | CLI 两种形态（serve / join）与插件形态**全部中招**（只要宿主是桌面 OS 且非 SSH 启动） |
| 安全 | 无安全影响：`browse` 后端只读宿主文件系统的目录层级（不涉及文件内容） |

## 5. 验收标准（AC）

| # | 标准 | 判定手段 |
|---|---|---|
| **AC1** | 装了 `dsh-web-remote` 的 profile：**任何** boot（隧道连/未连）解析出的选择器都是 `browse`；远端浏览器点「添加工作区」出现**浏览器内**目录浏览器，可浏览并在宿主上新建目录 | 真机启动 + 页面 boot graph 含 `directory-picker-browse`、不含 native；浏览器实测选目录成功 |
| **AC2** | `rdsh host serve` / `rdsh host join`（CLI spawn）在**未装插件**的 profile 上也解析为 `browse` | spawn 出的 dsh 页面 boot graph 检查 + 浏览器实测 |
| **AC3** | 两条通道**可共存**：装了插件又用 CLI spawn 时，dsh 正常启动（不得出现 `duplicate loader entry id` / `service "directoryPicker" has been registered`） | 真机启动冒烟 |
| **AC4** | 面板可观测：远程访问面板显示当前选择器类型；若不是 `browse` 要显式告警 | 面板 UI + 单测 |
| **AC5** | 既有能力不回归：join / 断开 / 注销 / E2EE / 局域网配对 / 工作区文件面板不受影响 | 现有测试全绿 + 真机冒烟 |
| **AC6** | 构建/测试零 issue；文档与变更日志更新（含"禁止手工 pin"与升级注意） | `pnpm build` / `pnpm test`；README、usage 故障排查表、CHANGELOG |

## 6. 非目标（本轮不做）

- 不做 per-client 自适应（上游未提供；见 discussion F5）。
- 不做"按隧道状态自动切换"（用户在 D1 明确改为无条件 browse；M1 方案作废）。
- 不实现 CLI 侧 `--patch` 通道（M4）：与插件的 patch 行**必然冲突**（F14/F17）。
- 不发布 npm（发布需单独显式确认）。
