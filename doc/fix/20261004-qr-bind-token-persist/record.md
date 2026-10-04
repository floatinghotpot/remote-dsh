# Record — 扫码绑定未持久化 host token，断开后无法重连

> **日期**: 2026-10-04
> **状态**: 已修复（web-remote 27/27）
> **入口**: 插件面板点「接入」报错 `未接入：无持久化 session 且未提供 --token；先 \`rdsh host join <hub>\` 生成/粘贴 join token`
> **结论**: feature 26 的扫码绑定路径（`scanState`）从 hub `consume` 拿到 host token 后**只用于内存中起隧道，未落盘**；而正常「粘贴令牌」路径（`registerJoin`）会 `persistToken()`。导致绑定当时可用、一旦断开就再也重连不上

---

## 1. 事实（代码定位）

- 正常路径：`packages/gateway/src/join.ts` → `registerJoin()`：`opts.token` 存在时 `register()` 换到 host token 后执行 `persistToken(opts.hubUrl, token)`；`opts.token` 缺省时走 `readPersistedToken()`，取不到即抛
  `未接入：无持久化 session 且未提供 --token；…`（与用户所见报错完全一致）。
- 扫码路径：`packages/web-remote/src/index.ts` → `scanState()`：轮询到 `approved` 后调 hub `POST /api/bind-sessions/:id/consume`，拿到 `{ hostId, hostToken }`，随后 `saveConfig()` 写入 `mode/hub/name/insecure` 并 `startTunnel(config, hub, cj.hostToken, name, insecure)` —— **hostToken 仅作为参数传入，未落盘**。
- token 存储：`packages/gateway/src/token-store.ts` 的 `tokenFilePath(hubUrl)` = `~/.rdsh/join-<host>.token`；`persistToken` 当时**未被 gateway 对外导出**（`index.ts` 只导出 `readPersistedToken` / `clearPersistedToken`），web-remote 取不到。
- 实测证据：`~/.rdsh/host.json` 显示 `mode: join`、`hub: https://rdsh.cn`、`name: iMacPro`，但 `~/.rdsh/` 下**没有任何 `join-*.token`** → 断线后 `registerJoin` 只能抛错。

## 2. 修复

- `packages/gateway/src/index.ts`：对外导出 `persistToken`；
- `packages/web-remote/src/index.ts` → `scanState()`：consume 成功后、写 config 之前调用 `persistToken(hub, cj.hostToken)`（与 `registerJoin` 行为对齐）。

另外确认 `disconnect()` 不会清除 token（仅停隧道），因此修复后「绑定 → 断开 → 重连」链路完整。

## 3. 验证

- `pnpm --filter ./packages/web-remote test`：**27/27**；`pnpm --filter rdsh-gateway test`：**165/165**；
- 真机：修复后扫码绑定产生 `~/.rdsh/join-rdsh.cn.token`，重启 DSH 后 `autoConnect` 能凭该 token 自动起隧道，手动「接入」亦可复用；
- 前置条件：旧的无 token 状态需先「注销」回到未配置态再重新扫码绑定（`revoke` 在无 token 时也能清配置）。

## 4. 未决 / 注意（非代码）

- **孤儿主机**：修复前完成过的扫码绑定，其主机已在 hub 上创建但本地无 token，`revoke()` 无法 `selfRevoke`（无 token），需在 APP 主机列表中手动吊销；
- **同类审计**：已核查插件内其余 token 获取路径（`connect` / `autoConnect` 均经 `registerJoin`，自带持久化），无遗漏；
- **发版**：修复横跨 `rdsh-gateway`（导出）与 `dsh-web-remote`（调用），已随 gateway 0.11.3 / web-remote 0.8.0 出货。

*关联：`packages/gateway/src/token-store.ts` ｜ `packages/gateway/src/join.ts` ｜ `packages/web-remote/src/index.ts` ｜ feature 26 扫码绑定*
