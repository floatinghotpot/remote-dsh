/**
 * api.test.ts — 层 1 API 端到端（http 测试实例，内存 DB）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { HubDb } from "../src/db.ts";
import { HubAuth, hashPassword, REFRESH_TTL_MS } from "../src/auth.ts";
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

test("register 端点：注册关闭（默认）返回 REGISTRATION_DISABLED 404，防 bot", async () => {
  const r = await post("/api/auth/register", { channel: "email", identifier: "bot@x.com", password: "x" });
  assert.equal(r.status, 404);
  assert.equal((r.json.error as Record<string, unknown>).code, "REGISTRATION_DISABLED");
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

test("GET /api/capabilities：公开返回通道可用性（未认证可访问）", async () => {
  const r = await get("/api/capabilities");
  assert.equal(r.status, 200);
  assert.equal(r.json.registration, "closed");
  assert.equal(r.json.emailEnabled, false);
  assert.equal(r.json.smsEnabled, false);
  assert.equal(r.json.captchaProvider, "arithmetic");
});

test("GET /api/account：绑定状态回显（未认证 401 / 登录 200 含字段）", async () => {
  const unauth = await get("/api/account");
  assert.equal(unauth.status, 401);
  const login = await post("/api/auth/login", { name: "alice", password: "pw123456" });
  const cookie = `rdsh_hub_session=${login.json.accessToken}`;
  const r = await get("/api/account", cookie);
  assert.equal(r.status, 200);
  assert.equal(r.json.name, "alice");
  assert.equal(r.json.emailVerified, false);
  assert.equal(r.json.phoneVerified, false);
  assert.equal(r.json.totpEnabled, false);
  assert.equal(r.json.smsEnabled, false);
  assert.equal(r.json.planStatus, null);
});



test("未认证访问 host 端点 → 401", async () => {
  const r = await get("/api/hosts");
  assert.equal(r.status, 401);
});

test("host 列表（含在线状态）", async () => {
  const login = await post("/api/auth/login", { name: "alice", password: "pw123456" });
  const cookie = `rdsh_hub_session=${login.json.accessToken}`;
  const r = await get("/api/hosts", cookie);
  assert.equal(r.status, 200);
  const hosts = r.json.hosts as Array<Record<string, unknown>>;
  assert.equal(hosts.length, 0);
});

test("改名 / 吊销（owner）", async () => {
  db.createHost("host-rename", 1, "rename-me", sha256(randomToken()));
  const login = await post("/api/auth/login", { name: "alice", password: "pw123456" });
  const cookie = `rdsh_hub_session=${login.json.accessToken}`;
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

test("self-revoke：host 持自己的 token 注销（未认证端点）", async () => {
  const hostId = "self-host";
  const hostToken = randomToken();
  db.createHost(hostId, 1, "self-host", sha256(hostToken)); // alice(id=1) 的 host

  // 缺 token → 400
  const bad = await post("/api/hosts/self-revoke", {});
  assert.equal(bad.status, 400);
  // 错误 token → 401
  const wrong = await post("/api/hosts/self-revoke", { token: randomToken() });
  assert.equal(wrong.status, 401);
  // 正确 token → 200，host 被删
  const ok = await post("/api/hosts/self-revoke", { token: hostToken });
  assert.equal(ok.status, 200);
  assert.equal(db.getHostById(hostId), null);
  // 再次自吊销 → 401（已删）
  const again = await post("/api/hosts/self-revoke", { token: hostToken });
  assert.equal(again.status, 401);
});

test("join token 创建/列表/吊销", async () => {
  const login = await post("/api/auth/login", { name: "alice", password: "pw123456" });
  const cookie = `rdsh_hub_session=${login.json.accessToken}`;
  const created = await post("/api/hosts/join-token", { label: "my-token" }, cookie);
  assert.equal(created.status, 200);
  const id = created.json.id as string;
  const token = created.json.token as string;
  assert.ok(token.length >= 32);
  assert.equal(typeof created.json.expiresAt, "number");
  // 未认证创建 → 401
  assert.equal((await post("/api/hosts/join-token", {})).status, 401);
  // 列表
  const list = await get("/api/hosts/join-tokens", cookie);
  const tokens = list.json.tokens as Array<Record<string, unknown>>;
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0]!.label, "my-token");
  assert.equal(tokens[0]!.revoked, false);
  // 吊销
  const revoke = await fetch(base + `/api/hosts/join-tokens/${id}`, { method: "DELETE", headers: { cookie } });
  assert.equal(revoke.status, 200);
  const list2 = await get("/api/hosts/join-tokens", cookie);
  assert.equal((list2.json.tokens as Array<Record<string, unknown>>)[0]!.revoked, true);
});

test("register：join token → host（多用途）；host token 幂等；无效 401", async () => {
  const login = await post("/api/auth/login", { name: "alice", password: "pw123456" });
  const cookie = `rdsh_hub_session=${login.json.accessToken}`;
  const created = await post("/api/hosts/join-token", {}, cookie);
  const joinToken = created.json.token as string;

  // 用 join token 注册
  const reg = await post("/api/hosts/register", { token: joinToken, name: "my-ecs" });
  assert.equal(reg.status, 200);
  const hostId = reg.json.hostId as string;
  const hostToken = reg.json.hostToken as string;
  assert.ok(hostId.length > 0 && hostToken.length >= 32);
  const hosts = await get("/api/hosts", cookie);
  assert.ok((hosts.json.hosts as Array<Record<string, unknown>>).some((h) => h.id === hostId));

  // host token 幂等 → 返回同一 hostId
  const reg2 = await post("/api/hosts/register", { token: hostToken });
  assert.equal(reg2.status, 200);
  assert.equal(reg2.json.hostId, hostId);

  // 同一 join token 多用途 → 第二台
  const reg3 = await post("/api/hosts/register", { token: joinToken, name: "my-ecs-2" });
  assert.equal(reg3.status, 200);
  assert.notEqual(reg3.json.hostId, hostId);

  // 无效 token → 401
  assert.equal((await post("/api/hosts/register", { token: randomToken() })).status, 401);
});

test("register：吊销的 join token 被拒", async () => {
  const login = await post("/api/auth/login", { name: "alice", password: "pw123456" });
  const cookie = `rdsh_hub_session=${login.json.accessToken}`;
  const created = await post("/api/hosts/join-token", {}, cookie);
  const id = created.json.id as string;
  const joinToken = created.json.token as string;
  await fetch(base + `/api/hosts/join-tokens/${id}`, { method: "DELETE", headers: { cookie } });
  assert.equal((await post("/api/hosts/register", { token: joinToken })).status, 401);
});

test("隔离：user B 不能访问 user A 的 host（403）", async () => {
  db.createUser("bob", await hashPassword("bobpw123"));
  const hostId = "host-for-alice";
  db.createHost(hostId, 1, "alice-host", sha256(randomToken())); // alice 的 host
  const bobLogin = await post("/api/auth/login", { name: "bob", password: "bobpw123" });
  const bobCookie = `rdsh_hub_session=${bobLogin.json.accessToken}`;
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
  const cookie = `rdsh_hub_session=${login.json.accessToken}`;
  const r = await post("/api/auth/password", { currentPassword: "oldpass1", newPassword: "newpass123" }, cookie);
  assert.equal(r.status, 200);
  const after = await get("/api/hosts", cookie); // 旧 access 失效（ver+1）
  assert.equal(after.status, 401);
  const relogin = await post("/api/auth/login", { name: "carol", password: "newpass123" });
  assert.equal(relogin.status, 200);
});

// ---- 方案①：HttpOnly 续期 cookie（cookie 优先 / body 回退 / 登出改密清 cookie） ----

async function loginRaw(name: string, password: string): Promise<{ status: number; json: { accessToken: string; refreshToken: string }; setCookies: string[] }> {
  const res = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, password }),
  });
  return { status: res.status, json: (await res.json()) as { accessToken: string; refreshToken: string }, setCookies: res.headers.getSetCookie() };
}

test("登录下发续期 cookie：HttpOnly; Path=/api/auth; Max-Age 由 REFRESH_TTL_MS 换算", async () => {
  db.createUser("dave", await hashPassword("pw123456"));
  const r = await loginRaw("dave", "pw123456");
  assert.equal(r.status, 200);
  const refresh = r.setCookies.find((c) => c.startsWith("rdsh_hub_refresh="));
  assert.ok(refresh, "登录应下发 rdsh_hub_refresh");
  assert.match(refresh!, /HttpOnly/);
  assert.match(refresh!, /Path=\/api\/auth/);
  assert.match(refresh!, new RegExp(`Max-Age=${Math.floor(REFRESH_TTL_MS / 1000)}`));
});

test("续期：仅带 cookie（空 body）→ 200 并轮换两枚 cookie", async () => {
  const login = await loginRaw("dave", "pw123456");
  const res = await fetch(base + "/api/auth/refresh", {
    method: "POST",
    headers: { cookie: `rdsh_hub_refresh=${login.json.refreshToken}` },
  });
  assert.equal(res.status, 200);
  const set = res.headers.getSetCookie();
  assert.ok(set.some((c) => c.startsWith("rdsh_hub_session=")), "续期应下发新 session cookie");
  assert.ok(set.some((c) => c.startsWith("rdsh_hub_refresh=")), "续期应轮换续期 cookie");
  const json = (await res.json()) as { refreshToken: string };
  assert.equal(typeof json.refreshToken, "string"); // 兼容：body 仍返回 refreshToken
});

test("续期：body 回退（旧 portal 兼容）→ 200", async () => {
  const login = await loginRaw("dave", "pw123456");
  const res = await fetch(base + "/api/auth/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken: login.json.refreshToken }),
  });
  assert.equal(res.status, 200);
});

test("续期：cookie 与 body 皆无 → 401（门户据此判 invalid → 跳登录）", async () => {
  const res = await fetch(base + "/api/auth/refresh", { method: "POST" });
  assert.equal(res.status, 401);
});

test("登出：读 cookie 吊销 + 清 session/refresh 两枚 cookie；旧 refresh 不能再续期", async () => {
  const login = await loginRaw("dave", "pw123456");
  const res = await fetch(base + "/api/auth/logout", {
    method: "POST",
    headers: { cookie: `rdsh_hub_refresh=${login.json.refreshToken}` },
  });
  assert.equal(res.status, 204);
  const set = res.headers.getSetCookie();
  assert.ok(set.some((c) => c.includes("rdsh_hub_session=;")), "应清 session cookie");
  assert.ok(set.some((c) => c.includes("rdsh_hub_refresh=;")), "应清 refresh cookie");
  const again = await fetch(base + "/api/auth/refresh", {
    method: "POST",
    headers: { cookie: `rdsh_hub_refresh=${login.json.refreshToken}` },
  });
  assert.equal(again.status, 401); // 已吊销
});

test("改密：清 session/refresh 两枚 cookie", async () => {
  db.createUser("erin", await hashPassword("oldpass1"));
  const login = await loginRaw("erin", "oldpass1");
  const res = await fetch(base + "/api/auth/password", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `rdsh_hub_session=${login.json.accessToken}` },
    body: JSON.stringify({ currentPassword: "oldpass1", newPassword: "newpass123" }),
  });
  assert.equal(res.status, 200);
  const set = res.headers.getSetCookie();
  assert.ok(set.some((c) => c.includes("rdsh_hub_session=;")), "改密应清 session cookie");
  assert.ok(set.some((c) => c.includes("rdsh_hub_refresh=;")), "改密应清 refresh cookie");
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

test("周期清理：pruneExpiredJoinTokens 只删过期 join token", async () => {
  const owner = db.createUser("irene", await hashPassword("pw123456"));
  db.createJoinToken("jt-expired", null, owner.id, sha256(randomToken()), Date.now() - 1000);
  db.createJoinToken("jt-valid", null, owner.id, sha256(randomToken()), Date.now() + 3600_000);

  db.pruneExpiredJoinTokens();

  assert.equal(db.getJoinTokenById("jt-expired"), null, "过期 join token 应被清理");
  assert.notEqual(db.getJoinTokenById("jt-valid"), null, "未过期 join token 应保留");
});

test("用量统计：report 幂等 + query 日序列 + 校验 + 隔离", async () => {
  const user = db.createUser("usage-tester", await hashPassword("pw123456"));
  const pair = auth.issueSession(user.id)!;
  const cookie = `rdsh_hub_session=${pair.accessToken}`;

  // 未认证 401
  assert.equal((await post("/api/usage/report", {})).status, 401);
  assert.equal((await get("/api/usage")).status, 401);

  // 缺字段 400
  assert.equal((await post("/api/usage/report", { date: "2026-10-10" }, cookie)).status, 400);
  // 负数 400
  assert.equal(
    (await post("/api/usage/report", { date: "2026-10-10", relaySeconds: -1 }, cookie)).status,
    400,
  );

  // 上报一天（完整字段）
  const day = {
    date: "2026-10-10",
    relaySeconds: 120,
    relayBytesUp: 1000,
    relayBytesDown: 5000,
    directBytesUp: 200,
    directBytesDown: 300,
    cloudAsrSeconds: 0,
    localAsrSeconds: 30,
    sessions: 2,
  };
  assert.equal((await post("/api/usage/report", day, cookie)).status, 200);

  // 幂等：同天再次上报，替换为最新累计值
  const day2 = { ...day, relaySeconds: 240, relayBytesUp: 2000 };
  assert.equal((await post("/api/usage/report", day2, cookie)).status, 200);

  // query 日序列
  const q = await get("/api/usage?from=2026-10-01&to=2026-10-31", cookie);
  assert.equal(q.status, 200);
  const days = q.json.days as Array<Record<string, unknown>>;
  assert.equal(days.length, 1);
  assert.equal(days[0]!.date, "2026-10-10");
  assert.equal(days[0]!.relaySeconds, 240, "幂等替换后应取最新累计值");
  assert.equal(days[0]!.relayBytesUp, 2000);
  assert.equal(days[0]!.directBytesDown, 300);

  // 非法 from/to 400
  assert.equal((await get("/api/usage?from=bad&to=2026-10-31", cookie)).status, 400);
  assert.equal((await get("/api/usage?from=2026-10-31&to=2026-10-01", cookie)).status, 400);
  // 跨度 > 366 天 → 400
  assert.equal((await get("/api/usage?from=2026-01-01&to=2027-12-31", cookie)).status, 400);
});

test("host usage report：host token 认证 + 归到 host owner", async () => {
  const owner = db.createUser("host-usage-owner", await hashPassword("pw123456"));
  const hostToken = randomToken();
  db.createHost("host-usage-1", owner.id, "host-usage", sha256(hostToken));

  // 缺 token → 400；假 token → 401
  assert.equal((await post("/api/host/usage/report", { date: "2026-10-11" })).status, 400);
  assert.equal(
    (await post("/api/host/usage/report", { token: "x".repeat(20), date: "2026-10-11" })).status,
    401,
  );

  // 正常上报（字节 + 时长 + 会话，语音字段留 0）
  const day = {
    token: hostToken,
    date: "2026-10-11",
    relaySeconds: 60,
    relayBytesUp: 111,
    relayBytesDown: 222,
    directBytesUp: 33,
    directBytesDown: 44,
    cloudAsrSeconds: 0,
    localAsrSeconds: 0,
    sessions: 1,
  };
  assert.equal((await post("/api/host/usage/report", day)).status, 200);

  // 归到 host owner（非访问者）
  const rows = db.listUsageDaily(owner.id, "2026-10-11", "2026-10-11");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.relayBytesUp, 111);
  assert.equal(rows[0]!.directBytesDown, 44);
  assert.equal(rows[0]!.sessions, 1);
});

test("用量统计：同实例 MAX、跨实例 SUM 合并", async () => {
  const user = db.createUser("sum-user", await hashPassword("pw123456"));
  const day = {
    date: "2026-10-10", relaySeconds: 0, relayBytesUp: 100, relayBytesDown: 0,
    directBytesUp: 0, directBytesDown: 0, cloudAsrSeconds: 0, localAsrSeconds: 0, sessions: 1,
  };
  // 实例 a：报 100，再报 80（同实例 MAX → 100）
  db.upsertUsageDaily(user.id, day, { hostId: "h1", instanceId: "a", source: "relay" });
  db.upsertUsageDaily(user.id, { ...day, relayBytesUp: 80 }, { hostId: "h1", instanceId: "a", source: "relay" });
  // 实例 b：报 50（跨实例 SUM → 100 + 50 = 150）
  db.upsertUsageDaily(user.id, { ...day, relayBytesUp: 50 }, { hostId: "h1", instanceId: "b", source: "relay" });

  const rows = db.listUsageDaily(user.id, "2026-10-01", "2026-10-31");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.relayBytesUp, 150, "同实例 MAX(100,80)=100 + 跨实例 50 = 150");
  assert.equal(rows[0]!.sessions, 2, "sessions 跨实例 SUM：实例 a 1 次 + 实例 b 1 次 = 2");
});
