/**
 * voice-billing.test.ts — 55-voice-router：语音按天累计计费（SQLite）。
 *
 * 覆盖：累计值→增量扣费、幂等（重复/乱序）、价格换算、欠费下限钳制、日累计查询。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { HubDb } from "../src/db.ts";
import { createSqliteStore } from "../src/store.ts";
import { CREDITS_MICRO_PER_CREDIT } from "../src/credits.ts";

const ASR_MICRO_PER_SEC = 2000; // 12 点/分钟
const TTS_MICRO_PER_CHAR = 600; // 6 点/百字

function makeDb(): HubDb {
  return new HubDb(":memory:");
}

function credit(db: HubDb, userId: number, points: number): void {
  db.appendCreditLedger(userId, points * CREDITS_MICRO_PER_CREDIT, "purchased", "test");
}

test("chargeVoiceUsage：累计值增量扣费 + 幂等（重复/乱序不多扣）", async () => {
  const db = makeDb();
  const uid = db.createUser("alice", "hash").id;
  credit(db, uid, 100); // 100 点 = 1,000,000 微
  const store = createSqliteStore(db);

  const r1 = await store.chargeVoiceUsage(uid, "2026-10-27", "asr", "volcengine", 60, ASR_MICRO_PER_SEC);
  assert.equal(r1.chargedMicro, 120_000); // 60s × 2000 = 12 点
  assert.equal((await store.getCreditBalances(uid)).purchased, 1_000_000 - 120_000);

  // 同一累计快照（重复上报）→ 不重复扣
  const r2 = await store.chargeVoiceUsage(uid, "2026-10-27", "asr", "volcengine", 60, ASR_MICRO_PER_SEC);
  assert.equal(r2.chargedMicro, 0);
  assert.equal((await store.getCreditBalances(uid)).purchased, 1_000_000 - 120_000);

  // 递增累计 → 只扣增量
  const r3 = await store.chargeVoiceUsage(uid, "2026-10-27", "asr", "volcengine", 120, ASR_MICRO_PER_SEC);
  assert.equal(r3.chargedMicro, 120_000);
  assert.equal((await store.getCreditBalances(uid)).purchased, 1_000_000 - 240_000);

  // 乱序（更低累计）→ 水位不退、不多扣
  const r4 = await store.chargeVoiceUsage(uid, "2026-10-27", "asr", "volcengine", 90, ASR_MICRO_PER_SEC);
  assert.equal(r4.chargedMicro, 0);
});

test("chargeVoiceUsage：欠费下限钳制（余额最多透支到 -100 点）", async () => {
  const db = makeDb();
  const uid = db.createUser("bob", "hash").id;
  credit(db, uid, 10); // 10 点
  const store = createSqliteStore(db);

  // 请求 1000 秒（=200 点），但余额只有 10 点、下限 -100 → 最多扣 110 点
  const r = await store.chargeVoiceUsage(uid, "2026-10-27", "asr", "volcengine", 1000, ASR_MICRO_PER_SEC, -100);
  assert.equal(r.chargedMicro, 110 * CREDITS_MICRO_PER_CREDIT);
  const bal = await store.getCreditBalances(uid);
  assert.equal(bal.total, -100 * CREDITS_MICRO_PER_CREDIT);

  // 再报更高累计 → 已到下限，不再扣
  const r2 = await store.chargeVoiceUsage(uid, "2026-10-27", "asr", "volcengine", 2000, ASR_MICRO_PER_SEC, -100);
  assert.equal(r2.chargedMicro, 0);
});

test("chargeVoiceUsage：TTS 按字符 + 与 ASR 分行（每人每天最多 2 行）", async () => {
  const db = makeDb();
  const uid = db.createUser("carol", "hash").id;
  credit(db, uid, 100);
  const store = createSqliteStore(db);

  await store.chargeVoiceUsage(uid, "2026-10-27", "tts", "volcengine", 100, TTS_MICRO_PER_CHAR);
  await store.chargeVoiceUsage(uid, "2026-10-27", "asr", "volcengine", 30, ASR_MICRO_PER_SEC);

  const rows = await store.getVoiceUsageDaily(uid, "2026-10-27", "2026-10-27");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.kind).sort(), ["asr", "tts"]);
});

test("voice_provider_configs：upsert/get/list 回读 + 覆盖更新", async () => {
  const db = makeDb();
  const store = createSqliteStore(db);
  assert.equal(await store.getVoiceProviderConfig("volcengine"), null);
  await store.upsertVoiceProviderConfig("volcengine", JSON.stringify({ asrUrl: "wss://x", voices: ["a", "b"] }));
  const got = await store.getVoiceProviderConfig("volcengine");
  assert.notEqual(got, null);
  assert.deepEqual(JSON.parse(got!.params), { asrUrl: "wss://x", voices: ["a", "b"] });
  await store.upsertVoiceProviderConfig("volcengine", JSON.stringify({ voices: ["c"] }));
  assert.deepEqual(JSON.parse((await store.getVoiceProviderConfig("volcengine"))!.params), { voices: ["c"] });
  assert.equal((await store.listVoiceProviderConfigs()).length, 1);
});
