# portal 深色模式（solution）

> **日期**: 2026-09-11
> **上游**: [req.md](req.md)（已批准）、[discussion.md](discussion.md)（事实审计）
> **状态**: **待批准**（本文件获批后方可编写 `plan.md`）
> **范围**: `packages/portal`（前端源码 + 新增 1 个 CSS 文件）

---

## 1. Goal

portal 引入**单层语义化配色层**，通过 `prefers-color-scheme` 在浅/深两套取值间自动切换；深色取值**对齐 DSH 官方深色 token**，使 portal 与 DSH 宿主观感一致；浅色取值**保留现状字面量**以将回归降到最低。

## 2. Facts（已核对，非推测）

### 2.1 主题层缺失（复核自 discussion.md §2）

- 包内 CSS 文件 0 个；`var(--...)` 0 处；`prefers-color-scheme` 0 处；无 `color-scheme` 声明；无 `body` 规则。
- `src/pages.tsx` 内联 hex **237** 处（其中 `ADMIN_CSS` 段 33 处），`src/legal.tsx` **8** 处，合计 **245**。
- `packages/hub/src/portal.ts:22` 已有 `".css": "text/css; charset=utf-8"` → **新增 CSS 文件无需改动 hub**。

### 2.2 DSH 官方深色真值（查档：`@deepseek-ai/dsh-client-ui-theme/lib/client.js`）

DSH 采用**两层**：`--dsw-static-*` 原始调色板 → `--dsw-alias-*` 语义，深色通过 `body[data-ds-dark-theme]` 重指别名。解析出的深色真值：

| DSH alias | 浅色 | 深色 |
|---|---|---|
| `bg-base` | `#fff` | `#151517` |
| `bg-layer-1` | `#fff` | `#232324` |
| `bg-layer-2` | `#fff` | `#2c2c2e` |
| `bg-layer-3` | `#fff` | `#353638` |
| `label-primary` | `#0f1115` | `#f9fafb` |
| `label-secondary` | `#61666b` | `#cfd3d6` |
| `label-tertiary` | `#81858c` | `#adb2b8` |
| `border-l2` | `#0000001a` | `#ffffff1f` |
| `border-l3` | `#0000001f` | `#ffffff29` |
| `link` | `#4176e6` | `#679efe` |
| `state-error-primary` | `#ec1313` | `#f25a5a` |
| `state-success-primary` | `#22c55e` | `#22c55e` |
| `state-warn-primary` | `#f59e0b` | `#f59e0b` |
| `state-warn-secondary` | `#f7ad31` | `#f7ad31` |
| `state-warn-label` | `#dd8629` | `#dd8629` |
| `state-success-tertiary` | `#e6faed` | `#233c2c` |
| `state-warn-tertiary` | `#fef5e7` | `#27241f` |
| `interactive-bg-hover` | `#2631480f` | `#ffffff14` |
| `bg-mask-1` | `#0000003d` | `#00000080` |
| `scrollbar-bg-l2` | `#e5e5e5` | `#545557` |

> 注：DSH 深色下 `button-primary-fill` 仍为 `#f9fafb`（近白填充）+ `label-primary-foreground` 转为深色 → DSH 的深色主按钮是**白底黑字**。portal 现有设计是**蓝底白字**。按 N5（不做视觉重设计），portal **不采纳** DSH 的按钮形态，仅采纳其配色取值。此处为对「follow DSH」的**刻意偏离**，已在 §6 标注待确认。

### 2.3 字面量角色盘点（30 个，全部逐个核对过用法）

