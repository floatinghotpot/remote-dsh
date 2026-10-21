/**
 * 心跳超时判定：hub 侧（PROTOCOL.md「心跳与重连」）。
 *
 * hub 也主动发 PING，并在超时未收到对端任何帧时 terminate 该连接
 * → close → onClose（摘除隧道注册表 + 推送 host.offline）。
 * 历史缺陷：hub 从不发 PING，也不判定超时（见 doc/fix/20260911-heartbeat-pong-timeout/）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket, WebSocketServer } from "ws";
import { encodeFrame, FRAME_TYPE, FrameParser, jsonPayload } from "rdsh-tunnel";
import type { Frame } from "rdsh-tunnel";
import { TunnelConn } from "../src/tunnel.ts";

/** 起一个 ws 服务，把每条连接包成 TunnelConn（毫秒级心跳时序），返回关闭器与 onClose 观测。 */
async function harness(
  clientOnFrame: (frames: Frame[], client: WebSocket) => void,
): Promise<{ everClosed: () => boolean; pingSeen: () => boolean; close: () => Promise<void> }> {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => wss.on("listening", () => r()));
  const port = (wss.address() as { port: number }).port;
  let closed = false;
  let pingSeen = false;
  wss.on("connection", (ws) => {
    new TunnelConn(
      ws,
      "host-under-test",
      () => {
        closed = true;
      },
      // 毫秒级注入：超时取 250ms（远大于 100ms 心跳间隔）以留出调度余量，
      // 避免 CI 负载导致"应答及时却被判死"的假失败。
      { heartbeatMs: 100, pongTimeoutMs: 250 },
    );
  });
  const client = new WebSocket(`ws://127.0.0.1:${port}/tunnel`);
  const parser = new FrameParser();
  client.on("message", (data) => {
    const frames = parser.push(Buffer.from(data as ArrayBuffer));
    if (frames.some((f) => f.type === FRAME_TYPE.PING)) pingSeen = true;
    clientOnFrame(frames, client);
  });
  await new Promise<void>((r) => client.on("open", () => r()));
  return {
    everClosed: () => closed,
    pingSeen: () => pingSeen,
    close: () =>
      new Promise<void>((r) => {
        try {
          client.terminate();
        } catch {
          /* 已关闭 */
        }
        wss.close(() => r());
      }),
  };
}

test("hub 心跳：客户端不应答 → 超时后断开并回调 onClose", async () => {
  const h = await harness(() => undefined); // 客户端收到 PING 但不回 PONG
  try {
    const start = Date.now();
    while (!h.everClosed()) {
      if (Date.now() - start > 3000) throw new Error("hub 未在超时后断开连接");
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(h.everClosed(), true);
  } finally {
    await h.close();
  }
});

test("hub 心跳：客户端回 PONG → 保持连接（不误判）", async () => {
  const h = await harness((frames, client) => {
    for (const f of frames) {
      if (f.type === FRAME_TYPE.PING) client.send(encodeFrame(FRAME_TYPE.PONG, 0, jsonPayload({ ts: Date.now() })));
    }
  });
  try {
    await new Promise((r) => setTimeout(r, 600)); // 跨越多个心跳周期
    assert.equal(h.pingSeen(), true, "hub 应主动发 PING（对称心跳）");
    assert.equal(h.everClosed(), false, "收到 PONG 后不应被判定离线");
  } finally {
    await h.close();
  }
});
