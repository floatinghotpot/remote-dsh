#!/usr/bin/env node
/**
 * V3 — 用户缓存刷新成本（70 V1 压测 harness）。
 *
 * 在临时 SQLite 库播种 N 个用户，测全表 `listUsers()` 的耗时（旧 reload 等价成本）。
 *
 * 说明：A1 之后 reload 走 PG 的增量 `listUsersSince(change_seq > lastSeq)`（O(变化量)），
 * SQLite 模式无用户缓存、也不建 change_seq 列，故「增量成本」只能在 PG 上测，本脚本只
 * 测「全表成本」作为改前基线。
 *
 * Usage:
 *   node bench-cache.mjs --users 100000
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = parseArgs(process.argv.slice(2));
const n = Number(args.users ?? 100000);
const dbUrl = new URL("../../packages/hub/src/db.ts", import.meta.url).href;
const { HubDb } = await import(dbUrl);

const dir = mkdtempSync(join(tmpdir(), "rdsh-bench-"));
const db = new HubDb(join(dir, "hub.db"));

const t0 = performance.now();
db.db.exec("BEGIN"); // 批量播种：单事务，避免逐条 fsync
for (let i = 0; i < n; i++) db.createUser(`u${i}`, "x");
db.db.exec("COMMIT");
const seedMs = performance.now() - t0;

const t1 = performance.now();
const all = db.listUsers();
const fullMs = performance.now() - t1;

console.log(JSON.stringify({
  users: n,
  seedMs: Number(seedMs.toFixed(0)),
  fullListUsersMs: Number(fullMs.toFixed(1)),
  note: "A1 后 reload 走 PG 增量（O(变化量)）；全表成本仅作改前基线",
}, null, 2));
process.exit(0);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const k = a.slice(2);
    out[k] = argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
  }
  return out;
}
