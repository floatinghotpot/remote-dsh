/**
 * rdsh WebView API 适配脚本的**落地**验证（集成，进程内）——feature 22。
 *
 * 用真实 `startJoin` + 假 hub + 假上游，覆盖 join 隧道路径的 HTML 注入：
 * - text/html（无 content-encoding）→ 注入 `window.__rdshWebViewApi`，重算 content-length；
 * - text/html + gzip → **跳过**注入（原样透传，不损坏压缩体）；
 * - 非 HTML（JSON）→ 保持流式原样透传。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { gzipSync } from "node:zlib";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { encodeFrame, FRAME_TYPE, FrameParser, jsonPayload } from "rdsh-tunnel";
import type { Frame } from "rdsh-tunnel";
import { startJoin } from "../src/join.ts";

const HTML = `<!doctype html><html><head><title>t</title></head><body><div id="root"></div></body></html>`;

async function startUpstream(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    if (url.startsWith("/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(HTML);
      return;
    }
    if (url.startsWith("/gzip.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-encoding": "gzip" });
      res.end(gzipSync(Buffer.from(HTML)));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
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

test("join：text/html 注入契约并重算 content-length；gzip/JSON 原样透传", async () => {
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

  const lockPath = join(await mkdtemp(join(tmpdir(), "rdsh-html-inject-")), "join.lock");
  const handle = startJoin({
    hubUrl: `http://127.0.0.1:${hubPort}`,
    token: "t".repeat(43),
    insecure: false,
    target: { host: "127.0.0.1", port: upstream.port },
    role: "plugin",
    lockPath,
    hooks: {},
  });

  async function get(streamId: number, path: string): Promise<Got> {
    hubSocket!.send(
      encodeFrame(FRAME_TYPE.OPEN, streamId, jsonPayload({ kind: "http", method: "GET", path, headers: { host: "127.0.0.1" } })),
    );
    hubSocket!.send(encodeFrame(FRAME_TYPE.CLOSE, streamId, jsonPayload({ code: 0 })));
    await waitFor(() => (frames.get(streamId) ?? []).some((f) => f.type === FRAME_TYPE.CLOSE));
    const list = frames.get(streamId) ?? [];
    const open = list.find((f) => f.type === FRAME_TYPE.OPEN);
    assert.ok(open !== undefined, "应收到 OPEN 帧");
    const headers = (JSON.parse(open.payload.toString("utf8")) as { headers: Record<string, string> }).headers;
    const body = Buffer.concat(list.filter((f) => f.type === FRAME_TYPE.DATA).map((f) => f.payload));
    return { headers, body };
  }

  try {
    await waitFor(() => hubSocket !== undefined);

    // 1) text/html → 注入
    const html = await get(1, "/index.html");
    assert.ok(html.body.toString("utf8").includes("window.__rdshWebViewApi"), "HTML 应含注入的契约脚本");
    assert.equal(
      Number(html.headers["content-length"]),
      html.body.length,
      "注入后 content-length 必须等于实际字节数",
    );

    // 2) text/html + gzip → 跳过注入（原样透传）
    const gz = await get(2, "/gzip.html");
    assert.ok(!gz.body.toString("utf8").includes("window.__rdshWebViewApi"), "gzip HTML 不得注入（避免损坏压缩体）");

    // 3) JSON → 原样透传
    const json = await get(3, "/api/x");
    assert.equal(json.body.toString("utf8"), '{"ok":true}');
    assert.ok(!json.body.toString("utf8").includes("window.__rdshWebViewApi"), "JSON 不得注入");
  } finally {
    await handle.stop();
    await new Promise<void>((r) => wss.close(() => r()));
    await new Promise<void>((r) => upstream.server.close(() => r()));
  }
});
