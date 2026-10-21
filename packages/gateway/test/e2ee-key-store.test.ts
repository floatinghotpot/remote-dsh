import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateE2eeKeyPair, e2eeKeyFilePath } from "../src/e2ee-key-store.ts";
import { serializeKeyPair } from "../src/e2ee.ts";

test("E2EE 密钥：首次生成并持久化，二次加载同一指纹", () => {
  const dir = mkdtempSync(join(tmpdir(), "rdsh-e2ee-"));
  try {
    const kp1 = loadOrCreateE2eeKeyPair(dir);
    const kp2 = loadOrCreateE2eeKeyPair(dir);
    assert.equal(serializeKeyPair(kp1).publicRaw, serializeKeyPair(kp2).publicRaw, "两次加载应为同一密钥（指纹稳定）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("E2EE 密钥：文件损坏 → 抛错（不静默重建，避免指纹变化踢掉已 pin 客户端）", () => {
  const dir = mkdtempSync(join(tmpdir(), "rdsh-e2ee-"));
  try {
    loadOrCreateE2eeKeyPair(dir); // 先正常生成
    writeFileSync(e2eeKeyFilePath(dir), "{ not valid json", "utf8"); // 损坏
    assert.throws(() => loadOrCreateE2eeKeyPair(dir), /corrupt/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
