# dsh 0.1.5-rc.2：dsh-web-remote 导致 `dsh web` 无法启动（discussion）

> **日期**: 2026-09-11
> **现象**: dsh 从 `0.1.2-rc.1` 升级到 `0.1.5-rc.2` 后，装有 `dsh-web-remote` 时 `dsh web` 起不来；卸载插件即恢复
> **结论**: **上游回归**（`connection.rpc.handle` 内部 `owner.webServer` 解析失败），非我们误用；改走原生路由 + 自实现 envelope，**单一代码路径兼容 0.1.2-rc.1 与 0.1.5-rc.2**
> **关联**: [20260911-dsh-0.1.5-rc.2-plugin-compat.md](../../review/20260911-dsh-0.1.5-rc.2-plugin-compat.md)、[20260907-dsh-0.1.2-rc1-auth](../20260907-dsh-0.1.2-rc1-auth/discussion.md)、`packages/web-remote`

---

## 1. 现象

用户升级 dsh 到 `0.1.5-rc.2` 后：装有 `dsh-web-remote` → `dsh web` 无法启动；移除插件 → 正常。

## 2. 复现（隔离环境，不触碰真实 profile）

```sh
rm -rf /tmp/dsh-compat
DSH_HOME=/tmp/dsh-compat dsh --profile compat --from-default-profile web --dump-config   # 建隔离 profile
DSH_HOME=/tmp/dsh-compat dsh plugin --profile compat add dsh-web-remote@0.5.0            # 装插件
DSH_HOME=/tmp/dsh-compat dsh --profile compat --no-open --port 0                         # 启动 → 失败
```

```
Error: dsh: plugin tree failed to load: failed to apply loader entry remote-access (dsh-web-remote):
cannot get property "webServer" without inject
    at Fiber.<anonymous> (dsh-client-connection/lib/index.js:618:35)
    at Proxy.register (dsh-client-connection/lib/index.js:618:16)
    at Object.handle (dsh-client-connection/lib/index.js:543:39)   ← connection.rpc.handle()
    at new apply (dsh-web-remote/dist/index.js:310:24)             ← 我们注册 channel 处
```

失败发生在**插件 apply 阶段** ⇒ loader 判整棵树加载失败 ⇒ `dsh web` 直接退出（不是面板不可用，是进程起不来）。

## 3. 根因（证据链）

### 3.1 失败点

`dsh-client-connection@0.1.5-rc.2` `register()` 第 618 行：

```js
return owner.effect(() => owner.webServer.register(route), `client-connection: ${channel} rpc channel`);
```

`owner = this.ctx`，即**读取 connection 服务的插件 ctx 经服务 tracker 派生的 shadow ctx**；该 shadow 在该版本下解析不到 `webServer`。cordis 侧规则：服务 impl 存在**提供者 fiber** 的 store 里（`cordis/lib/index.js:814`），属性访问沿 fiber 链上溯并在 isolate/inject 边界抛错。

### 3.2 探针矩阵（同一隔离 profile，最小插件实测）

| 访问方式 | 结果 |
|---|---|
| `ctx.get("webServer")` | ✅ present |
| `ctx.webServer.port` | ✅ 52726 |
| `ctx.effect(() => ctx.webServer.port)` | ✅ 52726 |
| `ctx.inject(["webServer"], (c) => c.webServer.port)` | ✅ 52778 |
| `ctx.connection.rpc.handle("/probe", …)` | ❌ `cannot get property "webServer" without inject` |
| 上述任意 inject 包装后再 `rpc.handle` | ❌ 均失败 |
| bundle patch 行级 `inject: [webServer, connection]` | ❌ 无效 |
| `ctx.connection.rpc.intercept("/api", …)` | ✅ 可用（但 `/api` 单 interceptor，不能抢占） |
| `ctx.connection.createSharedFetchHandler("/api")` | ✅ 可用 |

### 3.3 排除项（避免误判方向）

- **不是 cordis 版本差异**：`@deepseek-ai/cordis` 4.0.1 与 4.0.2 的 `lib/index.js` **逐字节相同**（diff 为空）。
- **不是我们漏导 inject**：已发布 `0.5.0` 的 `dist/index.js` 第 28 行确有 `export const inject = ["connection", "webServer"]`。
- **不是 cordis.patch.yml 行缺 inject**：行级补 inject 仍失败。
- **0.1.2-rc.1 相同代码可跑**（见 §5），说明是 0.1.5 侧行为变化。

### 3.4 上游

同类症状已有公开讨论：[deepseek-harness Discussion #5926 — "connection fails to start when a third-party plugin registers an HTTP channel: cannot get property 'webServer' without inject"](https://github.com/deepseek-ai/deepseek-harness/discussions/5926)。属上游回归，无 ETA。

### 3.5 附带发现（安全相关）

我们原先传给 `rpc.handle` 的第三参 `{ authority: "loopback" }` **从未生效**：0.1.2-rc.1 与 0.1.5-rc.2 的 `handle` 都只接受 `(channel, handler)`，两版 lib 中均无该选项。真正的围栏一直是 connection 的 Host/Origin fence + 浏览器会话 cookie（`requestRejection`）。本次改动顺带修正了这个错误认知。

## 4. 迁移路径（生态实证）

当前可用的同类第三方插件 [dsh-mobile-gateway](https://github.com/agent-mobile/dsh-mobile-gateway)（LAN 访问 dsh web，维护中、兼容 0.1.5）**不用 `rpc.handle`**：

```js
export const inject = ['connection', 'webServer']
ctx.inject(['connection'], (connCtx) => {
  connCtx.effect(() => connCtx.webServer.register({ kind: 'prefix', path: '/m/api', handler }), '...')
})
```

探针照此实现 `/probe` 路由实测：`dsh web` 正常启动，路由受官方 `connection.requestRejection` 保护（未认证 → 401）。

**跨版本 API 面已核对**：`webServer.register(route)`（两版同为第 176 行）、`connection.requestRejection()`、`createSharedFetchHandler()` 在 0.1.2-rc.1 与 0.1.5-rc.2 **完全一致** ⇒ 不需要版本分支。

**浏览器线协议**：`dsh-client-connection/lib/client.js` 的 `rpc.call(channel, endpoint, payload)` 固定为 `POST <channel>/<endpoint>`，body `{type:"client-request", rpcId, method, payload}`，期望 `{type:"server-response", rpcId, result:{ok,value|error}}`。我们 host 半自实现该 envelope ⇒ **`client.js` 零改动**。

## 5. 方案选型（2026-09-11 用户确认）

| 方案 | 说明 | 结论 |
|---|---|---|
| **A（选定）原生路由 + 自实现 envelope** | host 半用 `webServer.register` + `requestRejection`，自处理 envelope | 单代码路径兼容两版；不依赖上游；客户端零改动 |
| B 等上游修复 | 代码不动，钉住 0.1.2-rc.1 | 阻塞 dsh 升级；#5926 无 ETA |
| C 社区 shim `@dsh-plugin/dsh-loader` | 第三方版本适配层 | 引入 LGPL-3.0 依赖与额外供应链风险 |

交付范围（用户确认）：**改代码 + 本地验证 + 文档，暂不发 npm**。
