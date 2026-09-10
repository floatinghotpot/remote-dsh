# dsh 0.1.5-rc.2：dsh-web-remote 插件树加载失败（solution）

> **日期**: 2026-09-11
> **方案**: A —— 原生 `webServer` 前缀路由 + 自实现 RPC envelope（浏览器线协议不变）
> **依据**: [discussion.md](discussion.md)（根因与实证）

---

## 1. Goal

1. `dsh-web-remote` 在 `0.1.5-rc.2` 上可加载，`dsh web` 正常启动；
2. **同一份代码**继续兼容 `0.1.2-rc.1`（不做版本分支）；
3. 浏览器半（`client.js`）**零改动**——线协议与 RPC 语义不变；
4. 安全围栏不降级：沿用 DSH 官方 Host/Origin fence + 浏览器会话校验。

## 2. Facts（改前实查，非假设）

| # | 事实 | 出处 |
|---|---|---|
| F1 | 失败点在 `dsh-client-connection@0.1.5-rc.2` `lib/index.js:618` 的 `owner.webServer.register(route)`，由 `rpc.handle` 触发 | 错误栈 + 源码 |
| F2 | `webServer.register(route)` 在两版均存在（同为 `dsh-host-webserver/lib/index.js:176`），route 形状 `{kind:"prefix", path, handler(req,res)}` | 两版源码 |
| F3 | `connection.requestRejection(request)` / `createSharedFetchHandler(channel)` 两版均存在 | 两版源码（0.1.2: 530/547；0.1.5: 553/570） |
| F4 | `ctx.effect(cb, label)`、`ctx.inject(names, cb)`、`ctx.webServer` 直接访问在 0.1.5-rc.2 对第三方插件均可用 | 探针实测 |
| F5 | 浏览器半固定协议：`POST <channel>/<endpoint>`，body `{type:"client-request",rpcId,method,payload}`，期望 `{type:"server-response",rpcId,result}`（rpcId 必须回显） | `dsh-client-connection/lib/client.js:6194-6249`（两版同构） |
| F6 | 官方 `/api` 桥的状态语义：非 POST/空 endpoint → 404；非 `application/json` → 415；超限 → 413；JSON 解析失败/envelope 非法 → 400；业务失败走 200 + `result.ok=false` | `dsh-client-connection/lib/index.js:635-700` |
| F7 | 我们原先传的 `{ authority: "loopback" }` 两版都被忽略（`handle` 只取 2 参） | 两版源码 grep |
| F8 | `rdsh-gateway` 的 `join.lock` 对死 pid 自愈（stale 自动清除），测试残留无需手工处理 | `packages/gateway/src/lock.ts:4` |

## 3. Gap

host 半唯一的注册入口 `connection.rpc.handle("/remote-access", …)` 在 0.1.5-rc.2 上必失败，且无任何 inject/配置手段可绕过（探针矩阵全灭）⇒ 必须换注册机制，同时保持 F5 的线协议不变，否则 `client.js` 也要跟着改。

## 4. Call-site Audit（契约变更影响面）

| 位置 | 关系 | 兼容性 |
|---|---|---|
| `packages/web-remote/src/index.ts` `RpcHandler` 接口 | 仅本文件使用（`dist/` 为构建产物） | 删除，无外泄 |
| `packages/web-remote/src/index.ts` `ctx.connection`（`authenticatedUrl` 能力探测） | 保留 | 兼容（`ConnectionService` 类型补齐） |
| `packages/web-remote/client.js` `rpc.call("/remote-access", <endpoint>, {args})` | 消费方 | **零改动**（路径、envelope、语义全部保持） |
| 其他包引用 `rpc.handle` / `connection.rpc` | 无（全仓 grep 仅本文件） | — |

## 5. Tasks

| # | 文件 | 改动 |
|---|---|---|
| T1 | `packages/web-remote/src/index.ts` | 头部注释：说明为何不用 `rpc.handle`（0.1.5 回归 + 上游 #5926）+ 线协议与围栏不变 |
| T2 | 同上 | 类型与常量移入 `rpc-route.ts` 并由其导出（`RpcResult` / `RpcDispatch` / `ConnectionService` / `WebServerService` / `RPC_CHANNEL` / `MAX_REQUEST_BODY_BYTES`）；`Ctx` 保留在 `index.ts` 并增 `effect()` |
| T3 | 同上 | 注册改为 `ctx.effect(() => ctx.webServer.register({kind:"prefix", path:RPC_CHANNEL, handler}))`；原内联 switch 提为 `dispatch: RpcDispatch` |
| T4 | `packages/web-remote/src/rpc-route.ts`（新） | 协议路由独立成模块：`handleRpcRoute()`（官方围栏 → 404/415/413/400 → envelope 校验 → 业务 dispatch → 200 `server-response`）+ `readBody()`/`serverResponse()`/`envelopeFailure()`/`endpointFromPath()`；语义逐条对齐官方 `rpcFetchHandler`（envelope 非法 / `method` 与 path 不一致 → **200 + `gateway/bad-request`**；handler 抛错 → 500）。不依赖 fs/隧道状态，便于单测 |
| T4b | `packages/web-remote/src/index.ts` | 只留隧道业务逻辑 + `Ctx` 类型：从 `./rpc-route.ts` 导入 `RPC_CHANNEL` / `handleRpcRoute` / 类型；`handler: (req,res) => void handleRpcRoute(ctx.connection, req, res, dispatch)` |
| T4c | `packages/web-remote/test/rpc-route.test.ts`（新）+ `package.json` test 脚本 | `node:test` 协议单测 16 例：401/403、404（含多段 endpoint 的接受性）、415（含 charset）、413、400、envelope 非法、method/path 不一致、500、正常与业务错误 envelope |
| T5 | 同上 | `authConn` 去掉已多余的重复类型断言（`ConnectionService` 已声明 `authenticatedUrl?`） |
| T6 | `packages/web-remote/package.json` | 版本 `0.5.0` → `0.5.1` |
| T7 | `doc/review/20260911-dsh-0.1.5-rc.2-plugin-compat.md` | 兼容核验记录（硬点 + 实测矩阵） |
| T8 | `CHANGELOG.md` / `CHANGELOG.zh.md` | Unreleased 记录 + 兼容矩阵行更新（0.1.5-rc.2 ✅） |

**不改**：`packages/web-remote/client.js`、`packages/gateway/*`（网关侧兼容窗口见 TODO）。
