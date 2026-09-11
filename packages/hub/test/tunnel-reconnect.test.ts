/**
 * 重连不摘除新连接：注册表身份校验（hub 侧）。
 *
 * 缺陷背景：`register` 会 terminate 旧连接，旧连接的 close 回调晚于新连接注册才触发。
 * 若 close 回调无条件 `unregister(hostId)`，会把刚接手的新连接一起摘掉 →
 * host 假离线（门户显示离线、relay 取不到 conn → 503），而新隧道其实是活的。
 * 心跳超时判死会主动触发重连，因此该缺陷与心跳改动同域。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
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
    portalDir: "/nonexistent-portal",
  });
  const user = db.createUser("alice", "hash");
  const hostId = "host-reconnect";
  const hostToken = randomToken();
  db.createHost(hostId, user.id, "reconnect-host", sha256(hostToken));
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

function connect(f: Fixture): WebSocket {
  return new WebSocket(f.wsUrl, { headers: { authorization: `Bearer ${f.hostToken}` } });
}

test("重连：旧连接 close 不摘除新连接（host 保持在线、不推 offline）", async () => {
  const f = await startFixture();
  const first = connect(f);
  let second: WebSocket | undefined;
  try {
    await new Promise<void>((r) => first.on("open", () => r()));
    await waitFor(() => f.tunnels.isOnline(f.hostId));

    // 同 token 第二次连接 = 重连（hub 会 terminate 旧连接）
    second = connect(f);
    await new Promise<void>((r) => second?.on("open", () => r()));
    await waitFor(() => f.tunnels.isOnline(f.hostId));

    // 等旧连接 close 回调跑完：新连接必须仍在注册表中且可路由
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(f.tunnels.isOnline(f.hostId), true, "重连后 host 应保持在线");
    assert.notEqual(f.tunnels.get(f.hostId), null, "relay 应仍能取到活跃连接");
    assert.equal(
      f.pushed.some((e) => e.type === "host.offline"),
      false,
      "重连不应推送 host.offline",
    );

    // 收尾：真离线时仍应正常摘除并推送 offline
    second.terminate();
    second = undefined;
    await waitFor(() => !f.tunnels.isOnline(f.hostId));
    assert.ok(f.pushed.some((e) => e.type === "host.offline"), "真离线应推送 host.offline");
  } finally {
    try {
      first.terminate();
      second?.terminate();
    } catch {
      /* 已关闭 */
    }
    await stopFixture(f);
  }
});
