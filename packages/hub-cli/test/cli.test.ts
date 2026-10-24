/**
 * 47-cli-split 冒烟测试：验证 `rdsh-hub` 命令面
 * （serve|user|audit|host|router|relay|service；`node` 已移除）。
 * 依赖已构建的 dist/bin.js —— 需先 `pnpm build`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const execFileP = promisify(execFile);
const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "bin.js");

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

async function run(args: string[]): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [bin, ...args], { encoding: "utf8", timeout: 15_000 });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code ?? 1 };
  }
}

test("rdsh-hub --version", async () => {
  assert.ok(existsSync(bin), "dist/bin.js missing — run `pnpm build` first");
  const r = await run(["--version"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^rdsh-hub \d+\.\d+\.\d+/);
});

test("rdsh-hub --help lists serve|user|audit|host|relay|service, no node", async () => {
  const r = await run(["--help"]);
  assert.equal(r.code, 0);
  for (const sub of ["serve", "user", "audit", "host", "relay", "service"]) {
    assert.match(r.stdout, new RegExp(`rdsh-hub ${sub}`), `missing rdsh-hub ${sub}`);
  }
  assert.doesNotMatch(r.stdout, /rdsh-hub node/);
});

test("rdsh-hub node -> usage error (node removed)", async () => {
  const r = await run(["node"]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /usage: rdsh-hub /);
});

test("rdsh-hub relay --help lists the 6 subcommands", async () => {
  const r = await run(["relay", "--help"]);
  assert.equal(r.code, 0);
  for (const sub of ["ls", "invite", "enable", "disable", "revoke", "rename"]) {
    assert.match(r.stdout, new RegExp(sub), `missing relay ${sub}`);
  }
});

test("rdsh-hub relay (no action) -> usage error", async () => {
  const r = await run(["relay"]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /usage: rdsh-hub relay /);
});

test("rdsh-hub relay ls + invite (temp sqlite)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rdsh-hub-relay-"));
  try {
    const cfg = join(dir, "hub.json");
    await writeFile(cfg, JSON.stringify({ dbPath: join(dir, "hub.db") }));

    const ls = await run(["relay", "ls", "--config", cfg]);
    assert.equal(ls.code, 0, ls.stderr);
    assert.match(ls.stdout, /\(no relay nodes\)/);

    const inv = await run(["relay", "invite", "--name", "staging-relay-01", "--config", cfg]);
    assert.equal(inv.code, 0, inv.stderr);
    const out = JSON.parse(inv.stdout) as { id: string; name: string; token: string };
    assert.equal(out.name, "staging-relay-01");
    assert.ok(out.token.length >= 16, "join token should be issued");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
