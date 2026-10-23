/**
 * llm-catalog.test.ts — 51-llm-model-catalog：模型目录 / 上游 key 池加密 / Router join+config。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { HubDb } from "../src/db.ts";
import { HubAuth, hashPassword } from "../src/auth.ts";
import { createSqliteStore } from "../src/store.ts";
import { Jwt, randomToken, sha256 } from "../src/jwt.ts";
import { TunnelRegistry } from "../src/tunnel.ts";
import { EventHub } from "../src/events.ts";
import { startHubServer, type RunningHub } from "../src/server.ts";
import { encryptUpstreamKey, decryptUpstreamKey, sealConfig, unsealConfig } from "../src/crypto-upstream-keys.ts";

function kekFixture(): { dir: string; kek: Buffer } {
  const dir = mkdtempSync(join(tmpdir(), "llm-kek-"));
  const kek = Buffer.alloc(32, 7);
  writeFileSync(join(dir, "upstream-keys.kek.v1"), kek.toString("base64"));
  return { dir, kek };
}

async function boot(llm?: { upstreamKeyPool?: { kekDir: string; kekVersion?: number } }): Promise<{ db: HubDb; server: RunningHub; base: string }> {
  const db = new HubDb(":memory:");
  const auth = new HubAuth(createSqliteStore(db), (id) => db.getUserById(id), new Jwt(Buffer.from("test-key-0123456789abcdef")));
  const server = await startHubServer({
    host: "127.0.0.1", port: 0, db, auth, tunnels: new TunnelRegistry(), events: new EventHub(), portalDir: "/nonexistent-portal",
    llm,
  });
  return { db, server, base: `http://127.0.0.1:${server.actualPort}` };
}

test("51：模型目录种子 + CRUD", async () => {
  const ctx = await boot();
  try {
    const seeded = ctx.db.listLlmModels();
    assert.equal(seeded.length, 2);
    assert.deepEqual(seeded.map((m) => m.id), ["deepseek-flash", "deepseek-v4-pro"]);
    assert.equal(seeded[0]!.displayName, "DeepSeek-V4.1-Flash");
    assert.equal(seeded[1]!.inputPriceMicro, 17100000);

    const created = ctx.db.createLlmModel({ id: "deepseek-v4-x", displayName: "X", provider: "deepseek", upstreamModel: "deepseek-v4-x" });
    assert.equal(created.nameSource, "manual");
    assert.equal(ctx.db.listLlmModels().length, 3);

    const updated = ctx.db.updateLlmModel("deepseek-v4-x", { enabled: false });
    assert.equal(updated!.enabled, false);
    assert.equal(ctx.db.listLlmModels({ enabledOnly: true }).length, 2);
  } finally {
    await new Promise<void>((r) => ctx.server.server.close(() => r()));
    ctx.db.close();
  }
});

test("51：上游 key 信封加密往返", () => {
  const { kek } = kekFixture();
  const id = "k1";
  const { keyCipher, dekWrapped } = encryptUpstreamKey("sk-upstream-secret", kek, 1, id, "deepseek");
  assert.notEqual(keyCipher, "sk-upstream-secret");
  const plain = decryptUpstreamKey(keyCipher, dekWrapped, kek, 1, id, "deepseek");
  assert.equal(plain, "sk-upstream-secret");
});

test("51：Router join → approve → config（密文可解）", async () => {
  const { dir, kek } = kekFixture();
  const ctx = await boot({ upstreamKeyPool: { kekDir: dir, kekVersion: 1 } });
  try {
    // 1) 放一把上游 key（加密入库）
    const { keyCipher, dekWrapped } = encryptUpstreamKey("sk-upstream-secret", kek, 1, "uk1", "deepseek");
    ctx.db.createLlmUpstreamKey({ id: "uk1", provider: "deepseek", label: "key-01", keyCipher, dekWrapped, kekVersion: 1 });

    // 2) 发 join token
    const joinToken = `rdsh-join-${randomToken()}`;
    ctx.db.createLlmRouterJoinToken(randomUUID(), "router-1", sha256(joinToken), Date.now() + 600_000, "admin");

    // 3) join
    const joined = await fetch(`${ctx.base}/api/internal/llm/routers/join`, {
      method: "POST",
      headers: { authorization: `Bearer ${joinToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "router-1" }),
    });
    assert.equal(joined.status, 200);
    const { routerId, token } = (await joined.json()) as { routerId: string; token: string };
    assert.match(token, /^rdsh-rt-/);

    // 4) 未启用 → config 403
    const before = await fetch(`${ctx.base}/api/internal/llm/config`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(before.status, 403);

    // 5) 启用
    ctx.db.setLlmRouterStatus(routerId, "active", "admin");

    // 6) config → 密文可解
    const cfgRes = await fetch(`${ctx.base}/api/internal/llm/config`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(cfgRes.status, 200);
    const { payload } = (await cfgRes.json()) as { payload: string };
    const plain = JSON.parse(unsealConfig(payload, token, routerId)) as {
      provider: { name: string; apiKey: string; keyId: string };
      models: Array<{ id: string }>;
    };
    assert.equal(plain.provider.apiKey, "sk-upstream-secret");
    assert.equal(plain.provider.keyId, "uk1");
    assert.deepEqual(plain.models.map((m) => m.id), ["deepseek-flash", "deepseek-v4-pro"]);

    // 7) sealConfig 对称
    assert.equal(unsealConfig(sealConfig("hello", token, routerId), token, routerId), "hello");

    // 8) 吊销后 config 401
    ctx.db.setLlmRouterStatus(routerId, "revoked", "admin");
    ctx.db.revokeServiceToken(ctx.db.getLlmRouter(routerId)!.tokenId);
    const after = await fetch(`${ctx.base}/api/internal/llm/config`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(after.status, 401);
  } finally {
    await new Promise<void>((r) => ctx.server.server.close(() => r()));
    ctx.db.close();
  }
});

test("setLlmRouterEnabled：enable/disable 不改 approved_at；active 记审批", () => {
  const db = new HubDb(":memory:");
  db.createLlmRouter("r1", "router-1", "tok-1", null, null);

  // approve → active + 记审批时间
  db.setLlmRouterStatus("r1", "active", "admin", 1000);
  assert.equal(db.getLlmRouter("r1")!.status, "active");
  assert.equal(db.getLlmRouter("r1")!.approvedAt, 1000);
  assert.equal(db.getLlmRouter("r1")!.approvedBy, "admin");

  // disable → disabled，approved_at 不变
  db.setLlmRouterEnabled("r1", false, 2000);
  assert.equal(db.getLlmRouter("r1")!.status, "disabled");
  assert.equal(db.getLlmRouter("r1")!.approvedAt, 1000);

  // enable → active，approved_at 仍不变（不重新审批）
  db.setLlmRouterEnabled("r1", true, 3000);
  assert.equal(db.getLlmRouter("r1")!.status, "active");
  assert.equal(db.getLlmRouter("r1")!.approvedAt, 1000);

  db.close();
});
