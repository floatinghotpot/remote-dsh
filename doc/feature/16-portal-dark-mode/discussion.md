# portal 深色模式（discussion）

> **日期**: 2026-09-11
> **触发**: 用户报告 rdsh.cn 的 portal 网页「永远是白的，不支持深色模式」
> **状态**: 事实审计完成；下一步 `req.md`（待批准）
> **性质**: 本文件是原始记录（事实与出处），在 `req.md` 存在后即转为只读需求来源

---

## 1. 现象

用户以系统深色模式访问 portal 时，页面始终呈现白底浅色外观，没有任何深色适配；也未找到主题切换入口。

## 2. 事实（代码审计）

### 2.1 portal 不存在任何主题层

| 检查项 | 结果 | 证据 |
|---|---|---|
| 包内 CSS 文件 | **0 个**（`src/` 与 `dist/` 均无） | `find packages/portal -name '*.css'`（排除 `node_modules`）无输出 |
| `var(--...)` CSS 变量 | **0 处** | `grep -c 'var(--' src/pages.tsx src/legal.tsx` → 0 / 0 |
| `prefers-color-scheme` | **0 处**（源码与构建产物） | 源码 grep 无命中；`grep -c prefers-color-scheme dist/assets/index-*.js` → 0 |
| `color-scheme` 声明 | **0 处** | 源码无；`index.html` 无 `<meta name="color-scheme">` |
| `html` / `body` 样式规则 | **不存在** | 全包无 `body { }` 规则 |
| 主题切换 UI | **不存在** | 顶栏仅有语言切换与登出（`src/pages.tsx:153-159`） |

因 `body` 无任何样式，页面底色即浏览器 UA 默认白底；且构建产物中**没有任何 CSS 文件**，`dist/index.html` 只有 `<script type="module">`，无 `<link rel="stylesheet">`。

### 2.2 颜色全部为内联硬编码

`src/pages.tsx`（2861 行）内联样式中的 hex 色值共 **237** 处，其中 `ADMIN_CSS` 字符串段（`:1956`–`:2224`）占 33 处，其余 **204** 处散在 JSX 中。`src/legal.tsx` 另有 **8** 处。合计 **245** 处。

`src/pages.tsx` 色值频次（降序）：

- **32** `#dc2626`（危险/错误红）
- **28** `#6b7280`（次级文本）
- **26** `#666`（次级文本）
- **24** `#fff`（卡片/弹窗/输入框底色）
- **20** `#e5e7eb`（描边）
- **15** `#f3f4f6`、**5** `#f8fafc`、**1** `#f9fafb`（浅底色块）
- **15** `#2563eb`（主色蓝）
- **13** `#eee`、**6** `#ccc`（描边）
- **12** `#9ca3af`、**7** `#999`（占位/弱化文本）
- **5** `#111`、**4** `#111827`、**3** `#444`、**1** `#374151`、**1** `#333`（正文文本）
- 状态色：**3** `#16a34a`、**3** `#047857`、**3** `#ecfdf5`、**1** `#10b981`、**1** `#fef2f2`、**1** `#fffbeb`、**1** `#f59e0b`、**1** `#b45309`、**1** `#f87171`
- 品牌色：**2** `#07c160`（微信绿）
- 选中态底：**2** `#eef2ff`

代表性硬编码位置：

| 位置 | 内容 |
|---|---|
| `src/pages.tsx:152` | `AppShell` 容器只有 `maxWidth/margin/padding`，**无 `background`** |
| `src/pages.tsx:180` | `btnStyle()` 默认分支 `background: "#fff"` |
| `src/pages.tsx:718`、`750` | 设置项卡片 `background: "#fff"` |
| `src/pages.tsx:1354`、`2486` | 下拉菜单 `background: "#fff"` |
| `src/pages.tsx:1415`、`1940` | 模态框 `background: "#fff"` |
| `src/pages.tsx:2053`、`2548` | 管理后台弹窗 `background: "#fff"` |
| `src/pages.tsx:2062`、`2552` | **原生 `<input>` / `<select>` 硬编码 `background: "#fff"`** |
| `src/pages.tsx:1043`、`1063`、`1564`、`1579`、`1581` | `<pre>` / 提示块 `#f8fafc` + `#eee` |
| `src/pages.tsx:109-110` | 语言切换按钮 `#fff` / `#333` |
| `src/pages.tsx:629-630`、`664-665` | 成功/中性徽标 `#ecfdf5` / `#f3f4f6` |

### 2.3 两处非内联的样式片段同样固定浅色

- `src/pages.tsx:1956` 定义、`:2225` 注入的 `ADMIN_CSS`（管理后台整段 CSS），全部为固定浅色。
- `src/legal.tsx:24` 内联 `<style>`（法务页排版），含 `#f3f4f6` / `#e5e7eb` / `#2563eb` / `#999`。

