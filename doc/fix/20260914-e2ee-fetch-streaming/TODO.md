# TODO / LIMITATION：E2EE 大文件上传（未完成项与已知限制）

> 2026-09-14 ｜ 对应 [verification.md](./verification.md) ｜ **已完成**：AC1（分片）/ AC2（二进制保真）/ AC3（流式）/ AC6–AC10

## TODO（代码未修，待做）

_（本轮已清空：AC4 与 F14 均已完成，见下）_

## 已完成（本轮）

- [x] **AC4 请求体类型**（`packages/hub/src/e2ee-shim.ts`）：Blob / File（按 `blob.type` 补 content-type）、ReadableStream（边读边发、去掉未知 `content-length`）、FormData（multipart + boundary）、URLSearchParams 全部**字节正确**；**不支持的类型抛 `TypeError`**（且在开流之前失败）。真机验证：Blob 体 200 且 rpcId 原样回显、2 块流式体 200 且回显、`{not:'a body'}` 抛 `TypeError: unsupported request body type`。单测 4 例
- [x] **F14 错误文案**（`packages/gateway/src/join.ts`）：新增 `classifyUpstreamFailure()` —— 连不上（`ECONNREFUSED/ENOTFOUND/EAI_AGAIN/EHOSTUNREACH/ENETUNREACH`）才报 `UPSTREAM_UNREACHABLE`；已连上但提前断开报 `UPSTREAM_ABORTED: upstream closed before responding (ECONNRESET)`；**已发出响应头**时改用 `CLOSE(code 502)` 表示 body 截断。真机复现同一请求：`502 UPSTREAM_UNREACHABLE: dsh not reachable` → **`502 UPSTREAM_ABORTED: upstream closed before responding (ECONNRESET)`**。单测 4 例

## LIMITATION（已知限制，**已决策不修**；不是待办 bug）

- [x] **非图片文件附件走 Blob Worker ⇒ 明文**（F13）：范围**仅**"拖 pdf/zip/bin 当附件"这一类；图片随 prompt 走 E2EE、预览走页面 `fetch` 也是 E2EE（F25/F26）。已写入用户手册 `doc/overview/usage.md` §9.1（含判据）。复谈条件：**等 DSH 稳定后**再评估"包装 `window.Worker` + fail-closed"；**永不改 DSH 源码**
- [x] **dev/HMR 的 `EventSource` 不经 E2EE**（F10/AC5）：仅 dev 模式，生产路径不涉及
- [x] **响应头 `content-encoding` 原样透传**：若上游真回压缩体，消费方拿到的是压缩字节（native `Response` 不会解压）。**当前不可达**——我们的请求不带 `accept-encoding`（浏览器也禁止 JS 设置该头）⇒ 上游一律 identity；留作防御性加固项
- [x] **WS 消息不做分片**（设计上限）：单条 >16 MiB 的浏览器 WS 消息会被 hub 以 1009 拒绝（只废该流，不打挂 hub）。WS 分片会破坏 host 侧的消息边界，故不做
- [x] **LAN（`rdsh host serve`）本就没有 E2EE**：无 shim 注入，属设计差异，非缺陷

## 交付项（非代码）

- [ ] **发布 `rdsh-hub` + `rdsh-gateway`**（+ `remote-dsh` 依赖版本）：hub 侧含 shim/中继/manifest，gateway 侧含 F14；**不发版则线上不变**（仍无 E2EE / 大文件失败 / hub 会被打挂 / 预览坏 / manifest 报错 / 错误文案误导）
- [ ] 发布后复核：>16 MiB 上传、预览文档/图片、通道失效有明确报错、hub 不被单帧打死、console 0 报错
- [ ] **用户端复测预览**（PDF / 大图）：字节与流式已在真机验证（sha256 一致、287 块），渲染需人工确认
- [ ] **运维跟进（F13c）**：确认生产反代 `proxy_request_buffering off`（默认 on 会把大请求体写进 hub 机器临时文件）；知悉访问日志含上传文件名+大小（不含内容）
- [ ] **企业 opt-in（非默认）**：`e2ee.mode: "required"` 主机侧 fail-closed——**只做开关**，避免让"传图给 AI"这类主路径不可用
