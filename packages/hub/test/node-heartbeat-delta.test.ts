/**
 * 70 A4：N2 心跳增量（seq / full / added / removed / gap → needFull）HTTP 级回归。
 *
 * 直接打 /api/nodes/heartbeat，断言 presence 结果与 needFull 响应。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { HubDb } from "../src/db.ts";
import { HubAuth } from "../src/auth.ts";
import { createSqliteStore } from "../src/store.ts";
import { Jwt, randomToken, sha256 } from "../src/jwt.ts";
import { TunnelRegistry } from "../src/tunnel.ts";
import { EventHub } from "../src/events.ts";
import { startHubServer } from "../src/server.ts";
import type { RunningHub } from "../src/server.ts";

interface Fixture {
  server: RunningHub;
  db: HubDb;
  nodeToken: string;
  base: string;
}

async function startFixture(): Promise<Fixture> {
  const db = new HubDb(":memory:");
  const auth = new HubAuth(createSqliteStore(db), (id) => db.getUserById(id), new Jwt(Buffer.from("test-key-0123456789abcdef")));
  const server = await startHubServer({
    host: "127.0.0.1",
    port: 0,
    db,
    auth,
    tunnels: new TunnelRegistry(),
    events: new EventHub(),
    portalDir: "/nonexistent-portal",
  });
  const user = db.createUser("alice", "hash");
  const nodeToken = randomToken();
  const nodeId = "node-delta";
  db.createNode(nodeId, "relay-01", "https://relay-01.example.com", sha256(nodeToken), "", 0, 100, true, null);
  for (const hid of ["h1", "h2", "h3"]) {
    db.createHost(hid, user.id, hid, sha256(randomToken()));
    db.setHostNode(hid, nodeId); // 归属该节点，通过增量归属校验
  }
  return { server, db, nodeToken, base: `http://127.0.0.1:${server.actualPort}` };
}

async function stopFixture(f: Fixture): Promise<void> {
  await new Promise<void>((r) => f.server.server.close(() => r()));
  f.db.close();
}

async function heartbeat(base: string, nodeToken: string, body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}/api/nodes/heartbeat`, {
    method: "POST",
    headers: { authorization: `Bearer ${nodeToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

test("N2 全量：以 hosts 替换 presence，未上报主机下线", async () => {
  const f = await startFixture();
  try {
    const r = await heartbeat(f.base, f.nodeToken, { seq: 1, full: true, hosts: ["h1", "h2"] });
    assert.equal(r.status, 200);
    assert.equal(r.json.needFull, undefined);
    assert.equal(f.server.presence.isOnline("h1"), true);
    assert.equal(f.server.presence.isOnline("h2"), true);
    assert.equal(f.server.presence.isOnline("h3"), false, "h3 未在全量里 → 下线");
  } finally {
    await stopFixture(f);
  }
});

test("N2 增量：连续 seq 应用 added/removed", async () => {
  const f = await startFixture();
  try {
    await heartbeat(f.base, f.nodeToken, { seq: 1, full: true, hosts: ["h1", "h2"] });
    const r = await heartbeat(f.base, f.nodeToken, { seq: 2, added: ["h3"], removed: ["h1"] });
    assert.equal(r.status, 200);
    assert.equal(r.json.needFull, undefined);
    assert.equal(f.server.presence.isOnline("h1"), false);
    assert.equal(f.server.presence.isOnline("h2"), true);
    assert.equal(f.server.presence.isOnline("h3"), true);
  } finally {
    await stopFixture(f);
  }
});

test("N2 gap：seq 跳变 → needFull 且不应用增量", async () => {
  const f = await startFixture();
  try {
    await heartbeat(f.base, f.nodeToken, { seq: 1, full: true, hosts: ["h1"] });
    const r = await heartbeat(f.base, f.nodeToken, { seq: 5, added: ["h2"] });
    assert.equal(r.status, 200);
    assert.equal(r.json.needFull, true);
    assert.equal(f.server.presence.isOnline("h2"), false, "gap 不应用 → h2 仍未上线");
  } finally {
    await stopFixture(f);
  }
});

test("N2 兼容：无 seq 的旧 relay → 按 full 处理", async () => {
  const f = await startFixture();
  try {
    const r = await heartbeat(f.base, f.nodeToken, { hosts: ["h1"] });
    assert.equal(r.status, 200);
    assert.equal(r.json.needFull, undefined);
    assert.equal(f.server.presence.isOnline("h1"), true);
  } finally {
    await stopFixture(f);
  }
});

test("N2 超限：body > 4 MiB → 413 且节点仍判活", async () => {
  const f = await startFixture();
  try {
    // 用 UUID 长度（36 字符）的 hostId 撑到 > 4 MiB（200k × ~39B ≈ 7.8 MiB）
    const big = { seq: 1, full: true, hosts: Array.from({ length: 200_000 }, (_, i) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`) };
    const r = await heartbeat(f.base, f.nodeToken, big);
    assert.equal(r.status, 413);
    assert.equal(f.db.getNodeById("node-delta")?.status, "online", "超限心跳仍应把节点判活");
  } finally {
    await stopFixture(f);
  }
});
