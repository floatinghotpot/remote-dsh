/**
 * WS 上游消息超限（>16 MiB）不得打死 host（P1 的 WS 面）。
 *
 * 2026-09-14 复审发现：`openWsStream` 把 dsh 上游每条 WS 消息原样打包成一个 DATA 帧；
 * 消息 >16 MiB 会让 `encodeFrame` 抛 `ProtocolError`，抛点在 ws 的 message 回调里未捕获
 * ⇒ host（gateway）进程退出。WS 消息不能分片（会破坏消息边界），正确修法是**超限即废流**。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { FrameParser, FRAME_TYPE, encodeFrame, jsonPayload, MAX_PAYLOAD_LENGTH } from "rdsh-tunnel";
import type { Frame } from "rdsh-tunnel";
import { startJoin } from "../src/join.ts";

async function waitFor(cond: () => boolean, timeoutMs = 5000, what = "condition"): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("WS 上游消息 >16 MiB：发 CLOSE(1009) 并关上游，绝不转成 DATA 帧、不打死 host", async () => {
  // 假 dsh 上游 WS（target）：连接即回一条 >16 MiB 消息
  const upstream = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => upstream.on("listening", () => r()));
  const upstreamPort = (upstream.address() as { port: number }).port;
  const upstreamClosed = new Promise<number>((resolve) => {
    upstream.on("connection", (ws) => {
      ws.on("close", (code) => resolve(code));
      ws.send(Buffer.alloc(MAX_PAYLOAD_LENGTH + 1024));
    });
  });

  // 假 hub（隧道端）
  const hub = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => hub.on("listening", () => r()));
  const hubPort = (hub.address() as { port: number }).port;

  const frames = new Map<number, Frame[]>();
  let tunnelSocket: WebSocket | undefined;
  hub.on("connection", (ws) => {
    tunnelSocket = ws;
    const parser = new FrameParser();
    ws.on("message", (data) => {
      for (const f of parser.push(Buffer.from(data as ArrayBuffer))) {
        const list = frames.get(f.streamId) ?? [];
        list.push(f);
        frames.set(f.streamId, list);
      }
    });
  });

  const lockPath = join(await mkdtemp(join(tmpdir(), "rdsh-ws-oversize-")), "join.lock");
  const handle = startJoin({
    hubUrl: `http://127.0.0.1:${hubPort}`,
    token: "t".repeat(43),
    insecure: false,
    target: { host: "127.0.0.1", port: upstreamPort },
    role: "plugin",
    lockPath,
    hooks: {},
  });

  try {
    await waitFor(() => tunnelSocket !== undefined, 5000, "tunnel connected");
    const tunnel = tunnelSocket as WebSocket;
    tunnel.send(encodeFrame(FRAME_TYPE.OPEN, 1, jsonPayload({ kind: "ws", path: "/api/remote.mux", headers: { host: "127.0.0.1" } })));

    await waitFor(() => (frames.get(1) ?? []).some((f) => f.type === FRAME_TYPE.CLOSE), 5000, "CLOSE frame");

    const list = frames.get(1) ?? [];
    assert.equal(list.some((f) => f.type === FRAME_TYPE.DATA), false, "超限 WS 消息不得转成 DATA 帧（encodeFrame 会抛 ProtocolError）");
    const close = list.find((f) => f.type === FRAME_TYPE.CLOSE)!;
    const payload = JSON.parse(close.payload.toString("utf8")) as { code: number };
    assert.equal(payload.code, 1009, "应以 1009（message too big）关闭该流");

    // 上游 dsh 连接也应被关闭（code 1009）
    const upstreamCode = await Promise.race([upstreamClosed, new Promise<number>((r) => setTimeout(() => r(-1), 3000))]);
    assert.equal(upstreamCode, 1009, "上游连接应以 1009 被关闭");
  } finally {
    await handle.stop();
    await new Promise<void>((r) => hub.close(() => r()));
    await new Promise<void>((r) => upstream.close(() => r()));
  }
});
