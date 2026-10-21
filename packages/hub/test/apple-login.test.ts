/**
 * apple-login.test.ts — Sign in with Apple 服务端接入单测。
 *
 * 覆盖：client secret（ES256 JWT）结构/声明/验签；身份令牌 RS256 验签（正例 + 四类负例）；
 * 换码/刷新/吊销（注入 mock fetch）；AES-256-GCM 令牌加密往返。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createSign, createVerify, generateKeyPairSync } from "node:crypto";
import {
  makeAppleClientSecret,
  verifyAppleIdToken,
  exchangeAppleCode,
  refreshAppleToken,
  revokeAppleToken,
  encryptToken,
  decryptToken,
  sha256Hex,
} from "../src/apple-login.ts";

const KEY_HEX = "00".repeat(32);

// ---- mock fetch：返回给定 JSON ----
function jsonFetch(status: number, body: unknown): typeof fetch {
  const fn = async () =>
    ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;
  return fn as unknown as typeof fetch;
}

function rsaKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as { n: string; e: string };
  return { publicKey, privateKey, jwk: { kid: "K1", kty: "RSA", n: jwk.n, e: jwk.e } };
}

function makeIdToken(opts: {
  privateKey: ReturnType<typeof generateKeyPairSync<"rsa", "pkcs8">>["privateKey"];
  kid: string;
  sub: string;
  aud: string;
  iss: string;
  expMs: number;
  nonceRaw: string;
}): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: opts.kid })).toString("base64url");
  const nonceB64 = createHash("sha256").update(opts.nonceRaw).digest("base64url");
  const payload = Buffer.from(
    JSON.stringify({ iss: opts.iss, aud: opts.aud, exp: Math.floor(opts.expMs / 1000), sub: opts.sub, nonce: nonceB64, email: `${opts.sub}@privaterelay.appleid.com`, email_verified: true }),
  ).toString("base64url");
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  signer.end();
  const sig = signer.sign(opts.privateKey).toString("base64url");
  return `${header}.${payload}.${sig}`;
}

// ============================================================================

test("makeAppleClientSecret：ES256 JWT 结构 + 声明 + 可验签", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const now = Date.now();
  const jwt = makeAppleClientSecret({ teamId: "TEAM123", keyId: "KEY456", clientId: "com.example.app", privateKeyPem: pem, nowMs: now });
  const [h, p, s] = jwt.split(".") as [string, string, string];
  const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
  const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  assert.equal(header.alg, "ES256");
  assert.equal(header.kid, "KEY456");
  assert.equal(payload.iss, "TEAM123");
  assert.equal(payload.sub, "com.example.app");
  assert.equal(payload.aud, "https://appleid.apple.com");
  assert.equal(payload.iat, Math.floor(now / 1000));
  assert.equal(payload.exp, Math.floor(now / 1000) + 180 * 24 * 3600);
  const verifier = createVerify("SHA256");
  verifier.update(`${h}.${p}`);
  verifier.end();
  assert.equal(verifier.verify({ key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url")), true);
});

test("verifyAppleIdToken：正例（正确 nonce / aud / iss / 有效期）", async () => {
  const { privateKey, jwk } = rsaKeys();
  const now = Date.now();
  const token = makeIdToken({ privateKey, kid: "K1", sub: "sub-1", aud: "com.example.app", iss: "https://appleid.apple.com", expMs: now + 3600_000, nonceRaw: "raw-nonce" });
  const claims = await verifyAppleIdToken(token, {
    clientId: "com.example.app",
    nonce: "raw-nonce",
    nowMs: now,
    fetchImpl: jsonFetch(200, { keys: [jwk] }),
  });
  assert.ok(claims !== null);
  assert.equal(claims.sub, "sub-1");
  assert.equal(claims.email, "sub-1@privaterelay.appleid.com");
  assert.equal(claims.emailVerified, true);
});

test("verifyAppleIdToken：负例 —— 签名伪造", async () => {
  const { privateKey, jwk } = rsaKeys();
  const { privateKey: otherKey } = rsaKeys();
  const now = Date.now();
  const token = makeIdToken({ privateKey: otherKey, kid: "K1", sub: "sub-1", aud: "com.example.app", iss: "https://appleid.apple.com", expMs: now + 3600_000, nonceRaw: "raw-nonce" });
  // 用另一个公钥验签 → 失败
  const claims = await verifyAppleIdToken(token, { clientId: "com.example.app", nonce: "raw-nonce", nowMs: now, fetchImpl: jsonFetch(200, { keys: [jwk] }) });
  assert.equal(claims, null);
});

test("verifyAppleIdToken：负例 —— aud 不匹配", async () => {
  const { privateKey, jwk } = rsaKeys();
  const now = Date.now();
  const token = makeIdToken({ privateKey, kid: "K1", sub: "sub-1", aud: "com.other.app", iss: "https://appleid.apple.com", expMs: now + 3600_000, nonceRaw: "raw-nonce" });
  const claims = await verifyAppleIdToken(token, { clientId: "com.example.app", nonce: "raw-nonce", nowMs: now, fetchImpl: jsonFetch(200, { keys: [jwk] }) });
  assert.equal(claims, null);
});

test("verifyAppleIdToken：负例 —— 过期", async () => {
  const { privateKey, jwk } = rsaKeys();
  const now = Date.now();
  const token = makeIdToken({ privateKey, kid: "K1", sub: "sub-1", aud: "com.example.app", iss: "https://appleid.apple.com", expMs: now - 1000, nonceRaw: "raw-nonce" });
  const claims = await verifyAppleIdToken(token, { clientId: "com.example.app", nonce: "raw-nonce", nowMs: now, fetchImpl: jsonFetch(200, { keys: [jwk] }) });
  assert.equal(claims, null);
});

test("verifyAppleIdToken：负例 —— nonce 不符", async () => {
  const { privateKey, jwk } = rsaKeys();
  const now = Date.now();
  const token = makeIdToken({ privateKey, kid: "K1", sub: "sub-1", aud: "com.example.app", iss: "https://appleid.apple.com", expMs: now + 3600_000, nonceRaw: "raw-nonce" });
  const claims = await verifyAppleIdToken(token, { clientId: "com.example.app", nonce: "other-nonce", nowMs: now, fetchImpl: jsonFetch(200, { keys: [jwk] }) });
  assert.equal(claims, null);
});

test("exchangeAppleCode：成功（首次返回 refresh_token）", async () => {
  const res = await exchangeAppleCode("code-1", {
    clientId: "cid",
    clientSecret: "secret",
    fetchImpl: jsonFetch(200, { access_token: "at-1", refresh_token: "rt-1", id_token: "idt-1" }),
  });
  assert.deepEqual(res, { accessToken: "at-1", refreshToken: "rt-1", idToken: "idt-1" });
});

test("exchangeAppleCode：失败 → null", async () => {
  const res = await exchangeAppleCode("bad", { clientId: "cid", clientSecret: "secret", fetchImpl: jsonFetch(400, { error: "invalid_grant" }) });
  assert.equal(res, null);
});

test("refreshAppleToken：成功返回新 access token", async () => {
  const at = await refreshAppleToken("rt-1", { clientId: "cid", clientSecret: "secret", fetchImpl: jsonFetch(200, { access_token: "at-2" }) });
  assert.equal(at, "at-2");
});

test("revokeAppleToken：ok 与否", async () => {
  assert.equal(await revokeAppleToken("tok", { clientId: "cid", clientSecret: "secret", fetchImpl: jsonFetch(200, {}) }), true);
  assert.equal(await revokeAppleToken("tok", { clientId: "cid", clientSecret: "secret", fetchImpl: jsonFetch(400, {}) }), false);
});

test("encryptToken/decryptToken：往返 + 篡改失败", () => {
  const cipher = encryptToken("plain-secret", KEY_HEX);
  assert.notEqual(cipher, "plain-secret");
  assert.equal(decryptToken(cipher, KEY_HEX), "plain-secret");
  // 篡改密文 → 解密失败（GCM 认证）
  const [iv, enc, tag] = cipher.split(".");
  const tampered = [iv, Buffer.from(enc, "base64url").reverse().toString("base64url"), tag].join(".");
  assert.equal(decryptToken(tampered, KEY_HEX), null);
});

test("sha256Hex：与 node crypto 一致", () => {
  assert.equal(sha256Hex("abc"), createHash("sha256").update("abc").digest("hex"));
});
