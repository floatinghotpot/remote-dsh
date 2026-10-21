/**
 * apple-bind.test.ts — 苹果「绑定」账号（feature 28 补漏）：DB 绑定 + 越权检测。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { HubDb } from "../src/db.ts";

test("db：bindApple + getUserByAppleSub（含首次 email/fullName）", () => {
  const db = new HubDb(":memory:");
  const u = db.createUser("u1@x.com", "scrypt:1:1:1:a:b");
  assert.equal(u.appleSub, null);
  db.bindApple(u.id, "sub-1", "a@privaterelay.appleid.com", "Alice");
  const after = db.getUserByAppleSub("sub-1");
  assert.equal(after?.id, u.id);
  assert.equal(after?.appleEmail, "a@privaterelay.appleid.com");
  assert.equal(after?.appleFullName, "Alice");
  db.close();
});

test("db：同一 Apple sub 不能绑到两个账号（越权保护，唯一索引）", () => {
  const db = new HubDb(":memory:");
  const u1 = db.createUser("u1@x.com", "scrypt:1:1:1:a:b");
  const u2 = db.createUser("u2@x.com", "scrypt:1:1:1:a:b");
  db.bindApple(u1.id, "sub-1", null, null);
  // 越权检测（handler 层）：sub 已被 u1 占用
  const holder = db.getUserByAppleSub("sub-1");
  assert.equal(holder?.id, u1.id);
  assert.notEqual(holder?.id, u2.id);
  // 数据库层兜底：唯一索引拒绝二次绑定
  assert.throws(() => db.bindApple(u2.id, "sub-1", null, null));
  db.close();
});

test("db：删除账号墓碑化清 apple_sub（释放唯一索引，可再注册）", () => {
  const db = new HubDb(":memory:");
  const u = db.createUser("u1@x.com", "scrypt:1:1:1:a:b");
  db.bindApple(u.id, "sub-1", null, null);
  db.deleteAccount(u.id);
  assert.equal(db.getUserByAppleSub("sub-1"), null);
  // 释放后可绑定到新账号
  const u2 = db.createUser("u2@x.com", "scrypt:1:1:1:a:b");
  db.bindApple(u2.id, "sub-1", null, null);
  assert.equal(db.getUserByAppleSub("sub-1")?.id, u2.id);
  db.close();
});

test("db：clearApple 解绑（清 apple 字段 + 删令牌）", () => {
  const db = new HubDb(":memory:");
  const u = db.createUser("u1@x.com", "scrypt:1:1:1:a:b");
  db.bindApple(u.id, "sub-1", "a@x.com", "Alice");
  db.storeAppleTokens(u.id, "enc-rt", "enc-at");
  db.clearApple(u.id);
  const after = db.getUserById(u.id);
  assert.equal(after?.appleSub, null);
  assert.equal(after?.appleEmail, null);
  assert.equal(after?.appleFullName, null);
  assert.equal(db.getAppleTokens(u.id), null);
  db.close();
});

test("db：clearWechat 解绑（清网站/移动 openid + unionid + 昵称头像）", () => {
  const db = new HubDb(":memory:");
  const u = db.createUser("u1@x.com", "scrypt:1:1:1:a:b");
  db.bindWechat(u.id, "webOpenid", "unionid", "nick", "http://a");
  db.bindWechatApp(u.id, "appOpenid", "unionid", "nick", "http://a");
  db.clearWechat(u.id);
  const after = db.getUserById(u.id);
  assert.equal(after?.wxwebOpenid, null);
  assert.equal(after?.wxappOpenid, null);
  assert.equal(after?.wechatUnionid, null);
  assert.equal(after?.wechatNickname, null);
  assert.equal(after?.wechatAvatar, null);
  db.close();
});
