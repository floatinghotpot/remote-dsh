# rdsh-tunnel 协议（冻结 v1）

> **状态**: `FROZEN v1`（2026-08-23，M3 定稿）。跨语言契约 —— rdsh-hub（TS 原型 / 未来 Go
> 生产实现）与 rdsh-gateway 之间的**唯一**线协议。任何变更必须先更新本文档再改实现，
> 并补 conformance 互操作测试（TS ↔ Go，`e2e/`）。
>
> 参考：`doc/feature/03-hub/solution.md` §5.1。

## 传输

- 载体：WebSocket（WSS，TLS 1.3）
- 方向：gateway **出站**连接 hub；一个 host 一条隧道长连接
- 隧道认证：WSS URL query `?token=<hostToken>`（WSS 已加密；hub 日志不得记录 query）
- 帧即 WS message（binary），一条 WS message 恰为一帧（长度由帧头 length 字段约束）

## 帧格式

| 字段 | 长度 | 说明 |
|---|---|---|
| magic | 4B | `0x52 0x44 0x53 0x48`（"RDSH"） |
| version | 1B | 协议版本（当前 1） |
| flags | 1B | bit0: E2E 加密位（**预留**）；实现必须**忽略未知位并原样透传** |
| type | 1B | 帧类型（下表） |
| streamId | 4B | 流 id（大端，多路复用） |
| length | 4B | payload 长度（大端） |
| payload | N | 负载（JSON 或原始字节，见 type 表） |

帧头长度固定 15B；payload 上限 **16 MiB**（DATA 分片转发，超出属协议错误）。

## 帧类型与 payload

| type | 值 | payload 编码 | 语义 |
|---|---|---|---|
| OPEN | 0x01 | JSON（见下） | 流开始。**hub→gateway = 客户端请求**；**gateway→hub = 上游响应**（复用同一 streamId） |
| DATA | 0x02 | 原始字节 | 请求/响应体分片（流式，禁止整体缓冲；按背压转发） |
| CLOSE | 0x03 | JSON `{code?, message?}` | 流正常结束（code 0）或异常 |
| PING | 0x04 | JSON `{ts}` | 心跳探测（毫秒时间戳） |
| PONG | 0x05 | JSON `{ts}` | 心跳回显 |
| ERROR | 0x06 | JSON `{code, message}` | 协议级错误（认证失败、host 不存在、上游不可达等），关闭对应流 |

### OPEN payload

**请求（hub → gateway）**：

```json
{ "kind": "http", "method": "POST", "path": "/api/session.list", "headers": { "content-type": "application/json" } }
{ "kind": "ws", "path": "/api/events.mux", "headers": { "sec-websocket-version": "13" } }
```

**响应（gateway → hub）**：

```json
{ "kind": "http", "status": 200, "reason": "OK", "headers": { "content-type": "application/json" } }
```

- headers 为字符串键值对（多值头用逗号拼接；实现需按语义处理 `set-cookie` 等多值头时在 headers 中允许数组）
- 流方向由发送方决定，无需方向字段

## 多路复用

- streamId 由 **hub 分配**（原子递增 uint32），gateway 在响应流中**原样回显**
- 单隧道支持并发 HTTP / SSE / WebSocket 升级流（DSH 依赖 `/api/events.mux`、`events.host`）
- **WS 流内容按文本帧转发**（2026-08-24 定案）：DSH 前端与 events.mux 为 text/JSON 协议；
  隧道转发固定 binary 会把文本消息变成 binary 帧，前端会丢弃（表现为实时界面不刷新）。
  未来若需二进制 WS 内容，再扩展帧类型。
- 借鉴 DSH 自身 mux 帧设计（`/api/events.mux`）

## 心跳与重连

- 心跳：应用层 PING（30s 间隔）；对端 10s 未回 PONG → 判定离线，断开连接
- gateway 重连：指数退避 1s → 60s（×2）+ 随机抖动；重连后重新认证（token）

## 背压与流式

- 大负载（DSH 请求体上限 300 MB）必须**流式分片转发、禁止整体缓冲**
- 上下游 write backpressure 联动（DATA 帧按上游可写状态节奏发送）

## E2E 加密预留

- flags bit0 为加密帧标记（公共 SaaS 化时实现端到端加密，见 proposal §10 Q5）
- 当前实现必须**忽略未知 flag 位并原样透传**，保证向后兼容

## 错误映射（数据面）

| 场景 | 行为 |
|---|---|
| hostId 无对应隧道 | hub 直接回 `{error:{code:"HOST_OFFLINE", message}}`（503） |
| gateway 侧 dsh 不可达 | gateway 发 ERROR → hub 回 502 |
| token 无效/吊销 | 隧道建立被拒（WSS 101 后首个 ERROR 或直接断开）；重连同样被拒 |

## 变更记录

| 日期 | 变更 |
|---|---|
| 2026-08-23 | **冻结 v1**：payload 编码定稿（OPEN/DATA/CLOSE/PING/PONG/ERROR 语义 + HTTP/WS 封装 + 隧道认证 + 错误映射） |
