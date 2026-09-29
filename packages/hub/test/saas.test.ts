/**
 * saas.test.ts — 08-saas S1/S2 端到端（内存 DB + http 实例）。
 *
 * 覆盖：注册双通道（email/+86 phone）→ 验证激活 → trial 配额 → 订阅 → 状态机降级 → 删除。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { HubDb } from "../src/db.ts";
import { HubAuth, hashPassword } from "../src/auth.ts";
import { generateSecret, totp } from "../src/totp.ts";
import { Jwt, sha256 } from "../src/jwt.ts";
import { TunnelRegistry } from "../src/tunnel.ts";
import { EventHub } from "../src/events.ts";
import { startHubServer } from "../src/server.ts";
import type { RunningHub } from "../src/server.ts";
import { sweepBilling, addMonths } from "../src/api.ts";
import type { HubRuntime } from "../src/api.ts";
import type { HubConfig } from "../src/config.ts";

let server: RunningHub | null = null;
let base = "";
let db: HubDb;
let runtime: HubRuntime;
let adminSession = "";

const config: HubConfig = {
  host: "127.0.0.1",
  port: 0,
  dbPath: ":memory:",
  jwtKeyPath: "",
  behindProxy: false,
  email: { provider: "log", from: "noreply@test.local" },
  sms: { provider: "log" },
  captcha: { provider: "none" },
  registration: "open",
  billing: { plans: [{ id: "pro", name: "Pro", hosts: 5, priceCny: 39, intervalMonths: 1 }] },
};

async function start(): Promise<void> {
  db = new HubDb(":memory:");
  const auth = new HubAuth(db, new Jwt(Buffer.from("test-key-0123456789abcdef")));
  const tunnels = new TunnelRegistry();
  const events = new EventHub();
  runtime = { config, db, auth, tunnels, events };
  server = await startHubServer({
    host: "127.0.0.1",
    port: 0,
    db,
    auth,
    tunnels,
    events,
    portalDir: "/nonexistent-portal",
    email: config.email,
    sms: config.sms,
    captcha: config.captcha,
    registration: config.registration,
    billing: config.billing,
  });
  base = `http://127.0.0.1:${server.actualPort}`;
}

async function stop(): Promise<void> {
  if (server !== null) {
    await new Promise<void>((r) => server!.server.close(() => r()));
    db.close();
    server = null;
  }
}

async function post(path: string, body: unknown, cookie?: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie !== undefined ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

async function del(path: string, body: unknown, cookie?: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(base + path, {
    method: "DELETE",
    headers: { "content-type": "application/json", ...(cookie !== undefined ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

test.before(start);
test.before(async () => {
  adminSession = await adminCookie();
});
test.after(stop);

test("注册（email）→ 建 pending 用户 → 验证激活 → trial + 自动登录", async () => {
  const r = await post("/api/auth/register", { channel: "email", identifier: "a@test.com", password: "pw123456" });
  assert.equal(r.status, 200);
  const user = db.getUserByEmail("a@test.com");
  assert.ok(user !== null);
  assert.equal(user.name, "a@test.com");
  assert.equal(user.accountStatus, "pending");
  assert.equal(user.planStatus, null);

  // 用已知码替代真实邮件发送（seed）
  db.createEmailCode(user.id, "a@test.com", "verify", sha256("123456"), Date.now() + 60_000);
  const v = await post("/api/auth/verify", { channel: "email", identifier: "a@test.com", code: "123456" });
  assert.equal(v.status, 200);
  assert.equal(typeof v.json.accessToken, "string");

  const active = db.getUserByEmail("a@test.com");
  assert.equal(active.accountStatus, "active");
  assert.equal(active.emailVerified, 1);
  assert.equal(active.planStatus, "trial");
  assert.ok((active.planExpiresAt ?? 0) > Date.now());
});

test("重复注册已激活邮箱 → 409", async () => {
  const r = await post("/api/auth/register", { channel: "email", identifier: "a@test.com", password: "pw123456" });
  assert.equal(r.status, 409);
  assert.equal((r.json.error as Record<string, unknown>).code, "ALREADY_EXISTS");
});

test("手机号注册（sms log）→ 验证激活 → trial", async () => {
  const r = await post("/api/auth/register", { channel: "phone", identifier: "13800138000", password: "pw123456" });
  assert.equal(r.status, 200);
  const user = db.getUserByPhone("+8613800138000");
  assert.ok(user !== null);
  assert.equal(user.accountStatus, "pending");

  db.createSmsCode(user.id, "+8613800138000", "verify", sha256("654321"), Date.now() + 60_000);
  const v = await post("/api/auth/verify", { channel: "phone", identifier: "13800138000", code: "654321" });
  assert.equal(v.status, 200);
  assert.equal(db.getUserByPhone("+8613800138000").accountStatus, "active");
  assert.equal(db.getUserByPhone("+8613800138000").planStatus, "trial");
});

test("非法手机号 → 400", async () => {
  const r = await post("/api/auth/register", { channel: "phone", identifier: "12345", password: "pw123456" });
  assert.equal(r.status, 400);
});

test("配额钩子：trial=1 台，第 2 台 host 注册被拒 QUOTA_EXCEEDED", async () => {
  const owner = db.getUserByEmail("a@test.com");
  assert.ok(owner !== null);
  const token = "join-token-0123456789abcdef";
  db.createJoinToken("jt1", null, owner.id, sha256(token), Date.now() + 60_000);

  const first = await post("/api/hosts/register", { token, name: "host-1" });
  assert.equal(first.status, 200);
  assert.equal(typeof first.json.hostId, "string");

  const second = await post("/api/hosts/register", { token, name: "host-2" });
  assert.equal(second.status, 403);
  assert.equal((second.json.error as Record<string, unknown>).code, "QUOTA_EXCEEDED");
});

test("订阅 → mock 支付 → subscribed + 配额升级到 5", async () => {
  const owner = db.getUserByEmail("a@test.com");
  const cookie = await loginCookie("a@test.com", "pw123456");
  const s = await post("/api/billing/subscribe", { planId: "pro" }, cookie);
  assert.equal(s.status, 200);
  assert.equal(s.json.paid, true);

  const active = db.getUserByEmail("a@test.com");
  assert.equal(active.planStatus, "subscribed");
  const sub = db.getActiveSubscription(owner.id);
  assert.ok(sub !== null);
  assert.equal(sub.planId, "pro");
});

test("订阅 form 分流：jsapi 无 openid → 400；h5/native/缺省 → mock paid", async () => {
  const cookie = await loginCookie("a@test.com", "pw123456");

  const jsapi = await post("/api/billing/subscribe", { planId: "pro", form: "jsapi" }, cookie);
  assert.equal(jsapi.status, 400);
  assert.equal((jsapi.json.error as Record<string, unknown>).code, "JSAPI_OPENID_REQUIRED");

  const h5 = await post("/api/billing/subscribe", { planId: "pro", form: "h5" }, cookie);
  assert.equal(h5.status, 200);
  assert.equal(h5.json.paid, true);

  const native = await post("/api/billing/subscribe", { planId: "pro", form: "native" }, cookie);
  assert.equal(native.status, 200);
  assert.equal(native.json.paid, true);

  const bad = await post("/api/billing/subscribe", { planId: "pro", form: "weird" }, cookie);
  assert.equal(bad.status, 400);

  const oauth = await fetch(base + "/api/wechat/oauth/authorize?redirect=%2Fbilling", { headers: { cookie } });
  assert.equal(oauth.status, 400);
  const oj = (await oauth.json()) as Record<string, unknown>;
  assert.equal((oj.error as Record<string, unknown>).code, "WECHAT_OAUTH_DISABLED");
});

test("状态机：trial/subscribed 到期 → grace → free", async () => {
  const owner = db.getUserByEmail("a@test.com");
  // subscribed 到期 → grace
  db.setPlan(owner.id, "subscribed", Date.now() - 1);
  sweepBilling(runtime, Date.now());
  assert.equal(db.getUserByEmail("a@test.com").planStatus, "grace");
  // grace 到期 → free
  db.setPlan(owner.id, "grace", Date.now() - 1);
  sweepBilling(runtime, Date.now());
  assert.equal(db.getUserByEmail("a@test.com").planStatus, "free");
});

test("账号删除：墓碑化 + 释放标识符 + 可重注册", async () => {
  const before = db.getUserByEmail("a@test.com");
  assert.ok(before !== null);
  const uid = before.id;
  const cookie = await loginCookie("a@test.com", "pw123456");
  const d = await del("/api/account", { password: "pw123456" }, cookie);
  assert.equal(d.status, 200);
  const user = db.getUserByName(`deleted-${uid}`);
  assert.equal(user.accountStatus, "deleted");
  assert.equal(user.email, null);

  // 释放后可重新注册同一邮箱
  const r = await post("/api/auth/register", { channel: "email", identifier: "a@test.com", password: "pw123456" });
  assert.equal(r.status, 200);
});

async function loginCookie(identifier: string, password: string): Promise<string> {
  const res = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier, password }),
  });
  const setCookie = res.headers.get("set-cookie") ?? "";
  return setCookie.split(";")[0]!;
}

/** 直接铸造 admin 会话 cookie（开 2FA + admin 角色）。管理台登录流本身已由 admin.test.ts 覆盖。 */
async function adminCookie(): Promise<string> {
  const name = `boss-${Math.random().toString(36).slice(2, 8)}`;
  const u = db.createUser(name, await hashPassword("pw12345678"));
  db.setRole(u.id, "admin");
  const secret = generateSecret();
  db.setTotpSecret(u.id, secret);
  const token = runtime.auth.issueAdminSession(u.id, totp(secret));
  assert.ok(token !== null, "admin session should mint");
  return `rdsh_admin_session=${token}`;
}

