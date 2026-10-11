/**
 * 老 gateway 兼容（30-relay-node 动态分配的 307 能力门控）。
 *
 * 背景：hub 对在线 relay 节点会把 host 的 /tunnel 升级 307 到节点；只有 2026-10-11
 * 之后的 gateway 能跟随 307。老 gateway 拿到 307 只会 terminate + 重连循环。
 * 故 gateway 在握手带 `x-rdsh-relay-follow: 1` 声明能力，hub 仅对带此头的连接做节点分配；
 * 老 gateway（无此头）直接兜底直连。
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

async function startFixture(): Promise<{ server: RunningHub; db: HubDb; hostToken: string; wsUrl: string }> {
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
  const user = db.createUser("alice", "hash");
  const hostId = "host-relay-follow";
  const hostToken = randomToken();
  db.createHost(hostId, user.id, "relay-follow-host", sha256(hostToken));
  // 一个在线节点（capacity=0 无限容量，pickNode 恒命中）
  db.createNode("node-relay-follow", "relay-01", "https://relay-01.example.com", sha256(randomToken()), "", 0, 100);
  return { server, db, hostToken, wsUrl: `ws://127.0.0.1:${server.actualPort}/tunnel` };
}

async function stopFixture(f: { server: RunningHub; db: HubDb }): Promise<void> {
  await new Promise<void>((r) => f.server.server.close(() => r()));
  f.db.close();
}

/** 连 /tunnel，返回握手结果：101=升级成功直连，307=被重定向到节点。 */
function upgradeStatus(wsUrl: string, hostToken: string, follow: boolean): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const headers: Record<string, string> = { authorization: `Bearer ${hostToken}` };
    if (follow) headers["x-rdsh-relay-follow"] = "1";
    const ws = new WebSocket(wsUrl, { headers });
    ws.on("unexpected-response", (_req, res) => {
      const code = res.statusCode ?? 0;
      res.resume();
      resolve(code);
    });
    ws.on("open", () => {
      ws.close();
      resolve(101);
    });
    ws.on("error", reject);
    setTimeout(() => reject(new Error("upgrade timeout")), 3000).unref();
  });
}

test("带 x-rdsh-relay-follow: 1 → 307 到在线节点", async () => {
  const f = await startFixture();
  try {
    const status = await upgradeStatus(f.wsUrl, f.hostToken, true);
    assert.equal(status, 307, "带能力头的连接应被 307 到节点");
  } finally {
    await stopFixture(f);
  }
});

test("不带 x-rdsh-relay-follow → 直接兜底直连（不 307）", async () => {
  const f = await startFixture();
  try {
    const status = await upgradeStatus(f.wsUrl, f.hostToken, false);
    assert.equal(status, 101, "老 gateway（无能力头）应直连成功，而不是拿到 307");
  } finally {
    await stopFixture(f);
  }
});
