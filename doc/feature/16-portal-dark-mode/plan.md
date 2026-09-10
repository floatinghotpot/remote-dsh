# portal 深色模式（plan）

> **日期**: 2026-09-11
> **上游**: [req.md](req.md)（已批准）、[solution.md](solution.md)（已批准）
> **状态**: **待批准**（获批后按任务清单实施）
> **交付流程**: 见 req.md §5（就地构建 → 真机验证 → commit & push → 异地发布）

---

## 1. RTTM（需求 → 任务追溯矩阵）

| 需求 | 任务 | 覆盖方式 |
|---|---|---|
| R1 跟随系统深色 | T1 | `@media (prefers-color-scheme: dark)` 覆盖 `:root` token |
| R2 全页面覆盖 | T4、T5、T6、T7 | 组件内联 + `ADMIN_CSS` + 法务页内联 `<style>` 全覆盖 |
| R3 语义化配色层 | T1、T4 | token 表 + §5.4 映射规则 |
| R4 原生控件与浏览器 UI | T1、T4 | `color-scheme: light dark` + `inputStyle` + `:2062`/`:2552` |
| R5 二维码可扫描 | T4 | 二维码容器保持浅底（token 化后仍为浅色） |
| R6 对比度（收窄版） | T10 | 深色实算达标；浅色既有债记入 TODO |
| R7 阴影与遮罩 | T1、T4 | `--rdsh-scrim` / `--rdsh-shadow` |
| R8 架构图 | T8 | `img.rdsh-arch` 滤镜 |
| R9 声明 `color-scheme` | T1、T3 | CSS + meta 双声明 |
| R10 浅色不回归 | T4–T7、T9 | 浅色列取现状值；T9 出差异清单 |
| R11 构建与测试零缺陷 | T9 | `pnpm build` + `pnpm test` |

## 2. 任务清单

| # | 任务 | 文件 | 状态 |
|---|---|---|---|
| T1 | 新增 `theme.css`：token 层（浅/深两套）+ `color-scheme` + 架构图滤镜 | `packages/portal/src/theme.css`（新） | ✅ |
| T2 | 引入 `theme.css` | `packages/portal/src/main.tsx` | ✅ |
| T3 | 补 `color-scheme` meta | `packages/portal/index.html` | ✅ |
| T4 | 替换**单角色**字面量（表面/文本/描边/软底/状态色） | `packages/portal/src/pages.tsx` | ✅ |
| T5 | 替换**双角色**字面量（`#2563eb`、`#dc2626`、`#fff` 作 `color`）按属性判定 | `packages/portal/src/pages.tsx` | ✅ |
| T6 | 处理两处陷阱调用点（`:631` alpha 拼接、`:1184` SVG stroke） | `packages/portal/src/pages.tsx` | ✅ |
| T7 | 替换 `ADMIN_CSS` 与 admin 组件色值 | `packages/portal/src/pages.tsx` | ✅ |
| T8 | 替换法务页内联 `<style>` 色值 + 架构图 class | `packages/portal/src/legal.tsx` | ✅ |
| T9 | 构建 + 真机逐页核验（浅/深各一轮）+ 浅色差异清单 | — | ❌ |
| T10 | 对比度实算复核（R6，深色达标） | — | ✅ |
| T11 | 更新 `verification.md` / `summary.md` / `TODO.md` / `plan.md` 状态 | `doc/feature/16-portal-dark-mode/` | ✅ |
| T12 | 浅色既有对比度债（5 项 AA 不达标）的整改 | `packages/portal/src/theme.css` | ⏭️ |
| T13 | 深色下微信按钮反转前景/背景（R12）：深底 + 品牌绿前景 + 图标改 `currentColor` | `packages/portal/src/theme.css`、`packages/portal/src/pages.tsx` | ✅ |

> 状态标记：`✅` 完成并验证 / `❌` 未完成 / `⏭️` 本轮显式跳过（附决策理由）。
> T11 属 §7 流程收尾，非功能任务。
>
> - **T7 说明**：`ADMIN_CSS`（`:1956`–`:2224`）与其 admin 组件的色值由 T4/T5 的字面量映射一并覆盖（替换后全仓**已无任何硬编码颜色字面量**，见 verification.md §4）。
> - **T9 说明**：构建/测试部分已完成并通过；**真机目视核验需人工执行**（本机无浏览器、仓库无视觉回归基建，N6），故整体标记未完成。
> - **T12 决策理由**：C1 决策——浅色既有对比度债不在本轮范围（见 solution.md §6 C1）；本轮只保证深色达 AA 且浅色无回归。
> - **T13 来源**：2026-09-11 用户追加需求 R12（见 req.md）——原解决将该色列为「保留品牌绿」并接受 2.38:1 既有债，用户提出反转前景/背景的方案，实算后深色对比度由 2.38:1 提升至 6.58:1，故深色列 FAIL 由 1 降为 0。

## 3. 任务细节

### T1 `theme.css`

新增文件，内容为 solution.md §5.3 的 token 表：

- `:root { color-scheme: light dark; ...浅色 token... }`
- `@media (prefers-color-scheme: dark) { :root { ...深色 token... } }`
- `@media (prefers-color-scheme: dark) { img.rdsh-arch { filter: invert(1) hue-rotate(180deg); } }`
- **最小全局规则**：`html, body { background: var(--rdsh-bg-base); color: var(--rdsh-fg); }`
  （现状 portal 无任何 `body` 规则，深色下必须给底色，否则仍是白）
