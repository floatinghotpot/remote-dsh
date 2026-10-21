/**
 * 43b-2：PgStore 对拍冒烟（真实 PG17）。跳过条件：PG 不可达。
 * 覆盖关键/易错路径：RETURNING id、ON CONFLICT(GREATEST)、动态 WHERE、账本幂等、事务。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPgPool, migratePg } from "../src/pg.ts";
import { createPgStore } from "../src/pg-store/index.ts";

const DSN = process.env.RDSH_TEST_PG_DSN ?? "postgres://rdsh:rdsh_dev_password@127.0.0.1:5432/rdsh_parity";

test("PgStore 对拍：users/hosts/ledger/order/usage/audit/meta", async (t) => {
  const pool = createPgPool(DSN, { max: 3, min: 0 });
  try {
    await pool.query("SELECT 1");
  } catch {
    await pool.end();
    t.skip("PostgreSQL unreachable");
    return;
  }
  let store: ReturnType<typeof createPgStore> | null = null;
  try {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await migratePg(pool);
    store = createPgStore(pool);

    // users: createUser (RETURNING id) + getUserByName
    const u = await store.createUser("alice", "hash", new Date().toISOString(), true);
    assert.equal(typeof u.id, "number");
    assert.equal(u.mustChange, 1);
    const byName = await store.getUserByName("alice");
    assert.equal(byName?.id, u.id);
    await store.setEmail(u.id, "alice@test.local");
    assert.equal((await store.getUserByEmail("alice@test.local"))?.id, u.id);

    // hosts
    const h = await store.createHost("h1", u.id, "pc", "tokhash", undefined, "2026-10-19T00:00:00.000Z");
    assert.equal(h.ownerId, u.id);
    assert.equal(await store.isHostOwner("h1", u.id), true);
    assert.equal((await store.listHostsForUser(u.id)).length, 1);

    // credits ledger: append + idempotency + balances
    const ok1 = await store.appendCreditLedger(u.id, 800 * 10000, "purchased", "recharge", { sourceType: "unicpay", sourceId: "p1", idempotencyKey: "unicpay:p1" });
    assert.equal(ok1, true);
    const ok2 = await store.appendCreditLedger(u.id, 800 * 10000, "purchased", "recharge", { sourceType: "unicpay", sourceId: "p1", idempotencyKey: "unicpay:p1" });
    assert.equal(ok2, false, "idempotency key dedupes");
    const bal = await store.getCreditBalances(u.id);
    assert.equal(bal.purchased, 800 * 10000);

    // order: create + markOrderPaidIfCreated (boolean) + status
    await store.createOrder("o1", u.id, "pro", 39, Date.now());
    const paid = await store.markOrderPaidIfCreated("o1", "unicpay", "p1");
    assert.equal(paid, true);
    assert.equal((await store.getOrder("o1"))?.status, "paid");
    const paidAgain = await store.markOrderPaidIfCreated("o1", "unicpay", "p1");
    assert.equal(paidAgain, false, "already paid → not created → false");

    // usage: upsert (GREATEST semantics) + listUsageDaily
    const day = { date: "2026-10-19", relaySeconds: 0, relayBytesUp: 100, relayBytesDown: 0, directBytesUp: 0, directBytesDown: 0, cloudAsrSeconds: 0, localAsrSeconds: 0, cloudTtsChars: 0, localTtsChars: 0, sessions: 1 };
    await store.upsertUsageDaily(u.id, day, { hostId: "h1", instanceId: "i1", source: "gateway" });
    await store.upsertUsageDaily(u.id, { ...day, relayBytesUp: 80 }, { hostId: "h1", instanceId: "i1", source: "gateway" });
    await store.upsertUsageDaily(u.id, { ...day, relayBytesUp: 150 }, { hostId: "h1", instanceId: "i1", source: "gateway" });
    const usageRows = await store.listUsageDailyByHost("h1", "2026-10-19", "2026-10-19");
    assert.equal(usageRows.length, 1);
    assert.equal(usageRows[0]!.relayBytesUp, 150, "GREATEST keeps max, not sum");

    // audit + meta
    await store.recordAudit(u.id, "test.evt", { k: "v" }, "127.0.0.1", Date.now(), { source: "admin", actorUserId: u.id });
    const audits = await store.listAudit({ source: "admin" });
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.event, "test.evt");
    await store.setMeta("k", "v");
    assert.equal(await store.getMeta("k"), "v");

    // 嵌套事务：appendCreditLedger 内部自带 withTransaction，外层再包一层 → SAVEPOINT 可嵌套
    await store.withTransaction(async () => {
      await store.appendCreditLedger(u.id, 500 * 10000, "bonus_current", "bonus_subscription", { sourceType: "subscription", sourceId: "sub-1", idempotencyKey: "bonus:sub-1" });
    });
    const bal2 = await store.getCreditBalances(u.id);
    assert.equal(bal2.bonusCurrent, 500 * 10000);

    // 点数消费：reserve / settle / spend + 多桶
    const carol = await store.createUser("carol", "hash", new Date().toISOString(), false);
    await store.appendCreditLedger(carol.id, 100 * 10000, "purchased", "test");
    await store.appendCreditLedger(carol.id, 5 * 10000, "bonus_current", "test");
    const hold = await store.reserveCreditHold(carol.id, 60 * 10000, {
      scopeType: "llm_agent", scopeId: "a1", requestId: "parity-hold-1", ttlMs: 60_000,
    });
    assert.equal(hold.status, "held");
    const settled = await store.settleCreditHold(hold.hold!.id, 25 * 10000, { reason: "consume_llm" });
    assert.equal(settled.status, "settled");
    assert.equal(settled.balance.bonusCurrent, 0);
    assert.equal(settled.balance.purchased, 80 * 10000);
    const spent = await store.spendCredits(carol.id, 10 * 10000, { reason: "consume_relay", idempotencyKey: "parity-spend-1" });
    assert.equal(spent.status, "spent");
    assert.equal(spent.balance.purchased, 70 * 10000);

    // BIGINT 边界：PG bigint 余额/扣减不能被 Number 截断
    const dave = await store.createUser("dave", "hash", new Date().toISOString(), false);
    await store.appendCreditLedger(dave.id, 3_000_000_000, "purchased", "test");
    const bigHold = await store.reserveCreditHold(dave.id, 2_500_000_000, {
      scopeType: "llm_agent", requestId: "parity-bigint-1", ttlMs: 60_000,
    });
    assert.equal(bigHold.status, "held");
    const bigSettle = await store.settleCreditHold(bigHold.hold!.id, 2_200_000_000, { reason: "consume_llm" });
    assert.equal(bigSettle.status, "settled");
    assert.equal(bigSettle.balance.purchased, 800_000_000);

    // 动态 WHERE 的 $n 重编号对拍：listUsersPage / listHostsPage / listOrders / listAuditPage
    await store.createUser("bob", "hash", new Date().toISOString(), false);
    await store.setRole((await store.getUserByName("bob"))!.id, "admin");
    const adminPage = await store.listUsersPage({ role: "admin" });
    assert.equal(adminPage.total, 1);
    assert.equal(adminPage.rows[0]!.name, "bob");

    const hostsPage = await store.listHostsPage({ q: "pc" });
    assert.equal(hostsPage.total, 1);
    assert.equal(hostsPage.rows[0]!.name, "pc");

    const ordersPaid = await store.listOrders({ status: "paid" });
    assert.equal(ordersPaid.total, 1);
    assert.equal(ordersPaid.rows[0]!.id, "o1");
    const ordersQ = await store.listOrders({ q: "o1" });
    assert.equal(ordersQ.total, 1);

    const auditPage = await store.listAuditPage({ source: "admin" }, 10, 0);
    assert.equal(auditPage.total, 1);
    assert.equal(auditPage.rows[0]!.event, "test.evt");
  } finally {
    if (store !== null) await store.close();
  }
});
