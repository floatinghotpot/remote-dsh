/**
 * internal-llm.test.ts — 49-llm-router：Hub 内部服务 API（服务令牌 + key + authorize/settle/release/usage）。
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

const SCOPES = "llm:key:create,llm:key:revoke,llm:authorize,llm:settle,llm:release,llm:usage:read";

async function boot(): Promise<{ db: HubDb; server: RunningHub; base: string; svcToken: string }> {
  const db = new HubDb(":memory:");
  const auth = new HubAuth(createSqliteStore(db), (id) => db.getUserById(id), new Jwt(Buffer.from("test-key-0123456789abcdef")));
  const server = await startHubServer({
    host: "127.0.0.1", port: 0, db, auth, tunnels: new TunnelRegistry(), events: new EventHub(), portalDir: "/nonexistent-portal",
  });
  const svcToken = `svc-${randomToken()}`;
  db.createServiceToken("svc-llm-router", "llm-router", sha256(svcToken), SCOPES);
  return { db, server, base: `http://127.0.0.1:${server.actualPort}`, svcToken };
}

async function close(ctx: { db: HubDb; server: RunningHub }): Promise<void> {
  await new Promise<void>((r) => ctx.server.server.close(() => r()));
  ctx.db.close();
}

async function issueKey(ctx: { base: string; svcToken: string }, opts: Record<string, unknown> = {}): Promise<{ token: string; keyId: string }> {
  const res = await fetch(`${ctx.base}/api/internal/llm/keys`, {
    method: "POST",
    headers: { authorization: `Bearer ${ctx.svcToken}`, "content-type": "application/json" },
    body: JSON.stringify({ userId: opts.userId, agentId: opts.agentId ?? "a1", modelAllowlist: opts.modelAllowlist ?? null, budgetMicro: opts.budgetMicro ?? 0 }),
  });
  assert.equal(res.status, 200);
  const json = (await res.json()) as { token: string; keyId: string };
  return { token: json.token, keyId: json.keyId };
}

test("服务令牌 scope 校验：错误 scope → 401", async () => {
  const ctx = await boot();
  try {
    const wrong = `svc-${randomToken()}`;
    ctx.db.createServiceToken("svc-narrow", "narrow", sha256(wrong), "llm:usage:read");
    const res = await fetch(`${ctx.base}/api/internal/llm/keys`, {
      method: "POST",
      headers: { authorization: `Bearer ${wrong}`, "content-type": "application/json" },
      body: JSON.stringify({ userId: 1, agentId: "a1" }),
    });
    assert.equal(res.status, 401);
  } finally {
    await close(ctx);
  }
});

test("issue → authorize → settle → usage 全链路", async () => {
  const ctx = await boot();
  try {
    const uid = ctx.db.createUser("alice", "hash").id;
    ctx.db.appendCreditLedger(uid, 100 * 10000, "purchased", "test");
    const { token, keyId } = await issueKey(ctx, { userId: uid, agentId: "agent-1", budgetMicro: 100 * 10000 });

    const authRes = await fetch(`${ctx.base}/api/internal/llm/authorize`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.svcToken}`, "content-type": "application/json" },
      body: JSON.stringify({ token, model: "deepseek-v4-flash", requestId: "req-1", estimateMicro: 10000 }),
    });
    assert.equal(authRes.status, 200);
    const auth = (await authRes.json()) as { holdId: string; keyId: string; agentId: string };
    assert.equal(auth.keyId, keyId);
    assert.equal(auth.agentId, "agent-1");

    const settleRes = await fetch(`${ctx.base}/api/internal/llm/holds/${auth.holdId}/settle`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.svcToken}`, "content-type": "application/json" },
      body: JSON.stringify({ keyId, actualMicro: 6000, requestId: "req-1", modelAlias: "deepseek-v4-flash", provider: "deepseek", upstreamModel: "deepseek-chat", usage: { inputTokens: 10, outputTokens: 20 } }),
    });
    assert.equal(settleRes.status, 200);
    const settle = (await settleRes.json()) as { chargedMicro: number };
    assert.equal(settle.chargedMicro, 6000);
    assert.equal((await ctx.db.getCreditBalances(uid)).purchased, 100 * 10000 - 6000);

    const usageRes = await fetch(`${ctx.base}/api/internal/llm/usage?userId=${uid}&agentId=agent-1`, {
      headers: { authorization: `Bearer ${ctx.svcToken}` },
    });
    assert.equal(usageRes.status, 200);
    const usage = (await usageRes.json()) as { requests: Array<{ chargedMicro: number }> };
    assert.equal(usage.requests.length, 1);
    assert.equal(usage.requests[0]!.chargedMicro, 6000);
  } finally {
    await close(ctx);
  }
});

test("模型白名单：不允许的模型 → 403", async () => {
  const ctx = await boot();
  try {
    const uid = ctx.db.createUser("bob", "hash").id;
    ctx.db.appendCreditLedger(uid, 100 * 10000, "purchased", "test");
    const { token } = await issueKey(ctx, { userId: uid, agentId: "agent-2", modelAllowlist: "deepseek-v4-flash" });
    const res = await fetch(`${ctx.base}/api/internal/llm/authorize`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.svcToken}`, "content-type": "application/json" },
      body: JSON.stringify({ token, model: "other-model", requestId: "req-2", estimateMicro: 100 }),
    });
    assert.equal(res.status, 403);
  } finally {
    await close(ctx);
  }
});

test("余额不足 → 402；release 后不扣费", async () => {
  const ctx = await boot();
  try {
    const uid = ctx.db.createUser("carol", "hash").id;
    ctx.db.appendCreditLedger(uid, 5 * 10000, "purchased", "test");
    const { token } = await issueKey(ctx, { userId: uid, agentId: "agent-3" });

    const tooBig = await fetch(`${ctx.base}/api/internal/llm/authorize`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.svcToken}`, "content-type": "application/json" },
      body: JSON.stringify({ token, model: "deepseek-v4-flash", requestId: "req-big", estimateMicro: 999999 }),
    });
    assert.equal(tooBig.status, 402);

    const ok = await fetch(`${ctx.base}/api/internal/llm/authorize`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.svcToken}`, "content-type": "application/json" },
      body: JSON.stringify({ token, model: "deepseek-v4-flash", requestId: "req-rel", estimateMicro: 100 }),
    });
    assert.equal(ok.status, 200);
    const auth = (await ok.json()) as { holdId: string };
    const release = await fetch(`${ctx.base}/api/internal/llm/holds/${auth.holdId}/release`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.svcToken}` },
    });
    assert.equal(release.status, 200);
    assert.equal((await ctx.db.getCreditBalances(uid)).purchased, 5 * 10000);
  } finally {
    await close(ctx);
  }
});

test("吊销 key：authorize 拒绝", async () => {
  const ctx = await boot();
  try {
    const uid = ctx.db.createUser("dave", "hash").id;
    ctx.db.appendCreditLedger(uid, 10 * 10000, "purchased", "test");
    const { token, keyId } = await issueKey(ctx, { userId: uid, agentId: "agent-4" });
    const revoke = await fetch(`${ctx.base}/api/internal/llm/keys/${keyId}/revoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.svcToken}` },
    });
    assert.equal(revoke.status, 200);
    const res = await fetch(`${ctx.base}/api/internal/llm/authorize`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.svcToken}`, "content-type": "application/json" },
      body: JSON.stringify({ token, model: "deepseek-v4-flash", requestId: "req-rev", estimateMicro: 100 }),
    });
    assert.equal(res.status, 401);
  } finally {
    await close(ctx);
  }
});
