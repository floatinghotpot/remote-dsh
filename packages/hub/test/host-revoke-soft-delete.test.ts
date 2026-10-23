/**
 * host 软删（leave / 管理员吊销）语义：行保留、业务查询不可见、历史用量仍可查。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { HubDb } from "../src/db.ts";
import { createSqliteStore } from "../src/store.ts";
import { hashPassword } from "../src/auth.ts";

test("软删 host：行保留 + 业务查询不可见 + 历史用量仍可查", async () => {
  const db = new HubDb(":memory:");
  const store = createSqliteStore(db);
  try {
    const alice = db.createUser("alice", await hashPassword("pw"));
    const bob = db.createUser("bob", await hashPassword("pw"));
    await store.createHost("host-abc", alice.id, "abc", "hash-1", "pubkey");
    await store.shareHost("host-abc", bob.id, "member");
    db.upsertUsageDaily(
      alice.id,
      { date: "2026-10-01", relaySeconds: 1, relayBytesUp: 10, relayBytesDown: 20, directBytesUp: 0, directBytesDown: 0, cloudAsrSeconds: 0, localAsrSeconds: 0, cloudTtsChars: 0, localTtsChars: 0, sessions: 1 },
      { hostId: "host-abc", instanceId: "i1" },
    );

    assert.equal((await store.getHostById("host-abc"))?.id, "host-abc");
    assert.equal((await store.listUsageDailyByHost("host-abc", "2026-01-01", "2026-12-31")).length, 1);

    assert.equal(await store.revokeHostRecord("host-abc"), true);

    // 业务视角：全部不可见
    assert.equal(await store.getHostById("host-abc"), null);
    assert.equal(await store.findHostByTokenHash("hash-1"), null);
    assert.deepEqual(await store.listHostsByOwner(alice.id), []);
    assert.deepEqual(await store.listHostsForUser(bob.id), []);
    assert.equal((await store.listHostsPage({})).total, 0);
    assert.deepEqual(await store.countHostsByOwner(), []);
    assert.deepEqual(await store.listHostsByNode("node-x"), []);

    // 行仍在（软删而非物理删除）
    const raw = db.db.prepare("SELECT revoked_at, token_hash, name, owner_id FROM hosts WHERE id = ?").get("host-abc") as Record<string, unknown> | undefined;
    assert.ok(raw !== undefined, "host 行不应被物理删除");
    assert.equal(raw.name, "abc");
    assert.equal(Number(raw.owner_id), alice.id);
    assert.match(String(raw.token_hash), /^revoked:/, "旧 host token 必须失效");
    assert.ok(raw.revoked_at !== null && raw.revoked_at !== undefined, "应写入 revoked_at");

    // 历史用量仍可查（不再产生孤儿入口）
    assert.equal((await store.listUsageDailyByHost("host-abc", "2026-01-01", "2026-12-31")).length, 1);

    // 幂等：重复吊销返回 false
    assert.equal(await store.revokeHostRecord("host-abc"), false);
  } finally {
    db.close();
  }
});
