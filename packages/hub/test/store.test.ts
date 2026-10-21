/**
 * 43a：异步 HubStore 门面（SQLite 实现）基础契约。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { HubDb } from "../src/db.ts";
import { createSqliteStore } from "../src/store.ts";

test("store：SQLite 异步门面与直接 HubDb 结果一致", async () => {
  const db = new HubDb(":memory:");
  const store = createSqliteStore(db);

  const user = await store.createUser("store-user", "hash");
  assert.equal(user.name, "store-user");
  const again = await store.getUserByName("store-user");
  assert.equal(again?.id, user.id);

  // void 方法也返回 Promise（可 await）
  await store.markNodeAlive("missing-node");

  // 批量用量写入
  await store.upsertUsageDailyBatch([
    {
      userId: user.id,
      day: {
        date: "2026-10-19",
        relaySeconds: 0,
        relayBytesUp: 10,
        relayBytesDown: 0,
        directBytesUp: 0,
        directBytesDown: 0,
        cloudAsrSeconds: 0,
        localAsrSeconds: 0,
        cloudTtsChars: 0,
        localTtsChars: 0,
        sessions: 1,
      },
      meta: { hostId: "h1", instanceId: "i1", source: "gateway" },
    },
  ]);
  const rows = db.listUsageDailyByHost("h1", "2026-10-19", "2026-10-19");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.relayBytesUp, 10);

  db.close();
});
