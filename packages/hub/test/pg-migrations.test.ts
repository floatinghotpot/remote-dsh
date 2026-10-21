/**
 * 43b-1：PG migrations 冒烟（需可连通的 PostgreSQL）。
 * DSN 缺省指向本地 dev 库 `rdsh_test`；用 RDSH_TEST_PG_DSN 覆盖。不可达则跳过。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPgPool, migratePg } from "../src/pg.ts";

const DSN = process.env.RDSH_TEST_PG_DSN ?? "postgres://rdsh:rdsh_dev_password@127.0.0.1:5432/rdsh_test";

test("pg migrations：应用 20 表 + usage_daily 分区 + 幂等", async (t) => {
  const pool = createPgPool(DSN, { max: 2, min: 0 });
  try {
    await pool.query("SELECT 1");
  } catch {
    await pool.end();
    t.skip("PostgreSQL unreachable");
    return;
  }
  try {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    const applied = await migratePg(pool);
    assert.ok(applied.includes("0001_init.sql"), "0001_init.sql applied");

    const tables = (await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`,
    )).rows.map((r) => r.table_name) as string[];
    const expect = [
      "users", "hosts", "refresh_tokens", "join_tokens", "bind_sessions", "host_share",
      "audit_events", "email_codes", "sms_codes", "subscriptions", "orders", "payments",
      "credits_ledger", "meta", "apple_tokens", "usage_daily", "usage_daily_default",
      "nodes", "node_metrics", "relay_join_tokens", "relay_join_events",
    ];
    for (const name of expect) assert.ok(tables.includes(name), `missing table ${name}`);

    const relkind = (await pool.query(`SELECT relkind FROM pg_class WHERE relname='usage_daily'`)).rows[0]!.relkind;
    assert.equal(relkind, "p", "usage_daily is partitioned");

    const again = await migratePg(pool);
    assert.equal(again.length, 0, "migration is idempotent");
  } finally {
    await pool.end();
  }
});
