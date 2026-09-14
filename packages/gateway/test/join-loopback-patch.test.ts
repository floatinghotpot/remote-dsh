/**
 * host 侧 loopback 补丁的**落地**验证（集成，进程内）——含**压缩响应**（2026-09-14 事故回归）。
 *
 * 事故：dsh 在客户端声明 accept-encoding 时 gzip 压缩 JS，而补丁是在字节里做字面量替换
 * ⇒ 压缩体上必然 miss（fail-open 静默失效）⇒ 前端 isLoopback 未改写 ⇒ 设置页/API key 不可用。
 * 本测试用真实 `startJoin` + 假 hub + 假上游（identity/gzip/br/未知编码）覆盖该路径。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { brotliCompressSync, gunzipSync, gzipSync, brotliDecompressSync } from "node:zlib";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { encodeFrame, FRAME_TYPE, FrameParser, jsonPayload } from "rdsh-tunnel";
import type { Frame } from "rdsh-tunnel";
import { startJoin } from "../src/join.ts";

const TARGET = "isLoopbackHostname(pageLocation.hostname)";
const JS = `var loop = ${TARGET};\n`;
const JSON_BODY = `{"k":"${TARGET}"}`;
const ZSTD_FAKE = Buffer.from(`FAKE-ZSTD:${JS}`);

async function startUpstream(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    if (url.startsWith("/plugins/plain.js")) {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(JS);
      return;
    }
    if (url.startsWith("/plugins/gzip.js")) {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "content-encoding": "gzip" });
      res.end(gzipSync(Buffer.from(JS)));
      return;
    }
    if (url.startsWith("/plugins/br.js")) {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "content-encoding": "br" });
      res.end(brotliCompressSync(Buffer.from(JS)));
      return;
    }
    if (url.startsWith("/plugins/zstd.js")) {
      // 未知编码：补丁必须放弃并原样透传（不能损坏）
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "content-encoding": "zstd" });
      res.end(ZSTD_FAKE);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON_BODY);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  assert.ok(addr !== null && typeof addr === "object");
  return { server, port: addr.port };
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

interface Got {
  headers: Record<string, string>;
  body: Buffer;
}

test("loopback 补丁：identity / gzip / br 命中；未知编码与 JSON 原样透传；content-length 正确", async () => {
  const upstream = await startUpstream();
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

  const lockPath = join(await mkdtemp(join(tmpdir(), "rdsh-loopback-patch-")), "join.lock");
  const handle = startJoin({
    hubUrl: `http://127.0.0.1:${hubPort}`,
    token: "t".repeat(43),
    insecure: false,
    target: { host: "127.0.0.1", port: upstream.port },
    role: "plugin",
    lockPath,
    hooks: {},
  });

  try {
    await waitFor(() => hubSocket !== undefined);
    const hub = hubSocket as WebSocket;

    async function get(streamId: number, path: string): Promise<Got> {
      hub.send(
        encodeFrame(FRAME_TYPE.OPEN, streamId, jsonPayload({ kind: "http", method: "GET", path, headers: { host: "127.0.0.1" } })),
      );
      hub.send(encodeFrame(FRAME_TYPE.CLOSE, streamId, jsonPayload({ code: 0 })));
      await waitFor(() => (frames.get(streamId) ?? []).some((f) => f.type === FRAME_TYPE.CLOSE));
      const list = frames.get(streamId) ?? [];
      const open = list.find((f) => f.type === FRAME_TYPE.OPEN);
      assert.ok(open !== undefined, "应收到 OPEN 帧");
      const headers = (JSON.parse(open.payload.toString("utf8")) as { headers: Record<string, string> }).headers;
      const body = Buffer.concat(list.filter((f) => f.type === FRAME_TYPE.DATA).map((f) => f.payload));
      return { headers, body };
    }

    const plain = await get(1, "/plugins/plain.js");
    assert.ok(plain.body.toString("utf8").includes("var loop = true;"), "identity JS 应被替换");
    assert.equal(plain.headers["content-length"], String(plain.body.length), "content-length 必须与实际字节一致");

    const gz = await get(2, "/plugins/gzip.js");
    assert.equal(gz.headers["content-encoding"], "gzip", "应保留原编码");
    assert.equal(gz.headers["content-length"], String(gz.body.length), "重压后 content-length 必须重算");
    assert.ok(gunzipSync(gz.body).toString("utf8").includes("var loop = true;"), "gzip JS 解压后应已被替换");

    const br = await get(3, "/plugins/br.js");
    assert.equal(br.headers["content-encoding"], "br");
    assert.ok(brotliDecompressSync(br.body).toString("utf8").includes("var loop = true;"), "br JS 解压后应已被替换");

    const zstd = await get(4, "/plugins/zstd.js");
    assert.deepEqual(zstd.body, ZSTD_FAKE, "未知编码必须字节级原样透传（不得损坏）");
    assert.equal(zstd.headers["content-encoding"], "zstd");

    const json = await get(5, "/api/data.json");
    assert.equal(json.body.toString("utf8"), JSON_BODY, "非 JS 不得改动");
  } finally {
    await handle.stop();
    await new Promise<void>((r) => wss.close(() => r()));
    await new Promise<void>((r) => upstream.server.close(() => r()));
  }
});

test(">16 MiB 的 JS 响应：按 ≤1 MiB 分片发送、字节一致、补丁仍生效（P1 回归）", async () => {
  const upstream = createServer((req, res) => {
    const big = Buffer.alloc(17 * 1024 * 1024);
    Buffer.from(`var loop = ${TARGET};`).copy(big, 0);
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    res.end(big);
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
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

  const lockPath = join(await mkdtemp(join(tmpdir(), "rdsh-bigframe-")), "join.lock");
  const handle = startJoin({
    hubUrl: `http://127.0.0.1:${hubPort}`,
    token: "t".repeat(43),
    insecure: false,
    target: { host: "127.0.0.1", port: (upstream.address() as { port: number }).port },
    role: "plugin",
    lockPath,
    hooks: {},
  });

  try {
    await waitFor(() => hubSocket !== undefined);
    const hub = hubSocket as WebSocket;
    hub.send(encodeFrame(FRAME_TYPE.OPEN, 1, jsonPayload({ kind: "http", method: "GET", path: "/plugins/big.js", headers: { host: "127.0.0.1" } })));
    hub.send(encodeFrame(FRAME_TYPE.CLOSE, 1, jsonPayload({ code: 0 })));
    await waitFor(() => (frames.get(1) ?? []).some((f) => f.type === FRAME_TYPE.CLOSE));

    const list = frames.get(1) ?? [];
    const dataFrames = list.filter((f) => f.type === FRAME_TYPE.DATA);
    assert.ok(dataFrames.length > 1, `17 MiB 体必须分片（实际 ${dataFrames.length} 帧）`);
    for (const f of dataFrames) assert.ok(f.payload.length <= 1 << 20, `每帧必须 ≤ 1 MiB（实际 ${f.payload.length}）`);

    const body = Buffer.concat(dataFrames.map((f) => f.payload));
    assert.equal(body.length, 17 * 1024 * 1024 - (TARGET.length - "true".length), "重组字节数 = 原 body 减去补丁缩水");
    assert.ok(body.subarray(0, 32).toString("utf8").includes("var loop = true;"), "分片后补丁必须仍生效");

    const open = list.find((f) => f.type === FRAME_TYPE.OPEN)!;
    const headers = (JSON.parse(open.payload.toString("utf8")) as { headers: Record<string, string> }).headers;
    assert.equal(headers["content-length"], String(body.length), "content-length 必须与实际字节一致");
  } finally {
    await handle.stop();
    await new Promise<void>((r) => wss.close(() => r()));
    await new Promise<void>((r) => upstream.close(() => r()));
  }
});
