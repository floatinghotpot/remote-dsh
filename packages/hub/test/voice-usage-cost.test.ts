/**
 * voice-usage-cost.test.ts — 69：语音 usage 上报 → 上游成本落账 + perProviderStored 回传。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { HubDb } from "../src/db.ts";
import { HubAuth } from "../src/auth.ts";
import { createSqliteStore } from "../src/store.ts";
import { Jwt, randomToken, sha256 } from "../src/jwt.ts";
import { TunnelRegistry } from "../src/tunnel.ts";
import { EventHub } from "../src/events.ts";
import { startHubServer, type RunningHub } from "../src/server.ts";

async function boot(): Promise<{ db: HubDb; server: RunningHub; base: string; token: string }> {
  const db = new HubDb(":memory:");
  const auth = new HubAuth(createSqliteStore(db), (id) => db.getUserById(id), new Jwt(Buffer.from("test-key-0123456789abcdef")));
  const server = await startHubServer({
    host: "127.0.0.1", port: 0, db, auth, tunnels: new TunnelRegistry(), events: new EventHub(), portalDir: "/nonexistent-portal",
  });
  const token = `vtest-${randomToken()}`;
  db.createServiceToken(randomUUID(), "voice-router:test", sha256(token), "voice:usage:write");
  return { db, server, base: `http://127.0.0.1:${server.actualPort}`, token };
}

test("69：语音 usage 上报按供应商记成本，并回传 perProviderStored", async () => {
  const ctx = await boot();
  try {
    const uid = ctx.db.createUser("voice-cost-user", "hash").id;
    ctx.db.appendCreditLedger(uid, 10_000_000, "purchased", "test");
    const res = await fetch(`${ctx.base}/api/internal/voice/usage`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        userId: uid, kind: "asr", service: "deepseek-asr", provider: "deepseek",
        cumulative: 3600, perProvider: { deepseek: 3600 },
      }),
    });
    assert.equal(res.status, 200);
    const out = (await res.json()) as { perProviderStored: Record<string, number> };
    assert.equal(out.perProviderStored["deepseek"], 3600);

    const rows = ctx.db.listVoiceUpstreamUsageDaily({ service: "deepseek-asr" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.provider, "deepseek");
    assert.equal(rows[0]!.cumulative, 3600);
    assert.equal(rows[0]!.costMicro, 780_000); // 3600s × 216.6667 micro/s ≈ 0.78 元
  } finally {
    await new Promise<void>((r) => ctx.server.server.close(() => r()));
    ctx.db.close();
  }
});

test("69：旧 Router 无 perProvider 时跳过上游成本，不报错", async () => {
  const ctx = await boot();
  try {
    const uid = ctx.db.createUser("voice-cost-user2", "hash").id;
    ctx.db.appendCreditLedger(uid, 10_000_000, "purchased", "test");
    const res = await fetch(`${ctx.base}/api/internal/voice/usage`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.token}`, "content-type": "application/json" },
      body: JSON.stringify({ userId: uid, kind: "tts", service: "doubao-tts", provider: "volcengine", cumulative: 100 }),
    });
    assert.equal(res.status, 200);
    assert.equal(ctx.db.listVoiceUpstreamUsageDaily({}).length, 0);
  } finally {
    await new Promise<void>((r) => ctx.server.server.close(() => r()));
    ctx.db.close();
  }
});
