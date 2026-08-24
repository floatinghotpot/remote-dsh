import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireJoinLock, releaseJoinLock, readJoinLock } from "../src/lock.ts";

async function tmpLockPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "rdsh-lock-")), "join.lock");
}

test("acquire → read 往返（pid + role）→ release 清空", () => {
  const path = join(tmpdir(), "rdsh-lock-x", "join.lock");
  assert.equal(acquireJoinLock("plugin", path).ok, true);
  const held = readJoinLock(path);
  assert.ok(held !== null);
  assert.equal(held.pid, process.pid);
  assert.equal(held.role, "plugin");
  releaseJoinLock(path);
  assert.equal(readJoinLock(path), null);
});

test("他人活锁（pid 1）→ 拒绝且不覆盖", async () => {
  const path = await tmpLockPath();
  writeFileSync(path, JSON.stringify({ pid: 1, role: "cli" }));
  const res = acquireJoinLock("plugin", path);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.heldBy.pid, 1);
    assert.equal(res.heldBy.role, "cli");
  }
  // 未被覆盖
  const held = readJoinLock(path);
  assert.equal(held?.role, "cli");
});

test("stale 锁（已死 pid）→ 视为无锁并清除文件", async () => {
  const path = await tmpLockPath();
  // 极大 pid（几乎不可能存活）
  writeFileSync(path, JSON.stringify({ pid: 2147483647, role: "cli" }));
  assert.equal(readJoinLock(path), null);
  assert.equal(existsSync(path), false);
});

test("损坏/非法 role → null", async () => {
  const path = await tmpLockPath();
  writeFileSync(path, "not json");
  assert.equal(readJoinLock(path), null);
  writeFileSync(path, JSON.stringify({ pid: 1, role: "bogus" }));
  assert.equal(readJoinLock(path), null);
});

test("release 不误删他人锁", async () => {
  const path = await tmpLockPath();
  writeFileSync(path, JSON.stringify({ pid: 1, role: "cli" }));
  releaseJoinLock(path); // 锁是 pid 1，不是本进程 → 不删
  assert.equal(readJoinLock(path)?.pid, 1);
});
