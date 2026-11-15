/**
 * service-providers.test.ts — 68：四表 seed/CRUD + LLM 配置按 capabilities 过滤。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { HubDb } from "../src/db.ts";
import { HubAuth } from "../src/auth.ts";
import { createSqliteStore } from "../src/store.ts";
import { Jwt, randomToken, sha256 } from "../src/jwt.ts";
import { TunnelRegistry } from "../src/tunnel.ts";
import { EventHub } from "../src/events.ts";
import { startHubServer, type RunningHub } from "../src/server.ts";
import { encryptUpstreamKey, unsealConfig } from "../src/crypto-upstream-keys.ts";

function kekFixture(): { dir: string; kek: Buffer } {
  const dir = mkdtempSync(join(tmpdir(), "sp-kek-"));
  const kek = Buffer.alloc(32, 9);
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

test("68：seed 供应商/模型代理/上游服务齐全且可 CRUD", () => {
  const db = new HubDb(":memory:");
  assert.equal(db.listProviderConfigs().length, 3);
  assert.deepEqual(db.listServices().map((s) => s.service).sort(), [
    "deepseek-asr", "deepseek-flash", "deepseek-tts", "deepseek-v4-pro", "doubao-asr", "doubao-tts",
  ]);
  assert.equal(db.listServicePool().length, 7);
  assert.equal(db.listServicePoolByService("deepseek-flash").length, 2);
  // P1-4：LLM 服务由 llm_models 迁移而来，价格与 llm_models 一致（不漂移）。
  const flash = db.getService("deepseek-flash");
  assert.notEqual(flash, null);
  const flashPrices = JSON.parse(flash!.prices) as { input: number };
  const flashModel = db.getLlmModel("deepseek-flash");
  assert.equal(flashPrices.input, flashModel!.inputPriceMicro);
  assert.equal(JSON.parse(flash!.params as string).family, "deepseek");

  const created = db.upsertService({ service: "test-svc", capability: "asr", unit: "per_second", prices: JSON.stringify({ price: 1 }) });
  assert.equal(created.service, "test-svc");
  db.upsertServicePoolEntry({ id: "sp-test", service: "test-svc", provider: "deepseek", upstreamModel: "ds.asr" });
  assert.equal(db.listServicePoolByService("test-svc").length, 1);
  assert.equal(db.deleteServicePoolEntry("sp-test"), true);
  assert.equal(db.listServicePoolByService("test-svc").length, 0);
});

test("68：LLM config 只下发含 llm 能力的 Key，且 pool 只含有效 provider", async () => {
  const { dir, kek } = kekFixture();
  const ctx = await boot({ upstreamKeyPool: { kekDir: dir, kekVersion: 1 } });
  try {
    const asrOnly = encryptUpstreamKey("sk-asr", kek, 1, "uk-asr", "deepseek");
    ctx.db.createLlmUpstreamKey({ id: "uk-asr", provider: "deepseek", label: "asr", ...asrOnly, kekVersion: 1, capabilities: JSON.stringify(["asr"]) });
    const llm = encryptUpstreamKey("sk-llm", kek, 1, "uk-llm", "deepseek");
    ctx.db.createLlmUpstreamKey({ id: "uk-llm", provider: "deepseek", label: "llm", ...llm, kekVersion: 1, capabilities: JSON.stringify(["llm"]) });

    const joinToken = `rdsh-join-${randomToken()}`;
    ctx.db.createLlmRouterJoinToken(randomUUID(), "r", sha256(joinToken), Date.now() + 600_000, "admin");
    const joined = await fetch(`${ctx.base}/api/internal/llm/routers/join`, {
      method: "POST", headers: { authorization: `Bearer ${joinToken}`, "content-type": "application/json" }, body: JSON.stringify({ name: "r" }),
    });
    const { routerId, token } = (await joined.json()) as { routerId: string; token: string };
    ctx.db.setLlmRouterStatus(routerId, "active", "admin");

    const res = await fetch(`${ctx.base}/api/internal/llm/config`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    const { payload } = (await res.json()) as { payload: string };
    const plain = JSON.parse(unsealConfig(payload, token, routerId)) as {
      schemaVersion: number;
      providers: Record<string, { keys: Array<{ id: string }> }>;
      models: Record<string, { pool: Record<string, string> }>;
    };
    assert.equal(plain.schemaVersion, 2);
    assert.deepEqual(plain.providers.deepseek!.keys.map((k) => k.id), ["uk-llm"]);
    assert.deepEqual(plain.models["deepseek-flash"]!.pool, { deepseek: "deepseek-flash" }); // aliyun 池条目 disabled，不下发
  } finally {
    await new Promise<void>((r) => ctx.server.server.close(() => r()));
    ctx.db.close();
  }
});
