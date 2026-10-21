import { test } from "node:test";
import assert from "node:assert/strict";
import { HubDb } from "../src/db.ts";
import { HubAuth } from "../src/auth.ts";
import { createSqliteStore } from "../src/store.ts";
import { loadHostCookieSigner } from "../src/hostcookie.ts";
import { Jwt } from "../src/jwt.ts";
import { clearHostCookie } from "../src/server.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function setup() {
  const db = new HubDb(":memory:");
  const auth = new HubAuth(createSqliteStore(db), (id) => db.getUserById(id), new Jwt(Buffer.from("test-secret-key-0123456789abcdef")));
  return { db, auth };
}

test("签名 host cookie：签发/验证/篡改/过期", () => {
  const { db, auth } = setup();
  const user = db.createUser("alice", "scrypt:fake");
  assert.equal(user.id, 1, `createUser id=${user.id} 应为 1`);
  assert.equal(db.listUsers().length, 1, "db 应只有 1 个用户");
  const token = auth.signHostCookie("host-abc", user.id);
  assert.ok(auth.verifyHostCookie(token) !== null);
  // 篡改中间字符而非末尾：base64url 无 padding 时末字符可能只编码 2 个有效位，
  // 若只改末字符（如 "Q"→"X"，高位同为 01）解码字节不变 → 签名仍通过（间歇漏测）。
  const mid = Math.floor(token.length / 2);
  const tampered = token.slice(0, mid) + (token[mid] === "X" ? "Y" : "X") + token.slice(mid + 1);
  assert.notEqual(tampered, token, "篡改后 token 必须不同");
  assert.equal(auth.verifyHostCookie(tampered), null, "篡改 token 应校验失败");
  db.setPassword(user.id, "scrypt:fake2");
  assert.equal(db.getUserById(user.id)?.ver, 2, "改密后 ver 应=2");
  assert.equal(auth.verifyHostCookie(token), null, "改密后旧 host cookie 应失效");
});

test("Ed25519 host cookie：签发/验证/篡改（R17）", () => {
  const dir = mkdtempSync(join(tmpdir(), "rdsh-hc-"));
  try {
    const signer = loadHostCookieSigner(join(dir, "hostcookie.key"));
    const db = new HubDb(":memory:");
    const auth = new HubAuth(createSqliteStore(db), (id) => db.getUserById(id), new Jwt(Buffer.from("test-secret-key-0123456789abcdef")), {}, signer);
    const user = db.createUser("bob", "scrypt:fake");
    const token = auth.signHostCookie("host-xyz", user.id);
    assert.ok(auth.verifyHostCookie(token) !== null, "Ed25519 签发应可验证");
    const mid = Math.floor(token.length / 2);
    const tampered = token.slice(0, mid) + (token[mid] === "X" ? "Y" : "X") + token.slice(mid + 1);
    assert.equal(auth.verifyHostCookie(tampered), null, "篡改应校验失败");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clearHostCookie 必须带 Domain（否则清不掉跨域 cookie）", () => {
  assert.equal(
    clearHostCookie(".rdsh.cn"),
    "rdsh_host=; HttpOnly; SameSite=Lax; Path=/; Domain=.rdsh.cn; Max-Age=0",
  );
  assert.equal(clearHostCookie(), "rdsh_host=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
});
