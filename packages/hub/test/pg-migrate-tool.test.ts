/**
 * 48：migrateSqliteToPg 对拍——用 HubDb 造 SQLite 数据，跑并入 rdsh-hub 的迁移逻辑。
 * 跳过条件：PG 不可达。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HubDb } from "../src/db.ts";
import { createPgPool } from "../src/pg.ts";
import { createPgStore } from "../src/pg-store/index.ts";
import { migrateSqliteToPg, verify } from "../src/migrate.ts";

const DSN = process.env.RDSH_TEST_PG_DSN ?? "postgres://rdsh:rdsh_dev_password@127.0.0.1:5432/rdsh_migrate";

test("migration tool：SQLite → PG copy + verify 一致", async (t) => {
  // 1) 造 SQLite 数据
  const dir = mkdtempSync(join(tmpdir(), "rdsh-migrate-"));
  const src = join(dir, "hub.db");
  const db = new HubDb(src);
  const u = db.createUser("alice", "hash");
  db.setEmail(u.id, "alice@test.local");
  db.setPlan(u.id, "subscribed", Date.now() + 86_400_000);
  const h = db.createHost("h1", u.id, "pc", "tokhash");
  db.createOrder("o1", u.id, "pro", 39);
  db.markOrderPaid("o1", "unicpay", "p1");
  db.appendCreditLedger(u.id, 800 * 10000, "purchased", "recharge", { idempotencyKey: "unicpay:p1", sourceType: "unicpay", sourceId: "p1" });
  db.upsertUsageDaily(u.id, { date: "2026-10-19", relaySeconds: 0, relayBytesUp: 100, relayBytesDown: 0, directBytesUp: 0, directBytesDown: 0, cloudAsrSeconds: 0, localAsrSeconds: 0, cloudTtsChars: 0, localTtsChars: 0, sessions: 1 }, { hostId: h.id, instanceId: "i1", source: "gateway" });
  db.recordAudit(u.id, "test.evt", { k: "v" }, "127.0.0.1");
  db.createNode("n1", "n1", "https://n1.example", "nh", "sg", 100, 10, true, null);
  db.close();

  const pool = createPgPool(DSN, { max: 3, min: 0 });
  try {
    await pool.query("SELECT 1");
  } catch {
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
    t.skip("PostgreSQL unreachable");
    return;
  }
  try {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    // 刻意不预建 schema：migrateSqliteToPg 应自己 migratePg 建表（覆盖空库路径）

    const rep = await migrateSqliteToPg({ source: src, dsn: DSN, backupDir: join(dir, "backups") });
    assert.equal(rep.verify.ok, true, JSON.stringify(rep.verify.mismatches));
    assert.ok((rep.copied as Record<string, number>).users! >= 1, "users copied");

    // db verify 路径复核一致
    const v = await verify(src, DSN);
    assert.equal(v.ok, true, JSON.stringify(v.mismatches));

    // 账本一致
    const bal = (await pool.query(`SELECT COALESCE(SUM(purchased_credits),0) AS c FROM users`)).rows[0]!.c;
    assert.equal(Number(bal), 800 * 10000);

    // identity 序列已推进：迁移后新建用户 id 应大于已迁最大 id（否则新插入会撞主键）
    const store = createPgStore(pool);
    const bob = await store.createUser("bob", "hash");
    assert.ok(bob.id > 1, `sequence not advanced (bob.id=${bob.id})`);
  } finally {
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
  }
});
