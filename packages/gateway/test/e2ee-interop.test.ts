/**
 * e2ee-interop.test.ts — gateway（Node crypto）↔ portal（WebCrypto）线级互操作。
 *
 * 证明两端（同一 Noise NK 规范）派生一致密钥、双向 AEAD 互加解密，
 * 即浏览器端 WebCrypto 实现与 Node 端实现线级兼容。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateKeyPair as genNode,
  responderHandshake,
  Aead as NodeAead,
} from "../src/e2ee.ts";
import {
  initiatorHandshake,
  Aead as WebAead,
} from "../../portal/src/e2ee.ts";

test("wire 互操作：Node(host) ↔ WebCrypto(browser) 密钥一致 + 双向 AEAD", async () => {
  const host = genNode(); // Node 端 host 静态密钥对

  // browser 端（WebCrypto）发起握手，拿到临时公钥
  const init = await initiatorHandshake(host.publicRaw);
  // host 端（Node）响应握手，派生密钥
  const resp = responderHandshake(host, Buffer.from(init.ephemeralPublicRaw));

  // 两端密钥一致
  assert.deepEqual(Buffer.from(init.keys.initiatorToResponder), resp.initiatorToResponder);
  assert.deepEqual(Buffer.from(init.keys.responderToInitiator), resp.responderToInitiator);

  const aad = Buffer.from("hdr");

  // browser → host：WebCrypto 加密，Node 解密
  const webSender = new WebAead(init.keys.initiatorToResponder);
  const pkt = await webSender.encrypt(new TextEncoder().encode("hello from browser"), aad);
  const nodeRecv = new NodeAead(resp.initiatorToResponder);
  assert.deepEqual(nodeRecv.decrypt(Buffer.from(pkt), aad), Buffer.from("hello from browser"));

  // host → browser：Node 加密，WebCrypto 解密
  const nodeSender = new NodeAead(resp.responderToInitiator);
  const pkt2 = nodeSender.encrypt(Buffer.from("hello from host"), aad);
  const webRecv = new WebAead(init.keys.responderToInitiator);
  assert.deepEqual(await webRecv.decrypt(pkt2, aad), new TextEncoder().encode("hello from host"));
});
