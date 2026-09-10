# portal 深色模式（summary）

> **日期**: 2026-09-11
> **结论**: 已实现并通过构建/测试/对比度核验；**待人工真机目视核验**后交付
> **待办**: 见 [TODO.md](TODO.md)（T9 目视核验、T12 浅色既有对比度债）

---

## 做了什么

给 `rdsh-portal` 引入**单层语义化配色层**，由 `prefers-color-scheme` 驱动浅/深自动切换（无手动开关）。改动前 portal 没有任何主题层——包内 0 个 CSS 文件、0 处 `var()`、0 处 `prefers-color-scheme`，全部外观由 245 处内联硬编码浅色值决定；`body` 无样式，页面底色即浏览器默认白。

深色取值**对齐 DSH 官方 token**（从 `@deepseek-ai/dsh-client-ui-theme/lib/client.js` 查出真值，非凭记忆），使 portal 与 DSH 宿主观感一致；浅色取值一律保留现状字面量，把回归降到最低。

收尾审计时发现并修复一处遗漏：`--rdsh-scrim` / `--rdsh-shadow` 定义了却零引用（T4 的映射表只覆盖 hex，漏掉 6 处 `rgba()`），R7 实际未实现——已补齐并复验。

## 改了什么

| 文件 | 说明 |
|---|---|
| `packages/portal/src/theme.css`（新） | 30 个语义 token 的浅/深两套值 + `color-scheme: light dark` + `html,body` 底色 + 深色媒体查询 + `img.rdsh-arch` 滤镜 |
| `packages/portal/src/main.tsx` | 首行 `import "./theme.css";` |
| `packages/portal/index.html` | 补 `<meta name="color-scheme" content="light dark" />` |
| `packages/portal/src/pages.tsx` | 237 处硬编码色值 → token（含 `ADMIN_CSS` 与 admin 组件）；双角色字面量按属性判定；两处陷阱点单独处理；微信图标改 `currentColor` |
| `packages/portal/src/legal.tsx` | 8 处色值 → token；架构图 `<img>` 加 `className="rdsh-arch"` |
| `packages/hub/portal/**` | `copy-portal.mjs` 产物更新（该目录随包分发、为 git 纳管；`packages/portal/dist` 已在 `.gitignore`） |

替换后**全仓已无任何硬编码颜色字面量**（改动前 245 处）。

## 关键设计决策

| 决策 | 依据 |
|---|---|
| 前缀 `--rdsh-`，不复用 DSH 的 `--dsw-*` | 避免与 DSH 私有命名空间在插件同页场景下相互覆盖 |
| **单层** alias，不照搬 DSH 的 static + alias 两层 | portal 颜色角色仅 30 个，再插一层属过度设计（§2 Simplicity First） |
| 主色/危险色**按语义拆分**（填充 vs 文本） | `#2563eb` 作文本在深色底仅 **3.53:1**（不达 AA），作填充+白字 **5.17:1**（达标）；`#dc2626` 同理（3.78:1 vs 4.83:1） |
| 链接深色用 `#679efe`（DSH `link`） | **6.86:1** 达标 |
| 危险软底上的文本深色用 `#f87171`，而非 `#f25a5a` | `#f25a5a` 落在 10% 危险 tint 上仅 4.21:1；`#f87171` 为 **5.00:1** |
| 微信按钮深色**反转前景/背景**（R12，用户提出） | 品牌绿作前景：深底上 **6.58:1**（页面底 7.65:1）；原「绿底白字」仅 2.38:1。品牌绿仍见于图标/文字/描边，识别度不降；纯深色改动，浅色不变 |
| 架构图用 CSS 滤镜而非出图（Q3=A） | `filter: invert(1) hue-rotate(180deg)`；零依赖、零新资产 |
| 刻意偏离 DSH 一处 | DSH 深色主按钮是近白填充+深色文字；portal 按 N5（不做视觉重设计）保持蓝底白字，仅采纳配色取值 |

## 验证

| 维度 | 结果 |
|---|---|
| `pnpm build`（portal vite build + 4 包 tsc strict） | ✅ 退出码 0 |
| `pnpm test` | ✅ 229 用例全过（tunnel 12 / hub 91 / gateway 110 / cli 0 / web-remote 16），0 fail |
| token 层无死代码 | ✅ 30 个 token 全部被引用，`var(--rdsh-*)` 引用 256 处 |
| 残留硬编码色值 | ✅ **0 处**（原 245 处已全部 token 化） |
| 深色对比度（R6 收窄版） | ✅ **18 组全部 ≥ 4.5:1，0 FAIL** |
| 浅色无回归（R10） | ✅ 18 项取值逐字一致；9 组为已批准的近似色归并（仅 `#444`→`#111` 3 处可感知，已登记） |
| 线上生效 | ✅ `https://rdsh.cn/portal` 已挂载新 CSS；线上与本地 `dist` sha256 一致（`c2301185…`） |

细节见 [verification.md](verification.md)。

## 未做

- **T9 真机目视核验**（阻塞验收，需人工在浏览器执行浅/深各一轮）——见 TODO.md
- **T12 浅色既有对比度债整改**（5 项，按 C1 决策本轮跳过）——见 TODO.md
- 未 commit / push（按流程待验证通过后经显式路径提交）
