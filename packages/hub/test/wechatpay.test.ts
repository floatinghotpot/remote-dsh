/**
 * wechatpay.test.ts — 微信支付 APIv3 签名/验签/解密（纯函数，可离线验证）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify, createHmac, createCipheriv } from "node:crypto";
import { signWechatRequest, buildWechatAuthHeader, verifyWechatCallback, decryptWechatResource } from "../src/billing/wechatpay.ts";

test("请求签名：RSA-SHA256 可被公钥验证，Authorization 头格式正确", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const ts = "1700000000";
  const nonce = "abc123";
  const body = '{"out_trade_no":"o1"}';
  const sig = signWechatRequest("POST", "/v3/pay/transactions/native", ts, nonce, body, privatePem);
  const canonical = `POST\n/v3/pay/transactions/native\n${ts}\n${nonce}\n${body}\n`;
  assert.equal(createVerify("RSA-SHA256").update(canonical).verify(publicKey, sig, "base64"), true);

  const header = buildWechatAuthHeader("123", "SN", ts, nonce, sig);
  assert.ok(header.startsWith("WECHATPAY2-SHA256-RSA2048 "));
  assert.ok(header.includes('mchid="123"'));
  assert.ok(header.includes(`signature="${sig}"`));
  assert.ok(header.includes('serial_no="SN"'));
});

test("回调验签：正确签名通过、篡改失败", () => {
  const key = "0123456789abcdef0123456789abcdef"; // 32 字节 APIv3 密钥
  const ts = "1700000000";
  const nonce = "n1";
  const body = '{"event_type":"TRANSACTION.SUCCESS"}';
  const expected = createHmac("sha256", key).update(`${ts}\n${nonce}\n${body}\n`).digest("base64");
  assert.equal(verifyWechatCallback(key, ts, nonce, expected, body), true);
  assert.equal(verifyWechatCallback(key, ts, nonce, "ZmFrZQ==", body), false);
});

test("resource AES-256-GCM 解密 roundtrip", () => {
  const key = "0123456789abcdef0123456789abcdef";
  const plain = JSON.stringify({ out_trade_no: "o1", transaction_id: "t1", amount: { total: 3900 } });
  const nonce = "123456789012";
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key), Buffer.from(nonce));
  cipher.setAAD(Buffer.from("transaction"));
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  const decrypted = decryptWechatResource(key, { ciphertext: Buffer.concat([ct, tag]).toString("base64"), nonce, associated_data: "transaction" });
  assert.equal(decrypted.out_trade_no, "o1");
  assert.equal(decrypted.transaction_id, "t1");
  assert.equal((decrypted.amount as { total: number }).total, 3900);
});
