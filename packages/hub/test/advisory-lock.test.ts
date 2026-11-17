/**
 * 71 B4：withAdvisoryLock —— 拿锁才执行、拿不到跳过、finally 必 unlock + release。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withAdvisoryLock } from "../src/pg.ts";
import type { Pool } from "pg";

function fakePool(ok: boolean): { pool: Pool; calls: string[] } {
  const calls: string[] = [];
  const client = {
    query: async (sql: string) => {
      calls.push(sql);
      if (sql.includes("pg_try_advisory_lock")) return { rows: [{ ok }] };
      return { rows: [] };
    },
    release: () => {
      calls.push("release");
    },
  };
  const pool = { connect: async () => client } as unknown as Pool;
  return { pool, calls };
}

test("B4：拿到锁 → 执行 fn，unlock + release", async () => {
  const { pool, calls } = fakePool(true);
  let ran = 0;
  const r = await withAdvisoryLock(pool, "k", async () => {
    ran += 1;
    return 42;
  });
  assert.equal(r.acquired, true);
  assert.equal(r.value, 42);
  assert.equal(ran, 1);
  assert.ok(calls.some((c) => c.includes("pg_advisory_unlock")), "必须 unlock（否则回池泄漏）");
  assert.equal(calls.at(-1), "release");
});

test("B4：拿不到锁 → 跳过 fn，仍 release（不阻塞、不泄漏）", async () => {
  const { pool, calls } = fakePool(false);
  let ran = 0;
  const r = await withAdvisoryLock(pool, "k", async () => {
    ran += 1;
    return 1;
  });
  assert.equal(r.acquired, false);
  assert.equal(ran, 0, "拿不到锁不得执行 fn");
  assert.ok(!calls.some((c) => c.includes("pg_advisory_unlock")), "没拿到锁就无需 unlock");
  assert.equal(calls.at(-1), "release");
});

test("B4：fn 抛错 → 仍 unlock + release", async () => {
  const { pool, calls } = fakePool(true);
  await assert.rejects(
    () =>
      withAdvisoryLock(pool, "k", async () => {
        throw new Error("boom");
      }),
    /boom/,
  );
  assert.ok(calls.some((c) => c.includes("pg_advisory_unlock")));
  assert.equal(calls.at(-1), "release");
});
