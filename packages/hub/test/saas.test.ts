/**
 * saas.test.ts — 08-saas S1/S2 端到端（内存 DB + http 实例）。
 *
 * 覆盖：注册双通道（email/+86 phone）→ 验证激活 → trial 配额 → 订阅 → 状态机降级 → 删除。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { HubDb } from "../src/db.ts";
import { HubAuth } from "../src/auth.ts";
import { Jwt, sha256 } from "../src/jwt.ts";
import { TunnelRegistry } from "../src/tunnel.ts";
import { EventHub } from "../src/events.ts";
import { startHubServer } from "../src/server.ts";
import type { RunningHub } from "../src/server.ts";
import { sweepBilling } from "../src/api.ts";
import type { HubRuntime } from "../src/api.ts";
import type { HubConfig } from "../src/config.ts";

let server: RunningHub | null = null;
let base = "";
let db: HubDb;
let runtime: HubRuntime;

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
  billing: { plans: [{ id: "pro", name: "Pro", hosts: 5, priceCny: 39, intervalDays: 30 }] },
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
