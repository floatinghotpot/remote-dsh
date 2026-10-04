# Record — 隧道两处未捕获异常会杀死宿主进程（DSH 崩溃）

> **日期**: 2026-10-04
> **状态**: 已修复（gateway 165/165）
> **入口**: 用户在插件面板「断开 → 重连」后，以及用旧版 APP 发送对话消息时，**整个 DSH 进程退出**（DSH 由 VS Code 启动，栈打到其终端、重启后丢失）
> **结论**: `packages/gateway/src/join.ts` 中存在两条**未捕获异常**路径，异常从事件/定时器回调逃逸 → Node 以未捕获异常退出 → 宿主（DSH web）进程一并死亡。二者均为「缺少 try/catch」，非协议或逻辑错误

---

## 1. 事实（代码定位）

`packages/gateway/src/join.ts`（join 隧道客户端）有两处「回调内裸调用」：

1. **重连定时器**（`client.on("close")` 回调内）：
   ```ts
   setTimeout(connect, reconnectDelay + Math.random() * 500);
   ```
   初始 `connect()` 在 `try { connect() } catch (err) { releaseLockAndRethrow(err) }` 内有保护，**但重连这条没有**。`connect()` 一旦抛错（`new WebSocket(非法 URL)` 等），异常从定时器回调逃逸 → 未捕获 → 进程退出。对应「重连之后崩掉」。

2. **收帧处理**（`client.on("message")` 回调内）：
   ```ts
   try { frames = parser.push(chunk); } catch { client.terminate(); return; }  // 解析有保护
   for (const frame of frames) handleFrame(frame);                            // 处理无保护
   ```
   **帧解析有保护、逐帧处理没有**。当对端（含版本不匹配的旧客户端）发来「能解析但内容不完整/不兼容」的帧时，`handleFrame()` 抛错 → 从 message 回调逃逸 → 未捕获 → 进程退出。对应「APP 发消息就崩」。

- 相关背景：`handleOpen()` 内部对 `parseJsonPayload` 有 try/catch（回 `BAD_OPEN`），但外层 `handleFrame` 的分发链（含 `plainDispatcher`、`handleRawData` 等）并无兜底；`client.on("close")` 内还会调用 `setState(...)`（embedder 的 `onState` 钩子），同样无保护。
- 日志缺失原因：JS 层未捕获异常由 Node 打印到 stderr 后以退出码 1 结束；该 DSH 的 stdout/stderr 指向 VS Code 的 socket（`lsof` 显示 fd 1/2 为 unix socket），重启即丢失。仓库内无对应崩溃日志。

## 2. 修复

文件：`packages/gateway/src/join.ts`

- 重连：把 `connect()` 包进 try/catch，失败仅 `log("error", \`reconnect failed: ...\`)`，**不向上抛**；
- 收帧：逐帧 try/catch，单帧处理失败只记 `log("error", \`frame handling failed: ...\`)`，不终止整条隧道、不崩进程。

（保留原语义：初始 connect 失败仍走 `releaseLockAndRethrow`，fail-fast 行为不变。）

## 3. 验证

- `pnpm --filter rdsh-gateway test`：**165/165**；`pnpm build`（tsc strict）零 issue；
- 真机：用户断开/重连不再导致进程退出。

## 4. 未决 / 注意（非代码）

- **崩溃栈未取得**：上述两处是代码审计确认的真实路径，但**未能与现场栈一一对应**（日志已丢失）。已另加两处留痕（重连失败、单帧失败）便于后续定位；
- **运维建议**：DSH 启动时把输出落盘，例如
  `dsh web --port 0 --no-open 2>&1 | tee /tmp/dsh-web.log`，
  下次如仍崩溃可直接取末尾栈；
- **旧版 APP 兼容**：该修复使服务端不再因不兼容帧崩溃，但旧客户端的行为差异本身仍需客户端升级消化；
- **发版**：修复在 `rdsh-gateway` 包内，已随 0.11.3 出货。

*关联：`packages/gateway/src/join.ts` ｜ `client.on("close")` / `client.on("message")` ｜ 面板「断开/重连」、APP 远程对话*