| 字面量 | 频次 | 实际角色 | 归入 token |
|---|---|---|---|
| `#fff` | 25 | 12×`background` 表面底 / 5×`color` 填充上文字 / 8×其他 | `--rdsh-bg-surface` / `--rdsh-fg-on-fill` |
| `#f3f4f6` `#f8fafc` `#f9fafb` | 15 / 5 / 1 | 浅底色块（`<pre>`、提示块） | `--rdsh-bg-subtle` |
| `#eef2ff` | 2 | 选中标签底（`:162`、`:2230`） | `--rdsh-bg-active` |
| `#111` `#111827` `#374151` `#333` `#444` | 5 / 4 / 1 / 2 / 3 | 主要/正文文本 | `--rdsh-fg` |
| `#6b7280` `#666` | 28 / 26 | 次级文本 | `--rdsh-fg-muted` |
| `#9ca3af` `#999` | 12 / 7 | 弱化/占位文本 | `--rdsh-fg-subtle` |
| `#e5e7eb` `#ccc` | 20 / 6 | 描边 | `--rdsh-border` |
| `#eee` | 13 | 浅描边 | `--rdsh-border-soft` |
| `#2563eb` | 15 | **填充**（主按钮底）与**文本**（链接、`:598`/`:600`）两义 | `--rdsh-primary` / `--rdsh-link` |
| `#dc2626` | 32 | **填充**（危险按钮）与**文本/描边**两义 | `--rdsh-danger-fill` / `--rdsh-danger` |
| `#16a34a` | 3 | 成功文本/图形（`:1340` 在线点、`:1638` 成功文案、`:1184` SVG stroke） | `--rdsh-success` |
| `#047857` | 3 | 成功徽标文本（深绿，配浅绿底） | `--rdsh-success-strong` |
| `#ecfdf5` | 3 | 成功软底 | `--rdsh-success-soft` |
| `#10b981` | 1 | 成功描边（`:631`，**带 `55` 后缀**） | `--rdsh-success-border` |
| `#fef2f2` | 1 | 危险软底（`:629`） | `--rdsh-danger-soft` |
| `#f87171` | 1 | 危险描边（`:631`，**带 `55` 后缀**） | `--rdsh-danger-border` |
| `#f59e0b` | 1 | 警告描边（`:841`） | `--rdsh-warn` |
| `#fffbeb` | 1 | 警告软底（`:843`） | `--rdsh-warn-soft` |
| `#b45309` | 1 | 警告标题文本（`:852`） | `--rdsh-warn-strong` |
| `#07c160` | 2 | 微信品牌（登录/支付按钮） | `--rdsh-wechat`（两主题同值） |
| `rgba(0,0,0,.55)` ×2、`.4` ×2 | 4 | 模态遮罩（`:1414`/`:1939`、`:2052`/`:2547`） | `--rdsh-scrim` |
| `rgba(0,0,0,.1)` ×2 | 2 | 下拉投影（`:1354`、`:2486`） | `--rdsh-shadow` |

### 2.4 样式入口与爆炸半径

| 入口 | 位置 | 说明 |
|---|---|---|
| `btnStyle()` | `pages.tsx:170` | 主/危险/幽灵三种按钮，被全站调用 |
| `inputStyle()` | `pages.tsx:183` | 输入框样式 |
| `menuItemStyle()` | `pages.tsx:187` | 菜单项 |
| `adminBtnStyle()` | `pages.tsx:1974` | 管理后台按钮（独立于 `btnStyle`） |
| `adminTableStyle()` | `pages.tsx:1981` | 管理后台表格 |
| `ADMIN_CSS` | 定义 `:1956`，注入 `:2225` | 管理后台整段 CSS（33 处色值） |
| `Card` / `CurrentPlanCard` | `:644` / `:798` | 卡片容器，硬编码 `#fff` |
| 裸 `<style>` | `legal.tsx:24` | 法务页排版（8 处色值） |

改动均为**样式取值**层面，`btnStyle` 等函数的**签名与返回类型不变**。

### 2.5 两处替换陷阱（`var()` 不能简单套用）

| 位置 | 现状 | 问题 |
|---|---|---|
| `pages.tsx:631` | `` `1px solid ${ok ? "#10b981" : "#f87171"}55` `` | 在色值后**拼接 `55` alpha 后缀**；换成 `var(--x)` 后 `var(--x)55` 非法 |
| `pages.tsx:1184` | SVG 表现属性 `stroke="#16a34a"` | 表现属性中的 `var()` 支持不可靠，须改走 `style` 或 `currentColor` |

### 2.6 既有浅色对比度债（本次不修，需知情）

脚本实算（WCAG 2.1，`(L1+0.05)/(L2+0.05)`）：

| 组合 | 比值 | 结论 |
|---|---|---|
| 浅色 `#9ca3af` on `#fff` | **2.54:1** | 不达 AA（既有） |
| 浅色 `#999` on `#fff` | **2.85:1** | 不达 AA（既有） |
| 微信绿上的白字（两主题） | **2.38:1** | 不达 AA（既有） |
| 浅色 `#6b7280` on `#fff` | 4.83:1 | 达标 |

## 3. Gap

portal 缺一层「语义 → 浅/深取值」的映射：245 处字面量直接把浅色写死在组件里，既无法整体切换，也无法集中校正对比度。本次要补的正是这一层，并把 245 处收敛到约 20 个语义 token。

## 4. Call-site Audit