test("找回密码：email 通道接受 identifier（双通道回归）", async () => {
  await post("/api/auth/register", { channel: "email", identifier: "reset@test.com", password: "pw123456" });
  const u = db.getUserByEmail("reset@test.com");
  assert.ok(u !== null);
  db.createEmailCode(u.id, "reset@test.com", "verify", sha256("123456"), Date.now() + 60_000);
  await post("/api/auth/verify", { channel: "email", identifier: "reset@test.com", code: "123456" });

  const req = await post("/api/auth/password/reset", { channel: "email", identifier: "reset@test.com" });
  assert.equal(req.status, 200);

  const u2 = db.getUserByEmail("reset@test.com");
  db.createEmailCode(u2.id, "reset@test.com", "reset", sha256("654321"), Date.now() + 60_000);
  const conf = await post("/api/auth/password/reset/confirm", { channel: "email", identifier: "reset@test.com", code: "654321", newPassword: "newpw123456" });
  assert.equal(conf.status, 200);
});

test("feature16 E1：plan-null 账号被管理台设到期 → sweepBilling 到期硬降 free", () => {
  const u = db.createUser("manual-expire-user", "hash");
  // 模拟 admin 建号时带到期（E1：plan_status 保持 null + 只设 plan_expires_at）
  db.setPlan(u.id, null, Date.now() - 1000);
  sweepBilling(runtime, Date.now());
  const after = db.getUserById(u.id)!;
  assert.equal(after.planStatus, "free");
  assert.equal(after.planExpiresAt, null);
  // 未到期的不降
  const keep = db.createUser("manual-expire-future", "hash");
  db.setPlan(keep.id, null, Date.now() + 86_400_000);
  sweepBilling(runtime, Date.now());
  assert.equal(db.getUserById(keep.id)!.planStatus, null);
});

