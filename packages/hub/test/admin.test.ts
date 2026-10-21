/**
 * admin.test.ts — 管理面服务层（RBAC + 审计）+ admin 会话（独立短效 + 强制 2FA）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { HubDb } from "../src/db.ts";
import { HubAuth } from "../src/auth.ts";
import { createSqliteStore } from "../src/store.ts";
import { Jwt } from "../src/jwt.ts";
import { generateSecret, totp } from "../src/totp.ts";
import { banUser, unbanUser, resetUser2fa, refundOrder, deleteUser, setUserRole, removeAdmin, createUser, adjustPlan, grantTrial, grantSubscription, createRelayJoinToken, renameRelayJoinToken, listRelayJoinTokens, listAudit, AdminError } from "../src/admin.ts";
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

test("banUser：封禁 + 审计（source=admin、actor、reason）", async () => {
  const db = makeDb();
  const adminId = makeUser(db, "boss", "admin");
  const target = makeUser(db, "alice");
  await banUser(createSqliteStore(db), ctx(adminId, "admin"), target, "滥用");
  assert.equal(db.getUserById(target)!.accountStatus, "banned");
  const events = await listAudit(createSqliteStore(db), { source: "admin" });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.event, "admin.ban");
  assert.equal(events[0]!.source, "admin");
  assert.equal(events[0]!.actorUserId, adminId);
  assert.ok(events[0]!.detailJson.includes("滥用"));
});

test("RBAC：operator 不能删账号 / readonly 不能封禁与删号 / admin 可删", async () => {
  const db = makeDb();
  const opId = makeUser(db, "op", "operator");
  const roId = makeUser(db, "ro", "readonly");
  const adminId = makeUser(db, "boss", "admin");
  const target = makeUser(db, "alice");
  await assert.rejects(deleteUser(createSqliteStore(db), ctx(opId, "operator"), target, "x"), AdminError);
  await assert.rejects(banUser(createSqliteStore(db), ctx(roId, "readonly"), target, "x"), AdminError);
  await assert.rejects(deleteUser(createSqliteStore(db), ctx(roId, "readonly"), target, "x"), AdminError);
  await deleteUser(createSqliteStore(db), ctx(adminId, "admin"), target, "x");
  assert.equal(db.getUserById(target)!.accountStatus, "deleted");
});

test("resetUser2fa：清 secret + ver 递增 + 审计", async () => {
  const db = makeDb();
  const adminId = makeUser(db, "boss", "admin");
  const target = makeUser(db, "alice");
  db.setTotpSecret(target, generateSecret());
  const verBefore = db.getUserById(target)!.ver;
  await resetUser2fa(createSqliteStore(db), ctx(adminId, "admin"), target, "被盗");
  const u = db.getUserById(target)!;
  assert.equal(u.totpSecret, null);
  assert.equal(u.ver, verBefore + 1);
  assert.equal((await listAudit(createSqliteStore(db), { source: "admin" }))[0]!.event, "admin.reset-2fa");
});

test("refundOrder：订单置 refunded + 订阅取消 + 降级免费 + 审计", async () => {
  const db = makeDb();
  const adminId = makeUser(db, "boss", "admin");
  const target = makeUser(db, "alice");
  db.setPlan(target, "subscribed", Date.now() + 86_400_000);
  db.createSubscription(target, "pro", Date.now(), Date.now() + 86_400_000);
  db.createOrder("o1", target, "pro", 39);
  db.markOrderPaid("o1", "wechat", "wx-order-1");
  await refundOrder(createSqliteStore(db), ctx(adminId, "admin"), "o1", "质量问题");
  assert.equal(db.getOrder("o1")!.status, "refunded");
  assert.equal(db.getUserById(target)!.planStatus, "free");
  assert.equal(db.getActiveSubscription(target), null);
  assert.equal((await listAudit(createSqliteStore(db), { source: "admin" }))[0]!.event, "admin.refund");
});

test("setUserRole / removeAdmin：改角色 + 自删防护", async () => {
  const db = makeDb();
  const adminId = makeUser(db, "boss", "admin");
  const target = makeUser(db, "op");
  await setUserRole(createSqliteStore(db), ctx(adminId, "admin"), target, "operator", "晋升");
  assert.equal(db.getUserById(target)!.role, "operator");
  await removeAdmin(createSqliteStore(db), ctx(adminId, "admin"), target, "调岗");
  assert.equal(db.getUserById(target)!.role, "user");
  await assert.rejects(removeAdmin(createSqliteStore(db), ctx(adminId, "admin"), adminId, "自删"), AdminError);
});

test("admin 会话：未开 2FA / 普通角色拒绝；正常 token 不可作 admin 会话", async () => {
  const db = makeDb();
  const auth = new HubAuth(createSqliteStore(db), (id) => db.getUserById(id), new Jwt(Buffer.from("test-key-0123456789abcdef")));
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
  const pair = await auth.issueSession(adminId);
  assert.notEqual(pair, null);
  assert.equal(auth.verifyAdminAccess(pair!.accessToken), null);
});

test("unbanUser：解封 + 审计", async () => {
  const db = makeDb();
  const adminId = makeUser(db, "boss", "admin");
  const target = makeUser(db, "alice");
  db.setAccountStatus(target, "banned");
  await unbanUser(createSqliteStore(db), ctx(adminId, "admin"), target, "申诉通过");
  assert.equal(db.getUserById(target)!.accountStatus, "active");
  assert.equal((await listAudit(createSqliteStore(db), { source: "admin" }))[0]!.event, "admin.unban");
});

test("createUser：name 标识建号 → active/user/plan null/mustChange=1 + 审计（feature 16）", async () => {
  const db = makeDb();
  const boss = makeUser(db, "boss", "admin");
  const u = await createUser(createSqliteStore(db), ctx(boss, "admin"), { identifier: "zhangsan", password: "pw12345678", role: "user", mustChange: true, expiresAtMs: null }, "开内部号");
  assert.equal(u.name, "zhangsan");
  assert.equal(u.accountStatus, "active");
  assert.equal(u.role, "user");
  assert.equal(u.planStatus, null); // D4：无期限
  assert.equal(u.mustChange, 1); // D2：强制首登改密
  assert.equal(db.getUserByEmail("zhangsan"), null); // 非邮箱不绑 email
  const ev = (await listAudit(createSqliteStore(db), { source: "admin" }))[0]!;
  assert.equal(ev.event, "admin.user.create");
  assert.equal(ev.actorUserId, boss);
  assert.ok(ev.detailJson.includes("zhangsan"));
});

test("createUser：email/phone 标识自动绑定列（未验证）；重复 → CONFLICT", async () => {
  const db = makeDb();
  const boss = makeUser(db, "boss", "admin");
  const e = await createUser(createSqliteStore(db), ctx(boss, "admin"), { identifier: "Zhao@Corp.com", password: "pw12345678", role: "user", mustChange: false, expiresAtMs: null }, "x");
  assert.equal(e.name, "zhao@corp.com"); // 邮箱规范化小写作 name → 登录页输邮箱可登
  assert.equal(e.email, "zhao@corp.com");
  assert.equal(e.emailVerified, 0); // admin 背书，未验证
  const p = await createUser(createSqliteStore(db), ctx(boss, "admin"), { identifier: "13800138000", password: "pw12345678", role: "user", mustChange: true, expiresAtMs: null }, "x");
  assert.equal(p.phone, "+8613800138000");
  assert.equal(p.phoneVerified, 0);
  // 重复 email / name / phone → CONFLICT
  await assert.rejects(
    createUser(createSqliteStore(db), ctx(boss, "admin"), { identifier: "zhao@corp.com", password: "pw12345678", role: "user", mustChange: true, expiresAtMs: null }, "x"),
    (x: unknown) => x instanceof AdminError && x.code === "CONFLICT",
  );
  await assert.rejects(
    createUser(createSqliteStore(db), ctx(boss, "admin"), { identifier: "13800138000", password: "pw12345678", role: "user", mustChange: true, expiresAtMs: null }, "x"),
    (x: unknown) => x instanceof AdminError && x.code === "CONFLICT",
  );
});

test("createUser：RBAC（operator 建 user 可 / 建 admin 拒绝 / admin 可）；密码 <8 拒绝", async () => {
  const db = makeDb();
  const op = makeUser(db, "op", "operator");
  const boss = makeUser(db, "boss", "admin");
  const input = (identifier: string, role: string, password = "pw12345678") => ({ identifier, password, role, mustChange: true, expiresAtMs: null });
  await createUser(createSqliteStore(db), ctx(op, "operator"), input("u1", "user"), "x"); // operator 建 user 可
  await createUser(createSqliteStore(db), ctx(op, "operator"), input("u2", "readonly"), "x"); // operator 建 readonly 可
  await assert.rejects(
    createUser(createSqliteStore(db), ctx(op, "operator"), input("u3", "admin"), "x"),
    (x: unknown) => x instanceof AdminError && x.code === "FORBIDDEN",
  );
  await createUser(createSqliteStore(db), ctx(boss, "admin"), input("u4", "admin"), "x"); // admin 建 admin 可
  await assert.rejects(
    createUser(createSqliteStore(db), ctx(boss, "admin"), input("shortpw", "user", "pw12"), "x"),
    (x: unknown) => x instanceof AdminError && x.code === "BAD_REQUEST",
  );
});

test("createUser：带到期 → 试用（trial + 到期，不再写 null+到期）", async () => {
  const db = makeDb();
  const boss = makeUser(db, "boss", "admin");
  const exp = Date.now() + 30 * 24 * 3600 * 1000;
  const u = await createUser(createSqliteStore(db), ctx(boss, "admin"), { identifier: "term-user", password: "pw12345678", role: "user", mustChange: true, expiresAtMs: exp }, "临时人员 3 个月");
  assert.equal(u.planStatus, "trial");
  assert.equal(u.planExpiresAt, exp);
  assert.equal(db.getUserById(u.id)!.lastLoginAt, null); // 建号不算登录
});

test("adjustPlan 收紧：subscribed 无订阅 → BAD_REQUEST；null 带到期 → BAD_REQUEST", async () => {
  const db = makeDb();
  const boss = makeUser(db, "boss", "admin");
  const target = makeUser(db, "alice");
  await assert.rejects(
    adjustPlan(createSqliteStore(db), ctx(boss, "admin"), target, "subscribed", Date.now() + 86_400_000, "x"),
    (e: unknown) => e instanceof AdminError && e.code === "BAD_REQUEST",
  );
  await assert.rejects(
    adjustPlan(createSqliteStore(db), ctx(boss, "admin"), target, null, Date.now() + 86_400_000, "x"),
    (e: unknown) => e instanceof AdminError && e.code === "BAD_REQUEST",
  );
  // 合法：subscribed 有订阅；null 无到期
  db.createSubscription(target, "pro", Date.now(), Date.now() + 86_400_000);
  await adjustPlan(createSqliteStore(db), ctx(boss, "admin"), target, "subscribed", Date.now() + 86_400_000, "x");
  await adjustPlan(createSqliteStore(db), ctx(boss, "admin"), target, null, null, "x");
  assert.equal(db.getUserById(target)!.planStatus, null);
});

test("grantTrial：顺延 + 审计；已订阅 → CONFLICT", async () => {
  const db = makeDb();
  const boss = makeUser(db, "boss", "admin");
  const target = makeUser(db, "alice");
  const exp = Date.now() + 3 * 24 * 3600 * 1000;
  db.setPlan(target, "trial", exp);
  await grantTrial(createSqliteStore(db), ctx(boss, "admin"), target, 7, "客服延长");
  const u = db.getUserById(target)!;
  assert.equal(u.planStatus, "trial");
  assert.ok((u.planExpiresAt ?? 0) >= exp + 7 * 24 * 3600 * 1000 - 1000); // 顺延不吞剩余
  assert.equal((await listAudit(createSqliteStore(db), { source: "admin" }))[0]!.event, "admin.grant-trial");
  // 已订阅 → 拒绝（防误降级付费用户）
  db.createSubscription(target, "pro", Date.now(), Date.now() + 86_400_000);
  await assert.rejects(
    grantTrial(createSqliteStore(db), ctx(boss, "admin"), target, 7, "x"),
    (e: unknown) => e instanceof AdminError && e.code === "CONFLICT",
  );
});

test("grantSubscription：三表一致 + 停用旧订阅 + 参数校验", async () => {
  const db = makeDb();
  const boss = makeUser(db, "boss", "admin");
  const target = makeUser(db, "alice");
  db.createSubscription(target, "pro", Date.now(), Date.now() + 86_400_000); // 旧订阅
  await grantSubscription(createSqliteStore(db), ctx(boss, "admin"), { userId: target, planId: "pro", days: 365, amountCny: 0 }, "受邀请用户");
  const u = db.getUserById(target)!;
  assert.equal(u.planStatus, "subscribed");
  const sub = db.getActiveSubscription(target)!;
  assert.equal(sub.planId, "pro");
  assert.ok(sub.expiresAt >= Date.now() + 364 * 24 * 3600 * 1000);
  // 单有效订阅：旧订阅被停用
  const actives = db.listSubscriptionsByUser(target).filter((s) => s.status === "active");
  assert.equal(actives.length, 1);
  assert.equal(db.listOrders().rows.length, 1);
  assert.equal((await listAudit(createSqliteStore(db), { source: "admin" }))[0]!.event, "admin.credit-order");
  // days 与 expiresAtMs 均缺省 → BAD_REQUEST；过期 expiresAtMs → BAD_REQUEST
  await assert.rejects(
    grantSubscription(createSqliteStore(db), ctx(boss, "admin"), { userId: target, planId: "pro" }, "x"),
    (e: unknown) => e instanceof AdminError && e.code === "BAD_REQUEST",
  );
  await assert.rejects(
    grantSubscription(createSqliteStore(db), ctx(boss, "admin"), { userId: target, planId: "pro", expiresAtMs: Date.now() - 1 }, "x"),
    (e: unknown) => e instanceof AdminError && e.code === "BAD_REQUEST",
  );
});

test("listUsersPage：按角色 / 状态 / 登录时间范围过滤", () => {
  const db = makeDb();
  const alice = db.createUser("alice", "hash");
  const bob = db.createUser("bob", "hash");
  db.setRole(bob.id, "admin");
  const carol = db.createUser("carol", "hash");
  db.setAccountStatus(carol.id, "banned");
  db.touchLastLogin(alice.id, new Date("2023-11-14T00:00:00Z").getTime());
  db.touchLastLogin(bob.id, new Date("2027-01-15T00:00:00Z").getTime());

  // 角色
  assert.deepEqual(db.listUsersPage({ role: "admin" }).rows.map((u) => u.name), ["bob"]);
  // 状态：正常（active 且未锁）/ 封禁
  assert.deepEqual(db.listUsersPage({ status: "active" }).rows.map((u) => u.name), ["alice", "bob"]);
  assert.deepEqual(db.listUsersPage({ status: "banned" }).rows.map((u) => u.name), ["carol"]);

  // 登录时间范围：只有 alice 落在 2023 年（carol 从未登录 → 被排除）
  const from = new Date("2023-01-01T00:00:00Z").getTime();
  const to = new Date("2024-01-01T00:00:00Z").getTime();
  assert.deepEqual(db.listUsersPage({ lastLoginFrom: from, lastLoginTo: to }).rows.map((u) => u.name), ["alice"]);
  // 组合过滤：admin + 2023 范围 → 空
  assert.deepEqual(db.listUsersPage({ role: "admin", lastLoginFrom: from, lastLoginTo: to }).rows.map((u) => u.name), []);

  // 临时锁定：locked 命中 alice，且 active 不再含 alice
  db.lockAccount(alice.id, Date.now() + 60_000);
  assert.deepEqual(db.listUsersPage({ status: "locked" }).rows.map((u) => u.name), ["alice"]);
  assert.deepEqual(db.listUsersPage({ status: "active" }).rows.map((u) => u.name), ["bob"]);
});

test("listHostsPage：按搜索 / E2EE / 加入时间范围过滤", () => {
  const db = makeDb();
  const owner = db.createUser("owner", "hash");
  db.createHost("h-plain", owner.id, "plain-host", "tok1", undefined, "2024-03-01T00:00:00.000Z");
  db.createHost("h-e2ee", owner.id, "e2ee-host", "tok2", "pubkey", "2025-06-01T00:00:00.000Z");

  // 搜索（主机名 / 归属用户）
  assert.deepEqual(db.listHostsPage({ q: "plain" }).rows.map((h) => h.name), ["plain-host"]);
  // E2EE
  assert.deepEqual(db.listHostsPage({ e2ee: "yes" }).rows.map((h) => h.name), ["e2ee-host"]);
  assert.deepEqual(db.listHostsPage({ e2ee: "no" }).rows.map((h) => h.name), ["plain-host"]);

  // 加入时间范围：只落在 2025 的那台
  const from = new Date("2025-01-01T00:00:00Z").getTime();
  const to = new Date("2026-01-01T00:00:00Z").getTime();
  assert.deepEqual(db.listHostsPage({ createdFrom: from, createdTo: to }).rows.map((h) => h.name), ["e2ee-host"]);

  // 组合过滤：E2EE + 2024 范围 → 空
  const y2024From = new Date("2024-01-01T00:00:00Z").getTime();
  const y2024To = new Date("2025-01-01T00:00:00Z").getTime();
  assert.deepEqual(db.listHostsPage({ e2ee: "yes", createdFrom: y2024From, createdTo: y2024To }).rows.map((h) => h.name), []);
});

test("renameRelayJoinToken：改名生效 + 审计原名", async () => {
  const db = makeDb();
  const boss = makeUser(db, "boss", "admin");
  const created = await createRelayJoinToken(createSqliteStore(db), ctx(boss, "admin"), { name: "旧名" });
  await renameRelayJoinToken(createSqliteStore(db), ctx(boss, "admin"), created.id, "新名", "改名原因");
  assert.equal(db.getRelayJoinToken(created.id)!.name, "新名");
  const row = (await listAudit(createSqliteStore(db), { source: "admin" })).find((a) => a.event === "admin.relay-join-token.rename");
  assert.ok(row !== undefined);
});

test("listRelayJoinTokens：readonly 看不到明文，operator 可见", async () => {
  const db = makeDb();
  const op = makeUser(db, "op", "operator");
  const ro = makeUser(db, "ro", "readonly");
  const tok = await createRelayJoinToken(createSqliteStore(db), ctx(op, "operator"), { name: "t" });
  // operator 可见明文
  const opView = (await listRelayJoinTokens(createSqliteStore(db), ctx(op, "operator"))).find((x) => x.id === tok.id)!;
  assert.equal(opView.tokenPlaintext, tok.token);
  // readonly 明文被剥离
  const roView = (await listRelayJoinTokens(createSqliteStore(db), ctx(ro, "readonly"))).find((x) => x.id === tok.id)!;
  assert.equal(roView.tokenPlaintext, "");
});

test("listAuditPage：分页 total + limit/offset 生效，旧 listAudit 仍可用", () => {
  const db = makeDb();
  const bossId = makeUser(db, "boss", "admin");
  db.recordAudit(bossId, "admin.evt-1", {}, "1.2.3.4", 1_700_000_000_000, { source: "admin", actorUserId: bossId });
  db.recordAudit(bossId, "admin.evt-2", {}, "1.2.3.4", 1_700_000_100_000, { source: "admin", actorUserId: bossId });
  db.recordAudit(bossId, "admin.evt-3", {}, "1.2.3.4", 1_700_000_200_000, { source: "admin", actorUserId: bossId });
  // 按 id 倒序 → evt-3, evt-2, evt-1
  const page1 = db.listAuditPage({ source: "admin" }, 2, 0);
  assert.equal(page1.total, 3);
  assert.deepEqual(page1.rows.map((a) => a.event), ["admin.evt-3", "admin.evt-2"]);
  const page2 = db.listAuditPage({ source: "admin" }, 2, 2);
  assert.deepEqual(page2.rows.map((a) => a.event), ["admin.evt-1"]);
  // 旧接口仍是数组（最多 1000）
  assert.equal(db.listAudit({ source: "admin" }).length, 3);
});

test("listNodesPage：分页 total + limit/offset 生效", () => {
  const db = makeDb();
  db.createNode("nd-1", "sg1", "https://sg1.example", "h1", "sg", 100, 10, true, null, 1_700_000_000_000);
  db.createNode("nd-2", "sg2", "https://sg2.example", "h2", "sg", 100, 10, true, null, 1_700_000_100_000);
  db.createNode("nd-3", "sg3", "https://sg3.example", "h3", "sg", 100, 10, true, null, 1_700_000_200_000);
  // 按 created_at 升序 → nd-1, nd-2, nd-3
  const page1 = db.listNodesPage(2, 0);
  assert.equal(page1.total, 3);
  assert.deepEqual(page1.rows.map((n) => n.id), ["nd-1", "nd-2"]);
  const page2 = db.listNodesPage(2, 2);
  assert.deepEqual(page2.rows.map((n) => n.id), ["nd-3"]);
});

test("listOrders：按订单号精确 / 套餐 / 状态过滤 + 分页", () => {
  const db = makeDb();
  const u = makeUser(db, "alice");
  db.createOrder("ord-1", u, "pro", 100, 1_700_000_000_000);
  db.createOrder("ord-2", u, "basic", 50, 1_700_000_100_000);
  db.markOrderPaid("ord-2", "wechat", "out-1");
  db.createOrder("ord-3", u, "pro", 100, 1_700_000_200_000);
  db.closeOrder("ord-3");

  // 订单号精确匹配
  assert.deepEqual(db.listOrders({ q: "ord-1" }).rows.map((o) => o.id), ["ord-1"]);
  assert.deepEqual(db.listOrders({ q: "ord-9" }).rows.map((o) => o.id), []);
  // 套餐
  assert.deepEqual(db.listOrders({ planId: "pro" }).rows.map((o) => o.id).sort(), ["ord-1", "ord-3"]);
  // 状态
  assert.deepEqual(db.listOrders({ status: "paid" }).rows.map((o) => o.id), ["ord-2"]);
  assert.deepEqual(db.listOrders({ status: "closed" }).rows.map((o) => o.id), ["ord-3"]);
  // 组合
  assert.deepEqual(db.listOrders({ planId: "pro", status: "created" }).rows.map((o) => o.id), ["ord-1"]);
  // 分页：total 正确 + limit/offset 生效（按 created_at 倒序 → ord-3, ord-2, ord-1）
  const page1 = db.listOrders({ limit: 2, offset: 0 });
  assert.equal(page1.total, 3);
  assert.deepEqual(page1.rows.map((o) => o.id), ["ord-3", "ord-2"]);
  const page2 = db.listOrders({ limit: 2, offset: 2 });
  assert.deepEqual(page2.rows.map((o) => o.id), ["ord-1"]);
});
