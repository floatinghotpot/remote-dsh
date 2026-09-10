# dsh 0.1.5-rc.2：dsh-web-remote 插件树加载失败（summary）

> **日期**: 2026-09-11
> **结论**: 已修复并双版本实测通过；`dsh-web-remote` 0.5.1 未发布（待授权）

---

## 做了什么

dsh 升级到 `0.1.5-rc.2` 后，装有 `dsh-web-remote` 时 `dsh web` 起不来（插件树加载失败）。根因是上游回归：`connection.rpc.handle(...)` 内部经服务 shadow ctx 访问 `owner.webServer` 失败（[上游 #5926](https://github.com/deepseek-ai/deepseek-harness/discussions/5926)）。

改为：**在 web server 上自注册 `/remote-access` 前缀路由 + 自实现与官方一致的 RPC envelope**（围栏复用官方 `connection.requestRejection`）。浏览器半 `client.js` 零改动，单一代码路径兼容 `0.1.2-rc.1` 与 `0.1.5-rc.2`。

## 改了什么

| 文件 | 说明 |
|---|---|
| `packages/web-remote/src/rpc-route.ts`（新） | `/remote-access` 协议路由独立模块：围栏 → 404/415/413/400 → envelope 校验 → 业务 dispatch → `server-response`；语义逐条对齐官方 `rpcFetchHandler`（envelope 非法 / `method` 与 path 不一致 → 200 + `gateway/bad-request`；handler 抛错 → 500） |
| `packages/web-remote/src/index.ts` | 删 `RpcHandler`/`rpc.handle` 注册；注册改为 `ctx.effect(() => ctx.webServer.register({…}))`；switch 提为 `dispatch`；顺带删除从未生效的 `{authority:"loopback"}` 参数与冗余类型断言 |
| `packages/web-remote/test/rpc-route.test.ts`（新） | `node:test` 协议单测 16 例（围栏、404/415/413/400/500、envelope 与 method 校验、正常与业务错误 envelope） |
| `packages/web-remote/package.json` | `0.5.0` → `0.5.1`；新增 `test` 脚本 |
| `packages/gateway/src/spawn-dsh.ts` | `DSH_COMPAT_MAX`：`0.1.2-rc.1` → **`0.1.5-rc.2`**（真机实测通过后扩展，注释记录证据出处） |
| `packages/gateway/test/spawn-dsh.test.ts` | 新增 `dshVersionWarning` 窗口边界单测（窗口内不提示 / 超上界提示升级 rdsh / 低于下界提示升级 dsh / 探测失败不提示） |
| `doc/fix/20260911-dsh-0.1.5-plugin-rpc/` | 本次 fix 记录（discussion / solution / plan / verification / summary / TODO） |
| `doc/review/20260911-dsh-0.1.5-rc.2-plugin-compat.md` | 兼容核验记录（插件链路 + 网关链路 G1–G7） |
| `CHANGELOG.md` / `CHANGELOG.zh.md` | Unreleased 条目 + 兼容矩阵更新 |

## 验证

| 维度 | 结果 |
|---|---|
| `pnpm build`（tsc strict） | ✅ 零 issue |
| `pnpm test` | ✅ gateway 110 / hub 91 / web-remote 16 / tunnel 12，全 0 fail |
| 插件：dsh `0.1.5-rc.2` 启动 + 认证 RPC + 401/404/413/415 + envelope 语义 | ✅ 全通过 |
| 插件：dsh `0.1.2-rc.1` 同一份产物启动 + 认证 RPC | ✅ 全通过 |
| 插件浏览器半（真实 `~/.dsh/profiles/web`）：boot 图注册 + bundle 200 + 面板在设置页可见 + 经 hub 远端访问成功 | ✅ P1–P8 |
| 网关（`rdsh host serve` + 真实 dsh `0.1.5-rc.2`）：spawn/ready token/cookie 换发/`/api` 转发/HTML 注入/WS 桥接 | ✅ G1–G6 全通过 |
| 网关 join 侧 `patchLoopbackJs` 对真实 0.1.5 bundle 命中 | ✅ G7 |
| 窗口扩展后重跑网关 E2E（版本警告消失、功能不变） | ✅ |
| **完整隧道端到端**：`rdsh host serve` join 到生产 hub → 远端设备实际访问本机 DSH | ✅ G9（用户人工实测） |

细节见 [verification.md](verification.md) 与 [doc/review/20260911-dsh-0.1.5-rc.2-plugin-compat.md](../../review/20260911-dsh-0.1.5-rc.2-plugin-compat.md) §5。

## 未做（见 TODO.md）

- `dsh-web-remote@0.5.1` 发布 npm（需显式授权）。