`btnStyle` / `inputStyle` / `menuItemStyle` / `adminBtnStyle` / `adminTableStyle` 的**签名不变**，仅内部取值改为 `var(--rdsh-*)` → 全部调用点**自动兼容**，无需逐处改（这是选择「改助手内部」而非「改 44 个组件」的理由）。

需要**逐处单独处理**的调用点：

| 位置 | 处理 |
|---|---|
| `pages.tsx:631` | 去掉 `55` 拼接，改用 `--rdsh-success-border` / `--rdsh-danger-border`（内部已含 33% alpha） |
| `pages.tsx:1184` | `stroke="#16a34a"` → `stroke="currentColor"`，并在既有 `style`（`:1187`）中加 `color: "var(--rdsh-success)"` |
| `pages.tsx:629-630` | 危险文本改用 `--rdsh-danger-on-soft`（软底上的专用值，见 §5.5） |
| `pages.tsx:1354`、`2486` | `boxShadow` 改为 `var(--rdsh-shadow)` |
| `pages.tsx:1414`、`1939`、`2052`、`2547` | 遮罩底改为 `var(--rdsh-scrim)` |
| `pages.tsx:2062`、`2552` | `<input>`/`<select>` 的 `background: "#fff"` → `--rdsh-bg-surface` + `color: var(--rdsh-fg)` |
| `pages.tsx:152`（`AppShell`） | 补 `minHeight: "100vh"` + `background: var(--rdsh-bg-base)` |
| `legal.tsx:24` | 内联 `<style>` 中的 8 处色值改为 `var(--rdsh-*)` |
| `legal.tsx:54` | 架构图 `<img>` 增加 class，供深色滤镜规则命中（§5.6） |
| `ADMIN_CSS`（`:1956`） | 33 处色值改为 `var(--rdsh-*)` |

## 5. 设计

### 5.1 实现形态

新增 `packages/portal/src/theme.css`，在 `src/main.tsx` 顶部 `import "./theme.css"`。Vite 会产出 `dist/assets/index-*.css` 并自动在 `index.html` 注入 `<link rel="stylesheet">`。

选择真实 CSS 文件而非 `ADMIN_CSS` 那种字符串注入的理由：媒体查询与 `:root` 变量应存在于真正的样式表层，且便于后续维护。

同时：
- `theme.css` 内 `:root { color-scheme: light dark; }`（R9）
- `index.html` 补 `<meta name="color-scheme" content="light dark" />`（R9）

### 5.2 命名与层级决策

- **前缀 `--rdsh-`**：不复用 `--dsw-*`。理由：`--dsw-*` 是 DSH 私有命名空间，portal 在插件场景下可能与其同页共存，劫持该前缀有相互覆盖风险。
- **单层 alias，不做 static 两层**：portal 的颜色角色仅约 20 个，再插一层原始调色板属过度设计（§2 Simplicity First）。取值**对齐 DSH 深色真值**以满足 Q1「follow DSH」，但结构从简。

### 5.3 Token 表（浅 / 深）

浅色列一律取**现状字面量**（R10 最小回归）；深色列对齐 DSH。

