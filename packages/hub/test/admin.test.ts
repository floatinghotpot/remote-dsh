/**
 * admin.test.ts — 管理面服务层（RBAC + 审计）+ admin 会话（独立短效 + 强制 2FA）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { HubDb } from "../src/db.ts";
import { HubAuth } from "../src/auth.ts";
import { Jwt } from "../src/jwt.ts";
import { generateSecret, totp } from "../src/totp.ts";
import { banUser, unbanUser, resetUser2fa, refundOrder, deleteUser, setUserRole, removeAdmin, listAudit, AdminError } from "../src/admin.ts";
import type { AdminCtx } from "../src/admin.ts";

function makeDb(): HubDb {
  return new HubDb(":memory:");
}

function makeUser(db: HubDb, name: string, role = "user"): number {
  const u = db.createUser(name, "hash");
  if (role !== "user") db.setRole(u.id, role);
  return u.id;
}

function ctx(actorId: number, role: string): AdminCtx {
  return { actorId, role, ip: "127.0.0.1" };
}

test("banUser：封禁 + 审计（source=admin、actor、reason）", () => {
  const db = makeDb();
  const adminId = makeUser(db, "boss", "admin");
  const target = makeUser(db, "alice");
  banUser(db, ctx(adminId, "admin"), target, "滥用");
  assert.equal(db.getUserById(target)!.accountStatus, "banned");
  const events = listAudit(db, { source: "admin" });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.event, "admin.ban");
  assert.equal(events[0]!.source, "admin");
  assert.equal(events[0]!.actorUserId, adminId);
  assert.ok(events[0]!.detailJson.includes("滥用"));
});

test("RBAC：operator 不能删账号 / readonly 不能封禁与删号 / admin 可删", () => {
  const db = makeDb();
  const opId = makeUser(db, "op", "operator");
  const roId = makeUser(db, "ro", "readonly");
  const adminId = makeUser(db, "boss", "admin");
  const target = makeUser(db, "alice");
  assert.throws(() => deleteUser(db, ctx(opId, "operator"), target, "x"), AdminError);
  assert.throws(() => banUser(db, ctx(roId, "readonly"), target, "x"), AdminError);
  assert.throws(() => deleteUser(db, ctx(roId, "readonly"), target, "x"), AdminError);
  deleteUser(db, ctx(adminId, "admin"), target, "x");
  assert.equal(db.getUserById(target)!.accountStatus, "deleted");
});

test("resetUser2fa：清 secret + ver 递增 + 审计", () => {
  const db = makeDb();
  const adminId = makeUser(db, "boss", "admin");
  const target = makeUser(db, "alice");
  db.setTotpSecret(target, generateSecret());
  const verBefore = db.getUserById(target)!.ver;
  resetUser2fa(db, ctx(adminId, "admin"), target, "被盗");
  const u = db.getUserById(target)!;
  assert.equal(u.totpSecret, null);
  assert.equal(u.ver, verBefore + 1);
  assert.equal(listAudit(db, { source: "admin" })[0]!.event, "admin.reset-2fa");
});

test("refundOrder：订单置 refunded + 订阅取消 + 降级免费 + 审计", () => {
  const db = makeDb();
  const adminId = makeUser(db, "boss", "admin");
  const target = makeUser(db, "alice");
  db.setPlan(target, "subscribed", Date.now() + 86_400_000);
  db.createSubscription(target, "pro", Date.now(), Date.now() + 86_400_000);
  db.createOrder("o1", target, "pro", 39);
  db.markOrderPaid("o1", "wechat", "wx-order-1");
  refundOrder(db, ctx(adminId, "admin"), "o1", "质量问题");
  assert.equal(db.getOrder("o1")!.status, "refunded");
  assert.equal(db.getUserById(target)!.planStatus, "free");
  assert.equal(db.getActiveSubscription(target), null);
  assert.equal(listAudit(db, { source: "admin" })[0]!.event, "admin.refund");
});

test("setUserRole / removeAdmin：改角色 + 自删防护", () => {
  const db = makeDb();
  const adminId = makeUser(db, "boss", "admin");
  const target = makeUser(db, "op");
  setUserRole(db, ctx(adminId, "admin"), target, "operator", "晋升");
  assert.equal(db.getUserById(target)!.role, "operator");
  removeAdmin(db, ctx(adminId, "admin"), target, "调岗");
  assert.equal(db.getUserById(target)!.role, "user");
  assert.throws(() => removeAdmin(db, ctx(adminId, "admin"), adminId, "自删"), AdminError);
});

test("admin 会话：未开 2FA / 普通角色拒绝；正常 token 不可作 admin 会话", () => {
  const db = makeDb();
  const auth = new HubAuth(db, new Jwt(Buffer.from("test-key-0123456789abcdef")));
  const adminId = makeUser(db, "boss", "admin");
  // 未开 2FA → null
  assert.equal(auth.issueAdminSession(adminId, "000000"), null);
  const secret = generateSecret();
  db.setTotpSecret(adminId, secret);
  assert.equal(auth.issueAdminSession(adminId, "000000"), null); // 错误 code
  const token = auth.issueAdminSession(adminId, totp(secret));
  assert.notEqual(token, null);
  assert.equal(auth.verifyAdminAccess(token!)!.user.role, "admin");
  // 普通角色（即使有 2FA）→ null
  const userId = makeUser(db, "bob", "user");
  db.setTotpSecret(userId, secret);
  assert.equal(auth.issueAdminSession(userId, totp(secret)), null);
  // 正常 access token 无 admin 标记 → verifyAdminAccess null
  const pair = auth.issueSession(adminId);
  assert.notEqual(pair, null);
  assert.equal(auth.verifyAdminAccess(pair!.accessToken), null);
});

test("unbanUser：解封 + 审计", () => {
  const db = makeDb();
  const adminId = makeUser(db, "boss", "admin");
  const target = makeUser(db, "alice");
  db.setAccountStatus(target, "banned");
  unbanUser(db, ctx(adminId, "admin"), target, "申诉通过");
  assert.equal(db.getUserById(target)!.accountStatus, "active");
  assert.equal(listAudit(db, { source: "admin" })[0]!.event, "admin.unban");
});
