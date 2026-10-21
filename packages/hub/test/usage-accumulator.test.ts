/**
 * 42-hub-write-path P0：UsageAccumulator 批量/幂等/降级。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { HubDb } from "../src/db.ts";
import { createSqliteStore } from "../src/store.ts";
import { UsageAccumulator, localDate } from "../src/relay-usage.ts";

function day(date: string, up: number) {
  return {
    date,
    relaySeconds: 0,
    relayBytesUp: up,
    relayBytesDown: 0,
    directBytesUp: 0,
    directBytesDown: 0,
    cloudAsrSeconds: 0,
    localAsrSeconds: 0,
    cloudTtsChars: 0,
    localTtsChars: 0,
    sessions: 1,
  };
}

test("usage accumulator：10k host 上报 → 分 chunk 批写，不逐行写", async () => {
  const db = new HubDb(":memory:");
  const user = db.createUser("load-user", "hash");
  const acc = new UsageAccumulator(createSqliteStore(db));
  const today = localDate();

  let batchCalls = 0;
  let rowsWritten = 0;
  let begins = 0;
  const orig = db.upsertUsageDailyBatch.bind(db);
  (db as unknown as { upsertUsageDailyBatch: typeof db.upsertUsageDailyBatch }).upsertUsageDailyBatch = ((rows, chunk) => {
    batchCalls += 1;
    rowsWritten += rows.length;
    return orig(rows, chunk);
  }) as typeof db.upsertUsageDailyBatch;
  const origExec = db.db.exec.bind(db.db);
  db.db.exec = ((sql: string) => {
    if (sql.startsWith("SAVEPOINT usage_chunk")) begins += 1;
    return origExec(sql);
  }) as typeof db.db.exec;

  for (let i = 0; i < 10_000; i += 1) acc.reportHostUsage(user.id, `host-${i}`, "inst-1", day(today, 1));
  await acc.flush();

  assert.equal(rowsWritten, 10_000, "10k 个 (user,host) key 聚合成 10k 行");
  assert.equal(batchCalls, 1, "一次 flush 调用批处理方法");
  assert.equal(begins, 20, "10k 行 / chunk 500 = 20 个批次事务");
  const rows = db.listUsageDaily(user.id, today, today);
  assert.equal(rows.length, 1, "按 user×date 聚合后只有一行");
  db.close();
});

test("usage accumulator：同一 host 重复上报取 MAX（幂等）", async () => {
  const db = new HubDb(":memory:");
  const user = db.createUser("max-user", "hash");
  const acc = new UsageAccumulator(createSqliteStore(db));
  const today = localDate();
  acc.reportHostUsage(user.id, "h1", "inst-1", day(today, 100));
  acc.reportHostUsage(user.id, "h1", "inst-1", day(today, 80));
  acc.reportHostUsage(user.id, "h1", "inst-1", day(today, 120));
  await acc.flush();
  const rows = db.listUsageDailyByHost("h1", today, today);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.relayBytesUp, 120, "取 MAX，不是相加");
  db.close();
});

test("usage accumulator：flush 失败保留 dirty，下次可重试", async () => {
  const db = new HubDb(":memory:");
  const user = db.createUser("retry-user", "hash");
  const acc = new UsageAccumulator(createSqliteStore(db));
  const today = localDate();
  let fail = true;
  const orig = db.upsertUsageDailyBatch.bind(db);
  (db as unknown as { upsertUsageDailyBatch: typeof db.upsertUsageDailyBatch }).upsertUsageDailyBatch = ((rows, chunk) => {
    if (fail) throw new Error("db locked");
    return orig(rows, chunk);
  }) as typeof db.upsertUsageDailyBatch;

  acc.reportHostUsage(user.id, "h1", "inst-1", day(today, 5));
  await assert.rejects(() => acc.flush(), /db locked/);
  assert.equal(acc.stats().dirty, 1, "失败后 dirty 保留");
  fail = false;
  await acc.flush();
  assert.equal(acc.stats().dirty, 0);
  assert.equal(db.listUsageDailyByHost("h1", today, today)[0]!.relayBytesUp, 5);
  db.close();
});

test("usage accumulator：RDSH_USAGE_BATCH=0 回退单行直写", async () => {
  const prev = process.env.RDSH_USAGE_BATCH;
  process.env.RDSH_USAGE_BATCH = "0";
  try {
    const db = new HubDb(":memory:");
    const user = db.createUser("direct-user", "hash");
    const acc = new UsageAccumulator(createSqliteStore(db));
    const today = localDate();
    await acc.reportHostUsage(user.id, "h1", "inst-1", day(today, 7));
    assert.equal(db.listUsageDailyByHost("h1", today, today).length, 1, "无需 flush 即落库");
    db.close();
  } finally {
    if (prev === undefined) delete process.env.RDSH_USAGE_BATCH;
    else process.env.RDSH_USAGE_BATCH = prev;
  }
});
