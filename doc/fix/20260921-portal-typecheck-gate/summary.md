# portal 类型检查缺口与 97 条错误的清理（summary）

> **日期**: 2026-09-21 ｜ 关联: [discussion.md](./discussion.md) · [solution.md](./solution.md) · [verification.md](./verification.md)

## 做了什么

| 层 | 改动 |
|---|---|
| 配置 | portal 自己的 `tsconfig.json` 补 DOM lib（**不动共用 base**，避免放行 Node 包误用浏览器 API） |
| 关卡 | `typescript` 进 portal devDependencies；新增 `typecheck`；`build` 插入 `tsc --noEmit` ⇒ 随根 `pnpm build` 与 CI 自动把关 |
| 真问题 | i18n 删 9 个重复键（`渠道单号` 由 "Channel order" 纠正为 **"Channel order id"**）；`build-legal.mjs` 生成带具体键的类型以消除 `LEGAL.*` 的 `string \| undefined`；`e2ee.ts` 引入 `Bytes = Uint8Array<ArrayBuffer>`（纯类型收窄）并同步 `fromBase64url` 返回类型 |
| 防御性修复 | `AdminLogin` 把 `api.accountInfo({probe:true})` 的 `null` 按取数失败处理（跳 `/portal/login`），消除 tsc 报的类型洞 |
| 产物 | 重建 portal 并同步入库产物 `packages/hub/portal/**`；`pnpm-lock.yaml` 更新 |

## 结果

- portal tsc：**97 → 0**（分组对账见 [verification.md](./verification.md) §1）。
- `pnpm test`：**300 通过 / 0 失败**；根 `pnpm build` 会连带跑 portal 的 tsc 并同步产物。
- **关卡实测拦过**：拆分提交时漏恢复一行类型标注，`pnpm build` 立即失败。
- 本次唯一的用户可见变化：英文界面 `渠道单号` 的译文（"Channel order" → "Channel order id"）。

## 生效方式

改动落在 portal 静态产物里，产物随 **`rdsh-hub`** 一起分发 ⇒ 要让线上（rdsh.cn 门户）生效需**重新发布/部署 hub**。`rdsh-gateway` / `dsh-web-remote` / CLI 不受影响。

## 审查结论

- **自审**：修正了测试环境对"P0 崩溃"的定级（`null` 在仓内不可达 ⇒ 类型层缺陷/防御性修复，今天行为零变化）；发现既有构建顺序缺陷（hub 可能复制旧 portal 产物，本轮已实测）；核对了 i18n、E2EE 类型、生成器、关卡各项。
- **独立审查 ①（行为/文案侧）**：确认了我的定级修正（null 不可达、属类型层缺陷），并指出注释误导 ⇒ 已重构为"状态类型诚实 + 仅入参防御"；另报两条：跳转丢 `?next=`（既有，记 TODO）、**新产物未跟踪的打包陷阱**（P1，提交计划已显式纳入该文件）。i18n 与其余 `accountInfo` 调用点均被独立验证为正确。
- **独立审查 ②（构建配置/类型卫生侧）**：抓到一条 **HIGH**（`pnpm -r build` 竞态：hub 可能先复制 portal 产物；干净 clone 上会 ENOENT 失败并删掉入库产物，而 publish 不构建 ⇒ 可能发出无 portal 的 hub）⇒ 已修（根 build 先构建 portal + copy-portal 先校验后删）；另一条 MEDIUM（`@types/node` 泄漏使关卡形同虚设）⇒ 已闭环（真凶是 `@types/qrcode` 依赖 `@types/node`，改本地最小声明后写 `Buffer`/`process` 直接报错）。CI 产物一致性校验与 `vite.config.ts` 纳入检查记 TODO。

## 遗留

见 [TODO.md](./TODO.md)（`vite.config.ts` 未纳入、portal 无测例、真机验证、其余 `accountInfo` 调用点）。
