/**
 * wechatpay.test.ts — 微信支付 APIv3 签名/验签/解密（纯函数，可离线验证）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify, createHmac, createCipheriv } from "node:crypto";
import { signWechatRequest, buildWechatAuthHeader, signWechatJsapi, verifyWechatCallback, decryptWechatResource, getWechatOpenid, createWechatPayProvider } from "../src/billing/wechatpay.ts";
import type { WechatPayConfig } from "../src/billing/types.ts";

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

test("JSAPI 调起签名：RSA-SHA256 可被公钥验证", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const sig = signWechatJsapi("wx123", "1700000000", "nonce1", "prepay_id=p1", privatePem);
  const canonical = `wx123\n1700000000\nnonce1\nprepay_id=p1\n`;
  assert.equal(createVerify("RSA-SHA256").update(canonical).verify(publicKey, sig, "base64"), true);
});

test("getWechatOpenid：code 换 openid（注入 fetch）", async () => {
  const ok = (async (url: string | URL | Request) => {
    const u = typeof url === "string" ? url : url.toString();
    assert.ok(u.includes("appid=wx123"));
    assert.ok(u.includes("secret=s3"));
    assert.ok(u.includes("code=c1"));
    assert.ok(u.includes("grant_type=authorization_code"));
    return new Response(JSON.stringify({ openid: "o-abc" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  assert.equal(await getWechatOpenid("wx123", "s3", "c1", ok), "o-abc");

  const fail = (async () => new Response(JSON.stringify({ errcode: 40029, errmsg: "invalid code" }), { status: 200 })) as typeof fetch;
  assert.equal(await getWechatOpenid("wx123", "s3", "bad", fail), null);
});

test("下单三形态：native/h5/jsapi 路径、body 与 payInfo 正确", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const cfg: WechatPayConfig = {
    mchid: "1900000001",
    appid: "wx123",
    certSerialNo: "SN1",
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    apiV3Key: "0123456789abcdef0123456789abcdef",
    notifyUrl: "https://rdsh.cn/api/billing/callback",
    appSecret: "secret",
  };
  const provider = createWechatPayProvider(cfg);
  const calls: Array<{ url: string; body: string; auth: string }> = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = typeof init?.body === "string" ? init.body : "";
    const auth = (init?.headers as Record<string, string> | undefined)?.["authorization"] ?? "";
    calls.push({ url, body, auth });
    const p = new URL(url).pathname;
    const json = p.includes("/h5") ? { h5_url: "https://wx.tenpay.com/h5/abc" } : p.includes("/jsapi") ? { prepay_id: "prepay_abc" } : { code_url: "weixin://wxpay/bizpayurl?pr=abc" };
    return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    const native = await provider.createPayment({ orderId: "o-native", amountCny: 39, subject: "Pro", form: "native" });
    const h5 = await provider.createPayment({ orderId: "o-h5", amountCny: 39, subject: "Pro", form: "h5", clientIp: "1.2.3.4" });
    const jsapi = await provider.createPayment({ orderId: "o-jsapi", amountCny: 39, subject: "Pro", form: "jsapi", openid: "openid_xyz" });

    assert.ok(calls[0]!.url.includes("/v3/pay/transactions/native"));
    assert.ok((native.payInfo as { codeUrl?: string }).codeUrl?.startsWith("weixin://"));
    assert.ok(calls[0]!.auth.startsWith("WECHATPAY2-SHA256-RSA2048 "));

    assert.ok(calls[1]!.url.includes("/v3/pay/transactions/h5"));
    assert.ok(calls[1]!.body.includes("scene_info"));
    assert.ok(calls[1]!.body.includes("1.2.3.4"));
    assert.ok((h5.payInfo as { h5Url?: string }).h5Url?.startsWith("https://"));

    assert.ok(calls[2]!.url.includes("/v3/pay/transactions/jsapi"));
    assert.ok(calls[2]!.body.includes("openid_xyz"));
    const jp = jsapi.payInfo as { appId: string; paySign: string; package: string };
    assert.equal(jp.appId, "wx123");
    assert.equal(jp.package, "prepay_id=prepay_abc");
    assert.ok(jp.paySign.length > 0);
  } finally {
    globalThis.fetch = orig;
  }
});

test("jsapi 缺 openid → 抛错", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const cfg: WechatPayConfig = {
    mchid: "1",
    appid: "wx",
    certSerialNo: "SN",
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    apiV3Key: "0123456789abcdef0123456789abcdef",
    notifyUrl: "https://x.cn/api/billing/callback",
  };
  const provider = createWechatPayProvider(cfg);
  await assert.rejects(() => provider.createPayment({ orderId: "o", amountCny: 1, subject: "s", form: "jsapi" }), /openid/);
});
