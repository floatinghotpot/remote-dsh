import { test } from "node:test";
import assert from "node:assert/strict";
import { signGateCookie, verifyGateCookie, verifyGateCode, GATE_COOKIE, GATE_COOKIE_TTL_MS } from "../src/access-gate.ts";

test("访问 cookie：签发→验签 roundtrip；篡改/过期失败", () => {
  const code = "mycode";
  const { value, expiresAt } = signGateCookie(code, 1_000_000);
  assert.equal(expiresAt, 1_000_000 + GATE_COOKIE_TTL_MS);
  assert.ok(verifyGateCookie(code, value, 1_000_000)); // 未过期 → 通过
  assert.ok(verifyGateCookie(code, value, expiresAt - 1)); // 到期前一刻 → 通过
  assert.equal(verifyGateCookie(code, value, expiresAt), false); // 恰到期 → 拒
  // 篡改签名 / 载荷 → 拒
  assert.equal(verifyGateCookie(code, value.slice(0, -1) + (value.endsWith("A") ? "B" : "A"), 1_000_000), false);
  // 错 code（key 不同）→ 拒
  assert.equal(verifyGateCookie("other", value, 1_000_000), false);
});

test("改 code → 旧 cookie 失效", () => {
  const { value } = signGateCookie("oldcode", 1_000_000);
  assert.ok(verifyGateCookie("oldcode", value, 1_000_000));
  assert.equal(verifyGateCookie("newcode", value, 1_000_000), false); // key=sha256(code) 派生 → 改 code 全失效
});

test("code 恒定时间比对", () => {
  assert.equal(verifyGateCode("abcd", "abcd"), true);
  assert.equal(verifyGateCode("abcd", "abce"), false);
  assert.equal(verifyGateCode("", ""), true); // 空==空（gate 本身由 accessCode!=null 门控，不会空码比对）
  assert.equal(verifyGateCode("abcd", "ABCD"), false);
});

test("cookie 名常量", () => {
  assert.equal(GATE_COOKIE, "rdsh_gate");
});
