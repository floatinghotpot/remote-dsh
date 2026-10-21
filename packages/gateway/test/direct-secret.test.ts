import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateDirectSecret, directSecretPath } from "../src/direct-secret.ts";

test("loadOrCreateDirectSecret：生成 ≥32 位并持久化，二次读取一致", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rdsh-ds-"));
  try {
    const s1 = loadOrCreateDirectSecret(dir);
    assert.ok(s1.length >= 32, `长度应 ≥32，实际 ${s1.length}`);
    const s2 = loadOrCreateDirectSecret(dir);
    assert.equal(s1, s2, "二次读取应返回同一密钥");
    const raw = await readFile(directSecretPath(dir), "utf8");
    assert.equal(raw.trim(), s1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadOrCreateDirectSecret：坏/过短文件 → 重新生成", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rdsh-ds-"));
  try {
    await writeFile(directSecretPath(dir), "short\n");
    const s = loadOrCreateDirectSecret(dir);
    assert.ok(s.length >= 32);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
