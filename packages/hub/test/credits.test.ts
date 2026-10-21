/**
 * credits.test.ts — 点数账本（09-credits-wallet）：入账/分桶/退款/结转/月度幂等/嵌套事务。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { HubDb } from "../src/db.ts";
import { createSqliteStore } from "../src/store.ts";
import {
  creditRecharge,
  creditBonusMonthly,
  creditRefund,
  carryOverCredits,
  sweepCredits,
  CREDITS_MICRO_PER_CREDIT,
} from "../src/credits.ts";

function makeDb(): HubDb {
  return new HubDb(":memory:");
}

function makeUser(db: HubDb, name: string): number {
  return db.createUser(name, "hash").id;
}

test("充值入账：purchased 桶 + 幂等键去重（重复回调不重复入账）", async () => {
  const db = makeDb();
  const uid = makeUser(db, "alice");
  const ok1 = await creditRecharge(createSqliteStore(db), uid, 800 * CREDITS_MICRO_PER_CREDIT, {
    sourceType: "unicpay",
    sourceId: "p1",
    idempotencyKey: "unicpay:p1",
  });
  assert.equal(ok1, true);
  const ok2 = await creditRecharge(createSqliteStore(db), uid, 800 * CREDITS_MICRO_PER_CREDIT, {
    sourceType: "unicpay",
    sourceId: "p1",
    idempotencyKey: "unicpay:p1",
  });
  assert.equal(ok2, false); // 幂等键重复 → 不重复入账
  const b = db.getCreditBalances(uid);
  assert.equal(b.purchased, 800 * CREDITS_MICRO_PER_CREDIT);
  assert.equal(b.bonusCarried, 0);
  assert.equal(b.bonusCurrent, 0);
  assert.equal(b.total, 800 * CREDITS_MICRO_PER_CREDIT);
});

test("分桶：充值→purchased，赠点→bonus_current，余额互不干扰", async () => {
  const db = makeDb();
  const uid = makeUser(db, "alice");
  await creditRecharge(createSqliteStore(db), uid, 1000 * CREDITS_MICRO_PER_CREDIT, {
    sourceType: "unicpay", sourceId: "p1", idempotencyKey: "unicpay:p1",
  });
  await creditBonusMonthly(createSqliteStore(db), uid, 500 * CREDITS_MICRO_PER_CREDIT, { period: "2026-10" });
  const b = db.getCreditBalances(uid);
  assert.equal(b.purchased, 1000 * CREDITS_MICRO_PER_CREDIT);
  assert.equal(b.bonusCurrent, 500 * CREDITS_MICRO_PER_CREDIT);
  assert.equal(b.total, 1500 * CREDITS_MICRO_PER_CREDIT);
});

test("退款冲正：purchased 负 delta，余额归零", async () => {
  const db = makeDb();
  const uid = makeUser(db, "alice");
  await creditRecharge(createSqliteStore(db), uid, 800 * CREDITS_MICRO_PER_CREDIT, {
    sourceType: "unicpay", sourceId: "p1", idempotencyKey: "unicpay:p1",
  });
  await creditRefund(createSqliteStore(db), uid, 800 * CREDITS_MICRO_PER_CREDIT, { platform: "unicpay", transactionId: "p1" });
  assert.equal(db.getCreditBalances(uid).purchased, 0);
});

test("结转：bonus_current 剩余 → bonus_carried，旧 carried 清零", async () => {
  const db = makeDb();
  const uid = makeUser(db, "alice");
  // 上月结转来的 carried（300 点）
  db.appendCreditLedger(uid, 300 * CREDITS_MICRO_PER_CREDIT, "bonus_carried", "carry_over", { now: 1 });
  // 本月新发 current（500 点）
  await creditBonusMonthly(createSqliteStore(db), uid, 500 * CREDITS_MICRO_PER_CREDIT, { period: "2026-10" });
  await carryOverCredits(createSqliteStore(db), 2);
  const b = db.getCreditBalances(uid);
  // 旧 carried 清零；current 剩余（500）→ 新的 carried
  assert.equal(b.bonusCarried, 500 * CREDITS_MICRO_PER_CREDIT);
  assert.equal(b.bonusCurrent, 0);
});

test("嵌套事务：外层 BEGIN 内 appendCreditLedger 不抛异常（SAVEPOINT 可嵌套）", async () => {
  const db = makeDb();
  const uid = makeUser(db, "alice");
  db.db.exec("BEGIN");
  try {
    db.appendCreditLedger(uid, 100 * CREDITS_MICRO_PER_CREDIT, "purchased", "recharge", { now: 1 });
    db.db.exec("COMMIT");
  } catch (e) {
    db.db.exec("ROLLBACK");
    throw e;
  }
  assert.equal(db.getCreditBalances(uid).purchased, 100 * CREDITS_MICRO_PER_CREDIT);
});

test("sweepCredits 月度幂等：同月二次调用不重复结转", async () => {
  const db = makeDb();
  const uid = makeUser(db, "alice");
  await creditBonusMonthly(createSqliteStore(db), uid, 500 * CREDITS_MICRO_PER_CREDIT, { period: "2026-10" });
  await sweepCredits(createSqliteStore(db), [], new Date("2026-10-15T00:00:00").getTime());
  const after1 = db.getCreditBalances(uid);
  assert.equal(after1.bonusCarried, 500 * CREDITS_MICRO_PER_CREDIT);
  assert.equal(after1.bonusCurrent, 0);
  // 同月二次调用：meta 幂等，不重复结转（否则会把 carried 当作旧 carried 清零）
  await sweepCredits(createSqliteStore(db), [], new Date("2026-10-20T00:00:00").getTime());
  const after2 = db.getCreditBalances(uid);
  assert.equal(after2.bonusCarried, 500 * CREDITS_MICRO_PER_CREDIT);
  assert.equal(after2.bonusCurrent, 0);
});

test("非法 bucket：appendCreditLedger 抛错，不静默落到 bonus_current", async () => {
  const db = makeDb();
  const uid = makeUser(db, "alice");
  assert.throws(() => {
    db.appendCreditLedger(uid, 100, "nonexistent_bucket", "recharge", { now: 1 });
  });
});
