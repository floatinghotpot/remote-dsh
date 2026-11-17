/**
 * 71 B1：密钥缺失拒绝启动 + 同密钥两实例互通。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { verify as cryptoVerify } from "node:crypto";
import { loadJwtKey } from "../src/serve.ts";
import { loadHostCookieSigner } from "../src/hostcookie.ts";
import { Jwt } from "../src/jwt.ts";

test("B1：缺 JWT key → 拒绝（不自动生成）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rdsh-key-"));
  try {
    await assert.rejects(() => loadJwtKey(join(dir, "hub-jwt.key")), /missing JWT key/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B1：allowCreate 显式生成（0600），两实例同密钥 A 签 B 验", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rdsh-key-"));
  try {
    const path = join(dir, "hub-jwt.key");
    await loadJwtKey(path, { allowCreate: true });
    assert.equal(statSync(path).mode & 0o777, 0o600, "JWT key 权限应为 0600");
    // 两个实例各自读同一文件 → 同一把钥匙
    const a = await loadJwtKey(path);
    const b = await loadJwtKey(path);
    assert.deepEqual(a, b);
    const token = new Jwt(a).sign({ sub: 7, exp: Date.now() + 60_000 });
    const claims = new Jwt(b).verify(token);
    assert.ok(claims !== null);
    assert.equal(claims.sub, 7);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B1：缺 host-cookie key → 拒绝（不自动生成）", () => {
  const dir = mkdtempSync(join(tmpdir(), "rdsh-key-"));
  try {
    assert.throws(() => loadHostCookieSigner(join(dir, "hostcookie.key")), /missing host-cookie key/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B1：host-cookie allowCreate 生成后，两实例同私钥 A 签 B 验", () => {
  const dir = mkdtempSync(join(tmpdir(), "rdsh-key-"));
  try {
    const path = join(dir, "hostcookie.key");
    const a = loadHostCookieSigner(path, { allowCreate: true });
    const b = loadHostCookieSigner(path); // 第二个实例读同一文件
    const payload = "host-1.42.123";
    const sig = a.sign(payload);
    assert.equal(cryptoVerify(null, Buffer.from(payload), b.publicKey, Buffer.from(sig, "hex")), true);
    assert.equal(a.publicKeyHex, b.publicKeyHex);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
