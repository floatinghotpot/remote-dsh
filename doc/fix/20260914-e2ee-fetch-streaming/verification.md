# E2EE 大文件上传：分片 + 通道自愈（verification）

> **日期**: 2026-09-14 ｜ **对应**: [solution.md](./solution.md) ｜ **状态**: **全部达成**：G1 分片 / G2 不静默挂起 / G3 hub 不被打死 / AC2 二进制 / AC3 流式 / AC4 请求体类型 / F14 上游失败文案

---

## 1. AC 对照

| AC | 状态 | 证据 |
|---|---|---|
| **AC1 大文件上传**（>16 MiB 分片、字节一致） | 🟡 **传输层 ✅ / 端到端待用户复测** | ① 单测：2 MiB+1234 B 请求体 ⇒ 3 个 DATA 帧、每帧 ≤1 MiB、拼接字节全等、OPEN/CLOSE 顺序正确（`e2ee-shim-ws.test.ts`）；② 真机：**20 MiB 请求体经 E2EE 全量送达** —— DSH 读到完整 body 后回 `HTTP 400 · body is not JSON`，**448 ms 完成**（修复前：单帧 20 MiB ⇒ hub 1009 + 永久挂起）；③ 用户端 18 MiB 文件待复测 |
| **AC2 预览二进制保真** | ✅ **真机实测** | 18,755,423 B PNG（`/api/file?path=/tmp/big18.png`）经 E2EE 取回：长度一致、**sha256 = `df348384168c8c5d…`，与本地文件相同**；对照明文 XHR 亦一致。单测：含 `0x00/0xff/0x80` 的字节块逐块原样（旧实现经 UTF-8 往返必变形，用例已断言该前提） |
| **AC3 流式响应** | ✅ **真机实测** | 同一响应被切成 **287 块**逐块读取（不再是一次性整包）；**首块 206 ms 到达**而整体仍在传输；单测：只发响应头时 `fetch` 即 resolve（不等 CLOSE）、块边界保持、`cancel()` 向 host 发 `CLOSE(code 1)` 中止上游 |
| **AC4 请求体类型**（Blob/FormData/ReadableStream + 不支持类型明确报错） | ✅ **已修已验** | Blob/File、ReadableStream（边读边发）、FormData（multipart+boundary）、URLSearchParams 字节正确；其余抛 `TypeError` 且**开流前**失败。真机：Blob 体 200 + rpcId 回显、2 块流式体 200 + 回显、`{not:'a body'}` ⇒ `TypeError`。单测 4 例 |
| **AC5 EventSource** | ⏳ 登记 | 仅 HMR 使用（F10）；dev 下该通道不走 E2EE（低危） |
| **AC6 不回归**（设置/API key、WS 门面、密文） | ✅ | 真机复验：`WrappedWS` 接管、`/api/settings/describe`、`/api/credentials/describe` 仍 200；`pnpm test` 全绿 |
| **AC7 超限帧只废连接/流、hub 存活** | ✅ | `relay-oversize-frame.test.ts`：超限 ⇒ 连接 **1009** + host 侧收到 CLOSE + hub 同进程仍应答 401 |
| **AC8 上限内不误伤** | ✅ | 同文件第 2 例：1 MiB 消息仍按一条消息一帧转发、连接保持打开 |
| **AC9 单测 + 反证** | ✅ | 反证：临时移除两处护栏 ⇒ 同一用例失败（`Error: payload too large: 16781312 > 16777216`） |
| **AC10 真机复现** | ✅ | ① 修复后 20 MiB 单帧：连接被拒、hub 存活（`/portal` 200、pid 不变）；② 用户实测上传大文件后 hub 未重启（日志无 `ProtocolError` / `tunnel lost`） |

## 2. 关键证据

1. **静默挂起被消除**（G2，对应用户的 "no error and no reply"）：`deliverClose()` 后挂起请求立刻以 `e2ee channel closed` reject，且下一条请求重建内层连接（`e2ee-shim-ws.test.ts`）。
2. **分片**（G1）：单测按帧解密断言（真实 X25519+HKDF+AES-GCM 沙箱），非"看代码推断"。
3. **20 MiB 真机全量送达**：`{ outcome: "HTTP 400 · body is not JSON", elapsedMs: 448 }` —— 关键在"DSH 读满了 20 MiB 才判 JSON 非法"，而不是半路断开。
4. **hub 存活**（G3）：同一次实测中日志无 `ProtocolError`、无 `raw ws frame rejected`、无 `tunnel lost`，hub pid 不变（ws 层 `maxPayload` 在解帧阶段直接 1009，不到我们的回调）。

## 3. 质量门

- `pnpm build` exit 0（0 TS error）；
- `pnpm test` exit 0 全绿；`e2ee-shim-ws.test.ts` **18/18**、`upstream-failure.test.ts` **4/4**、`relay-oversize-frame.test.ts` **2/2**。

## 4. 尚未完成（见 [TODO.md](./TODO.md)）

_（代码项已清空）_
3. **F13（已决策）**：后台上传走 Blob Worker（原生 XHR/fetch）⇒ **不经 E2EE** ⇒ **暂时接受**并写入 `doc/overview/usage.md` §9.1；hub 侧确认**不缓存/不落盘**请求体（F13b），部署侧注意反代 `proxy_request_buffering` 与访问日志（F13c）；
3. **F14**：上传路径 502 文案（`UPSTREAM_UNREACHABLE`）掩盖真实错误，待定位；
4. 用户端**文档/图片预览**复测；发布 `rdsh-hub`。
