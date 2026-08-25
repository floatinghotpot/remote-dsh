import { test } from "node:test";
import assert from "node:assert/strict";
import { totp, verifyTotp, generateSecret } from "../src/totp.ts";

// RFC 6238 Appendix B 测试向量：secret = base32("12345678901234567890")，SHA1，8 位
const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

test("TOTP：RFC 6238 官方向量（8 位）", () => {
  assert.equal(totp(SECRET, 59 * 1000, 30, 8), "94287082");
  assert.equal(totp(SECRET, 1111111109 * 1000, 30, 8), "07081804");
  assert.equal(totp(SECRET, 1111111111 * 1000, 30, 8), "14050471");
  assert.equal(totp(SECRET, 1234567890 * 1000, 30, 8), "89005924");
  assert.equal(totp(SECRET, 2000000000 * 1000, 30, 8), "69279037");
  assert.equal(totp(SECRET, 20000000000 * 1000, 30, 8), "65353130");
});

test("TOTP：6 位 + 窗口 ±1 校验", () => {
  const secret = generateSecret();
  const now = Date.now();
  const code = totp(secret, now, 30, 6);
  assert.equal(code.length, 6);
  assert.equal(verifyTotp(secret, code, 1, now, 30, 6), true);
  // 相邻窗口（±30s）也在容差内
  assert.equal(verifyTotp(secret, totp(secret, now - 30 * 1000, 30, 6), 1, now, 30, 6), true);
  assert.equal(verifyTotp(secret, totp(secret, now + 30 * 1000, 30, 6), 1, now, 30, 6), true);
  // 超窗口 → 拒绝
  assert.equal(verifyTotp(secret, totp(secret, now - 90 * 1000, 30, 6), 1, now, 30, 6), false);
  // 非法输入 → 拒绝
  assert.equal(verifyTotp(secret, "12345", 1, now, 30, 6), false);
  assert.equal(verifyTotp(secret, "abcdef", 1, now, 30, 6), false);
});

test("generateSecret：base32 长度与唯一性", () => {
  const a = generateSecret();
  const b = generateSecret();
  assert.ok(a.length >= 32);
  assert.notEqual(a, b);
});
