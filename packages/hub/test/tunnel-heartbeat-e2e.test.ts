/**
 * 心跳超时 → hub 摘除注册表 + 推送 host.offline（真实 hub 服务端到端）。
 *
 * 覆盖 doc/fix/20260911-heartbeat-pong-timeout 的验收标准第 1 条：
 * 对端静默 ≥ 心跳超时后，hub 侧隧道注册表不再包含该 host（门户据此显示离线）。
 * 时序用毫秒级注入（生产为 30s/10s）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { encodeFrame, FRAME_TYPE, FrameParser, jsonPayload } from "rdsh-tunnel";
import { HubDb } from "../src/db.ts";
import { HubAuth } from "../src/auth.ts";
import { Jwt, randomToken, sha256 } from "../src/jwt.ts";
import { TunnelRegistry } from "../src/tunnel.ts";
import { EventHub } from "../src/events.ts";
import { startHubServer } from "../src/server.ts";
import type { RunningHub } from "../src/server.ts";

interface Fixture {
  server: RunningHub;
  db: HubDb;
  tunnels: TunnelRegistry;
  pushed: { type?: string; hostId?: string }[];
  hostId: string;
  hostToken: string;
  wsUrl: string;
}

async function startFixture(): Promise<Fixture> {
  const db = new HubDb(":memory:");
  const auth = new HubAuth(db, new Jwt(Buffer.from("test-key-0123456789abcdef")));
  const tunnels = new TunnelRegistry();
  const events = new EventHub();
  const pushed: { type?: string; hostId?: string }[] = [];
  const original = events.pushToUser.bind(events);
  events.pushToUser = (userId: number, event: unknown): void => {
    pushed.push(event as { type?: string; hostId?: string });
    original(userId, event);
  };
  const server = await startHubServer({
    host: "127.0.0.1",
    port: 0,
    db,
    auth,
    tunnels,
    events,
    portalDir: "/nonexistent-portal", // 测试不依赖 portal
    // 毫秒级注入：超时 250ms ≫ 心跳 100ms，留出 CI 调度余量（生产为 30s/10s）
    tunnelTimings: { heartbeatMs: 100, pongTimeoutMs: 250 },
  });
  const user = db.createUser("alice", "hash");
  const hostId = "host-hb-e2e";
  const hostToken = randomToken();
  db.createHost(hostId, user.id, "hb-host", sha256(hostToken));
  return { server, db, tunnels, pushed, hostId, hostToken, wsUrl: `ws://127.0.0.1:${server.actualPort}/tunnel` };
}

async function stopFixture(f: Fixture): Promise<void> {
  await new Promise<void>((r) => f.server.server.close(() => r()));
  f.db.close();
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("心跳超时：对端静默 → hub 判死、摘除注册表并推 host.offline", async () => {
  const f = await startFixture();
  const client = new WebSocket(f.wsUrl, { headers: { authorization: `Bearer ${f.hostToken}` } });
  try {
    await new Promise<void>((r) => client.on("open", () => r()));
    await waitFor(() => f.tunnels.isOnline(f.hostId));
    assert.equal(f.tunnels.isOnline(f.hostId), true, "连接后应在注册表中");
    assert.ok(f.pushed.some((e) => e.type === "host.online"), "应推送 host.online");

    // 之后保持静默（不回应 hub 的 PING）→ 应在超时后被判死
    await waitFor(() => !f.tunnels.isOnline(f.hostId));
    assert.equal(f.tunnels.isOnline(f.hostId), false, "超时后应从注册表摘除");
    assert.ok(f.pushed.some((e) => e.type === "host.offline"), "应推送 host.offline");
  } finally {
    try {
      client.terminate();
    } catch {
      /* 已关闭 */
    }
    await stopFixture(f);
  }
});

test("心跳正常：对端回 PONG → hub 保持在线（不误判）", async () => {
  const f = await startFixture();
  const client = new WebSocket(f.wsUrl, { headers: { authorization: `Bearer ${f.hostToken}` } });
  const parser = new FrameParser();
  client.on("message", (data) => {
    const frames = parser.push(Buffer.from(data as ArrayBuffer));
    for (const frame of frames) {
      if (frame.type === FRAME_TYPE.PING) {
        client.send(encodeFrame(FRAME_TYPE.PONG, 0, jsonPayload({ ts: Date.now() })));
      }
    }
  });
  try {
    await waitFor(() => f.tunnels.isOnline(f.hostId));
    // 跨越多个心跳周期（>= 5 × 100ms）：正常应答不应被判离线
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(f.tunnels.isOnline(f.hostId), true, "应答 PONG 后应保持在线");
    assert.equal(f.pushed.some((e) => e.type === "host.offline"), false, "不应推送 host.offline");
  } finally {
    try {
      client.terminate();
    } catch {
      /* 已关闭 */
    }
    await stopFixture(f);
  }
});