| Token | 浅色 | 深色 | DSH 对应 |
|---|---|---|---|
| `--rdsh-bg-base` | `#fff` | `#151517` | `bg-base` |
| `--rdsh-bg-surface` | `#fff` | `#232324` | `bg-layer-1` |
| `--rdsh-bg-subtle` | `#f3f4f6` | `#2c2c2e` | `bg-layer-2` |
| `--rdsh-bg-active` | `#eef2ff` | `#ffffff14` | `interactive-bg-hover` |
| `--rdsh-fg` | `#111` | `#f9fafb` | `label-primary` |
| `--rdsh-fg-muted` | `#6b7280` | `#cfd3d6` | `label-secondary` |
| `--rdsh-fg-subtle` | `#9ca3af` | `#adb2b8` | `label-tertiary` |
| `--rdsh-fg-on-fill` | `#fff` | `#fff` | （刻意偏离，§2.2） |
| `--rdsh-border` | `#e5e7eb` | `#ffffff29` | `border-l3` |
| `--rdsh-border-soft` | `#eee` | `#ffffff1f` | `border-l2` |
| `--rdsh-primary` | `#2563eb` | `#2563eb` | （保留，§5.5） |
| `--rdsh-link` | `#2563eb` | `#679efe` | `link` |
| `--rdsh-danger` | `#dc2626` | `#f25a5a` | `state-error-primary` |
| `--rdsh-danger-on-soft` | `#dc2626` | `#f87171` | （复用既有字面量，§5.5） |
| `--rdsh-danger-fill` | `#dc2626` | `#dc2626` | （保留，§5.5） |
| `--rdsh-danger-soft` | `#fef2f2` | `color-mix(in srgb, var(--rdsh-danger) 10%, transparent)` | （DSH tag 同款手法） |
| `--rdsh-danger-border` | `color-mix(in srgb, var(--rdsh-danger) 33%, transparent)` | 同左（自适应） | （等价原 `#f87171`+`55`） |
| `--rdsh-success` | `#16a34a` | `#22c55e` | `state-success-primary` |
| `--rdsh-success-strong` | `#047857` | `#22c55e` | `state-success-primary` |
| `--rdsh-success-soft` | `#ecfdf5` | `#233c2c` | `state-success-tertiary` |
| `--rdsh-success-border` | `color-mix(in srgb, var(--rdsh-success) 33%, transparent)` | 同左（自适应） | （等价原 `#10b981`+`55`） |
| `--rdsh-warn` | `#f59e0b` | `#f59e0b` | `state-warn-primary` |
| `--rdsh-warn-strong` | `#b45309` | `#f7ad31` | `state-warn-secondary` |
| `--rdsh-warn-soft` | `#fffbeb` | `#27241f` | `state-warn-tertiary` |
| `--rdsh-wechat` | `#07c160` | `#07c160` | 第三方品牌（§5.5） |
| `--rdsh-scrim` | `rgba(0,0,0,.55)` | `rgba(0,0,0,.72)` | `bg-mask-1` |
| `--rdsh-shadow` | `0 4px 12px rgba(0,0,0,.1)` | `0 4px 12px rgba(0,0,0,.5)` | — |

### 5.4 字面量 → token 映射规则

JSX 内联样式中的字面量按 §2.3 表替换；**双义字面量按属性判定**：

- `background:` → 填充型 token（`--rdsh-bg-surface` / `--rdsh-primary` / `--rdsh-danger-fill`）
- `color:` / `border` / `stroke` → 文本型 token（`--rdsh-fg*` / `--rdsh-link` / `--rdsh-danger`）
- `#fff` 作 `color` 时 → `--rdsh-fg-on-fill`

### 5.5 Q2 决策：品牌色处理（附实算依据）

| 色 | 决策 | 依据（实算 WCAG 比值） |
|---|---|---|
| `#2563eb` 主色 | **按语义拆分**：填充保留 `#2563eb`；文本/链接深色改用 `#679efe`（对齐 DSH `link`） | `#2563eb` 作**文本**在深色底 `#151517` 上仅 **3.53:1**（不达 AA 4.5:1）；作**填充 + 白字**为 **5.17:1**（达标）。DSH 深色 link `#679efe` 达 **6.86:1** |
| `#dc2626` 危险色 | **按语义拆分**：填充保留；文本深色改用 `#f25a5a`；**软底上的文本**用 `#f87171` | `#dc2626` 作文本在深色底仅 **3.78:1**；`#f25a5a` 为 **5.55:1**；但在软底色块（10% tint 落在卡片面 `#232324` 上 → `#382929`）上 `#f25a5a` 只有 **4.21:1**，`#f87171` 为 **5.00:1**（达标） |
| `#047857` 成功文本 | 深色改用 `#22c55e` | `#047857` 在深色底仅 **3.33:1**；`#22c55e` 为 **8.00:1** |
| `#07c160` 微信绿 | **保留原值** | 第三方品牌色，用户凭颜色识别「微信登录/支付」。白字在其上为 **2.38:1**，但**浅色下即已如此**（该比值与主题无关），属既有对比度债，非深色回归；改动会破坏品牌一致性 |

### 5.6 Q3 决策：架构图（方案 A，CSS 滤镜）

`legal.tsx:54` 的 `<img>` 增加 class（如 `rdsh-arch`），`theme.css` 中：

```css
@media (prefers-color-scheme: dark) {
  img.rdsh-arch { filter: invert(1) hue-rotate(180deg); }
}
```

原理：`invert` 反转明度（白底→黑底、深蓝字→浅蓝字），`hue-rotate(180deg)` 把被 `invert` 一并翻转的色相转回。

**已知局限（须真机目视确认）**：
1. `hue-rotate()` 是线性矩阵近似，不是精确的 HSL 旋转 → 色相会有偏移，需目视判断是否可接受。
2. 底会变成纯黑 `#000`，与 `--rdsh-bg-surface`（`#232324`）不一致，会出现一块纯黑矩形。若观感突兀，备选：叠加 `mix-blend-mode: screen`（反转后底为黑，screen 会吃掉黑底，图直接落在页面底色上）。
3. JPEG 压缩噪点被反转放大，方框边缘可能有轻微杂色。

