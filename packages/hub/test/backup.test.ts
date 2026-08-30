/**
 * backup.test.ts — 每日快照（VACUUM INTO）+ 保留策略 + 最近备份时间。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HubDb } from "../src/db.ts";
import { backupNow, pruneBackups, lastBackupAt } from "../src/backup.ts";

test("backupNow：生成一致快照文件", () => {
  const dir = mkdtempSync(join(tmpdir(), "rdsh-bak-"));
  const db = new HubDb(":memory:");
  db.createUser("alice", "hash");
  const { path, at } = backupNow(db, dir);
  assert.ok(existsSync(path));
  assert.ok(path.endsWith(".db"));
  assert.ok(at > 0);
  // 快照可被新实例打开（一致性验证）
  const snap = new HubDb(path);
  assert.equal(snap.getUserByName("alice")!.name, "alice");
  snap.close();
  db.close();
});

test("lastBackupAt + pruneBackups：保留策略", () => {
  const dir = mkdtempSync(join(tmpdir(), "rdsh-bak2-"));
  const db = new HubDb(":memory:");
  const { path } = backupNow(db, dir);
  assert.equal(lastBackupAt(dir) !== null, true);
  // 保留 7 天：当前快照不会被清
  pruneBackups(dir, 7);
  assert.ok(existsSync(path));
  assert.equal(readdirSync(dir).filter((f) => f.endsWith(".db")).length, 1);
  db.close();
});

test("lastBackupAt：空目录返回 null", () => {
  const dir = mkdtempSync(join(tmpdir(), "rdsh-bak3-"));
  assert.equal(lastBackupAt(dir), null);
});
