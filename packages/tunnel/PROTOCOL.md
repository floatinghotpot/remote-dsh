# rdsh-tunnel 协议（草案）

> **协议先行纪律**：本协议是 rdsh-hub（未来 Go 实现）与 rdsh-gateway（TS）之间的
> 跨语言唯一契约。任何帧格式/消息类型变更必须**先更新本文档**，再改实现，并补充
> conformance 互操作测试（TS ↔ Go）。

## 传输

- 载体：WebSocket（WSS，TLS 1.3）
- 方向：gateway **出站**连接 hub；一个 host 一条隧道长连接
- 心跳：应用层 ping/pong（见帧类型），空闲超时断连重连

## 帧格式（草案，待 solution.md 定稿）

| 字段 | 长度 | 说明 |
|---|---|---|
| magic | 4B | `0x52 0x44 0x53 0x48`（"RDSH"） |
| version | 1B | 协议版本（当前 1） |
| flags | 1B | bit0: E2E 加密位（**预留**，见下文） |
| type | 1B | 帧类型（open/data/close/ping/pong/error） |
| streamId | 4B | 请求/流 id（多路复用） |
| length | 4B | 负载长度（大端） |
| payload | N | 负载（HTTP 请求行/头/体、WS 帧、事件） |

> **E2E 预留**：flags bit0 为加密帧标记（未来公共 SaaS 实现端到端加密，见
> proposal.md §10 Q5）。当前实现必须**忽略未知 flag 位并原样透传**，保证向后兼容。

## 多路复用

- 单隧道按 `streamId` 分帧，支持并发 HTTP / SSE / WebSocket 升级流
- 借鉴 DSH 自身 mux 帧设计（`/api/events.mux`）

## 背压与流式

- 大负载（DSH 请求体上限 300 MB）必须**流式转发、禁止整体缓冲**
- 上下游 write backpressure 联动

## 状态

`DRAFT` —— 待 M0/M2 的 solution.md 定稿后冻结。
