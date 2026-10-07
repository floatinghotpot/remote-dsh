/**
 * SSE 响应进行中客户端中断 → 上游 socket 必须被 destroy（2026-10-07 socket 泄漏回归）。
 *
 * 根因：GET 空 body 时 hub 会先发 CLOSE{code:0}（半关，请求体发完），旧 closeStream
 * 在半关时就 `httpStreams.delete`，导致之后客户端断开、CLOSE{code:1} 到达时取不到 up，
 * destroy() 永不执行 → 上游 gateway→dsh 的 SSE socket 遗留。
 * 本测试复现完整时序：半关 → 响应流式 → abort，并断言上游连接被强制关闭。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { encodeFrame, FRAME_TYPE, FrameParser, jsonPayload } from "rdsh-tunnel";
import type { Frame } from "rdsh-tunnel";
import { startJoin } from "../src/join.ts";

async function waitFor(cond: () => boolean, timeoutMs = 5000, label = "waitFor"): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`${label} timeout`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("SSE 响应进行中客户端中断 → 半关后 abort 仍能 destroy 上游 socket", async () => {
  let upstreamClosed = false;
  const upstream = createServer((_req, res) => {
    // SSE：发响应头 + 一片数据后**永不 end**（模拟长连接），连接被强制关闭时触发 close。
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: hello\n\n");
    res.on("close", () => {
      upstreamClosed = true;
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
  const addr = upstream.address();
  assert.ok(addr !== null && typeof addr === "object");
  const upstreamPort = addr.port;

  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => wss.on("listening", () => r()));
  const hubPort = (wss.address() as { port: number }).port;

  const frames = new Map<number, Frame[]>();
  let hubSocket: WebSocket | undefined;
  wss.on("connection", (ws) => {
    hubSocket = ws;
    const parser = new FrameParser();
    ws.on("message", (data) => {
      for (const f of parser.push(Buffer.from(data as ArrayBuffer))) {
        const list = frames.get(f.streamId) ?? [];
        list.push(f);
        frames.set(f.streamId, list);
      }
    });
  });

  const lockPath = join(await mkdtemp(join(tmpdir(), "rdsh-sse-abort-")), "join.lock");
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
    await waitFor(() => hubSocket !== undefined);
    const hub = hubSocket as WebSocket;

    // ① GET 空 body：hub 发 OPEN + 半关（CLOSE code 0，请求体发完）
    hub.send(
      encodeFrame(FRAME_TYPE.OPEN, 1, jsonPayload({ kind: "http", method: "GET", path: "/sse", headers: { host: "127.0.0.1" } })),
    );
    hub.send(encodeFrame(FRAME_TYPE.CLOSE, 1, jsonPayload({ code: 0 })));

    // ② 响应头（OPEN）+ 至少一片 SSE 数据已流回，证明响应进行中
    await waitFor(() => (frames.get(1) ?? []).some((f) => f.type === FRAME_TYPE.OPEN), 5000, "响应头 OPEN");
    await waitFor(() => (frames.get(1) ?? []).some((f) => f.type === FRAME_TYPE.DATA), 5000, "SSE 数据帧");

    // ③ 客户端断开 → hub 发 CLOSE code 1（abort）
    hub.send(encodeFrame(FRAME_TYPE.CLOSE, 1, jsonPayload({ code: 1, message: "client aborted" })));

    // ④ 断言：上游 SSE 连接被强制关闭（destroy 生效；修复前会因 map 已删而 destroy 不到）
    await waitFor(() => upstreamClosed, 5000, "上游 socket 应被 destroy");
  } finally {
    await handle.stop();
    await new Promise<void>((r) => wss.close(() => r()));
    await new Promise<void>((r) => upstream.close(() => r()));
  }
});
