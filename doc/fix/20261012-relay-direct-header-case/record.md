# Record — Go relay 路径下内网直连不切换（header key 大小写不一致）

> **日期**: 2026-10-12
> **状态**: 已修复并上线验证（真机直连日志 `picked` + 右上角「内网直连」图标）
> **入口**: 华为手机通过 Hub 连树莓派（走 Go 版 relay `cn-relay-01.rdsh.cn`），右上角一直显示「服务器转发」云图标，未自动切内网直连；同一手机连 Mac（走 Node hub）却能正常切直连
> **结论**: 不是直连口/候选/TCP 探测的问题（候选一直存在）。是 **Go relay 与 TS gateway 之间的 header key 大小写不一致**：relay 转发请求头时保留 Go 规范化的大写 key（`Accept`），gateway 用小写（`accept`）读取，导致 `acceptsHtml` 误判为 false → 不剥离 `accept-encoding` → DSH 返回 gzip HTML → gateway 的 HTML 注入（含直连 bootstrap）因 `content-encoding` 门控被跳过 → 页面拿不到 `window.__rdshDirectInfo` → App 永不切直连。

---

## 1. 现象

- 同一台华为手机：连 **Mac（Node hub 路径）**能自动切内网直连；连 **树莓派（Go relay 路径）**只走「服务器转发」云图标，不切直连。
- 直接输 `http://192.168.10.202:8442` 能连上树莓派（直连口是通的）。
- App debug 日志：`[rdsh] direct: no __rdshDirectInfo (bootstrap not ready?)`。

---

## 2. 事实（代码 + 真机 CDP 证据链）

**直连候选的产生链路**：DSH 页面里的 bootstrap 脚本（`directBootstrapScript`）`fetch("/__rdsh/direct-candidates")` → 经 relay 隧道 → gateway（`join.ts`）合成返回候选 + 一次性票 → 挂到 `window.__rdshDirectInfo` → App 读取候选 → TCP 探测 → 切直连。

**一步步真机验证（华为手机 + CDP）**：

| 验证 | 结果 | 含义 |
|---|---|---|
| 手动 `fetch('/__rdsh/direct-candidates')` | ✅ 200，`{"candidates":[{"host":"192.168.10.202","port":8442}],...}` | **候选存在、relay 转发正常、gateway 端点正常** |
| `window.__rdshDirectBootstrapped` | `undefined` | **bootstrap 脚本根本没执行** |
| 页面 HTML 里注入脚本 | `injectedCount: 0`，无 `__rdsh`/`__rdshDirectBootstrapped` 痕迹 | **gateway 的 htmlInject 整体没注入** |
| 首页响应头 | `content-encoding: gzip` | **DSH 返回的 HTML 被 gzip 压缩了** |
| App 日志 | `no __rdshDirectInfo (bootstrap not ready?)` | 候选拿不到，不切直连 |

**根因链**：

1. DSH 0.1.2 起对 HTML 默认 gzip。
2. gateway（`proxy.ts`）靠 `rewriteHeadersForDsh` 里 `acceptsHtml()` 判断请求 `Accept` 头是否含 `text/html`，是则 `delete out["accept-encoding"]` 来阻止 DSH gzip。
3. 而 `acceptsHtml` 用 `headers["accept"]`（**小写**）读取；Go relay 的 `normalizeHeaders`（`relay.go`）输出 `out[k]`（**原始 key，Go `http.Header` 规范化为 `Accept` 大写**）。Node hub 用 Node 的 `http` 库，header key 自动小写，所以 hub 路径能读到。
4. relay 路径下 `acceptsHtml` 读不到 `accept` → 返回 false → 不剥离 `accept-encoding` → DSH gzip HTML。
5. gateway 的 HTML 注入条件 `canInject` 要求 `content-encoding === undefined`（`proxy.ts`），gzip 的 HTML 直接跳过注入。
6. bootstrap 脚本 + `RDSH_WEBVIEW_API` 都没注入 → `window.__rdshDirectInfo` 永不赋值 → App 轮询 15s 拿不到 → 放弃直连。

**为什么 Mac 正常**：Node hub 的 header key 是小写，`acceptsHtml` 能读到 → 剥离成功 → 不 gzip → 注入成功 → 切直连。

---

## 3. 修复（跨仓，两层）

- `go/internal/relay/relay.go` `normalizeHeaders`：`out[k]` → `out[lk]`，**输出统一小写 key**，与 Node hub 的 `relay.ts` 对齐（根因）。
- `packages/gateway/src/proxy.ts` `rewriteHeadersForDsh`：入口把传入 headers 的 key **统一 lower 后再处理**（防御，一处覆盖 `acceptsHtml` / `delete accept-encoding` / `cookie` 三处小写读取）。
- `go/internal/relay/relay_test.go`：`TestNormalizeHeaders` 断言从 `out["Content-Type"]` 改为 `out["content-type"]`（契约同步）。

> 与 [20261012-go-relay-white-screen](../20261012-go-relay-white-screen/record.md) 同属「Go relay 与 TS gateway 跨语言契约不一致」系列：那次是 wire header 类型 `string` vs `[]string`，这次是 header key 大小写。**跨语言隧道的任何 wire 契约（类型、大小写、枚举值）都必须两侧显式对齐并加 conformance 断言。**

---

## 4. 验证

- `go build ./...` + `go test ./...`（relay/tunnel/cmd）全绿；`pnpm --filter rdsh-gateway build`（tsc strict）通过。
- 部署：relay 交叉编译（`GOOS=linux GOARCH=amd64 CGO_ENABLED=0`）→ scp 到 `rdsh.cn` → 重启 `rdsh-relay.service`；gateway 本地 tsc → scp `proxy.js` 到树莓派 `rdsh-gateway/dist/` → 重启 `rdsh-join.service`。
- 真机复验（华为手机重新连树莓派）：
  ```
  [rdsh] direct: 1 candidates: 192.168.10.202:8442
  [rdsh] direct: picked 192.168.10.202:8442
  [rdsh] direct http (plaintext, trusted LAN only)
  ```
  右上角图标由「服务器转发」变为「**内网直连**」。

---

## 5. 待办 / 遗留

1. **服务器 workspace 代码未同步**：本次是交叉编译 + SCP 二进制部署，未走「提交→拉取→编译」；服务器 `~/workspace/remote-dsh` 仍停在旧 HEAD，且工作区有之前部署 portal 时残留的 `packages/hub/portal/assets` 改动（git 状态脏），下次 `git pull` 前需先处理。
2. **conformance 回归测试**：`relay.go` 的「header key 小写」与 `proxy.ts` 的「入口 lower」应补跨语言断言（本轮以真机 + 单侧单测验证为准），与 `20261012-go-relay-white-screen` 的待办同类。
3. **树莓派 DSH 版本告警**：日志提示 `dsh 0.1.7-rc.2` 超出 `remote-dsh` 实测范围（≤`0.1.7-rc.1`），与本次直连问题无关，属独立技术债，建议对齐版本后复验。
