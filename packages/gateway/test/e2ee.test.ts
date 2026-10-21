/**
 * e2ee.test.ts — Noise NK（X25519 + HKDF + AES-GCM）roundtrip / 篡改 / 密钥不一致。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateKeyPair,
  initiatorHandshake,
  responderHandshake,
  ecdh,
  Aead,
  fingerprint,
  serializeKeyPair,
  deserializeKeyPair,
} from "../src/e2ee.ts";

test("NK 握手：发起方与响应方派生一致密钥（方向密钥不同）", () => {
  const host = generateKeyPair(); // responder static
  const init = initiatorHandshake(host.publicRaw);
  const resp = responderHandshake(host, init.ephemeralPublicRaw);
  assert.deepEqual(init.keys.initiatorToResponder, resp.initiatorToResponder);
  assert.deepEqual(init.keys.responderToInitiator, resp.responderToInitiator);
  assert.notDeepEqual(init.keys.initiatorToResponder, init.keys.responderToInitiator);
});

test("AEAD roundtrip + 篡改被拒 + AAD 绑定", () => {
  const host = generateKeyPair();
  const init = initiatorHandshake(host.publicRaw);

  const aad = Buffer.from("hdr");
  const pt = Buffer.from("hello e2ee");
  const sender = new Aead(init.keys.initiatorToResponder);
  const pkt = sender.encrypt(pt, aad);

  const receiver = new Aead(init.keys.initiatorToResponder);
  assert.deepEqual(receiver.decrypt(pkt, aad), pt);

  const bad = Buffer.from(pkt);
  bad[bad.length - 1] ^= 0xff;
  assert.throws(() => new Aead(init.keys.initiatorToResponder).decrypt(bad, aad));

  assert.throws(() => new Aead(init.keys.initiatorToResponder).decrypt(pkt, Buffer.from("other")));
});

test("错误 host 公钥 → 密钥不一致（防 MITM 语义）", () => {
  const hostA = generateKeyPair();
  const hostB = generateKeyPair();
  const init = initiatorHandshake(hostA.publicRaw);
  const respB = responderHandshake(hostB, init.ephemeralPublicRaw);
  assert.notDeepEqual(init.keys.initiatorToResponder, respB.initiatorToResponder);
});

test("序列化 roundtrip + ECDH 一致 + 指纹稳定", () => {
  const kp = generateKeyPair();
  const s = serializeKeyPair(kp);
  const kp2 = deserializeKeyPair(s.publicRaw, s.privateRaw);
  assert.deepEqual(kp2.publicRaw, kp.publicRaw);

  const other = generateKeyPair();
  assert.deepEqual(ecdh(kp.privateKey, other.publicRaw), ecdh(kp2.privateKey, other.publicRaw));
  assert.equal(fingerprint(kp.publicRaw), fingerprint(kp2.publicRaw));
  assert.notEqual(fingerprint(kp.publicRaw), fingerprint(other.publicRaw));
});
