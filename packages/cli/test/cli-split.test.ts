/**
 * 47-cli-split 冒烟测试：验证 `rdsh` 拆分后的命令面
 * （短形式为主、`host` 兼容别名、`hub` 不再识别）。
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

test("rdsh --version", async () => {
  assert.ok(existsSync(bin), "dist/bin.js missing — run `pnpm build` first");
  const r = await run(["--version"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^rdsh \d+\.\d+\.\d+/);
});

test("rdsh --help shows host commands, not hub", async () => {
  const r = await run(["--help"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /rdsh setup/);
  assert.match(r.stdout, /rdsh serve/);
  assert.doesNotMatch(r.stdout, /rdsh hub/);
});

test("rdsh hub -> unknown command (non-zero)", async () => {
  const r = await run(["hub"]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /unknown command 'hub'/);
});

test("rdsh serve --help == rdsh host serve --help (host alias)", async () => {
  const a = await run(["serve", "--help"]);
  const b = await run(["host", "serve", "--help"]);
  assert.equal(a.code, 0);
  assert.equal(a.stdout, b.stdout);
  assert.match(a.stdout, /rdsh <command>/);
});
