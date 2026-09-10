# portal 深色模式（verification）

> **日期**: 2026-09-11（含当日追加需求 R12 后的复算）
> **上游**: [req.md](req.md)、[solution.md](solution.md)、[plan.md](plan.md)
> **性质**: 收尾审计——按 RTTM 复核 req → plan 覆盖，确认代码**存在且被调用**，逐项列出缺口

---

## 1. 结论

实现完成，构建与测试全绿，**深色配色 18 组对比度全部达标**，全仓已无硬编码颜色字面量。**T9 真机目视核验已由用户于 2026-09-11 在浏览器确认通过**（浅/深各一轮），发布前另做一轮独立复核（见 §10）；剩余唯一未做项为 T12（浅色既有对比度债，按 C1 决策本轮跳过）。

## 2. RTTM 复核（req → 代码事实）

| 需求 | 计划任务 | 代码事实 | 结论 |
|---|---|---|---|
| R1 跟随系统 | T1 | `theme.css` 中 `@media (prefers-color-scheme: dark)` 覆盖 `:root` token；全仓无切换入口 | ✅ |
| R2 全页面覆盖 | T4–T8 | 245 处字面量**全部** token 化（残留 0），覆盖 `pages.tsx`（含 `ADMIN_CSS` 与 admin 组件）与 `legal.tsx` | ✅（目视待 T9） |
| R3 语义化配色层 | T1、T4、T5、T13 | 30 个 token，**全部被引用**（无死 token），`var(--rdsh-*)` 引用 256 处 | ✅ |
| R4 原生控件 | T1、T4 | `color-scheme: light dark`（CSS）+ `<meta name="color-scheme">`（HTML）；17 `<input>`/4 `<select>`/2 `<textarea>` 走 `inputStyle` 与 token | ✅ |
| R5 二维码 | T4 | 二维码容器背景为 `--rdsh-bg-surface` | ✅（扫描待 T9） |
| R6 对比度（收窄版） | T10、T13 | **深色 18 组全部 ≥ 4.5:1（0 FAIL）**；浅色 5 项 FAIL 全部为既有值 | ✅ |
| R7 阴影与遮罩 | T1、T4 | `--rdsh-scrim`/`--rdsh-scrim-soft`/`--rdsh-shadow` 已替换 6 处 `rgba()`，残留 0 | ✅ |
| R8 架构图 | T8 | `legal.tsx:54` 加 `className="rdsh-arch"`；深色滤镜规则存在于线上 CSS | ✅（观感待 T9） |
| R9 `color-scheme` | T1、T3 | CSS + meta 双声明，线上 HTML 可见 meta | ✅ |
| R10 浅色不回归 | T4–T7、T9 | 见 §7：17 项取值完全一致，9 组为归并产生的轻微差异 | ✅（目视待 T9） |
| R11 构建与测试零缺陷 | T9 | `pnpm build` 退出码 0；`pnpm test` 229 用例 0 fail | ✅ |
| R12 深色微信按钮反转 | T13 | `--rdsh-wechat-bg`/`--rdsh-wechat-fg` 按主题反转；`fill="#FFF"` → `fill="currentColor"`；深色对比度 2.38:1 → **6.58:1** | ✅（目视待 T9） |

## 3. 代码存在且被调用（证据）

| 检查 | 证据 |
|---|---|
| `theme.css` 被引入 | `packages/portal/src/main.tsx:1` `import "./theme.css";` |
| 构建产物包含 token 层 | `packages/portal/dist/assets/index-COSAeRGT.css`，含 `:root` 浅色 token、深色媒体查询、`img.rdsh-arch` 滤镜 |
| 生产页面挂载样式 | 线上 `/portal` HTML 含 `<link rel="stylesheet" href="/portal/assets/index-COSAeRGT.css">` |
| 线上与本地字节一致 | 线上 CSS 与本地 `dist` 的 sha256 均为 `c23011853e398f7abdc84e6a2357a75d00613b35065b4a9910893ab891d9d86c` |
| 微信按钮两主题取值 | 产物与线上均为 `--rdsh-wechat-bg: #07c160` / `--rdsh-wechat-fg: #fff`（浅）与 `#232324` / `#07c160`（深） |
| token 无死代码 | 30 个 token 全部有引用；引用总数 256 |
| 未引入新依赖 | `packages/portal/package.json` 未改动 |

## 4. 残留硬编码颜色：**0 处**

改动前 245 处内联硬编码色值（`pages.tsx` 237 + `legal.tsx` 8）已全部替换为 token。

原先有意保留的 `pages.tsx:1771` `fill="#FFF"`（微信白 logo）已在 R12 中改为 `fill="currentColor"`——既让图标随主题变色，又顺带消除了「SVG 表现属性中 `var()` 支持不可靠」的隐患（`currentColor` 是关键字，不受该限制）。

