/**
 * api.test.ts — 层 1 API 端到端（http 测试实例，内存 DB）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { HubDb } from "../src/db.ts";
import { HubAuth, hashPassword } from "../src/auth.ts";
import { Jwt, randomToken, sha256 } from "../src/jwt.ts";
import { TunnelRegistry } from "../src/tunnel.ts";
import { EventHub } from "../src/events.ts";
import { startHubServer } from "../src/server.ts";
import type { RunningHub } from "../src/server.ts";

let server: RunningHub | null = null;
let base = "";
let db: HubDb;
let auth: HubAuth;

async function start(): Promise<void> {
  db = new HubDb(":memory:");
  auth = new HubAuth(db, new Jwt(Buffer.from("test-key-0123456789abcdef")));
  server = await startHubServer({
    host: "127.0.0.1",
    port: 0,
    db,
    auth,
    tunnels: new TunnelRegistry(),
    events: new EventHub(),
    portalDir: "/nonexistent-portal", // 测试不依赖 portal
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

async function get(path: string, cookie?: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(base + path, { headers: cookie !== undefined ? { cookie } : {} });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

test.before(start);
test.after(stop);

test("register 端点不存在（注册关闭，防 bot）", async () => {
  const r = await post("/api/auth/register", { name: "bot", password: "x" });
  assert.equal(r.status, 404);
  assert.equal((r.json.error as Record<string, unknown>).code, "NOT_FOUND");
});

test("登录：成功 200 + Cookie + token；错误密码 401", async () => {
  db.createUser("alice", await hashPassword("pw123456"));
  const ok = await post("/api/auth/login", { name: "alice", password: "pw123456" });
  assert.equal(ok.status, 200);
  assert.equal(typeof ok.json.accessToken, "string");
  assert.equal(typeof ok.json.refreshToken, "string");
  const bad = await post("/api/auth/login", { name: "alice", password: "wrong" });
  assert.equal(bad.status, 401);
});



test("未认证访问 host 端点 → 401", async () => {
  const r = await get("/api/hosts");
  assert.equal(r.status, 401);
});

test("host 列表（含在线状态）", async () => {
  const login = await post("/api/auth/login", { name: "alice", password: "pw123456" });
  const cookie = `rdsh_session=${login.json.accessToken}`;
  const r = await get("/api/hosts", cookie);
  assert.equal(r.status, 200);
  const hosts = r.json.hosts as Array<Record<string, unknown>>;
  assert.equal(hosts.length, 0);
});

test("配对码流程：pending → bind → gateway 轮询取 token", async () => {
  const login = await post("/api/auth/login", { name: "alice", password: "pw123456" });
  const cookie = `rdsh_session=${login.json.accessToken}`;

  const pending = await post("/api/hosts/pending", {});
  assert.equal(pending.status, 200);
  const pendingId = pending.json.pendingId as string;
  const code = pending.json.code as string;
  assert.match(code, /^\d{6}$/);

  // 未绑定时轮询 → pending
  const poll1 = await get(`/api/hosts/pending/${pendingId}`);
  assert.equal(poll1.json.status, "pending");

  // 错误码 → 400
  const badBind = await post("/api/hosts/bind", { code: "000000" }, cookie);
  assert.equal(badBind.status, 400);

  // 绑定
  const bind = await post("/api/hosts/bind", { code }, cookie);
  assert.equal(bind.status, 200);
  const hostId = bind.json.hostId as string;
  assert.ok(hostId.length > 0);

  // gateway 轮询 → bound + token
  const poll2 = await get(`/api/hosts/pending/${pendingId}`);
  assert.equal(poll2.json.status, "bound");
  const hostToken = poll2.json.token as string;
  assert.ok(hostToken.length >= 32);
  // token 只取一次
  const poll3 = await get(`/api/hosts/pending/${pendingId}`);
  assert.equal(poll3.status, 410);

  // host 出现在列表（离线）
  const hosts = await get("/api/hosts", cookie);
  const list = hosts.json.hosts as Array<Record<string, unknown>>;
  assert.equal(list.length, 1);
  assert.equal(list[0]!.id, hostId);
  assert.equal(list[0]!.online, false);
});

test("改名 / 吊销（owner）", async () => {
  const login = await post("/api/auth/login", { name: "alice", password: "pw123456" });
  const cookie = `rdsh_session=${login.json.accessToken}`;
  const hosts = await get("/api/hosts", cookie);
  const list = hosts.json.hosts as Array<Record<string, unknown>>;
  const hostId = list[0]!.id as string;

  const rename = await fetch(base + `/api/hosts/${hostId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "dev-ubuntu" }),
  });
  assert.equal(rename.status, 200);
  const renamed = await get("/api/hosts", cookie);
  assert.equal((renamed.json.hosts as Array<Record<string, unknown>>)[0]!.name, "dev-ubuntu");

  const del = await fetch(base + `/api/hosts/${hostId}`, { method: "DELETE", headers: { cookie } });
  assert.equal(del.status, 200);
  const after = await get("/api/hosts", cookie);
  assert.equal((after.json.hosts as Array<Record<string, unknown>>).length, 0);
});

test("隔离：user B 不能访问 user A 的 host（403）", async () => {
  db.createUser("bob", await hashPassword("bobpw123"));
  const hostId = "host-for-alice";
  db.createHost(hostId, 1, "alice-host", sha256(randomToken())); // alice 的 host
  const bobLogin = await post("/api/auth/login", { name: "bob", password: "bobpw123" });
  const bobCookie = `rdsh_session=${bobLogin.json.accessToken}`;
  const list = await get("/api/hosts", bobCookie);
  assert.equal((list.json.hosts as Array<Record<string, unknown>>).length, 0); // 看不到
  const patch = await fetch(base + `/api/hosts/${hostId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: bobCookie },
    body: JSON.stringify({ name: "hijack" }),
  });
  assert.equal(patch.status, 403);
});

test("改密：旧 cookie 立即失效", async () => {
  db.createUser("carol", await hashPassword("oldpass1"));
  const login = await post("/api/auth/login", { name: "carol", password: "oldpass1" });
  const cookie = `rdsh_session=${login.json.accessToken}`;
  const r = await post("/api/auth/password", { currentPassword: "oldpass1", newPassword: "newpass123" }, cookie);
  assert.equal(r.status, 200);
  const after = await get("/api/hosts", cookie); // 旧 access 失效（ver+1）
  assert.equal(after.status, 401);
  const relogin = await post("/api/auth/login", { name: "carol", password: "newpass123" });
  assert.equal(relogin.status, 200);
});

test("首次设密码（--no-password 建号激活）", async () => {
  // 未激活用户：must_change=1
  db.createUser("newbie", "scrypt:disabled", new Date().toISOString(), true);
  // 未激活无法正常登录
  const pre = await post("/api/auth/login", { name: "newbie", password: "whatever" });
  assert.equal(pre.status, 401);
  // 激活：设置密码
  const act = await post("/api/auth/first-password", { name: "newbie", newPassword: "activat3d" });
  assert.equal(act.status, 200);
  assert.equal(typeof act.json.accessToken, "string");
  // 已激活用户再次 first-password → 400
  const again = await post("/api/auth/first-password", { name: "newbie", newPassword: "anotherpw1" });
  assert.equal(again.status, 400);
  // 新密码可登录
  const login = await post("/api/auth/login", { name: "newbie", password: "activat3d" });
  assert.equal(login.status, 200);
  assert.equal(login.json.mustChangePassword, false);
});

test("登录限流：连续失败 5 次 → 429", async () => {
  // 复用 login：5 次失败（前面已 1 次失败 → 再 4 次到阈值）
  let status = 0;
  for (let i = 0; i < 5; i++) {
    const r = await post("/api/auth/login", { name: "alice", password: "bad" });
    status = r.status;
  }
  assert.equal(status, 429);
  // 锁定期间正确密码也 429
  const locked = await post("/api/auth/login", { name: "alice", password: "pw123456" });
  assert.equal(locked.status, 429);
});