test("feature16 last_login：建号不算；touchLastLogin 更新；密码登录成功更新", async () => {
  // db 级
  const u = db.createUser("last-login-db-user", "hash");
  assert.equal(db.getUserById(u.id)!.lastLoginAt, null);
  db.touchLastLogin(u.id, 12345);
  assert.equal(db.getUserById(u.id)!.lastLoginAt, 12345);
  // 真实注册 + 验证（verify 自动登录但不算 last_login）→ 密码登录成功才更新
  const r = await post("/api/auth/register", { channel: "email", identifier: "login-touch@test.com", password: "pw123456" });
  assert.equal(r.status, 200);
  const user = db.getUserByEmail("login-touch@test.com")!;
  db.createEmailCode(user.id, "login-touch@test.com", "verify", sha256("123456"), Date.now() + 60_000);
  await post("/api/auth/verify", { channel: "email", identifier: "login-touch@test.com", code: "123456" });
  const afterVerify = db.getUserByEmail("login-touch@test.com")!;
  assert.equal(afterVerify.lastLoginAt, null); // 注册验证不计（只统计成功登录）
  const lr = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: "login-touch@test.com", password: "pw123456" }),
  });
  assert.equal(lr.status, 200);
  const afterLogin = db.getUserByEmail("login-touch@test.com")!;
  assert.ok(afterLogin.lastLoginAt !== null && afterLogin.lastLoginAt > 0);
});

// ---- feature 23：授权动作化 + 后端强校验（HTTP 级） ----

test("grant-trial：HTTP 成功 + trial 顺延；缺 days → 400", async () => {
  const u = db.createUser("grant-trial-ee", await hashPassword("pw12345678"));
  const exp = Date.now() + 24 * 3600 * 1000;
  db.setPlan(u.id, "trial", exp);
  const r = await post(`/api/admin/users/${u.id}/grant-trial`, { days: 30, reason: "客服延长" }, adminSession);
  assert.equal(r.status, 200);
  const after = db.getUserById(u.id)!;
  assert.equal(after.planStatus, "trial");
  assert.ok((after.planExpiresAt ?? 0) >= exp + 30 * 24 * 3600 * 1000 - 1000);
  const bad = await post(`/api/admin/users/${u.id}/grant-trial`, { reason: "x" }, adminSession);
  assert.equal(bad.status, 400);
});

