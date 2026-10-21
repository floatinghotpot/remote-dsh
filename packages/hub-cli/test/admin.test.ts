/**
 * 48-hub-admin 冒烟测试：`rdsh-hub setup` / `db check` / `user add`（backend-aware）。
 * 依赖已构建的 dist/bin.js；postgres 用例如 PG 不可达则跳过。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPgPool } from "rdsh-hub";

const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "bin.js");
// 独立库 rdsh_admin：避免与 hub 包测试（rdsh_test/rdsh_parity/rdsh_boot/rdsh_migrate）并行 DROP SCHEMA 竞争。
const DSN = process.env.RDSH_TEST_PG_DSN ?? "postgres://rdsh:rdsh_dev_password@127.0.0.1:5432/rdsh_admin";

function run(args: string[], input?: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [bin, ...args], { encoding: "utf8", timeout: 20_000, input });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

test("rdsh-hub setup --db sqlite --behind-proxy writes hub.json", () => {
  assert.ok(existsSync(bin), "dist/bin.js missing — run `pnpm build` first");
  const dir = mkdtempSync(join(tmpdir(), "rdsh-setup-"));
  const cfg = join(dir, "hub.json");
  const r = run(["setup", "--db", "sqlite", "--behind-proxy", "--config", cfg]);
  assert.equal(r.status, 0, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.ok(existsSync(cfg), "hub.json written");
  const parsed = JSON.parse(readFileSync(cfg, "utf8")) as { behindProxy?: boolean };
  assert.equal(parsed.behindProxy, true);
  rmSync(dir, { recursive: true, force: true });
});

test("rdsh-hub setup --db postgres with bad DSN fails without writing hub.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "rdsh-setup-bad-"));
  const cfg = join(dir, "hub.json");
  const r = run(["setup", "--db", "postgres", "--dsn", "postgres://rdsh:bad@127.0.0.1:1/nope", "--behind-proxy", "--config", cfg]);
  assert.notEqual(r.status, 0, "bad DSN must fail");
  assert.match(r.stderr, /postgres unreachable|connection refused|ECONNREFUSED/i);
  assert.ok(!existsSync(cfg), "hub.json must not be written on validation failure");
  rmSync(dir, { recursive: true, force: true });
});

test("rdsh-hub db check (sqlite) reports backend", () => {
  const dir = mkdtempSync(join(tmpdir(), "rdsh-check-"));
  const cfg = join(dir, "hub.json");
  writeFileSync(cfg, JSON.stringify({ behindProxy: true }));
  const r = run(["db", "check", "--config", cfg]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /db backend: sqlite/);
  rmSync(dir, { recursive: true, force: true });
});

test("rdsh-hub user add (postgres) lands in PG", async (t) => {
  const probe = createPgPool(DSN, { max: 2, min: 0 });
  try {
    await probe.query("SELECT 1");
  } catch {
    await probe.end();
    t.skip("PostgreSQL unreachable");
    return;
  }
  await probe.end();

  const dir = mkdtempSync(join(tmpdir(), "rdsh-admin-"));
  const cfg = join(dir, "hub.json");
  writeFileSync(cfg, JSON.stringify({ db: { driver: "postgres", dsn: DSN } }));

  const name = `cliadmin${Date.now()}`;
  const r = run(["user", "add", name, "--config", cfg], "password123\npassword123\n");
  assert.equal(r.status, 0, `stdout=${r.stdout} stderr=${r.stderr}`);

  const pool = createPgPool(DSN, { max: 2 });
  try {
    const got = (await pool.query("SELECT name, role FROM users WHERE name=$1", [name])).rows[0];
    assert.ok(got, "user must exist in PG");
    assert.equal(got.role, "user");
    // 清理
    await pool.query("DELETE FROM users WHERE name=$1", [name]);
  } finally {
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
  }
});