同类陷阱点 `pages.tsx:1184` 亦已改为 `stroke="currentColor"` + `style={{ color: "var(--rdsh-success)" }}`。

复算命令：`grep -ohE '#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)' src/pages.tsx src/legal.tsx` → 无输出。

## 5. 构建与测试

```
pnpm build   → exit 0（portal vite build + 4 包 tsc strict；hub 执行 copy-portal 复制到 packages/hub/portal）
pnpm test    → exit 0
```

| 包 | tests | fail |
|---|---|---|
| tunnel | 12 | 0 |
| hub | 91 | 0 |
| gateway | 110 | 0 |
| cli | 0 | 0 |
| web-remote | 16 | 0 |
| **合计** | **229** | **0** |

构建期存在既有告警 `src/i18n.ts: Duplicate key "已复制"`——`i18n.ts` 本次未改动（`git diff --name-only` 无此文件），属既有问题，按「Surgical Changes」未顺手修改。

## 6. 对比度实算（R6）

脚本读取 `theme.css` 实际 token 值后按 WCAG 2.1 计算。

### 深色：18 组，**0 FAIL**

| 组合 | 比值 |
|---|---|
| 正文 on 页面底 `#f9fafb`/`#151517` | 17.45:1 |
| 正文 on 卡片 `#f9fafb`/`#232324` | 15.03:1 |
| 次级 on 页面 `#cfd3d6`/`#151517` | 12.11:1 |
| 次级 on 卡片 | 10.42:1 |
| 弱化 on 页面 `#adb2b8`/`#151517` | 8.54:1 |
| 弱化 on 卡片 | 7.36:1 |
| 链接 on 页面 `#679efe`/`#151517` | 6.86:1 |
| 链接 on 卡片 | 5.91:1 |
| 危险 on 页面 `#f25a5a`/`#151517` | 5.55:1 |
| 危险 on 卡片 | 4.77:1 |
| 危险 on 危险软底 `#f87171`/`#382929` | 5.00:1 |
| 成功强 on 成功软底 `#22c55e`/`#233c2c` | 5.25:1 |
| 成功 on 页面 `#22c55e`/`#151517` | 8.00:1 |
| 警告强 on 警告软底 `#f7ad31`/`#27241f` | 8.08:1 |
| 警告标题 on 页面 | 9.53:1 |
| 填充上文字 on 主色 `#fff`/`#2563eb` | 5.17:1 |
| 填充上文字 on 危险填充 `#fff`/`#dc2626` | 4.83:1 |
| **微信按钮前景 on 按钮底 `#07c160`/`#232324`** | **6.58:1**（R12 前为 2.38:1） |

### 浅色：18 组，5 FAIL——**全部为既有**

| FAIL 组合 | 比值 | 是否既有 |
|---|---|---|
| 弱化文本 `#9ca3af` on `#fff`（页面） | 2.54:1 | 既有（token 取值与改动前逐字一致） |
| 弱化文本 `#9ca3af` on `#fff`（卡片） | 2.54:1 | 既有（同上） |
| 危险 on 危险软底 `#dc2626`/`#fef2f2` | 4.41:1 | 既有（同上） |
| 成功 on 页面 `#16a34a`/`#fff` | 3.30:1 | 既有（同上） |
| 微信按钮白字 on 绿底 `#fff`/`#07c160` | 2.38:1 | 既有（浅色按 R12 明确保持不变） |

## 7. 浅色差异清单（R10）

**取值完全一致（18 项）**：`#f3f4f6`、`#eef2ff`、`#111`、`#6b7280`、`#9ca3af`、`#e5e7eb`、`#eee`、`#16a34a`、`#047857`、`#ecfdf5`、`#fef2f2`、`#f59e0b`、`#fffbeb`、`#b45309`、`#07c160`、`#2563eb`（填充与文本同值）、`#dc2626`（填充与文本同值）、`#fff`（表面 / 填充上文字 / 微信按钮前景三处同值）。

**归并产生的差异（9 组，Q4 已批准）**：

| 原字面量 | 归入 token | 浅色现值 | 变化方向 | 出现处 |
|---|---|---|---|---|
| `#f8fafc` | `--rdsh-bg-subtle` | `#f3f4f6` | 极轻微变深 | 5 |
| `#f9fafb` | `--rdsh-bg-subtle` | `#f3f4f6` | 极轻微变深 | 1 |
| `#111827` | `--rdsh-fg` | `#111` | 轻微变深 | 4 |
| `#374151` | `--rdsh-fg` | `#111` | 变深 | 1 |
| `#333` | `--rdsh-fg` | `#111` | 轻微变深 | 2 |
| `#444` | `--rdsh-fg` | `#111` | **可感知变深** | 3 |
| `#666` | `--rdsh-fg-muted` | `#6b7280` | 轻微变浅 | 26 |
| `#999` | `--rdsh-fg-subtle` | `#9ca3af` | 轻微变浅 | 7 |
| `#ccc` | `--rdsh-border` | `#e5e7eb` | 轻微变浅 | 6 |

