/**
 * 超大 WS 帧不得打死 hub（远程 DoS 回归）。
 *
 * 2026-09-14 真机：E2EE 下上传 18 MiB 附件 → DSH 页面走 RPC + base64 ⇒ 单条
 * **25,007,697 B** 的浏览器 WS 消息（/e2e raw 流）→ hub `encodeFrame` 抛
 * `ProtocolError: payload too large: 25007697 > 16777216`，且抛点在 ws 的 message
 * 回调里未被捕获 ⇒ **hub 进程直接退出**（日志栈：`relay.js sendRawData`），
 * 之后全体租户 `ERR_CONNECTION_REFUSED`。
 *
 * 本用例断言：超限消息只导致**该连接以 1009 关闭 + 该流被中止**，hub 仍在同一进程内服务。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { WebSocket } from "ws";
import { MAX_PAYLOAD_LENGTH, FrameParser, FRAME_TYPE } from "rdsh-tunnel";
import { HubDb } from "../src/db.ts";
import { HubAuth } from "../src/auth.ts";
import { Jwt, randomToken, sha256 } from "../src/jwt.ts";
import { TunnelRegistry } from "../src/tunnel.ts";
import { EventHub } from "../src/events.ts";
import { startHubServer } from "../src/server.ts";
import type { RunningHub } from "../src/server.ts";

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
  return true;
}

interface Fixture {
  port: number;
  server: RunningHub;
  db: HubDb;
  hostId: string;
  auth: HubAuth;
  userId: number;
  /** 假 host 收到的隧道帧（按到达顺序）。 */
  frames: number[];
  hostWs: WebSocket;
  clients: WebSocket[];
}

async function startFixture(tag: string): Promise<Fixture> {
  const db = new HubDb(":memory:");
  const auth = new HubAuth(db, new Jwt(Buffer.from("test-key-0123456789abcdef")));
  const tunnels = new TunnelRegistry();
  const events = new EventHub();
  const server = await startHubServer({
    host: "127.0.0.1",
    port: 0,
    db,
    auth,
    tunnels,
    events,
    portalDir: "/nonexistent-portal",
  });
  const port = server.actualPort;
  const user = db.createUser(`u-${tag}`, "hash");
  const hostId = `host-${tag}`;
  const hostToken = randomToken();
  db.createHost(hostId, user.id, tag, sha256(hostToken));

  const frames: number[] = [];
  const hostWs = new WebSocket(`ws://127.0.0.1:${port}/tunnel`, { headers: { authorization: `Bearer ${hostToken}` } });
  const parser = new FrameParser();
  hostWs.on("message", (data) => {
    for (const f of parser.push(Buffer.from(data as ArrayBuffer))) frames.push(f.type);
  });
  await new Promise<void>((resolve, reject) => {
    hostWs.on("open", () => resolve());
    hostWs.on("error", reject);
  });
  assert.equal(await waitFor(() => tunnels.isOnline(hostId)), true, "假 host 应已注册到注册表");
  return { port, server, db, hostId, auth, userId: user.id, frames, hostWs, clients: [] };
}

/** 浏览器侧连 /e2e（E2EE raw 流），带合法 host cookie。 */
async function openRawClient(f: Fixture): Promise<WebSocket> {
  const cookie = f.auth.signHostCookie(f.hostId, f.userId);
  const client = new WebSocket(`ws://127.0.0.1:${f.port}/e2e`, { headers: { cookie: `rdsh_host=${cookie}` } });
  f.clients.push(client);
  await new Promise<void>((resolve, reject) => {
    client.on("open", () => resolve());
    client.on("error", reject);
  });
  return client;
}

async function stopFixture(f: Fixture): Promise<void> {
  for (const c of f.clients) {
    try {
      c.terminate();
    } catch {
      /* 已关闭 */
    }
  }
  try {
    f.hostWs.terminate();
  } catch {
    /* 已关闭 */
  }
  // 先切断 keep-alive socket，否则 server.close() 会等连接释放而挂住
  (f.server.server as Server).closeAllConnections?.();
  await new Promise<void>((resolve) => f.server.server.close(() => resolve()));
  f.db.close();
}

test("超过隧道单帧上限的浏览器 WS 消息：只关闭该连接，hub 存活", async () => {
  const f = await startFixture("oversize");
  try {
    const client = await openRawClient(f);
    assert.equal(await waitFor(() => f.frames.includes(FRAME_TYPE.OPEN)), true, "raw 流应以 OPEN 帧开流");

    const closed = new Promise<number>((resolve) => client.on("close", (code) => resolve(code)));
    client.send(Buffer.alloc(MAX_PAYLOAD_LENGTH + 4096));
    const code = await Promise.race([closed, new Promise<number>((r) => setTimeout(() => r(-1), 5000))]);
    assert.equal(code, 1009, `超限消息应以 1009（message too big）关闭该连接，实际 ${code}`);

    assert.equal(await waitFor(() => f.frames.includes(FRAME_TYPE.CLOSE)), true, "超限流应被 abortStream（host 侧收到 CLOSE）");

    // hub 仍在同一进程内服务（若异常逃逸，本测试进程早已退出）
    const res = await fetch(`http://127.0.0.1:${f.port}/api/admin/me`, { headers: { connection: "close" } });
    assert.equal(res.status, 401, "hub 应仍在服务（未登录访问管理接口 → 401）");
  } finally {
    await stopFixture(f);
  }
});

test("上限内的浏览器 WS 消息仍被原样转发（上限不误伤）", async () => {
  const f = await startFixture("oversize-ok");
  try {
    const client = await openRawClient(f);
    client.send(Buffer.alloc(1024 * 1024, 7));
    assert.equal(await waitFor(() => f.frames.includes(FRAME_TYPE.DATA)), true, "上限内的消息应被转发为 DATA 帧");
    assert.equal(client.readyState, WebSocket.OPEN, "转发后连接应保持打开");
  } finally {
    await stopFixture(f);
  }
});
