/**
 * cmb.test.ts — 招商银行 SM2withSM3 签名/验签（纯函数，可离线验证）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sm2 } from "sm-crypto";
import { sm2Sign, sm2Verify } from "../src/billing/cmb.ts";

test("SM2withSM3 签名验签 roundtrip + 篡改拒绝", () => {
  const { privateKey, publicKey } = sm2.generateKeyPairHex();
  const msg = "merchantNo=123&orderNo=o1&amount=39";
  const sig = sm2Sign(msg, privateKey);
  assert.equal(sm2Verify(msg, sig, publicKey), true);
  assert.equal(sm2Verify(`${msg}&amount=40`, sig, publicKey), false);
});