- 不做全局 reset、不引入字体/排版规则（N5）

**验证**：文件语法正确；构建后生成 `dist/assets/index-*.css` 且 `dist/index.html` 出现 `<link rel="stylesheet">`。

### T2 `main.tsx`

顶部增加 `import "./theme.css";`（`main.tsx` 现仅 24 行，无其他 CSS 引入）。

**验证**：构建产物含 CSS 文件。

### T3 `index.html`

`<meta name="viewport">` 后补 `<meta name="color-scheme" content="light dark" />`。

### T4 单角色字面量替换

按 solution.md §2.3 表替换以下**无歧义**字面量（`background`/`color`/`border` 语义唯一）：

| 字面量 | token |
|---|---|
| `#f3f4f6` `#f8fafc` `#f9fafb` | `--rdsh-bg-subtle` |
| `#eef2ff` | `--rdsh-bg-active` |
| `#111` `#111827` `#374151` `#333` `#444` | `--rdsh-fg` |
| `#6b7280` `#666` | `--rdsh-fg-muted` |
| `#9ca3af` `#999` | `--rdsh-fg-subtle` |
| `#e5e7eb` `#ccc` | `--rdsh-border` |
| `#eee` | `--rdsh-border-soft` |
| `#16a34a` `#047857` | `--rdsh-success` / `--rdsh-success-strong` |
| `#ecfdf5` | `--rdsh-success-soft` |
| `#fef2f2` | `--rdsh-danger-soft` |
| `#f59e0b` | `--rdsh-warn` |
| `#fffbeb` | `--rdsh-warn-soft` |
| `#b45309` | `--rdsh-warn-strong` |
| `#07c160` `#07C160` | `--rdsh-wechat` |
| `rgba(0,0,0,.55)` / `.4` | `--rdsh-scrim` |
| `rgba(0,0,0,.1)` | `--rdsh-shadow` 的一部分（投影整值替换） |

**验收**：替换后 `grep` 确认这些字面量归零；`pnpm --filter rdsh-portal build` 通过。

### T5 双角色字面量替换（按属性判定）

按 solution.md §5.4 规则，**逐处按属性名判定**，不做全局替换：

| 字面量 | `background:` | `color:` / `border` / `stroke` |
|---|---|---|
| `#fff` | `--rdsh-bg-surface` | `--rdsh-fg-on-fill` |
| `#2563eb` | `--rdsh-primary` | `--rdsh-link` |
| `#dc2626` | `--rdsh-danger-fill` | `--rdsh-danger` |

`#fff` 共 25 处（12 `background` / 5 `color` / 8 其他），`#2563eb` 15 处，`#dc2626` 32 处 → **共 72 处需逐处判定**。判定后须 `git diff` 逐块复核，确认没有把填充误判为文本（会把按钮变成透明底）。

### T6 陷阱调用点

- `pages.tsx:631`：`` `1px solid ${ok ? "#10b981" : "#f87171"}55` `` → `` `1px solid var(${ok ? "--rdsh-success-border" : "--rdsh-danger-border"})` ``
- `pages.tsx:1184`：`stroke="#16a34a"` → `stroke="currentColor"`，并在既有 `style`（`:1187`）加 `color: "var(--rdsh-success)"`

### T7 `ADMIN_CSS` 与 admin 组件

`ADMIN_CSS`（`:1956`–`:2224`，33 处）与 5 个 admin 组件（`adminBtnStyle:1974`、`adminTableStyle:1981` 等）按同一映射替换。

### T8 法务页

- `legal.tsx:24` 内联 `<style>` 的 8 处色值 → token
- `legal.tsx:54` 的 `<img>` 增加 `className="rdsh-arch"`

### T9 构建与真机核验

```
pnpm --filter rdsh-portal build && pnpm --filter rdsh-hub build
pnpm build && pnpm test
```

真机：`https://rdsh.cn/portal`，系统深色/浅色各跑一轮，逐页覆盖 req.md §2 R2 列出的全部路由；产出**浅色差异清单**（R10）。

**注意**：核验期间不得重启 `rdsh-hub.service`（req.md §5 第 3 条）。

### T10 对比度实算

对 solution.md §5.3 深色列的每个「文本/背景」组合实算 WCAG 比值并留档（脚本输出），要求全部 ≥ 4.5:1。

## 4. 实施顺序与验证节点

```
T1 → T2 → T3          构建验证（CSS 产出 + link 注入）
  ↓
T4                    grep 归零 + 构建
  ↓
T5 （72 处判定）       git diff 逐块复核 + 构建
  ↓
T6 → T7 → T8          构建 + pnpm test
  ↓
T9 （真机两轮核验）    浅色差异清单
  ↓
T10 → T11
```

每个节点失败即视为 Blocked，先修复再继续（§4 Zero-Defect Gate）。

## 5. 风险登记

沿用 solution.md §7（R-1 浅色可感知差异、R-2 架构图滤镜观感、R-3 `color-mix` 兼容性、R-4 重启回退、R-5 管理后台规模）。其中 R-1 与 R-2 需在 T9 真机阶段定论。
