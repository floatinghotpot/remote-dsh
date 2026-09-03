import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { startJoin } from "../src/join.ts";
import { FrameParser, FRAME_TYPE, encodeFrame, jsonPayload, parseJsonPayload } from "rdsh-tunnel";
import type { Frame } from "rdsh-tunnel";
import { GATE_COOKIE } from "../src/access-gate.ts";

async function waitFor(cond: () => boolean, timeoutMs = 3000, what = "condition"): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

interface GateCtx {
  tunnel: WebSocket;
  handle: ReturnType<typeof startJoin>;
  wss: WebSocketServer;
  frames: Frame[];
  /** 发送一帧（jsonPayload 编码 payload）。 */
  send(type: number, streamId: number, payload: unknown): void;
  /** 发送 POST（OPEN + DATA body + CLOSE），用于 gate_code 提交。 */
  sendPost(streamId: number, path: string, body: string, headers?: Record<string, string>): void;
  /** 等待指定 streamId + type + 谓词的响应帧。 */
  waitFrame(streamId: number, type: number, pred: (f: Frame) => boolean, what: string): Promise<Frame>;
}

/** 起 fake hub（WebSocketServer）+ startJoin；返回隧道 socket 与测试句柄。 */
async function setup(accessCode: string | null, name?: string): Promise<GateCtx> {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => wss.on("listening", () => r()));
  const port = (wss.address() as { port: number }).port;
  const lockPath = join(await mkdtemp(join(tmpdir(), "rdsh-join-gate-")), "join.lock");

  const states: string[] = [];
  const tunnelP = new Promise<WebSocket>((resolve) => wss.on("connection", (ws) => resolve(ws)));

  const handle = startJoin({
    hubUrl: `http://127.0.0.1:${port}`,
    token: "t".repeat(43),
    insecure: false,
    target: { host: "127.0.0.1", port: 1 }, // 无监听；gate 放行后触发 UPSTREAM_UNREACHABLE，证明过了 gate
    role: "plugin",
    lockPath,
    gateway: { accessCode },
    name,
    hooks: { onState: (s) => states.push(s) },
  });

  const tunnel = await tunnelP;
  await waitFor(() => states.includes("connected"), 3000, "gateway connected");

  const parser = new FrameParser();
  const frames: Frame[] = [];
  tunnel.on("message", (data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    for (const f of parser.push(buf)) frames.push(f);
  });

  return {
    tunnel,
    handle,
    wss,
    frames,
    send(type, streamId, payload) {
      tunnel.send(encodeFrame(type, streamId, jsonPayload(payload)));
    },
    sendPost(streamId, path, body, headers = { "accept-language": "zh-CN" }) {
      tunnel.send(encodeFrame(FRAME_TYPE.OPEN, streamId, jsonPayload({ kind: "http", method: "POST", path, headers })));
      tunnel.send(encodeFrame(FRAME_TYPE.DATA, streamId, Buffer.from(body, "utf8")));
      tunnel.send(encodeFrame(FRAME_TYPE.CLOSE, streamId, jsonPayload({ code: 0 })));
    },
    async waitFrame(streamId, type, pred, what) {
      let found: Frame | undefined;
      await waitFor(() => {
        found = frames.find((f) => f.streamId === streamId && f.type === type && pred(f));
        return found !== undefined;
      }, 3000, what);
      return found as Frame;
    },
  };
}

