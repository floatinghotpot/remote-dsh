/**
 * 43b-1：PG migrations 冒烟（需可连通的 PostgreSQL）。
 * DSN 缺省指向本地 dev 库 `rdsh_test`；用 RDSH_TEST_PG_DSN 覆盖。不可达则跳过。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPgPool, migratePg } from "../src/pg.ts";
import { assertTestDb, isTestDb, testDbName } from "./pg-test-db.ts";

const DSN = process.env.RDSH_TEST_PG_DSN ?? "postgres://rdsh:rdsh_dev_password@127.0.0.1:5432/rdsh_test";

test("pg migrations：应用 25 表 + usage_daily 分区 + 幂等", async (t) => {
  if (!isTestDb(DSN)) {
    t.skip(`not a test database (expected test_* or *_test): ${testDbName(DSN)}`);
    return;
  }
  const pool = createPgPool(DSN, { max: 2, min: 0 });
  try {
    await pool.query("SELECT 1");
  } catch {
    await pool.end();
    t.skip("PostgreSQL unreachable");
    return;
  }
  try {
    assertTestDb(DSN);
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    const applied = await migratePg(pool, "test");
    const auditRows = (await pool.query("SELECT DISTINCT source, pid FROM schema_migrations")).rows;
    assert.equal(auditRows.length, 1, "single (source, pid) recorded for the run");
    assert.equal(auditRows[0].source, "test", "source recorded");
    assert.equal(auditRows[0].pid, process.pid, "pid recorded");
    assert.ok(applied.includes("0001_init.sql"), "0001_init.sql applied");
    assert.ok(applied.includes("0002_node_bytes_bigint.sql"), "0002_node_bytes_bigint.sql applied");
    assert.ok(applied.includes("0003_credit_spend.sql"), "0003_credit_spend.sql applied");
    assert.ok(applied.includes("0004_llm_service.sql"), "0004_llm_service.sql applied");
    const byteCols = (await pool.query(
      `SELECT data_type FROM information_schema.columns
       WHERE table_name IN ('nodes', 'node_metrics')
         AND column_name IN ('bytes_in', 'bytes_out')`,
    )).rows as Array<{ data_type: string }>;
    assert.equal(byteCols.length, 4, "four node byte columns");
    for (const col of byteCols) assert.equal(col.data_type, "bigint", "node bytes are bigint");
    const creditCols = (await pool.query(
      `SELECT data_type FROM information_schema.columns
       WHERE (table_name = 'users' AND column_name IN ('purchased_credits', 'bonus_carried', 'bonus_current'))
          OR (table_name = 'credits_ledger' AND column_name = 'delta')`,
    )).rows as Array<{ data_type: string }>;
    assert.equal(creditCols.length, 4, "four credit columns");
    for (const col of creditCols) assert.equal(col.data_type, "bigint", "credit balances/delta are bigint");

    const tables = (await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`,
    )).rows.map((r) => r.table_name) as string[];
    const expect = [
      "users", "hosts", "refresh_tokens", "join_tokens", "bind_sessions", "host_share",
      "audit_events", "email_codes", "sms_codes", "subscriptions", "orders", "payments",
      "credits_ledger", "credit_holds", "service_tokens", "llm_keys",
      "meta", "apple_tokens", "usage_daily", "usage_daily_default",
      "nodes", "node_metrics", "relay_join_tokens", "relay_join_events",
    ];
    for (const name of expect) assert.ok(tables.includes(name), `missing table ${name}`);

    const relkind = (await pool.query(`SELECT relkind FROM pg_class WHERE relname='usage_daily'`)).rows[0]!.relkind;
    assert.equal(relkind, "p", "usage_daily is partitioned");

    const again = await migratePg(pool, "test");
    assert.equal(again.length, 0, "migration is idempotent");
  } finally {
    await pool.end();
  }
});

test("pg migrations：并发迁移串行化（advisory lock）", async (t) => {
  if (!isTestDb(DSN)) {
    t.skip(`not a test database (expected test_* or *_test): ${testDbName(DSN)}`);
    return;
  }
  const p1 = createPgPool(DSN, { max: 1, min: 0 });
  const p2 = createPgPool(DSN, { max: 1, min: 0 });
  try {
    await p1.query("SELECT 1");
    await p2.query("SELECT 1");
  } catch {
    await p1.end();
    await p2.end();
    t.skip("PostgreSQL unreachable");
    return;
  }
  try {
    assertTestDb(DSN);
    await p1.query("DROP SCHEMA public CASCADE");
    await p1.query("CREATE SCHEMA public");
    const [r1, r2] = await Promise.all([
      migratePg(p1, "concurrent-a"),
      migratePg(p2, "concurrent-b"),
    ]);
    assert.ok(
      (r1.length > 0) !== (r2.length > 0),
      "exactly one side applied migrations, the other waited (serialized)",
    );
    const dups = (await p1.query(
      "SELECT version FROM schema_migrations GROUP BY version HAVING COUNT(*) > 1",
    )).rows;
    assert.equal(dups.length, 0, "no duplicate migration versions");
  } finally {
    await p1.end();
    await p2.end();
  }
});
