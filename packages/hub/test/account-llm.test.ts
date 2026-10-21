/**
 * account-llm.test.ts — 用户自助 LLM API key（创建一次性显示 / 列表 / 吊销 / 跨用户隔离）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { HubDb } from "../src/db.ts";
import { HubAuth, hashPassword } from "../src/auth.ts";
import { createSqliteStore } from "../src/store.ts";
import { Jwt, randomToken, sha256 } from "../src/jwt.ts";
import { TunnelRegistry } from "../src/tunnel.ts";
import { EventHub } from "../src/events.ts";
import { startHubServer } from "../src/server.ts";
import type { RunningHub } from "../src/server.ts";

async function boot(): Promise<{ db: HubDb; server: RunningHub; base: string }> {
  const db = new HubDb(":memory:");
  const auth = new HubAuth(createSqliteStore(db), (id) => db.getUserById(id), new Jwt(Buffer.from("test-key-0123456789abcdef")));
  const server = await startHubServer({
    host: "127.0.0.1", port: 0, db, auth, tunnels: new TunnelRegistry(), events: new EventHub(), portalDir: "/nonexistent-portal",
  });
  return { db, server, base: `http://127.0.0.1:${server.actualPort}` };
}

async function close(ctx: { db: HubDb; server: RunningHub }): Promise<void> {
  await new Promise<void>((r) => ctx.server.server.close(() => r()));
  ctx.db.close();
}

async function makeUser(db: HubDb, name: string): Promise<{ id: number; token: string }> {
  const id = db.createUser(name, await hashPassword("pw123456")).id;
  return { id, token: "" };
}

async function login(base: string, name: string, password: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, password }),
  });
  assert.equal(res.status, 200);
  const json = (await res.json()) as { accessToken: string };
  return json.accessToken;
}

test("用户自助 key：创建一次性显示 → 列表不含 token → 吊销", async () => {
  const ctx = await boot();
  try {
    await makeUser(ctx.db, "alice");
    const at = await login(ctx.base, "alice", "pw123456");

    const created = await fetch(`${ctx.base}/api/account/llm/keys`, {
      method: "POST",
      headers: { authorization: `Bearer ${at}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "my-dsh" }),
    });
    assert.equal(created.status, 200);
    const cj = (await created.json()) as { keyId: string; token: string; name: string };
    assert.match(cj.token, /^sk-rdsh-/);
    assert.equal(cj.name, "my-dsh");

    const list = await fetch(`${ctx.base}/api/account/llm/keys`, {
      headers: { authorization: `Bearer ${at}` },
    });
    assert.equal(list.status, 200);
    const lj = (await list.json()) as { keys: Array<Record<string, unknown>> };
    assert.equal(lj.keys.length, 1);
    assert.equal(lj.keys[0]!.id, cj.keyId);
    assert.equal("token" in lj.keys[0]!, false, "list must never expose token");

    const revoke = await fetch(`${ctx.base}/api/account/llm/keys/${cj.keyId}/revoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${at}` },
    });
    assert.equal(revoke.status, 200);
    const rj = (await revoke.json()) as { ok: boolean };
    assert.equal(rj.ok, true);
  } finally {
    await close(ctx);
  }
});

test("跨用户隔离：不能看/吊销别人的 key", async () => {
  const ctx = await boot();
  try {
    await makeUser(ctx.db, "alice");
    await makeUser(ctx.db, "bob");
    const at = await login(ctx.base, "alice", "pw123456");
    const bt = await login(ctx.base, "bob", "pw123456");

    const created = await fetch(`${ctx.base}/api/account/llm/keys`, {
      method: "POST",
      headers: { authorization: `Bearer ${at}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "alice-key" }),
    });
    const cj = (await created.json()) as { keyId: string };

    // bob 看不到 alice 的 key
    const bobList = await fetch(`${ctx.base}/api/account/llm/keys`, { headers: { authorization: `Bearer ${bt}` } });
    const bl = (await bobList.json()) as { keys: unknown[] };
    assert.equal(bl.keys.length, 0);

    // bob 吊销 alice 的 key → 404
    const bobRevoke = await fetch(`${ctx.base}/api/account/llm/keys/${cj.keyId}/revoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${bt}` },
    });
    assert.equal(bobRevoke.status, 404);

    // alice 的 key 仍在
    const aliceList = await fetch(`${ctx.base}/api/account/llm/keys`, { headers: { authorization: `Bearer ${at}` } });
    const al = (await aliceList.json()) as { keys: Array<{ id: string }> };
    assert.equal(al.keys.length, 1);
  } finally {
    await close(ctx);
  }
});

test("用户自助 key 可被 internal authorize 接受（端到端打通）", async () => {
  const ctx = await boot();
  try {
    const { id: uid } = await makeUser(ctx.db, "carol");
    ctx.db.appendCreditLedger(uid, 100 * 10000, "purchased", "test");
    const at = await login(ctx.base, "carol", "pw123456");

    const created = await fetch(`${ctx.base}/api/account/llm/keys`, {
      method: "POST",
      headers: { authorization: `Bearer ${at}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "carol-key" }),
    });
    const cj = (await created.json()) as { token: string };

    const svc = `svc-${randomToken()}`;
    ctx.db.createServiceToken("svc-router", "router", sha256(svc), "llm:authorize");
    const authRes = await fetch(`${ctx.base}/api/internal/llm/authorize`, {
      method: "POST",
      headers: { authorization: `Bearer ${svc}`, "content-type": "application/json" },
      body: JSON.stringify({ token: cj.token, model: "deepseek-v4-flash", requestId: "req-self", estimateMicro: 1000 }),
    });
    assert.equal(authRes.status, 200, "user-issued key must pass internal authorize");
  } finally {
    await close(ctx);
  }
});
