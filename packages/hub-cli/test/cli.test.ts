/**
 * 47-cli-split 冒烟测试：验证 `rdsh-hub` 命令面
 * （serve|user|audit|host|service；`node` 已移除）。
 * 依赖已构建的 dist/bin.js —— 需先 `pnpm build`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
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

test("rdsh-hub --help lists serve|user|audit|host|service, no node", async () => {
  const r = await run(["--help"]);
  assert.equal(r.code, 0);
  for (const sub of ["serve", "user", "audit", "host", "service"]) {
    assert.match(r.stdout, new RegExp(`rdsh-hub ${sub}`), `missing rdsh-hub ${sub}`);
  }
  assert.doesNotMatch(r.stdout, /rdsh-hub node/);
});

test("rdsh-hub node -> usage error (node removed)", async () => {
  const r = await run(["node"]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /usage: rdsh-hub setup\|serve\|user\|host\|audit\|db\|service/);
});
