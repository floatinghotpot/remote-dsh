# TODO / LIMITATION：E2EE 大文件上传（未完成项与已知限制）

> 2026-09-14 ｜ 对应 [verification.md](./verification.md) ｜ **已完成**：AC1（分片）/ AC2（二进制保真）/ AC3（流式）/ AC6–AC10

## TODO（代码未修，待做）

- [ ] **AC4 请求体类型**：`packages/hub/src/e2ee-shim.ts` 现在只认 string / ArrayBuffer·TypedArray；`Blob`→**0 字节**、`ReadableStream`→**0 字节**、`FormData`→**1 个垃圾字节**（实测，且**静默**）。要求：Blob / FormData / ReadableStream **正确支持**，其余类型**明确抛 TypeError**（不得静默发错）
- [ ] 随 AC4 扩展 F7 沙箱：Blob/FormData/ReadableStream 请求体字节一致 + 不支持类型抛错（二进制响应/流式/取消已覆盖）
- [ ] **F14 错误文案误导**：`packages/gateway/src/join.ts:591` 把"上游已接受但中途断开（ECONNRESET）"统一报成 `UPSTREAM_UNREACHABLE: dsh not reachable`，掩盖真实 401/400/413。要求：区分"连不上"与"上游中断"，已收到响应头时用 `CLOSE(code, reason)` 而非 ERROR

## LIMITATION（已知限制，**已决策不修**；不是待办 bug）

- [ ] **非图片文件附件走 Blob Worker ⇒ 明文**（F13）：范围**仅**"拖 pdf/zip/bin 当附件"这一类；图片随 prompt 走 E2EE、预览走页面 `fetch` 也是 E2EE（F25/F26）。已写入用户手册 `doc/overview/usage.md` §9.1（含判据）。复谈条件：**等 DSH 稳定后**再评估"包装 `window.Worker` + fail-closed"；**永不改 DSH 源码**
- [ ] **dev/HMR 的 `EventSource` 不经 E2EE**（F10/AC5）：仅 dev 模式，生产路径不涉及
- [ ] **响应头 `content-encoding` 原样透传**：若上游真回压缩体，消费方拿到的是压缩字节（native `Response` 不会解压）。**当前不可达**——我们的请求不带 `accept-encoding`（浏览器也禁止 JS 设置该头）⇒ 上游一律 identity；留作防御性加固项
- [ ] **WS 消息不做分片**（设计上限）：单条 >16 MiB 的浏览器 WS 消息会被 hub 以 1009 拒绝（只废该流，不打挂 hub）。WS 分片会破坏 host 侧的消息边界，故不做
- [ ] **LAN（`rdsh host serve`）本就没有 E2EE**：无 shim 注入，属设计差异，非缺陷

## 交付项（非代码）

- [ ] **发布 `rdsh-hub`**（+ `remote-dsh` 依赖版本）：**不发版则线上不变**（仍无 E2EE / 大文件失败 / hub 会被打挂 / 预览坏 / manifest 报错）
- [ ] 发布后复核：>16 MiB 上传、预览文档/图片、通道失效有明确报错、hub 不被单帧打死、console 0 报错
- [ ] **用户端复测预览**（PDF / 大图）：字节与流式已在真机验证（sha256 一致、287 块），渲染需人工确认
- [ ] **运维跟进（F13c）**：确认生产反代 `proxy_request_buffering off`（默认 on 会把大请求体写进 hub 机器临时文件）；知悉访问日志含上传文件名+大小（不含内容）
- [ ] **企业 opt-in（非默认）**：`e2ee.mode: "required"` 主机侧 fail-closed——**只做开关**，避免让"传图给 AI"这类主路径不可用