test("gate 拦截：无 cookie challenge → ws 403 → 错误 code 提示 → 正确 code 302+cookie → 带 cookie 放行", async () => {
  const ctx = await setup("secret");

  // 1) GET / 无 cookie → challenge 页（HTML 含「受访问密码保护」），非 302
  ctx.send(FRAME_TYPE.OPEN, 1, { kind: "http", method: "GET", path: "/", headers: { "accept-language": "zh-CN" } });
  const chal = await ctx.waitFrame(1, FRAME_TYPE.DATA, (f) => f.payload.toString("utf8").includes("受访问密码保护"), "challenge html");
  assert.ok(chal.payload.toString("utf8").includes("secret") === false, "challenge 不回显 code");
  assert.equal(ctx.frames.some((f) => f.streamId === 1 && f.type === FRAME_TYPE.OPEN && parseJsonPayload(f).status === 302), false);

  // 2) ws 无 cookie → CLOSE 403
  ctx.send(FRAME_TYPE.OPEN, 2, { kind: "ws", path: "/", headers: {} });
  const wsClose = await ctx.waitFrame(2, FRAME_TYPE.CLOSE, () => true, "ws 403 close");
  assert.equal(parseJsonPayload(wsClose).code, 403);

  // 3) POST 错误 code → challenge 错误提示
  ctx.sendPost(3, "/", "gate_code=wrong");
  await ctx.waitFrame(3, FRAME_TYPE.DATA, (f) => f.payload.toString("utf8").includes("访问密码错误"), "wrong code error");

  // 4) POST 正确 code → 302 + Set-Cookie rdsh_gate
  ctx.sendPost(4, "/", "gate_code=secret");
  const ok302 = await ctx.waitFrame(4, FRAME_TYPE.OPEN, (f) => parseJsonPayload(f).status === 302, "302 redirect");
  const hdrs = parseJsonPayload(ok302).headers as Record<string, string>;
  assert.match(hdrs["set-cookie"] ?? "", new RegExp(`${GATE_COOKIE}=`));
  const cookieVal = hdrs["set-cookie"].split(";")[0].split("=").slice(1).join("=");

  // 5) GET / 带有效 cookie → 放行（转发 127.0.0.1:1 → UPSTREAM_UNREACHABLE），非 challenge
  ctx.send(FRAME_TYPE.OPEN, 5, { kind: "http", method: "GET", path: "/", headers: { cookie: `${GATE_COOKIE}=${cookieVal}` } });
  await ctx.waitFrame(5, FRAME_TYPE.ERROR, (f) => parseJsonPayload(f).code === "UPSTREAM_UNREACHABLE", "pass gate → forward");
  assert.equal(ctx.frames.some((f) => f.streamId === 5 && f.type === FRAME_TYPE.DATA && f.payload.toString("utf8").includes("受访问密码保护")), false);

  await ctx.handle.stop();
  ctx.wss.close();
});

test("gate 关闭（accessCode null）→ 不拦截，直接转发", async () => {
  const ctx = await setup(null);
  ctx.send(FRAME_TYPE.OPEN, 1, { kind: "http", method: "GET", path: "/", headers: {} });
  await ctx.waitFrame(1, FRAME_TYPE.ERROR, (f) => parseJsonPayload(f).code === "UPSTREAM_UNREACHABLE", "直接转发");
  assert.equal(ctx.frames.some((f) => f.streamId === 1 && f.type === FRAME_TYPE.DATA && f.payload.toString("utf8").includes("受访问密码保护")), false);
  await ctx.handle.stop();
  ctx.wss.close();
});

test("setAccessCode 运行中切换：off → on → off 即时生效", async () => {
  const ctx = await setup(null);

  // off → 直接转发
  ctx.send(FRAME_TYPE.OPEN, 1, { kind: "http", method: "GET", path: "/", headers: {} });
  await ctx.waitFrame(1, FRAME_TYPE.ERROR, () => true, "off 转发");

  // on → challenge
  ctx.handle.setAccessCode("abcd");
  ctx.send(FRAME_TYPE.OPEN, 2, { kind: "http", method: "GET", path: "/", headers: { "accept-language": "zh-CN" } });
  await ctx.waitFrame(2, FRAME_TYPE.DATA, (f) => f.payload.toString("utf8").includes("受访问密码保护"), "on challenge");

  // off → 直接转发
  ctx.handle.setAccessCode(null);
  ctx.send(FRAME_TYPE.OPEN, 3, { kind: "http", method: "GET", path: "/", headers: {} });
  await ctx.waitFrame(3, FRAME_TYPE.ERROR, () => true, "再 off 转发");

  await ctx.handle.stop();
  ctx.wss.close();
});