三者都必须在 `https://rdsh.cn/portal/product` 真机核验后定稿（见 §7 R-2）。

## 6. 需求澄清（需确认）

**C1：R6（浅/深两边都达 AA）与 R10（浅色不回归）存在冲突。**
现状浅色下有 3 类文本不达标（`#9ca3af` 2.54:1、`#999` 2.85:1、微信绿白字 2.38:1，见 §2.6）。若严格执行 R6，必须改浅色取值 → 违反 R10 且超出深色适配范围。

**建议**：R6 收窄为「**深色必须达 AA**；浅色沿用现状，既有对比度债记入 `TODO.md` 另开」。

**C2：「follow DSH」的边界。** 已按「采纳 DSH 深色**取值**，不采纳 DSH 的**组件形态**（深色主按钮白底黑字）」执行，理由见 §2.2 / N5。若你期望连按钮形态也一并对齐，请指出——那将超出 N5，属视觉重设计。

**C3：Q4/Q5 沿用批准时确认的默认**（允许近似色归并并逐项列出浅色差异；验收以人工逐页核验 + 对比度实算为准）。

## 7. 风险

- **R-1 浅色回归**：`#444`→`--rdsh-fg`(`#111`) 是**可感知**的加深（3 处，`pages.tsx:1042/1043/1063`）；`#ccc`→`--rdsh-border`(`#e5e7eb`) 为轻微变浅（6 处）。计划中列入浅色差异清单逐项复核，若不可接受则为其单列 token。
- **R-2 架构图滤镜观感**：见 §5.6，三处局限需真机定夺。
- **R-3 `color-mix` 兼容性**：`color-mix()` 需 Chrome 111+/Safari 16.2+/Firefox 113+。DSH 自身已在使用该函数，故本机与目标浏览器环境可接受；仍须在真机确认。
- **R-4 验证期间重启 hub 会回退**：见 req.md §5 第 3 条。
- **R-5 管理后台规模**：`ADMIN_CSS` 33 处 + 5 个 admin 组件，逐页核验成本较高，但无技术风险。

## 8. Tasks

| # | 任务 | 文件 |
|---|---|---|
| T1 | 新增 token 层与深色媒体查询（含 `color-scheme`） | `packages/portal/src/theme.css`（新） |
| T2 | 引入 `theme.css` | `packages/portal/src/main.tsx` |
| T3 | 补 `color-scheme` meta | `packages/portal/index.html` |
| T4 | 替换 `btnStyle`/`inputStyle`/`menuItemStyle` 及 `AppShell`/`Card`/`CurrentPlanCard` 等组件内联色值 | `packages/portal/src/pages.tsx` |
| T5 | 处理两处陷阱调用点（`:631` alpha 拼接、`:1184` SVG stroke） | `packages/portal/src/pages.tsx` |
| T6 | 替换 `ADMIN_CSS` 与 5 个 admin 组件色值 | `packages/portal/src/pages.tsx` |
| T7 | 替换法务页内联 `<style>` 色值 | `packages/portal/src/legal.tsx` |
| T8 | 架构图深色滤镜 + class | `packages/portal/src/legal.tsx`、`packages/portal/src/theme.css` |
| T9 | 构建并真机逐页核验（浅/深各一轮），记录浅色差异清单 | `pnpm --filter rdsh-portal build && pnpm --filter rdsh-hub build` |
| T10 | 对比度实算复核（R6） | 脚本输出留档 |

## 9. 与需求对照

| 需求 | 落点 |
|---|---|
| R1 跟随系统 | T1（媒体查询），无开关 |
| R2 全页面覆盖 | T4 / T6 / T7 |
| R3 语义化 | T1 token 表 + §5.4 映射规则 |
| R4 原生控件 | T4（`inputStyle` + `:2062`/`:2552`）+ T1 `color-scheme` |
| R5 二维码 | T4（二维码容器保持浅底，见 plan 细化） |
| R6 对比度 | T10（深色达标；浅色收窄，见 §6 C1） |
| R7 阴影/遮罩 | §5.3 `--rdsh-scrim` / `--rdsh-shadow` + T4 |
| R8 架构图 | T8（§5.6） |
| R9 `color-scheme` | T1 / T3 |
| R10 浅色不回归 | §5.3 浅色列取现状值 + R-1 差异清单 |
| R11 构建零缺陷 | T9 |