边界色另有一处轻微偏移：`--rdsh-success-border` / `--rdsh-danger-border` 由 `#10b981`/`#f87171` + `55` alpha 改为以 `--rdsh-success`/`--rdsh-danger` 为基的 33% `color-mix`（各 1 处）。

**其中 `#444`→`#111`（3 处，`pages.tsx` 2FA 说明段落）为可感知差异**，plan.md 风险 R-1 已预判。若需逐字保留，可为其单列 `--rdsh-fg-body` token（成本：1 个 token + 3 处替换）。

## 8. 缺口清单

| # | 缺口 | 严重度 | 建议动作 |
|---|---|---|---|
| G1 | **T9 真机目视核验未执行** | **高（阻塞验收）** | 人工在 `https://rdsh.cn/portal` 以系统深色/浅色各跑一轮，逐页覆盖 req.md R2 列出的路由；核对 §7 差异清单 |
| G2 | 架构图滤镜观感未定论（`hue-rotate` 为矩阵近似、底色为纯黑、JPEG 噪点放大） | 中 | 同 G1 目视 `/portal/product`；若不满意，备选 `mix-blend-mode: screen` 或改出深色资产（solution.md §5.6） |
| G3 | 浅色既有对比度债 5 项（§6） | 低 | 已列为 plan.md T12（`⏭️`），见 TODO.md |
| G4 | 改动尚未 commit / push | 中 | 按 req.md §5 流程：验证通过后显式路径提交（Batch Plan 待出） |
| G5 | `color-mix()` 浏览器下限（Chrome 111+ / Safari 16.2+ / Firefox 113+） | 低 | DSH 自身已使用该函数；如需支持更旧浏览器，可将 soft/border token 降级为固定字面量 |
| G6 | 部署态：重启 `rdsh-hub.service` 会切回全局 npm 包内的旧 portal | 中（流程约束） | 验证期间不得重启（req.md §5 第 3 条）；根治需异地发布新 hub 包 |

## 9. 非本次范围的观察项

- 构建期 `src/i18n.ts` 存在重复 key `"已复制"`（既有，未修）。
- 浅色下微信按钮白字 on 绿底 2.38:1（既有，R12 明确只改深色）。
- 浅色下弱化文本 2.54:1、成功文本 3.30:1、危险 on 软底 4.41:1（既有，见 T12）。
- 线上 hub 服务的是工作区构建而非全局包产物（discussion.md §6，本次按决策不处理）。

## 10. 发布前独立复核（2026-09-11，另一会话执行）

原实现会话之外，按「以查档求证为荣」再做一轮独立验证，全部通过：

| # | 复核项 | 方法 | 结果 |
|---|---|---|---|
| I1 | 构建与测试 | `pnpm build` + `pnpm test` | ✅ 退出码 0；tunnel 12 / hub 91 / gateway 110 / cli 0 / web-remote 16，全 0 fail |
| I2 | 残留硬编码色值 | `grep -o '#[0-9a-fA-F]\{3,8\}' src/*.tsx src/*.ts`（排除 `theme.css`） | ✅ **0 处** |
| I3 | token 层规模 | `grep -o -- '--rdsh-[a-z-]*:' theme.css` / `var(--rdsh-*)` 计数 | ✅ 30 个 token；tsx 中 251 处引用 |
| I4 | 深色对比度 | 独立脚本按 WCAG 2.1 从 `theme.css` 实际取值重算 18 组 | ✅ 18 组全部 ≥ 4.5:1，且与 §6 声明值**逐条一致** |
| I5 | 提交资产 vs 重新构建 | 重建后 `git status` | ✅ 无差异（`packages/hub/portal` 与构建产物一致，无漂移） |
| I6 | 线上字节一致 | 拉取 `https://rdsh.cn/portal/assets/index-COSAeRGT.css` 与本地 `dist` 比对 sha256 | ✅ 均为 `c23011853e398f7abdc84e6a2357a75d00613b35065b4a9910893ab891d9d86c` |
| I7 | 线上挂载 | 抓取 `https://rdsh.cn/portal/` 的 `<link>` 并检查 CSS 内容 | ✅ 引用新 CSS；CSS 含 `prefers-color-scheme:dark` 与 30 个 token |
| I8 | 真机目视（T9） | 用户在浏览器浅/深各一轮确认 | ✅ 2026-09-11 通过 |

> 结论：实现、构建、产物、线上、对比度五个层面均独立复核通过；发布为 `rdsh-hub 0.7.1` + `remote-dsh 0.10.3`。剩余唯一项为 T12（浅色既有对比度债，按 C1 决策跳过）。
