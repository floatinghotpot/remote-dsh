/**
 * internal-hosts.test.ts — 50-hub-host-invite：内部 host invite 端点（服务令牌 + scope + 签发）。
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

async function boot(): Promise<{ db: HubDb; server: RunningHub; base: string; svcToken: string }> {
  const db = new HubDb(":memory:");
  const auth = new HubAuth(createSqliteStore(db), (id) => db.getUserById(id), new Jwt(Buffer.from("test-key-0123456789abcdef")));
  const server = await startHubServer({
    host: "127.0.0.1", port: 0, db, auth, tunnels: new TunnelRegistry(), events: new EventHub(), portalDir: "/nonexistent-portal",
  });
  const svcToken = `svc-${randomToken()}`;
  db.createServiceToken("svc-invite", "invite", sha256(svcToken), "host:invite");
  return { db, server, base: `http://127.0.0.1:${server.actualPort}`, svcToken };
}

async function close(ctx: { db: HubDb; server: RunningHub }): Promise<void> {
  await new Promise<void>((r) => ctx.server.server.close(() => r()));
  ctx.db.close();
}

test("host invite：错误 scope → 401", async () => {
  const ctx = await boot();
  try {
    const wrong = `svc-${randomToken()}`;
    ctx.db.createServiceToken("svc-other", "other", sha256(wrong), "host:revoke");
    const res = await fetch(`${ctx.base}/api/internal/hosts/invite`, {
      method: "POST",
      headers: { authorization: `Bearer ${wrong}`, "content-type": "application/json" },
      body: JSON.stringify({ userId: 1 }),
    });
    assert.equal(res.status, 401);
  } finally {
    await close(ctx);
  }
});

test("host invite：签发成功，label 缺省填时间戳", async () => {
  const ctx = await boot();
  try {
    const uid = ctx.db.createUser("alice", "hash").id;
    const res = await fetch(`${ctx.base}/api/internal/hosts/invite`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.svcToken}`, "content-type": "application/json" },
      body: JSON.stringify({ userId: uid }),
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { id: string; token: string; expiresAt: number };
    assert.ok(json.token.length >= 16);
    const jt = await ctx.db.getJoinTokenByHash(sha256(json.token));
    assert.equal(jt!.ownerId, uid);
    assert.match(jt!.label!, /^\d{14}$/, "default label should be YYYYMMDDHHmmss");
  } finally {
    await close(ctx);
  }
});

test("host invite：显式 label 原样保存", async () => {
  const ctx = await boot();
  try {
    const uid = ctx.db.createUser("bob", "hash").id;
    const res = await fetch(`${ctx.base}/api/internal/hosts/invite`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.svcToken}`, "content-type": "application/json" },
      body: JSON.stringify({ userId: uid, label: "agent-01" }),
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { token: string };
    const jt = await ctx.db.getJoinTokenByHash(sha256(json.token));
    assert.equal(jt!.label, "agent-01");
  } finally {
    await close(ctx);
  }
});

test("host invite：ttl 越界 / 用户不存在", async () => {
  const ctx = await boot();
  try {
    const uid = ctx.db.createUser("carol", "hash").id;
    for (const ttl of [0, 3601, -1]) {
      const res = await fetch(`${ctx.base}/api/internal/hosts/invite`, {
        method: "POST",
        headers: { authorization: `Bearer ${ctx.svcToken}`, "content-type": "application/json" },
        body: JSON.stringify({ userId: uid, ttlSeconds: ttl }),
      });
      assert.equal(res.status, 400, `ttl=${ttl} should be 400`);
    }
    const notFound = await fetch(`${ctx.base}/api/internal/hosts/invite`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.svcToken}`, "content-type": "application/json" },
      body: JSON.stringify({ userId: 999999 }),
    });
    assert.equal(notFound.status, 404);
  } finally {
    await close(ctx);
  }
});