test("改 code → 旧 cookie 失效（R3）", async () => {
  const ctx = await setup("abcd");

  // 用 abcd 领 cookie
  ctx.sendPost(1, "/", "gate_code=abcd");
  const ok302 = await ctx.waitFrame(1, FRAME_TYPE.OPEN, (f) => parseJsonPayload(f).status === 302, "302");
  const hdrs = parseJsonPayload(ok302).headers as Record<string, string>;
  const oldCookie = hdrs["set-cookie"].split(";")[0].split("=").slice(1).join("=");

  // 改 code → 旧 cookie 失效：带旧 cookie 访问被 challenge（非转发）
  ctx.handle.setAccessCode("wxyz");
  ctx.send(FRAME_TYPE.OPEN, 2, { kind: "http", method: "GET", path: "/", headers: { cookie: `${GATE_COOKIE}=${oldCookie}`, "accept-language": "zh-CN" } });
  await ctx.waitFrame(2, FRAME_TYPE.DATA, (f) => f.payload.toString("utf8").includes("受访问密码保护"), "旧 cookie 被拒");
  assert.equal(ctx.frames.some((f) => f.streamId === 2 && f.type === FRAME_TYPE.ERROR), false);

  await ctx.handle.stop();
  ctx.wss.close();
});

test("连续 10 次错误 code → 锁定（后续正确 code 也被拒）", async () => {
  const ctx = await setup("secret");
  // 10 次错误 → 每次回 challenge「访问密码错误」
  for (let i = 1; i <= 10; i++) {
    ctx.sendPost(i, "/", "gate_code=wrong");
    await ctx.waitFrame(i, FRAME_TYPE.DATA, (f) => f.payload.toString("utf8").includes("访问密码错误"), `第 ${i} 次错误`);
  }
  // 第 11 次：正确 code 也因锁定被拒
  ctx.sendPost(11, "/", "gate_code=secret");
  await ctx.waitFrame(11, FRAME_TYPE.DATA, (f) => f.payload.toString("utf8").includes("尝试次数过多"), "锁定提示");

  await ctx.handle.stop();
  ctx.wss.close();
});

test("challenge 页 i18n：含 zh → 中文；非 zh/缺 header → 英文兜底（含错误提示）", async () => {
  const ctx = await setup("secret");

  // en → 英文 challenge 页（不回中文）
  ctx.send(FRAME_TYPE.OPEN, 1, { kind: "http", method: "GET", path: "/", headers: { "accept-language": "en-US,en;q=0.9" } });
  const en = await ctx.waitFrame(1, FRAME_TYPE.DATA, (f) => f.payload.toString("utf8").includes("protected by an access code"), "英文 challenge");
  assert.equal(en.payload.toString("utf8").includes("受访问密码保护"), false);

  // en → 英文错误提示
  ctx.sendPost(2, "/", "gate_code=wrong", { "accept-language": "en-US,en;q=0.9" });
  await ctx.waitFrame(2, FRAME_TYPE.DATA, (f) => f.payload.toString("utf8").includes("Incorrect access code"), "英文错误提示");

  // 缺 header → 英文兜底
  ctx.send(FRAME_TYPE.OPEN, 3, { kind: "http", method: "GET", path: "/", headers: {} });
  await ctx.waitFrame(3, FRAME_TYPE.DATA, (f) => f.payload.toString("utf8").includes("protected by an access code"), "缺 header 英文兜底");

  await ctx.handle.stop();
  ctx.wss.close();
});

test("challenge 页 hostName/actionPath HTML 转义（防注入）", async () => {
  const ctx = await setup("secret", '"><script>alert(1)</script>');
  // 直接发原始（未 percent-encode）特殊字符 path —— 验证 gateway 侧纵深防御转义
  ctx.send(FRAME_TYPE.OPEN, 1, { kind: "http", method: "GET", path: '/x"><img src=x onerror=alert(1)>', headers: { "accept-language": "zh-CN" } });
  const chal = await ctx.waitFrame(1, FRAME_TYPE.DATA, () => true, "challenge html");
  const html = chal.payload.toString("utf8");
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "hostName 被转义");
  assert.ok(html.includes('action="/x&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"'), "actionPath 被转义");
  assert.equal(html.includes("<script>alert(1)</script>"), false, "无原始 script 标签");
  await ctx.handle.stop();
  ctx.wss.close();
});
