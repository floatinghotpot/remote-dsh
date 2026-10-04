# Record — 插件面板「断开」卡死 + LAN 直连口不再监听

> **日期**: 2026-10-04
> **状态**: 已修复（gateway 165/165、web-remote 27/27；真机验证断开/重连不再卡死）
> **入口**: 用户在插件面板点「断开」后，下方按钮显示 `…`（busy）且灰掉不能点，输入框也不可编辑；切到其他设置面板再切回才恢复。修复该问题后，又发现 LAN 直连口（8442）不再监听，APP 只能走公网隧道
> **结论**: 两个独立缺陷 —— (1) `DirectHandle.stop()` 用 `server.close(cb)`，存在 keep-alive 连接时回调永不触发 → `disconnect` RPC 挂住 → 面板 `busy` 卡死；(2) `disconnect()` 停掉了 LAN 直连口（与 `direct.ts` 声明的「join 模式始终监听」设计冲突），且 `syncDirect()` 前半段不在 try 内、失败被宿主静默吞掉

---

## 1. 事实（代码定位）

- `packages/gateway/src/direct.ts` → `DirectHandle.stop()`：
  `await new Promise<void>((resolve) => gateway.server.close(() => resolve()))`。
  Node 的 `server.close(cb)` 回调**仅在全部连接结束后**触发；浏览器/DSH 的 keep-alive 连接常驻 → 回调永不触发 → Promise 永不 resolve → `stopDirect()` 挂住 → `disconnect` RPC 不返回。
- `packages/web-remote/src/index.ts` → `disconnect()` 调用 `await stopDirect()`，即把 LAN 直连口一起停掉；而 `direct.ts` 顶部注释写明的设计是「门禁 = ticket（方案 B）：直连口**始终监听**（join 模式）」。
- 同文件 `syncDirect()`：原实现只在 `startDirect(...)` 外包 try/catch，`loadOrCreateDirectSecret()` / `createDirectTicketManager()` 位于 try **之外**；调用点写作 `void syncDirect(config)`（fire-and-forget）→ 前半段一旦抛错即成为**未捕获 rejection**，被宿主静默吞掉，直连口永远起不来且**没有任何日志线索**（原 `catch {}` 也不记录）。
- 实测证据：`lsof -a -p <dsh-pid> -iTCP -sTCP:LISTEN` 仅有 DSH web 端口，**8442 完全无监听**；`~/.rdsh/host.json` 配置的直连口正是 8442。
- 隔离验证：以真实参数（端口 8442 + 真实 `~/.rdsh/direct-secret`）调用 `startDirect()` 连做 3 轮 start/stop/start **全部成功**，`actualPort=8442` → 排除端口释放与参数问题，确认问题在调用链。
- 面板侧：`client.js` 的 connect/disconnect/revoke 原先直接 `await rpc.call(...)`，服务端不回包即永久卡住，只能靠组件重挂载复位。

## 2. 修复

- `packages/gateway/src/direct.ts` → `stop()`：在 `close()` 之前先执行 `gateway.server.closeAllConnections()`（Node ≥ 18.2），强制断开含 keep-alive 在内的全部连接，使 `close()` 回调必然触发。
- `packages/web-remote/src/index.ts`：
  - `syncDirect()` **整个函数体**包 try/catch，失败输出 `rdsh: direct gateway sync failed on <host>:<port> — <reason>`；
  - `disconnect()` **不再**调用 `stopDirect()`（只停隧道，直连口按设计持续监听）；`revoke()` 保留 `stopDirect()`（真注销时一并关闭）。
- `packages/web-remote/client.js`：所有会置 `busy` 的 RPC（connect / disconnect / revoke）统一走新增的 `callRpc()`，带 **15s 超时** → 即使服务端不回包，按钮也会自动恢复并提示「请求超时，请重试」。

## 3. 验证

- `pnpm --filter rdsh-gateway test`：**165/165**；`pnpm --filter ./packages/web-remote test`：**27/27**；
- 隔离实测：`startDirect` 真实参数 3 轮 start/stop/start 全部成功；
- 面板新增「内网直连 · 已开启 · 端口 N / 未开启」信息行（`state` RPC 上报 `direct: { active, port }`），异常可一眼诊断，并配合上述 `sync failed` 日志定位。

## 4. 未决 / 注意（非代码）

- **发版**：修复分别在 `rdsh-gateway` 与 `dsh-web-remote` 包内，已随本次发布（gateway 0.11.3 / web-remote 0.8.0）出货；
- **行为变更**：面板「断开」现在只断公网隧道，**不停 LAN 直连口**（直连口有独立 ticket 门禁，仅同网段可达）。若产品上希望「断开」也一并关闭直连口，需调整 `disconnect()`；
- **rc 观察**：15s 超时是兜底阈值，正常情况下本地 RPC 远低于此值。

*关联：`packages/gateway/src/direct.ts` ｜ `packages/web-remote/src/index.ts` ｜ `packages/web-remote/client.js` ｜ feature 26 扫码绑定*
