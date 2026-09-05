/**
 * admin.test.ts — 管理面服务层（RBAC + 审计）+ admin 会话（独立短效 + 强制 2FA）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { HubDb } from "../src/db.ts";
import { HubAuth } from "../src/auth.ts";
import { Jwt } from "../src/jwt.ts";
import { generateSecret, totp } from "../src/totp.ts";
import { banUser, unbanUser, resetUser2fa, refundOrder, deleteUser, setUserRole, removeAdmin, createUser, listAudit, AdminError } from "../src/admin.ts";
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

test("createUser：name 标识建号 → active/user/plan null/mustChange=1 + 审计（feature 16）", async () => {
  const db = makeDb();
  const boss = makeUser(db, "boss", "admin");
  const u = await createUser(db, ctx(boss, "admin"), { identifier: "zhangsan", password: "pw12345678", role: "user", mustChange: true, expiresAtMs: null }, "开内部号");
  assert.equal(u.name, "zhangsan");
  assert.equal(u.accountStatus, "active");
  assert.equal(u.role, "user");
  assert.equal(u.planStatus, null); // D4：无期限
  assert.equal(u.mustChange, 1); // D2：强制首登改密
  assert.equal(db.getUserByEmail("zhangsan"), null); // 非邮箱不绑 email
  const ev = listAudit(db, { source: "admin" })[0]!;
  assert.equal(ev.event, "admin.user.create");
  assert.equal(ev.actorUserId, boss);
  assert.ok(ev.detailJson.includes("zhangsan"));
});

test("createUser：email/phone 标识自动绑定列（未验证）；重复 → CONFLICT", async () => {
  const db = makeDb();
  const boss = makeUser(db, "boss", "admin");
  const e = await createUser(db, ctx(boss, "admin"), { identifier: "Zhao@Corp.com", password: "pw12345678", role: "user", mustChange: false, expiresAtMs: null }, "x");
  assert.equal(e.name, "zhao@corp.com"); // 邮箱规范化小写作 name → 登录页输邮箱可登
  assert.equal(e.email, "zhao@corp.com");
  assert.equal(e.emailVerified, 0); // admin 背书，未验证
  const p = await createUser(db, ctx(boss, "admin"), { identifier: "13800138000", password: "pw12345678", role: "user", mustChange: true, expiresAtMs: null }, "x");
  assert.equal(p.phone, "+8613800138000");
  assert.equal(p.phoneVerified, 0);
  // 重复 email / name / phone → CONFLICT
  await assert.rejects(
    createUser(db, ctx(boss, "admin"), { identifier: "zhao@corp.com", password: "pw12345678", role: "user", mustChange: true, expiresAtMs: null }, "x"),
    (x: unknown) => x instanceof AdminError && x.code === "CONFLICT",
  );
  await assert.rejects(
    createUser(db, ctx(boss, "admin"), { identifier: "13800138000", password: "pw12345678", role: "user", mustChange: true, expiresAtMs: null }, "x"),
    (x: unknown) => x instanceof AdminError && x.code === "CONFLICT",
  );
});

test("createUser：RBAC（operator 建 user 可 / 建 admin 拒绝 / admin 可）；密码 <8 拒绝", async () => {
  const db = makeDb();
  const op = makeUser(db, "op", "operator");
  const boss = makeUser(db, "boss", "admin");
  const input = (identifier: string, role: string, password = "pw12345678") => ({ identifier, password, role, mustChange: true, expiresAtMs: null });
  await createUser(db, ctx(op, "operator"), input("u1", "user"), "x"); // operator 建 user 可
  await createUser(db, ctx(op, "operator"), input("u2", "readonly"), "x"); // operator 建 readonly 可
  await assert.rejects(
    createUser(db, ctx(op, "operator"), input("u3", "admin"), "x"),
    (x: unknown) => x instanceof AdminError && x.code === "FORBIDDEN",
  );
  await createUser(db, ctx(boss, "admin"), input("u4", "admin"), "x"); // admin 建 admin 可
  await assert.rejects(
    createUser(db, ctx(boss, "admin"), input("shortpw", "user", "pw12"), "x"),
    (x: unknown) => x instanceof AdminError && x.code === "BAD_REQUEST",
  );
});

test("createUser：到期（E1）→ plan null + planExpiresAt 落库", async () => {
  const db = makeDb();
  const boss = makeUser(db, "boss", "admin");
  const exp = Date.now() + 30 * 24 * 3600 * 1000;
  const u = await createUser(db, ctx(boss, "admin"), { identifier: "term-user", password: "pw12345678", role: "user", mustChange: true, expiresAtMs: exp }, "临时人员 3 个月");
  assert.equal(u.planStatus, null);
  assert.equal(u.planExpiresAt, exp);
  assert.equal(db.getUserById(u.id)!.lastLoginAt, null); // 建号不算登录
});