### 2.4 原生控件规模

`src/pages.tsx` 中 `<input>` 17 个、`<select>` 4 个、`<textarea>` 2 个。其中至少 2 处（`:2062`、`:2552`）显式写死白底，其余依赖 UA 默认外观。由于未声明 `color-scheme`，浏览器不会对控件、滚动条、日期选择器做深色适配。

### 2.5 阴影与遮罩

`rgba(0,0,0,...)` 出现 6 次：`.55` / `.4` / `.1` 各 2 次（模态遮罩、下拉/菜单投影）。深色背景下黑色投影不可见。

### 2.6 媒体资产

`public/media/` 仅一张 `rdsh-arch.jpg`（1206×670，455 KB，经 `read_image` 确认为**白底 JPEG** 架构图），在 `/product` 页以 `/portal/media/rdsh-arch.jpg` 引用。深色下会成为刺眼白块，且无深色变体。

### 2.7 二维码（同属对比度敏感面）

`qrcode` 依赖被使用 2 次：TOTP 两步验证绑定（`src/pages.tsx:1053`）与微信支付 `codeUrl`（`:1857`），均以 `toDataURL` 生成图片。二维码需要浅色底保证可扫描性。

## 3. 与 DSH 前端的对照

DSH 官方前端（`@deepseek-ai/dsh-web-frontend`）**具备主题体系**：定义有 `--dsw-alias-*` 语义 token（如 `--dsw-alias-bg-base`、`--dsw-alias-label-primary`、`--dsw-alias-border-l2`）与 `body[data-ds-dark-theme]` 深色覆盖，并有 `body{background:var(--dsw-alias-bg-base,#fff)}` 之类的兜底。

portal 的 `package.json` 自述「mirrors DSH frontend stack」，但实际只复用了构建栈（Vite + React 18），**未复用主题层**。

## 4. 根因

**portal 从未实现主题层**：无 CSS 变量、无媒体查询、无 `color-scheme` 声明、无切换入口，全部外观由 245 处硬编码浅色值决定。因此「永远是白的」与「不支持深色」是同一根因的两个表现，而非深色适配失效。

## 5. 影响面

`src/pages.tsx:62-97` 的 `App` 路由分发表列出全部 portal 页面：

- 无壳页：`/login`、`/register`、`/terms`、`/privacy`、`/product`、`/verify`、`/reset-password`
- 应用壳（`AppShell`）：`/`（Landing）、`/hosts`、`/add-host`、`/billing`、`/settings/password`、`/settings/account`、`/settings/email`、`/settings/phone`、`/settings/2fa`、`/settings/danger`、`/change-password`
- 管理后台：`/admin`（含 `/users`、`/admins`、`/audit`、`/config`、`/health` 等子路由）

## 6. 与本次修复相关的部署态事实

线上 hub（`https://rdsh.cn`，本机 `127.0.0.1:8443`，pid 174652，2026-09-06 启动）**实际服务的是工作区构建**，而非全局 npm 包内的产物：

- `curl /portal` 响应体 sha256 == `packages/hub/portal/index.html` sha256（字节一致）
- `GET /portal/assets/index-U60O1-cv.js` → 200，296176 字节（该文件仅存在于工作区 `packages/hub/portal/assets/` 与 `packages/portal/dist/assets/`）
- `GET /portal/assets/index-D1WFNrcq.js` → 200 但仅 329 字节（即 SPA fallback 吐回 `index.html`，证明该文件不存在于实际服务根）

原因：`packages/hub/src/portal.ts:14` 的 `defaultPortalDir()` 以 `import.meta.url` 解析 `../portal`，而该进程启动时其 `rdsh-hub` 解析到了工作区路径；2026-09-11 00:56 的 `npm i -g remote-dsh@0.10.2` 已将全局包内该文件替换为 `index-D1WFNrcq.js`。

**后果**：源码改动经 `pnpm build` 后即时生效（hub 每请求读盘，无需重启）；但一旦重启 hub，将切回全局 npm 包内的已发布构建。**本次已决策：只改 portal 源码，部署归属另行跟踪。**

## 7. 待决问题（进入 req 前需澄清）

1. 深色配色基线：是自定义一套，还是贴近 DSH 官方深色 token 的观感？
2. 品牌色 `#07c160`（微信绿）与主色 `#2563eb` 是否在深色下保留原值？
3. 架构图白底 JPEG 的处理方式：提供深色变体，还是容器层适配（如允许点击放大 / 加边框）？
4. 浅色外观是否允许发生最小可感知变化（例如把 `#666`/`#999` 统一为同一语义色导致的细微差异）？
5. 验收方式：portal 现有测试仅 `vitest run --passWithNoTests`，无视觉回归能力，深色验收如何取证？
