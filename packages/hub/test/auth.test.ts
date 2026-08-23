/**
 * auth.test.ts — hub 认证：登录/刷新轮换/改密失效/登出/限流 + JWT + DB 安全存储。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { HubDb } from "../src/db.ts";
import { HubAuth, hashPassword, verifyPassword, createLoginLimiter, ACCESS_TTL_MS } from "../src/auth.ts";
import { Jwt, randomToken, sha256 } from "../src/jwt.ts";

function setup() {
  const db = new HubDb(":memory:");
  const jwt = new Jwt(Buffer.from("test-secret-key-0123456789abcdef"));
  const auth = new HubAuth(db, jwt);
  return { db, jwt, auth };
}

test("scrypt 哈希格式与校验", async () => {
  const h = await hashPassword("pw123");
  assert.match(h, /^scrypt:16384:8:1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
  assert.equal(await verifyPassword("pw123", h), true);
  assert.equal(await verifyPassword("wrong", h), false);
  assert.equal(await verifyPassword("pw123", "not-scrypt"), false);
});

test("登录成功发 token 对；错误密码 null", async () => {
  const { db, auth } = setup();
  db.createUser("alice", await hashPassword("pw"));
  const ok = await auth.login("alice", "pw");
  assert.ok(ok !== null);
  assert.ok(ok.tokens.accessToken.length > 0);
  assert.ok(ok.tokens.refreshToken.length > 0);
  assert.equal(ok.mustChangePassword, false);
  assert.equal(await auth.login("alice", "bad"), null);
  assert.equal(await auth.login("nobody", "pw"), null);
});

test("access JWT 校验（签名 + ver）", async () => {
  const { db, auth } = setup();
  db.createUser("alice", await hashPassword("pw"));
  const pair = (await auth.login("alice", "pw"))!;
  const v = auth.verifyAccess(pair!.tokens.accessToken);
  assert.ok(v !== null);
  assert.equal(v!.user.name, "alice");
  // 篡改 → 无效
  assert.equal(auth.verifyAccess(pair!.tokens.accessToken + "x"), null);
});

test("refresh 轮换：旧 refresh 立即失效", () => {
  const { db, auth } = setup();
  const user = db.createUser("bob", "hash");
  const pair = auth.refresh("nope");
  assert.equal(pair, null);
  // 先造一个合法 refresh
  const login = { accessToken: "x", refreshToken: randomToken() };
  void login;
  const r1 = randomToken();
  db.createRefreshToken(user.id, sha256(r1), Date.now() + 100000);
  const p1 = auth.refresh(r1);
  assert.ok(p1 !== null);
  // 旧 refresh 已吊销
  assert.equal(auth.refresh(r1), null);
  // 新 refresh 可用（轮换链）
  const p2 = auth.refresh(p1!.refreshToken);
  assert.ok(p2 !== null);
});

test("改密：旧 access 立即失效 + 全部 refresh 吊销", async () => {
  const { db, auth } = setup();
  db.createUser("carol", await hashPassword("old"));
  const pair = (await auth.login("carol", "old"))!;
  assert.ok(auth.verifyAccess(pair!.tokens.accessToken) !== null);
  const ok = await auth.changePassword(1, "old", "new");
  assert.equal(ok, true);
  // 旧 access 失效（ver+1）
  assert.equal(auth.verifyAccess(pair!.tokens.accessToken), null);
  // 旧 refresh 失效
  assert.equal(auth.refresh(pair!.tokens.refreshToken), null);
  // 新密码可登录
  assert.ok((await auth.login("carol", "new")) !== null);
  // 当前密码错误 → 改密失败
  assert.equal(await auth.changePassword(1, "wrong", "x"), false);
});

test("登出：吊销 refresh", async () => {
  const { db, auth } = setup();
  db.createUser("dave", "hash");
  const r = randomToken();
  db.createRefreshToken(1, sha256(r), Date.now() + 100000);
  auth.logout(r);
  assert.equal(auth.refresh(r), null);
});

test("DB 安全：token 只存 SHA-256 摘要（无明文）", async () => {
  const { db } = setup();
  db.createUser("eve", await hashPassword("pw"));
  const token = randomToken();
  db.createRefreshToken(1, sha256(token), Date.now() + 100000);
  const row = db.findRefreshByHash(sha256(token));
  assert.ok(row !== null);
  const all = db.db.prepare("SELECT * FROM refresh_tokens").all() as unknown as Array<Record<string, unknown>>;
  assert.equal(all.length, 1);
  assert.notEqual(all[0]!.token_hash, token); // 不是明文
  assert.equal(all[0]!.token_hash, sha256(token));
});

test("限流：5 次失败 → 锁定；锁定期间正确密码也拒绝", async () => {
  const limiter = createLoginLimiter(3, 60000); // 3 次便于测试
  assert.equal(limiter.allow("1.2.3.4"), 0);
  limiter.fail("1.2.3.4");
  limiter.fail("1.2.3.4");
  assert.equal(limiter.fail("1.2.3.4") > 0, true); // 第 3 次锁定
  assert.equal(limiter.allow("1.2.3.4") > 0, true);
  assert.equal(limiter.allow("5.6.7.8"), 0); // 其他 IP 不受影响
  limiter.clear("1.2.3.4");
  assert.equal(limiter.allow("1.2.3.4"), 0);
});

test("JWT 过期校验", () => {
  const jwt = new Jwt(Buffer.from("k"));
  const expired = jwt.sign({ sub: 1, name: "x", ver: 1, exp: Date.now() - 1000 });
  assert.equal(jwt.verify(expired), null);
  const valid = jwt.sign({ sub: 1, name: "x", ver: 1, exp: Date.now() + ACCESS_TTL_MS });
  assert.ok(jwt.verify(valid) !== null);
});
