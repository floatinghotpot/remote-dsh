import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeLock, describeJoinLockAt, forceUnlockJoinLock } from "../src/lock-report.ts";
import type { DescribeLockInput, ProcessProbe } from "../src/lock-report.ts";
import type { RawJoinLock } from "../src/lock.ts";

const NOW = 1_000_000_000_000;
const SELF = 4242;

function raw(lock: RawJoinLock["lock"], corrupt: boolean, mtimeMs: number | null): RawJoinLock {
  return { lock, corrupt, mtimeMs };
}

function probe(p: ProcessProbe | null): ProcessProbe | null {
  return p;
}

function report(input: Partial<DescribeLockInput> & { raw: RawJoinLock }) {
  return describeLock({ selfPid: SELF, now: NOW, probe: null, ...input });
}

test("describeLock：锁不存在 → none / unnecessary", () => {
  const r = report({ raw: raw(null, false, null) });
  assert.equal(r.reason, "none");
  assert.equal(r.held, false);
  assert.equal(r.unlock, "unnecessary");
});

test("describeLock：损坏且过保护期 → damaged / allowed", () => {
  const r = report({ raw: raw(null, true, NOW - 10_000) });
  assert.equal(r.reason, "damaged");
  assert.equal(r.unlock, "allowed");
});

test("describeLock：损坏但很新鲜 → fresh-corrupt / blocked", () => {
  const r = report({ raw: raw(null, true, NOW - 100) });
  assert.equal(r.reason, "fresh-corrupt");
  assert.equal(r.unlock, "blocked");
});

test("describeLock：pid 已死 → dead / allowed", () => {
  const r = report({ raw: raw({ pid: 99999, role: "plugin" }, false, NOW - 10_000), probe: probe({ alive: false }) });
  assert.equal(r.reason, "dead");
  assert.equal(r.alive, false);
  assert.equal(r.unlock, "allowed");
});

test("describeLock：活着且非复用 → alive / blocked", () => {
  // 持有者启动时间（NOW-5000）早于锁写入时间（NOW-1000）→ 合法持有者
  const r = report({
    raw: raw({ pid: 99999, role: "plugin" }, false, NOW - 1_000),
    probe: probe({ alive: true, startedAtMs: NOW - 5_000, command: "dsh --profile web" }),
  });
  assert.equal(r.reason, "alive");
  assert.equal(r.confirmed, true);
  assert.equal(r.unlock, "blocked");
});

test("describeLock：pid 复用（启动晚于锁写入）→ pid-reuse / allowed", () => {
  const r = report({
    raw: raw({ pid: 99999, role: "plugin" }, false, NOW - 10_000),
    probe: probe({ alive: true, startedAtMs: NOW - 1_000, command: "unrelated-process" }),
  });
  assert.equal(r.reason, "pid-reuse");
  assert.equal(r.pidReuse, true);
  assert.equal(r.unlock, "allowed");
});

test("describeLock：活着但 ps 不可用 → unconfirmed / allowed（用户原决定）", () => {
  const r = report({
    raw: raw({ pid: 99999, role: "plugin" }, false, NOW - 10_000),
    probe: probe({ alive: true }),
  });
  assert.equal(r.reason, "unconfirmed");
  assert.equal(r.confirmed, false);
  assert.equal(r.unlock, "allowed");
});

test("describeLock：本进程自己的 pid → self / blocked", () => {
  const r = report({ raw: raw({ pid: SELF, role: "plugin" }, false, NOW - 10_000), probe: probe({ alive: true }) });
  assert.equal(r.reason, "self");
  assert.equal(r.unlock, "blocked");
});

test("forceUnlockJoinLock：alive → 不删文件", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "rdsh-lock-report-")), "join.lock");
  writeFileSync(path, JSON.stringify({ pid: 99999, role: "plugin" }));
  const res = await forceUnlockJoinLock(path, { probe: async () => ({ alive: true, startedAtMs: 0 }) });
  assert.equal(res.reason, "alive");
  assert.equal(res.removed, false);
  assert.equal(existsSync(path), true, "活锁不得删除");
});

test("forceUnlockJoinLock：dead → 删除文件", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "rdsh-lock-report-")), "join.lock");
  writeFileSync(path, JSON.stringify({ pid: 99999, role: "plugin" }));
  const res = await forceUnlockJoinLock(path, { probe: async () => ({ alive: false }) });
  assert.equal(res.reason, "dead");
  assert.equal(res.removed, true);
  assert.equal(existsSync(path), false);
});

test("forceUnlockJoinLock：pid-reuse → 删除文件", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "rdsh-lock-report-")), "join.lock");
  writeFileSync(path, JSON.stringify({ pid: 99999, role: "plugin" }));
  // 锁很旧 → 持有者"现在才启动"即 pid 复用（进程启动时间晚于锁写入时间）
  const old = Date.now() / 1000 - 60;
  utimesSync(path, old, old);
  const res = await forceUnlockJoinLock(path, { probe: async () => ({ alive: true, startedAtMs: Date.now() }) });
  assert.equal(res.reason, "pid-reuse");
  assert.equal(res.removed, true);
});

test("forceUnlockJoinLock：锁不存在 → unnecessary 且不删", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "rdsh-lock-report-")), "join.lock");
  const res = await forceUnlockJoinLock(path, { probe: async () => ({ alive: false }) });
  assert.equal(res.reason, "none");
  assert.equal(res.removed, false);
});

test("forceUnlockJoinLock：判定与删除之间锁被替换 → 不删（CAS 兜底）", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "rdsh-lock-report-")), "join.lock");
  writeFileSync(path, JSON.stringify({ pid: 99999, role: "plugin" }));
  const old = Date.now() / 1000 - 60;
  utimesSync(path, old, old);
  // probe 执行期间，另一实例把残锁替换成了新活锁 → 判定基于旧快照说"dead/allowed"，
  // 但 CAS 必须发现 inode/内容已变，拒绝删除。
  const res = await forceUnlockJoinLock(path, {
    probe: async () => {
      writeFileSync(path, JSON.stringify({ pid: 1, role: "cli" }));
      return { alive: false };
    },
  });
  assert.equal(res.removed, false);
  assert.equal(existsSync(path), true);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).pid, 1);
});

test("describeJoinLockAt：损坏的锁能被看到（不判活）", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "rdsh-lock-report-")), "join.lock");
  writeFileSync(path, "{ not json");
  const r = await describeJoinLockAt(path, { probe: async () => ({ alive: false }) });
  assert.equal(r.corrupt, true);
  assert.equal(r.held, false);
});
