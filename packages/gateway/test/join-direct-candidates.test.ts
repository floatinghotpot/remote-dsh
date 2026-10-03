/**
 * join-direct-candidates.test.ts — 直连候选端点必须同时对 **plain 与 raw** 两条路径提供。
 *
 * 背景（2026-10-04 真机）：plain 页同样被注入了直连 bootstrap 脚本（`pageAuthorizeScript`，
 * 见 plainDispatcher 的 htmlInject），但该端点原先只写在 `rawGate` 块内 —— 而 plain dispatcher
 * 不传 `rawGate`，整块被跳过 ⇒ plain 页里的 `fetch("/__rdsh/direct-candidates")` 被转发给
 * `dsh web` → 404 ⇒ `window.__rdshDirectInfo` 永不赋值，app 打出
 * `[rdsh] direct: no __rdshDirectInfo (bootstrap not ready?)`。
 *
 * 本测试锁住两件事：① plain 路径能取到候选；② 它仍在**口令校验之后**（不泄露内网地址、不未授权签票）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { startJoin } from "../src/join.ts";
import { GATE_COOKIE, signGateCookie } from "../src/access-gate.ts";
import { FrameParser, FRAME_TYPE, encodeFrame, jsonPayload, parseJsonPayload } from "rdsh-tunnel";
import type { Frame } from "rdsh-tunnel";

const CANDIDATES = [{ host: "10.0.0.5", port: 8442 }];
const TICKET = "test-ticket";

async function waitFor(cond: () => boolean, timeoutMs = 3000, what = "condition"): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

interface Ctx {
  handle: ReturnType<typeof startJoin>;
  frames: Frame[];
  wss: WebSocketServer;
  send(type: number, streamId: number, payload: unknown): void;
  waitFrame(streamId: number, type: number, pred: (f: Frame) => boolean, what: string): Promise<Frame>;
  /** 该 streamId 上收到的所有 DATA 拼成的响应体（合成响应不做 chunked 分帧）。 */
  body(streamId: number): string;
  close(): Promise<void>;
}

async function setup(accessCode: string | null): Promise<Ctx> {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => wss.on("listening", () => r()));
  const port = (wss.address() as { port: number }).port;
  const tunnelP = new Promise<WebSocket>((resolve) => wss.on("connection", (ws) => resolve(ws)));
  const dir = await mkdtemp(join(tmpdir(), "rdsh-direct-cand-"));

  const handle = startJoin({
    hubUrl: `http://127.0.0.1:${port}`,
    token: "t".repeat(43),
    insecure: false,
    // 无监听的 target：若请求被错误地转发给 dsh，会以 UPSTREAM_UNREACHABLE 收场而非 200 JSON
    target: { host: "127.0.0.1", port: 1 },
    role: "plugin",
    lockPath: join(dir, "join.lock"),
    e2eeKeyDir: dir,
    gateway: { accessCode },
    direct: { candidates: () => CANDIDATES, mintTicket: () => TICKET },
  });

  const tunnel = await tunnelP;
  const parser = new FrameParser();
  const frames: Frame[] = [];
  tunnel.on("message", (data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    for (const f of parser.push(buf)) frames.push(f);
  });

  return {
    handle,
    frames,
    wss,
    send(type, streamId, payload) {
      tunnel.send(encodeFrame(type, streamId, jsonPayload(payload)));
    },
    async waitFrame(streamId, type, pred, what) {
      let found: Frame | undefined;
      await waitFor(() => {
        found = frames.find((f) => f.streamId === streamId && f.type === type && pred(f));
        return found !== undefined;
      }, 3000, what);
      return found as Frame;
    },
    body(streamId) {
      return frames
        .filter((f) => f.streamId === streamId && f.type === FRAME_TYPE.DATA)
        .map((f) => f.payload.toString("utf8"))
        .join("");
    },
    async close() {
      handle.stop();
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
    },
  };
}

function httpGet(ctx: Ctx, streamId: number, path: string, headers: Record<string, string> = {}): void {
  ctx.send(FRAME_TYPE.OPEN, streamId, { kind: "http", method: "GET", path, headers });
}

test("plain 路径（未设口令）：候选端点由网关直接应答，不再被转发给 dsh（转发即 404）", async () => {
  const ctx = await setup(null);
  try {
    httpGet(ctx, 1, "/__rdsh/direct-candidates");
    const open = await ctx.waitFrame(1, FRAME_TYPE.OPEN, () => true, "候选响应头");
    assert.equal((parseJsonPayload(open) as { status?: number }).status, 200, "必须是网关的合成 200");
    await ctx.waitFrame(1, FRAME_TYPE.CLOSE, () => true, "候选响应结束");
    assert.deepEqual(JSON.parse(ctx.body(1)), { candidates: CANDIDATES, ticket: TICKET });
  } finally {
    await ctx.close();
  }
});

test("plain 路径（设了口令，未带 cookie）：候选端点仍必须在口令之后 —— 走 challenge，不泄露地址/票", async () => {
  const ctx = await setup("secret");
  try {
    httpGet(ctx, 1, "/__rdsh/direct-candidates", { "accept-language": "zh-CN" });
    const open = await ctx.waitFrame(1, FRAME_TYPE.OPEN, () => true, "响应头");
    // 语言无关的判据：拿到的是 challenge 页（text/html），而不是候选端点的 JSON
    const headers = (parseJsonPayload(open) as { headers?: Record<string, string> }).headers ?? {};
    assert.match(headers["content-type"] ?? "", /text\/html/, "未授权必须拿到 challenge 页");
    await ctx.waitFrame(
      1,
      FRAME_TYPE.DATA,
      (f) => f.payload.toString("utf8").includes("受访问密码保护"),
      "口令 challenge",
    );
    const body = ctx.body(1);
    assert.equal(body.includes("10.0.0.5"), false, "不得泄露候选内网地址");
    assert.equal(body.includes(TICKET), false, "不得在未授权时签发直连票");
  } finally {
    await ctx.close();
  }
});

test("plain 路径（设了口令，带正确 cookie）：能取到候选", async () => {
  const ctx = await setup("secret");
  try {
    httpGet(ctx, 1, "/__rdsh/direct-candidates", {
      cookie: `${GATE_COOKIE}=${signGateCookie("secret").value}`,
    });
    const open = await ctx.waitFrame(1, FRAME_TYPE.OPEN, () => true, "候选响应头");
    assert.equal((parseJsonPayload(open) as { status?: number }).status, 200);
    await ctx.waitFrame(1, FRAME_TYPE.CLOSE, () => true, "候选响应结束");
    assert.deepEqual(JSON.parse(ctx.body(1)), { candidates: CANDIDATES, ticket: TICKET });
  } finally {
    await ctx.close();
  }
});
