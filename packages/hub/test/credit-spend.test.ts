/**
 * credit-spend.test.ts — 点数消费原语：reserve / settle / release / spend。
 *
 * 覆盖：多桶扣减、预留、幂等、过期、并发、BIGINT 边界。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { HubDb } from "../src/db.ts";
import { createSqliteStore } from "../src/store.ts";
import { CREDITS_MICRO_PER_CREDIT } from "../src/credits.ts";

function makeDb(): HubDb {
  return new HubDb(":memory:");
}

function makeUser(db: HubDb, name: string): number {
  return db.createUser(name, "hash").id;
}

function credit(db: HubDb, userId: number, bucket: string, credits: number): void {
  db.appendCreditLedger(userId, credits * CREDITS_MICRO_PER_CREDIT, bucket, "test");
}

test("reserve/settle：预留不扣余额，结算按实际金额扣减并释放差额", async () => {
  const db = makeDb();
  const uid = makeUser(db, "alice");
  credit(db, uid, "purchased", 100);
  const store = createSqliteStore(db);

  const reserved = await store.reserveCreditHold(uid, 60 * CREDITS_MICRO_PER_CREDIT, {
    scopeType: "llm_agent",
    scopeId: "a1",
    requestId: "req-1",
    ttlMs: 60_000,
  });
  assert.equal(reserved.status, "held");
  assert.equal(reserved.availableMicro, 40 * CREDITS_MICRO_PER_CREDIT);
  assert.equal((await store.getCreditBalances(uid)).purchased, 100 * CREDITS_MICRO_PER_CREDIT);

  const settled = await store.settleCreditHold(reserved.hold!.id, 30 * CREDITS_MICRO_PER_CREDIT, { reason: "consume_llm" });
  assert.equal(settled.status, "settled");
  assert.equal(settled.chargedMicro, 30 * CREDITS_MICRO_PER_CREDIT);
  assert.equal(settled.balance.purchased, 70 * CREDITS_MICRO_PER_CREDIT);
  assert.equal(settled.hold?.status, "settled");

  const again = await store.settleCreditHold(reserved.hold!.id, 30 * CREDITS_MICRO_PER_CREDIT, { reason: "consume_llm" });
  assert.equal(again.status, "already_settled");
  assert.equal((await store.getCreditBalances(uid)).purchased, 70 * CREDITS_MICRO_PER_CREDIT);
  assert.equal(await store.releaseCreditHold(reserved.hold!.id), false);
});

test("reserve/release：释放后 available 恢复，不写账本", async () => {
  const db = makeDb();
  const uid = makeUser(db, "alice");
  credit(db, uid, "purchased", 100);
  const store = createSqliteStore(db);

  const reserved = await store.reserveCreditHold(uid, 40 * CREDITS_MICRO_PER_CREDIT, {
    scopeType: "llm_agent", requestId: "req-release", ttlMs: 60_000,
  });
  assert.equal(reserved.status, "held");
  assert.equal(await store.releaseCreditHold(reserved.hold!.id), true);
  assert.equal(await store.releaseCreditHold(reserved.hold!.id), true);

  const balances = await store.getCreditBalances(uid);
  assert.equal(balances.purchased, 100 * CREDITS_MICRO_PER_CREDIT);
  assert.equal((await store.getCreditLedgerByIdempotencyKey(`${reserved.hold!.id}:purchased`)), null);
});

test("多桶扣减顺序：bonus_carried → bonus_current → purchased", async () => {
  const db = makeDb();
  const uid = makeUser(db, "alice");
  credit(db, uid, "bonus_carried", 10);
  credit(db, uid, "bonus_current", 20);
  credit(db, uid, "purchased", 30);
  const store = createSqliteStore(db);

  const reserved = await store.reserveCreditHold(uid, 25 * CREDITS_MICRO_PER_CREDIT, {
    scopeType: "llm_agent", requestId: "req-buckets", ttlMs: 60_000,
  });
  assert.equal(reserved.status, "held");
  const settled = await store.settleCreditHold(reserved.hold!.id, 25 * CREDITS_MICRO_PER_CREDIT, { reason: "consume_llm" });
  assert.equal(settled.status, "settled");

  const balances = await store.getCreditBalances(uid);
  assert.equal(balances.bonusCarried, 0);
  assert.equal(balances.bonusCurrent, 5 * CREDITS_MICRO_PER_CREDIT);
  assert.equal(balances.purchased, 30 * CREDITS_MICRO_PER_CREDIT);
});

test("余额不足：reserve 返回 insufficient，不创建 hold", async () => {
  const db = makeDb();
  const uid = makeUser(db, "alice");
  credit(db, uid, "purchased", 10);
  const store = createSqliteStore(db);

  const reserved = await store.reserveCreditHold(uid, 20 * CREDITS_MICRO_PER_CREDIT, {
    scopeType: "llm_agent", requestId: "req-insufficient", ttlMs: 60_000,
  });
  assert.equal(reserved.status, "insufficient");
  assert.equal(reserved.availableMicro, 10 * CREDITS_MICRO_PER_CREDIT);
  assert.equal(await store.getCreditHoldByRequestId("req-insufficient"), null);
});

test("requestId 幂等：重复 reserve 返回同一 hold", async () => {
  const db = makeDb();
  const uid = makeUser(db, "alice");
  credit(db, uid, "purchased", 100);
  const store = createSqliteStore(db);

  const a = await store.reserveCreditHold(uid, 20 * CREDITS_MICRO_PER_CREDIT, {
    scopeType: "llm_agent", requestId: "req-idem", ttlMs: 60_000,
  });
  const b = await store.reserveCreditHold(uid, 20 * CREDITS_MICRO_PER_CREDIT, {
    scopeType: "llm_agent", requestId: "req-idem", ttlMs: 60_000,
  });
  assert.equal(a.status, "held");
  assert.equal(b.status, "existing");
  assert.equal(a.hold!.id, b.hold!.id);
  assert.equal((await store.getCreditBalances(uid)).purchased, 100 * CREDITS_MICRO_PER_CREDIT);
});

test("spend：无 hold 批量扣减，requestId 幂等", async () => {
  const db = makeDb();
  const uid = makeUser(db, "alice");
  credit(db, uid, "purchased", 100);
  const store = createSqliteStore(db);

  const a = await store.spendCredits(uid, 30 * CREDITS_MICRO_PER_CREDIT, {
    reason: "consume_relay", idempotencyKey: "spend-1",
  });
  assert.equal(a.status, "spent");
  assert.equal(a.balance.purchased, 70 * CREDITS_MICRO_PER_CREDIT);

  const b = await store.spendCredits(uid, 30 * CREDITS_MICRO_PER_CREDIT, {
    reason: "consume_relay", idempotencyKey: "spend-1",
  });
  assert.equal(b.status, "already_spent");
  assert.equal(b.chargedMicro, 30 * CREDITS_MICRO_PER_CREDIT);
  assert.equal((await store.getCreditBalances(uid)).purchased, 70 * CREDITS_MICRO_PER_CREDIT);
});

test("过期 hold：sweep 标记 expired；过期后仍可补 settle", async () => {
  const db = makeDb();
  const uid = makeUser(db, "alice");
  credit(db, uid, "purchased", 100);
  const store = createSqliteStore(db);

  const reserved = await store.reserveCreditHold(uid, 40 * CREDITS_MICRO_PER_CREDIT, {
    scopeType: "llm_agent", requestId: "req-expire", ttlMs: 10, now: 1_000,
  });
  assert.equal(reserved.status, "held");
  assert.equal(await store.sweepExpiredCreditHolds(2_000), 1);
  assert.equal((await store.getCreditHoldByRequestId("req-expire"))?.status, "expired");

  const settled = await store.settleCreditHold(reserved.hold!.id, 5 * CREDITS_MICRO_PER_CREDIT, {
    reason: "consume_llm", now: 2_000,
  });
  assert.equal(settled.status, "settled");
  assert.equal(settled.balance.purchased, 95 * CREDITS_MICRO_PER_CREDIT);
});

test("结算过期未 sweep 的 hold 时，仍保护其他 active hold 的预留", async () => {
  const db = makeDb();
  const uid = makeUser(db, "alice");
  credit(db, uid, "purchased", 10);
  const store = createSqliteStore(db);

  // A 已过期但未 sweep；B 是 active hold，占 3 点。
  const a = await store.reserveCreditHold(uid, 2 * CREDITS_MICRO_PER_CREDIT, {
    scopeType: "llm_agent", requestId: "expired-a", ttlMs: 10, now: 1_000,
  });
  await store.reserveCreditHold(uid, 3 * CREDITS_MICRO_PER_CREDIT, {
    scopeType: "llm_agent", requestId: "active-b", ttlMs: 60_000, now: 1_000,
  });
  assert.equal(a.status, "held");

  // 不 sweep A（模拟 sweep 还没跑）。结算 A 8 点 = 总余额 10 - B 预留 3 = 7，应当不足。
  const settled = await store.settleCreditHold(a.hold!.id, 8 * CREDITS_MICRO_PER_CREDIT, {
    reason: "consume_llm", now: 2_000,
  });
  assert.equal(settled.status, "insufficient");
  assert.equal((await store.getCreditBalances(uid)).purchased, 10 * CREDITS_MICRO_PER_CREDIT);
});

test("并发 reserve：只能有一个成功，不能超占", async () => {
  const db = makeDb();
  const uid = makeUser(db, "alice");
  credit(db, uid, "purchased", 100);
  const store = createSqliteStore(db);

  const [a, b] = await Promise.all([
    store.reserveCreditHold(uid, 60 * CREDITS_MICRO_PER_CREDIT, { scopeType: "llm_agent", requestId: "c1", ttlMs: 60_000 }),
    store.reserveCreditHold(uid, 60 * CREDITS_MICRO_PER_CREDIT, { scopeType: "llm_agent", requestId: "c2", ttlMs: 60_000 }),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, ["held", "insufficient"]);
  assert.equal((await store.getCreditBalances(uid)).purchased, 100 * CREDITS_MICRO_PER_CREDIT);
});

test("超出余额：默认拒绝；显式 allowOverdraft 才允许负余额", async () => {
  const db = makeDb();
  const uid = makeUser(db, "alice");
  credit(db, uid, "purchased", 5);
  const store = createSqliteStore(db);

  const reserved = await store.reserveCreditHold(uid, 2 * CREDITS_MICRO_PER_CREDIT, {
    scopeType: "llm_agent", requestId: "req-over", ttlMs: 60_000,
  });
  const denied = await store.settleCreditHold(reserved.hold!.id, 8 * CREDITS_MICRO_PER_CREDIT, { reason: "consume_llm" });
  assert.equal(denied.status, "insufficient");
  assert.equal((await store.getCreditBalances(uid)).purchased, 5 * CREDITS_MICRO_PER_CREDIT);

  const allowed = await store.settleCreditHold(reserved.hold!.id, 8 * CREDITS_MICRO_PER_CREDIT, {
    reason: "consume_llm", allowOverdraft: true,
  });
  assert.equal(allowed.status, "settled");
  assert.equal(allowed.balance.purchased, -3 * CREDITS_MICRO_PER_CREDIT);
});

test("BIGINT 边界：超过 int4 的余额可正确预留/结算", async () => {
  const db = makeDb();
  const uid = makeUser(db, "alice");
  db.appendCreditLedger(uid, 3_000_000_000, "purchased", "test");
  const store = createSqliteStore(db);

  const reserved = await store.reserveCreditHold(uid, 2_500_000_000, {
    scopeType: "llm_agent", requestId: "req-bigint", ttlMs: 60_000,
  });
  assert.equal(reserved.status, "held");
  const settled = await store.settleCreditHold(reserved.hold!.id, 2_200_000_000, { reason: "consume_llm" });
  assert.equal(settled.status, "settled");
  assert.equal(settled.balance.purchased, 800_000_000);
});