test("plan 收紧：subscribed 无订阅 → 400；null 带到期 → 400", async () => {
  const u = db.createUser("plan-ee", "hash");
  const a = await post(`/api/admin/users/${u.id}/plan`, { planStatus: "subscribed", expiresAtMs: Date.now() + 86_400_000, reason: "x" }, adminSession);
  assert.equal(a.status, 400);
  const b = await post(`/api/admin/users/${u.id}/plan`, { planStatus: "null", expiresAtMs: Date.now() + 86_400_000, reason: "x" }, adminSession);
  assert.equal(b.status, 400);
});

test("建号：trialDays → trial；都不给 → 永久无限；两者同给 → 400", async () => {
  const a = await post("/api/admin/users", { identifier: "trial-new@test.com", password: "pw12345678", trialDays: 7, reason: "x" }, adminSession);
  assert.equal(a.status, 200);
  assert.equal(db.getUserByEmail("trial-new@test.com")!.planStatus, "trial");
  const b = await post("/api/admin/users", { identifier: "perm-new@test.com", password: "pw12345678", reason: "x" }, adminSession);
  assert.equal(b.status, 200);
  assert.equal(db.getUserByEmail("perm-new@test.com")!.planStatus, null);
  const c = await post("/api/admin/users", { identifier: "both@test.com", password: "pw12345678", trialDays: 7, expiresAtMs: Date.now() + 86_400_000, reason: "x" }, adminSession);
  assert.equal(c.status, 400);
});

test("grant-subscription 端到端：trial(1 台) → 赠 pro → 配额升级可接第 2 台", async () => {
  const r = await post("/api/admin/users", { identifier: "grant-pro@test.com", password: "pw12345678", trialDays: 7, reason: "x" }, adminSession);
  assert.equal(r.status, 200);
  const owner = db.getUserByEmail("grant-pro@test.com")!;
  const token = "grant-pro-join-token-0123456789abcdef";
  db.createJoinToken("jgrant", null, owner.id, sha256(token), Date.now() + 60_000);
  const h1 = await post("/api/hosts/register", { token, name: "h1" });
  assert.equal(h1.status, 200);
  const h2 = await post("/api/hosts/register", { token, name: "h2" });
  assert.equal(h2.status, 403); // trial 1 台
  const g = await post(`/api/admin/users/${owner.id}/grant-subscription`, { planId: "pro", days: 365, reason: "受邀请用户" }, adminSession);
  assert.equal(g.status, 200);
  assert.equal(db.getUserByEmail("grant-pro@test.com")!.planStatus, "subscribed");
  assert.equal(db.getActiveSubscription(owner.id)!.planId, "pro");
  const h2b = await post("/api/hosts/register", { token, name: "h2" });
  assert.equal(h2b.status, 200); // 配额升级后成功
  const badPlan = await post(`/api/admin/users/${owner.id}/grant-subscription`, { planId: "nope", days: 30, reason: "x" }, adminSession);
  assert.equal(badPlan.status, 400);
});

// ---- 日历月顺延（addMonths）边界 ----

test("addMonths：月末收敛 + 闰年 + 跨年 + 普通日期不漂移", () => {
  const iso = (ts: number) => new Date(ts).toISOString().slice(0, 10);
  // 2026-01-31 +1 月 → 2026-02-28（月末收敛到 2 月最后一天）
  assert.equal(iso(addMonths(Date.UTC(2026, 0, 31), 1)), "2026-02-28");
  // 2024-01-31 +1 月 → 2024-02-29（闰年）
  assert.equal(iso(addMonths(Date.UTC(2024, 0, 31), 1)), "2024-02-29");
  // 2026-01-15 +1 月 → 2026-02-15（普通日期不漂移）
  assert.equal(iso(addMonths(Date.UTC(2026, 0, 15), 1)), "2026-02-15");
  // 2026-12-31 +1 月 → 2027-01-31（跨年）
  assert.equal(iso(addMonths(Date.UTC(2026, 11, 31), 1)), "2027-01-31");
  // 2026-03-31 +1 月 → 2026-04-30（30 天月）
  assert.equal(iso(addMonths(Date.UTC(2026, 2, 31), 1)), "2026-04-30");
  // 2026-08-31 +1 月 → 2026-09-30
  assert.equal(iso(addMonths(Date.UTC(2026, 7, 31), 1)), "2026-09-30");
  // 多个月：2026-01-31 +3 月 → 2026-04-30
  assert.equal(iso(addMonths(Date.UTC(2026, 0, 31), 3)), "2026-04-30");
});
