# Record — 苹果登录 / App 微信登录的配置从未接线到运行时（功能恒禁用）

> **日期**: 2026-10-05
> **状态**: 已修复（hub 177/177）
> **入口**: 在 `hub.json` 配好 `appleLogin`（Team ID / Key ID / `.p8` / tokenEncKey）并重启 hub 后，`/api/capabilities` 仍报 `appleLoginEnabled: false`，`POST /api/app/apple/login` 恒返回 `404 APPLE_LOGIN_DISABLED`
> **结论**: `5d4d2d8 feat(hub): add Sign in with Apple login endpoint` 与 `9438725 feat(hub): add App WeChat login endpoints` **只改了 `config.ts` 与 `api.ts`，没有把三个新配置字段接进运行时**：`server.ts` 的 `HubServerOptions` 类型、运行时 `config: {…}` 组装、以及 `serve.ts` 的调用点都缺 `appleLogin` / `wechatAppLogin` / `appSchemes`。运行时 `config` 是白名单式逐字段组装，因此 `hub.json` 里写什么都不生效

---

## 1. 事实（代码定位）

- **读取方**（`api.ts`）：`appleLoginEnabled: runtime.config.appleLogin !== undefined`（:885）；`runtime.config.wechatAppLogin`（:1235、:1441）；`runtime.config.appSchemes`（:908，`appRedirect` 内，缺省 → `503 APP_REDIRECT_DISABLED`）。
- **组装方**（`server.ts`）：`config: { … }` 在 `startHubServer` 内逐字段列举（:131-151），原先只有 `billing/beian/site/wechatLogin/e2ee/backup` 等 —— **没有这三个字段**；`HubServerOptions` 类型里同样搜不到它们（调用方想传也传不进来）。
- **调用方**（`serve.ts`）：`serveHub` 调 `startHubServer({ … })`（:78-101）也没传这三个字段。
- **对照实验**：用 `dist` 直接 `loadHubConfig("/home/liming/.rdsh/hub.json")` → `appleLogin` **存在**（配置层与校验层都正常）；而运行中的 hub `/api/capabilities` → `appleLoginEnabled: false` ⇒ 丢失点必然在"配置 → 运行时"这一层。
- **为何 174 条既有测试全绿**：`test/apple-login.test.ts` 是**直接构造 runtime**（自己塞 `config.appleLogin`）测处理函数的；而真正调用 `startHubServer` 的测试（api / bind-session / multi-tenant …）**连传该选项的入口都没有**，且没有任何用例断言"配置 → 运行时"的接线。
- **附带发现**：`packages/hub/tsconfig.json` 的 `include` 仅 `["src"]`，`test/` 不参与 `tsc` ⇒ 漏接线**不会**在 `pnpm build` 阶段暴露。

## 2. 修复

- `packages/hub/src/server.ts`
  - `config.ts` 类型导入补 `WechatAppLoginConfig`、`AppleLoginConfig`；
  - `HubServerOptions` 新增三个**可选**字段（向后兼容，无调用方破坏）：`wechatAppLogin?`、`appSchemes?`、`appleLogin?`；
  - 运行时 `config: { … }` 组装补 `wechatAppLogin` / `appSchemes` / `appleLogin`。
- `packages/hub/src/serve.ts`：`startHubServer({ … })` 补传 `config.wechatAppLogin` / `config.appSchemes` / `config.appleLogin`。
- `packages/hub/test/apple-login-wiring.test.ts`（新增，3 条用例，全部从 `startHubServer` 入口断言）：
  1. 未配置 → `appleLoginEnabled === false`、两个端点 `404 *_DISABLED`；
  2. 配 `appleLogin` → `appleLoginEnabled === true` 且端点进入业务校验（`400 BAD_REQUEST`，而非被 `*_DISABLED` 短路）；
  3. 配 `wechatAppLogin` + `appSchemes` → `/api/app/wechat/login` 返回 `400 BAD_REQUEST`。

## 3. 验证

- **反证（关键）**：`git stash` 暂存 `server.ts` / `serve.ts` 的修复后运行 hub 测试 → **`not ok` 两条接线用例**（175/177，失败点正是断言 `appleLoginEnabled === true` 与 `400 BAD_REQUEST`）；`git stash pop` 恢复后 **177/177 通过** ⇒ 该测试确实能抓住此类"漏接线"回归。
- **全量回归**：`pnpm build` 零 issue；hub **177** · gateway 165 · portal 5 · tunnel 12 · web-remote 27 · agent-mesh 1，零失败。
- **线上实测**（工作区构建，`rdsh` bin 已指回工作区）：重启 hub（PID 384860，2026-10-05 20:58:29）后
  - `/api/capabilities` → **`appleLoginEnabled: true`**；
  - `POST /api/app/apple/login {}` → `400 BAD_REQUEST "identity_token and nonce are required"`（修复前为 `404 APPLE_LOGIN_DISABLED`）；
  - `POST /api/app/wechat/login {}` → `400 BAD_REQUEST "missing code"`（修复前为 `404 WECHAT_LOGIN_DISABLED`）；
  - 门户 bundle 不变（`index-DJgVttaX.js`），host 隧道 1 秒自愈。
- **未覆盖**：`appSchemes` 只验证到"已到达运行时"，未走完 `302` 回跳链路（需真实微信/App 流程）；苹果登录的完整链路需 iOS 真机走一次。

## 4. 未决 / 注意（非代码）

1. `serve.ts` 仍是**逐字段枚举**（本次补了三行）——将来再加配置字段仍有漏接线风险。更彻底的做法：让 `startHubServer` 直接接收完整 `HubConfig`（由 server 侧派生运行时 config），或维护一份共享字段清单。
2. `packages/hub/tsconfig.json` 的 `include` 仅 `"src"`，测试文件不参与类型检查；建议把 `test/` 纳入 typecheck（否则测试里的类型错误只能靠运行时暴露）。
3. **真机验证待做**：iOS 上用 Apple 账号走一次完整登录（服务端已就绪）。
4. **发布纪律**：本缺陷说明"发版前必须在本环境实跑一遍新功能的开关与端点"，仅凭单测不足 —— 本次即由"先验证再发版"的流程拦下。
