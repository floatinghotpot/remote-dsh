/**
 * llm-provision.test.ts — 52-auto-provision-router：/api/hosts/llm-key 签发 / 重签 / 鉴权。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { HubDb } from "../src/db.ts";
import { HubAuth, hashPassword } from "../src/auth.ts";
import { createSqliteStore } from "../src/store.ts";
import { Jwt, randomToken, sha256 } from "../src/jwt.ts";
import { TunnelRegistry } from "../src/tunnel.ts";
import { EventHub } from "../src/events.ts";
import { startHubServer, type RunningHub } from "../src/server.ts";

async function boot(): Promise<{ db: HubDb; server: RunningHub; base: string }> {
  const db = new HubDb(":memory:");
  const auth = new HubAuth(createSqliteStore(db), (id) => db.getUserById(id), new Jwt(Buffer.from("test-key-0123456789abcdef")));
  const server = await startHubServer({
    host: "127.0.0.1", port: 0, db, auth, tunnels: new TunnelRegistry(), events: new EventHub(), portalDir: "/nonexistent-portal",
  });
  return { db, server, base: `http://127.0.0.1:${server.actualPort}` };
}

async function post(base: string, path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test("52：/api/hosts/llm-key 签发 + 重签 + 鉴权", async () => {
  const ctx = await boot();
  try {
    const owner = ctx.db.createUser("owner", await hashPassword("pw"));
    const hostToken = randomToken();
    ctx.db.createHost("h1", owner.id, "host-1", sha256(hostToken));

    const rid = randomUUID();
    ctx.db.createLlmRouter(rid, "router-1", "dummy-token", null, "https://llm.rdsh.cn");
    ctx.db.setLlmRouterStatus(rid, "active", "test");

    // 1) 签发
    const r1 = await post(ctx.base, "/api/hosts/llm-key", { token: hostToken });
    assert.equal(r1.status, 200);
    assert.ok(typeof r1.body.key === "string" && (r1.body.key as string).startsWith("sk-rdsh-"));
    assert.equal(r1.body.baseURL, "https://llm.rdsh.cn");
    assert.deepEqual((r1.body.models as Array<{ id: string }>).map((m) => m.id), ["deepseek-flash", "deepseek-v4-pro"]);

    const keys1 = ctx.db.listLlmKeysByUser(owner.id);
    assert.equal(keys1.length, 1);
    assert.equal(keys1[0]!.hostId, "h1");

    // 2) 重签：旧 key 吊销，只剩一把 active
    const r2 = await post(ctx.base, "/api/hosts/llm-key", { token: hostToken });
    assert.equal(r2.status, 200);
    assert.notEqual(r2.body.key, r1.body.key);
    const keys2 = ctx.db.listLlmKeysByUser(owner.id);
    assert.equal(keys2.filter((k) => k.status === "active").length, 1);

    // 3) 无效 host token → 401
    const r3 = await post(ctx.base, "/api/hosts/llm-key", { token: "wrong-token-12345678" });
    assert.equal(r3.status, 401);

    // 4) 无 active router → baseURL 空串但 key 仍签发
    ctx.db.setLlmRouterStatus(rid, "revoked", "test");
    const r4 = await post(ctx.base, "/api/hosts/llm-key", { token: hostToken });
    assert.equal(r4.status, 200);
    assert.equal(r4.body.baseURL, "");
  } finally {
    await new Promise<void>((r) => ctx.server.server.close(() => r()));
    ctx.db.close();
  }
});
