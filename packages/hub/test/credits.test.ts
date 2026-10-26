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
  grantSubscriptionBonus,
  carryOverUserBonus,
  clearUserBonus,
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
  await creditBonusMonthly(createSqliteStore(db), uid, 500 * CREDITS_MICRO_PER_CREDIT, { period: "sub:1:exp1" });
  await carryOverUserBonus(createSqliteStore(db), uid, "sub:1:exp2");
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

test("carryOverUserBonus 幂等：同 periodKey 二次结转不重复（旧 carried 不被二次清零）", async () => {
  const db = makeDb();
  const uid = makeUser(db, "alice");
  await creditBonusMonthly(createSqliteStore(db), uid, 500 * CREDITS_MICRO_PER_CREDIT, { period: "sub:1:exp1" });
  await carryOverUserBonus(createSqliteStore(db), uid, "sub:1:exp2");
  const after1 = db.getCreditBalances(uid);
  assert.equal(after1.bonusCarried, 500 * CREDITS_MICRO_PER_CREDIT);
  assert.equal(after1.bonusCurrent, 0);
  // 同 periodKey 二次调用：幂等键跳过，不把 carried 当作旧 carried 清零
  await carryOverUserBonus(createSqliteStore(db), uid, "sub:1:exp2");
  const after2 = db.getCreditBalances(uid);
  assert.equal(after2.bonusCarried, 500 * CREDITS_MICRO_PER_CREDIT);
  assert.equal(after2.bonusCurrent, 0);
});

test("grantSubscriptionBonus：按档位发赠点入 bonus_current，幂等去重", async () => {
  const db = makeDb();
  const uid = makeUser(db, "alice");
  const ok1 = await grantSubscriptionBonus(createSqliteStore(db), uid, 1900, "sub:1:exp1");
  assert.equal(ok1, true);
  const ok2 = await grantSubscriptionBonus(createSqliteStore(db), uid, 1900, "sub:1:exp1");
  assert.equal(ok2, false); // 幂等键重复
  const b = db.getCreditBalances(uid);
  assert.equal(b.bonusCurrent, 1900 * CREDITS_MICRO_PER_CREDIT);
});

test("clearUserBonus：赠点清零，purchased 保留", async () => {
  const db = makeDb();
  const uid = makeUser(db, "alice");
  await creditRecharge(createSqliteStore(db), uid, 800 * CREDITS_MICRO_PER_CREDIT, {
    sourceType: "unicpay", sourceId: "p1", idempotencyKey: "unicpay:p1",
  });
  await grantSubscriptionBonus(createSqliteStore(db), uid, 1900, "sub:1:exp1");
  await carryOverUserBonus(createSqliteStore(db), uid, "sub:1:exp2");
  await clearUserBonus(createSqliteStore(db), uid);
  const b = db.getCreditBalances(uid);
  assert.equal(b.bonusCurrent, 0);
  assert.equal(b.bonusCarried, 0);
  assert.equal(b.purchased, 800 * CREDITS_MICRO_PER_CREDIT);
});

test("非法 bucket：appendCreditLedger 抛错，不静默落到 bonus_current", async () => {
  const db = makeDb();
  const uid = makeUser(db, "alice");
  assert.throws(() => {
    db.appendCreditLedger(uid, 100, "nonexistent_bucket", "recharge", { now: 1 });
  });
});
