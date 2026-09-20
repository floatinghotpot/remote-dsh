# portal 类型检查缺口与 97 条错误的清理（TODO）

> 机械提取自 [solution.md](./solution.md)「不做」与 [verification.md](./verification.md)「未覆盖」。
> **本文件非空 = 本次修复未完全收口**，由人决定关闭 / 延期 / 放弃。

## 本轮不做（solution.md）

| # | 项 | 理由 |
|---|---|---|
| ⏭️ | 给 portal 补测例 | 需要设计（组件 / 路由 / i18n），另立任务 |
| ⏭️ | 其余 `api.accountInfo(...)` 调用点的 null 防御（`pages.tsx:138` 等） | 当前不可达；要先决定是否把 API 返回类型改可空（审查 ① 已确认这些点全都 null 容忍） |
| ⏭️ | 跳转丢回跳路径（审查 ① F2） | `pages.tsx` 两处 `assign("/portal/login")` 不带 `?next=`；`api.ts` 已有 `redirectToLogin()`（带 `?next=`）但未导出。最小修法：导出并复用 —— 属既有行为，作为独立 UX 变更处理 |
| ❌ | CI 校验「入库产物 = 新构建产物」（审查 ② F3） | 建议 build 后加 `git diff --exit-code -- packages/hub/portal packages/portal/src/legal/generated.ts`；未加的原因：跨平台确定性只在 macOS 验证过，硬门可能造成 CI 抖动。备选：`publish.sh` 发布前先构建 |
| ⏭️ | `vite.config.ts` / `test/` 纳入类型检查（审查 ② F5） | **与浏览器类型围栏冲突**（import `vite` 会把 `@types/node` 带回程序）；需拆 `tsconfig.node.json` |
| ⏭️ | `.catch` 对任何错误都硬跳登录 + 丢 `?next=`（fresh reviewer F2） | 既有行为；REFRESH_FAILED 网络抖动也会把管理员弹去登录且无错误提示；与「跳转丢回跳路径」同源，建议合并成一个 UX 修复（导出并复用 `redirectToLogin()`，且只对 401 硬跳） |
| ⏭️ | `Bytes` 收窄与 gateway 互操作测试的 `Buffer` 实参冲突（fresh reviewer F3） | 潜伏：gateway tsc 的 `include` 不含 `test/`。将来纳入时在 e2ee 边界放宽入参（`Uint8Array`/`BufferSource`） |
| ⏭️ | 首个 effect 缺 `alive` 清理（fresh reviewer F4） | React 18 无告警；纯一致性，需要时补 `alive` 守卫 |
| ⏭️ | `typescript: ^5.7.0` 与注释「TS 5.9」口径（fresh reviewer F5） | 语法只需 5.7，无实际破坏；如需严格对齐可收紧范围或改注释 |
| ⏭️ | `generated.ts` 改为 gitignored 路径（fresh reviewer ② F5 备选） | 现值已可接受（幂等 + 已从新鲜度扫描排除）；更彻底是 emit 到 dist 外、由 tsconfig 引入 |
| ⏭️ | 入库产物每次源码变更就换 hash 文件名（fresh reviewer ② 备注，既有） | 每 build 一个 delete + 一个 untracked；根治需把 `packages/hub/portal/**` 改为构建期生成 + gitignore |
| ⏭️ | 本地 `qrcode.d.ts` 的维护（审查 ② F2 的代价） | 只声明了 `toDataURL`；新增用法须对照上游 `@types/qrcode` 补齐（文件头已写明） |
| ⏭️ | 让 `packages/hub/portal/**` 不再入库（审查 ① F3 的备选） | 改为构建期生成 + gitignore；需同时保证发布流程会先构建 portal（比"显式 add 产物"更彻底，但改动更大） |

## 未覆盖 / 发现的问题（verification.md）

| # | 项 | 说明 |
|---|---|---|
| ⏭️ | G1 `vite.config.ts` 不被检查 | 同上 |
| ⏭️ | G2 portal 无测例 | 本轮的"测试通过"是 `--passWithNoTests` 空跑 |
| ❌ | G3 真机浏览器验证 | 英文文案变更与（不可达的）null 分支跳转只有静态证据；需部署 hub 后在浏览器确认 |
