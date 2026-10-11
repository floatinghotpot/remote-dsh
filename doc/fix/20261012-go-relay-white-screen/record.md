# Record — Go relay 白屏 + WS 断连 + 目录选择器 403（四个跨语言/生命周期根因）

> **日期**: 2026-10-12
> **状态**: 已修复（curl 验证 200 + index.html + WS open + 目录 API 200）
> **入口**: 通过 `cn-relay-01.rdsh.cn`（Go 版 relay）进入主机，DSH 页面白屏；修 HTTP 后又出现右下角「re-connecting」，接着目录选择器报 `directoryPicker/list ... HTTP 403`
> **结论**: 不是 DSH 版本问题（`DSH_COMPAT_MAX` 已到 `0.1.7-rc.1`，认证/RPC 未变）。是 **Go relay 与 TS gateway 之间的四处跨语言契约 / 生命周期不一致**：Go `net/http` 的「handler 返回即自动补空响应」、wire header 类型 `string` vs `[]string`、以及 DSH 插件围栏要求 loopback `Origin` 而两种请求路径都没带。

---

## 1. 事实（代码定位）

- **白屏主因（HTTP body 被截断）**：`go/internal/relay/relay.go` 的 `HandleHTTP` 在 `conn.EndRequest(streamID)` 后**直接 return**，没有等隧道异步响应回来。Go `net/http` 见 handler 返回且未写 body，就自动回一个 `Content-Length: 0` 的空 200，随后才到的 `OnResponse`/`OnData` 写的是已提交的响应 → 浏览器拿到空 HTML（之前日志里的 `superfluous response.WriteHeader call ... writeError` 也是这个时序下的双写）。对照 Node 侧 hub 的 `relay.ts`：`res` 一直挂到 `res.end()`，所以 hub 路径从不出这问题。
- **502 `malformed response open`**：`go/internal/tunnel/payload.go` 的 wire 类型是 `Headers = map[string][]string`；而 `packages/gateway/src/join.ts` 的 `normalizeRespHeaders` 返回 `Record<string, string | string[]>`，注入/补丁路径又混入字符串 `"content-length": String(...)`。Go 的 `json.Unmarshal` 遇到 `string`（非 `[]string`）直接失败 → relay 回 502。
- **WS 403**：`join.ts` 的 `openWsStream` 用 `new WebSocket(url, { headers })`，但 `ws` 库的 `Origin` 走独立 `origin` option、不取 `headers.origin`，于是 DSH 的 `/api/remote.mux` WS 围栏 403。
- **目录选择器 403**：`proxy.ts` 的 `rewriteHeadersForDsh` 只在「原请求有 Origin」时才改写为 loopback；而浏览器**同源 fetch 不带 Origin**，DSH 目录选择器插件的围栏要求 Origin 存在且为 loopback → `forbidden`。

## 2. 修复

- `go/internal/relay/relay.go`
  - `httpHandler` 加 `done chan struct{}` + `doneOnce sync.Once` + `finish()`；
  - `OnClose` / `OnError` 调 `finish()`；
  - `HandleHTTP` 在 `EndRequest` 后 `<-h.done` 阻塞到响应流结束（`1e17487`）。
- `packages/gateway/src/join.ts`
  - `normalizeRespHeaders` 返回 `Record<string, string[]>`，所有值统一 `string[]`（`out[k] = Array.isArray(v) ? v : [String(v)]`），注入/补丁路径的 `content-length` / `cache-control` 也改数组（`5d1433f`）；
  - `openWsStream` 显式传 `origin: http://<host>:<port>`（`39b5a36`）。
- `packages/gateway/src/proxy.ts`
  - `rewriteHeadersForDsh` 去掉 `if (out.origin !== undefined)` 条件，**始终**改写 `out.origin = http://<host>:<port>`（`59f45bf`）。

## 3. 验证

- `go build ./...` + `go test ./internal/relay/...` 通过。
- `pnpm build` 全绿。
- 线上 curl（带 `rdsh_host` 签名 cookie）：
  - `GET https://cn-relay-01.rdsh.cn/` → `200` + `Content-Length: 39691` + `<!doctype html>`（修复前 `Content-Length: 0`）；
  - WS `/api/remote.mux` → `ws open` + text 消息（修复前 `Unexpected server response: 403`）；
  - `POST /api/directoryPicker/list` → `200 application/json`（修复前 `403 forbidden`）。

## 待办

- 回归测试：`relay.go` 的「阻塞到响应完成」用例、`join.ts` 响应头 `string[]` 与 `rewriteHeadersForDsh` 恒补 Origin 的断言（本轮以线上 curl 验证为准，测试后续补）。
