import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HubDb } from "../src/db.ts";
import { HubAuth } from "../src/auth.ts";
import { createSqliteStore } from "../src/store.ts";
import { loadHostCookieSigner } from "../src/hostcookie.ts";
import { Jwt } from "../src/jwt.ts";

const SECRET = Buffer.from("test-secret-key-0123456789abcdef");

test("assign 令牌：签发/验证/篡改/过期 + 跨实例（重启）仍有效", () => {
  const db = new HubDb(":memory:");
  const auth = new HubAuth(createSqliteStore(db), (id) => db.getUserById(id), new Jwt(SECRET));

  const token = auth.signAssignToken("host-abc", "node-123");
  assert.deepEqual(auth.verifyAssignToken(token), { hostId: "host-abc", nodeId: "node-123" });

  // 篡改中间字符（而非末尾：base64url 无 padding 时末字符可能只编码 2 个有效位）。
  const mid = Math.floor(token.length / 2);
  const tampered = token.slice(0, mid) + (token[mid] === "X" ? "Y" : "X") + token.slice(mid + 1);
  assert.notEqual(tampered, token, "篡改后 token 必须不同");
  assert.equal(auth.verifyAssignToken(tampered), null, "篡改 token 应校验失败");

  // 无状态：全新实例（同 secret，模拟 hub 重启）也能验 —— 旧实现是进程内 Map，重启即失效。
  const auth2 = new HubAuth(createSqliteStore(db), (id) => db.getUserById(id), new Jwt(SECRET));
  assert.deepEqual(
    auth2.verifyAssignToken(token),
    { hostId: "host-abc", nodeId: "node-123" },
    "跨实例（重启）仍应有效",
  );

  // 过期：手工构造一个 exp 已过的 HMAC 令牌（绕过 signAssignToken 的固定 60s）。
  const jwt = new Jwt(SECRET);
  const expiredPayload = ["host-abc", "node-123", String(Date.now() - 1000)].join(".");
  const expiredToken = Buffer.from(`${expiredPayload}.${jwt.hmacSign(expiredPayload)}`).toString("base64url");
  assert.equal(auth.verifyAssignToken(expiredToken), null, "过期令牌应校验失败");
});

test("assign 令牌：Ed25519 签发/验证/篡改（与 host cookie 同源）", () => {
  const dir = mkdtempSync(join(tmpdir(), "rdsh-at-"));
  try {
    const signer = loadHostCookieSigner(join(dir, "hostcookie.key"));
    const db = new HubDb(":memory:");
    const auth = new HubAuth(createSqliteStore(db), (id) => db.getUserById(id), new Jwt(SECRET), {}, signer);
    const token = auth.signAssignToken("host-abc", "node-123");
    assert.deepEqual(auth.verifyAssignToken(token), { hostId: "host-abc", nodeId: "node-123" });

    const mid = Math.floor(token.length / 2);
    const tampered = token.slice(0, mid) + (token[mid] === "X" ? "Y" : "X") + token.slice(mid + 1);
    assert.notEqual(tampered, token, "篡改后 token 必须不同");
    assert.equal(auth.verifyAssignToken(tampered), null, "篡改应校验失败");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
