/**
 * usage-migration.test.ts — 11-usage-analytics：`usage_daily` 遗留库迁移 + relay meter 写放大回归。
 *
 * 覆盖测试环境 F17（既有库缺迁移 ⇒ 现网写入全挂）与 F16（每次 flush 全量 upsert 的写放大）。
 * 这两个问题都是「新建内存库」的单测结构性漏检的：前者只在**旧 schema 库**上出现，
 * 后者只在**多 (user,host) 且只有部分有流量**时出现。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HubDb } from "../src/db.ts";
import { hashPassword } from "../src/auth.ts";
import { RelayUsageMeter } from "../src/relay-usage.ts";

/** 造一个「旧 schema」的库：usage_daily 只有 12 列 + UNIQUE(user_id, date)。 */
function makeLegacyDb(path: string): void {
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL, ver INTEGER NOT NULL DEFAULT 0, must_change INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE usage_daily (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      relay_seconds INTEGER NOT NULL DEFAULT 0,
      relay_bytes_up INTEGER NOT NULL DEFAULT 0,
      relay_bytes_down INTEGER NOT NULL DEFAULT 0,
      direct_bytes_up INTEGER NOT NULL DEFAULT 0,
      direct_bytes_down INTEGER NOT NULL DEFAULT 0,
      cloud_asr_seconds INTEGER NOT NULL DEFAULT 0,
      local_asr_seconds INTEGER NOT NULL DEFAULT 0,
      sessions INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      UNIQUE(user_id, date)
    );
    INSERT INTO users (id, name, password_hash, created_at) VALUES (1, 'legacy', 'x', '2026-01-01');
    INSERT INTO usage_daily (user_id, date, relay_bytes_up, updated_at) VALUES (1, '2026-10-01', 777, 0);
  `);
  old.close();
}

test("迁移：旧 usage_daily schema 自动重建，旧行保留且可按多 host 写（F17）", () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-usage-migrate-"));
  const path = join(dir, "hub.db");
  try {
    makeLegacyDb(path);

    // 新代码打开 → 触发迁移守卫
    const db = new HubDb(path);

    // ① 旧行保留（回填 host_id=''）
    const legacy = db.listUsageDaily(1, "2026-10-01", "2026-10-01");
    assert.equal(legacy.length, 1, "旧行应保留");
    assert.equal(legacy[0]!.relayBytesUp, 777, "旧行数值应保留");

    // ② 同一 user+day 可为两个不同 host 各写一行（旧 UNIQUE(user_id,date) 会拒绝第二行）
    const day = {
      date: "2026-10-10",
      relaySeconds: 0,
      relayBytesUp: 100,
      relayBytesDown: 0,
      directBytesUp: 0,
      directBytesDown: 0,
      cloudAsrSeconds: 0,
      localAsrSeconds: 0,
      sessions: 1,
    };
    db.upsertUsageDaily(1, day, { hostId: "h1", instanceId: "a", source: "relay" });
    db.upsertUsageDaily(1, { ...day, relayBytesUp: 50 }, { hostId: "h2", instanceId: "a", source: "relay" });

    // ③ 用户视图按 date 求和
    const userView = db.listUsageDaily(1, "2026-10-10", "2026-10-10");
    assert.equal(userView.length, 1, "按 date 聚合为一行");
    assert.equal(userView[0]!.relayBytesUp, 150, "两 host 各一行，求和 = 150");

    // ④ owner 视图（GROUP BY host_id）可查
    assert.equal(db.listUsageDailyByHost("h1", "2026-10-10", "2026-10-10")[0]!.relayBytesUp, 100);
    assert.equal(db.listUsageDailyByHost("h2", "2026-10-10", "2026-10-10")[0]!.relayBytesUp, 50);

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("迁移幂等：新库（或已迁移库）再次打开不报错", () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-usage-idem-"));
  const path = join(dir, "hub.db");
  try {
    const db1 = new HubDb(path);
    db1.close();
    // 第二次打开：usage_daily 已含 host_id ⇒ 迁移跳过
    const db2 = new HubDb(path);
    assert.equal(db2.listUsageDaily(1, "2026-10-01", "2026-10-01").length, 0);
    db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("relay meter：flush 只上报变更行（F16 写放大）", async () => {
  const db = new HubDb(":memory:");
  const user = db.createUser("f16-user", await hashPassword("pw123456"));
  const meter = new RelayUsageMeter(db);

  // 先让 3 个 (user,host) 都产生流量 → 首次 flush 应写 3 行
  let calls = 0;
  const orig = db.upsertUsageDaily.bind(db);
  (db as unknown as { upsertUsageDaily: typeof db.upsertUsageDaily }).upsertUsageDaily = ((...args: Parameters<typeof orig>) => {
    calls += 1;
    return orig(...args);
  }) as typeof db.upsertUsageDaily;

  meter.addBytes(user.id, "h1", 1, 0);
  meter.addBytes(user.id, "h2", 1, 0);
  meter.addBytes(user.id, "h3", 1, 0);
  meter.flush();
  assert.equal(calls, 3, "首次 flush 写 3 行");

  // 之后只有 h1 有流量 → 本次 flush 只应写 1 行（不是 3 行）
  calls = 0;
  meter.addBytes(user.id, "h1", 5, 0);
  meter.flush();
  assert.equal(calls, 1, "只 upsert 有变更的那 1 行");

  db.close();
});
