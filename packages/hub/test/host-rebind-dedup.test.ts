/**
 * host-rebind-dedup.test.ts — 同一设备重绑复用 host 记录（fix 20261106-box-rebind-duplicate-host）。
 *
 * 语义：`POST /api/hosts/register` 带 `deviceId` 时，按 (owner, deviceId) **含已吊销行**匹配；
 * 命中则清 `revoked_at`、轮换 host token、保留 hostId/name/共享；未命中才新建。
 *
 * 关键回归点：盒子 `unbind` 走 `rdsh leave` → `selfRevoke` → 行被吊销，
 * 因此去重**必须**能命中 revoked 行，否则「解绑→绑定」每轮都会新建一条。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { HubDb } from "../src/db.ts";
import { HubAuth, hashPassword } from "../src/auth.ts";
import { createSqliteStore } from "../src/store.ts";
import { Jwt, randomToken, sha256 } from "../src/jwt.ts";
import { generateSecret, totp } from "../src/totp.ts";
import { revokeHost as adminRevokeHost } from "../src/admin.ts";
import { TunnelRegistry } from "../src/tunnel.ts";
import { EventHub } from "../src/events.ts";
import { startHubServer } from "../src/server.ts";
import type { RunningHub } from "../src/server.ts";

const DEVICE = "device-aaaaaaaaaaaaaaaaaaaaaaaa";
const DEVICE_B = "device-bbbbbbbbbbbbbbbbbbbbbbbb";

let server: RunningHub | null = null;
let base = "";
let db: HubDb;
let authRef: HubAuth;
let ipSeq = 0;

async function start(): Promise<void> {
  db = new HubDb(":memory:");
  const auth = new HubAuth(createSqliteStore(db), (id) => db.getUserById(id), new Jwt(Buffer.from("test-key-0123456789abcdef")));
  authRef = auth;
  server = await startHubServer({
    host: "127.0.0.1",
    port: 0,
    db,
    auth,
    tunnels: new TunnelRegistry(),
    events: new EventHub(),
    portalDir: "/nonexistent-portal",
    // register 未认证端点按 IP 限流（10 次/分钟）；测试里用 X-Forwarded-For 给每次注册换桶。
    behindProxy: true,
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
  // 每个请求一个独立来源 IP，绕开 register 的 10 次/分钟/IP 限流（不影响被测语义）。
  const res = await fetch(base + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": `10.0.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`,
      ...(cookie !== undefined ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

async function get(path: string, cookie?: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(base + path, { headers: cookie !== undefined ? { cookie } : {} });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

async function owner(name: string): Promise<{ id: number; cookie: string }> {
  const u = db.createUser(name, await hashPassword("pw123456"));
  db.setPlan(u.id, "internal", null);
  const login = await post("/api/auth/login", { name, password: "pw123456" });
  assert.equal(login.status, 200);
  return { id: u.id, cookie: `rdsh_hub_session=${login.json.accessToken}` };
}

/** 造一个可用的 join token（返回明文）。 */
function joinToken(ownerId: number): string {
  const token = randomToken();
  db.createJoinToken(randomUUID(), null, ownerId, sha256(token), Date.now() + 3600_000);
  return token;
}

async function register(token: string, deviceId?: string, name = "RDSH-B6C7"): Promise<{ hostId: string; hostToken: string }> {
  const body: Record<string, unknown> = { token, name };
  if (deviceId !== undefined) body.deviceId = deviceId;
  const res = await post("/api/hosts/register", body);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return { hostId: res.json.hostId as string, hostToken: res.json.hostToken as string };
}

test("同一 deviceId 二次注册 → 同一 hostId + token 轮换（旧 token 失效）", async () => {
  await start();
  try {
    const { id, cookie } = await owner("alice");
    const first = await register(joinToken(id), DEVICE);
    const second = await register(joinToken(id), DEVICE);

    assert.equal(second.hostId, first.hostId, "同一设备重绑必须复用 hostId");
    assert.notEqual(second.hostToken, first.hostToken, "token 必须轮换");

    // 旧 token 失效、新 token 可用
    assert.equal((await post("/api/hosts/self/meta", { token: first.hostToken })).status, 401);
    assert.equal((await post("/api/hosts/self/meta", { token: second.hostToken })).status, 200);

    // 列表里只有一条
    const list = await get("/api/hosts", cookie);
    const hosts = (list.json.hosts as Array<{ id: string }>);
    assert.equal(hosts.length, 1, JSON.stringify(hosts));
  } finally {
    await stop();
  }
});

test("解绑（吊销）后重绑 → 复活同一 hostId，且保留改过的 name", async () => {
  await start();
  try {
    const { id, cookie } = await owner("alice");
    const first = await register(joinToken(id), DEVICE);
    // 用户改名
    assert.equal(db.renameHost(first.hostId, "客厅盒子"), true);
    // 盒子 unbind 走 leave → selfRevoke（软删）
    assert.equal(db.revokeHostRecord(first.hostId), true);
    assert.equal((await get("/api/hosts", cookie)).json.hosts !== undefined, true);
    assert.equal(((await get("/api/hosts", cookie)).json.hosts as unknown[]).length, 0, "吊销后列表不可见");

    const again = await register(joinToken(id), DEVICE);
    assert.equal(again.hostId, first.hostId, "吊销行必须被复活复用，而不是新建");
    const hosts = (await get("/api/hosts", cookie)).json.hosts as Array<{ id: string; name: string }>;
    assert.equal(hosts.length, 1);
    assert.equal(hosts[0]!.name, "客厅盒子", "重绑不应冲掉用户改的名字");
    assert.equal((await post("/api/hosts/self/meta", { token: again.hostToken })).status, 200);
  } finally {
    await stop();
  }
});

test("不同账号用同一个 deviceId → 互不复用", async () => {
  await start();
  try {
    const alice = await owner("alice");
    const bob = await owner("bob");
    const a = await register(joinToken(alice.id), DEVICE);
    const b = await register(joinToken(bob.id), DEVICE);
    assert.notEqual(a.hostId, b.hostId, "deviceId 只在同 owner 内匹配");
    assert.equal(((await get("/api/hosts", alice.cookie)).json.hosts as unknown[]).length, 1);
    assert.equal(((await get("/api/hosts", bob.cookie)).json.hosts as unknown[]).length, 1);
  } finally {
    await stop();
  }
});

test("不带 deviceId（老客户端）→ 每次新建，行为与从前一致", async () => {
  await start();
  try {
    const { id, cookie } = await owner("alice");
    const first = await register(joinToken(id));
    const second = await register(joinToken(id));
    assert.notEqual(second.hostId, first.hostId);
    assert.equal(((await get("/api/hosts", cookie)).json.hosts as unknown[]).length, 2);
  } finally {
    await stop();
  }
});

test("非法 deviceId 被忽略（超长/含非法字符）→ 新建而非复用", async () => {
  await start();
  try {
    const { id } = await owner("alice");
    const first = await register(joinToken(id), DEVICE);
    const bad = await register(joinToken(id), `${DEVICE}/../x`);
    assert.notEqual(bad.hostId, first.hostId);
  } finally {
    await stop();
  }
});

test("设备 B 注册不会抢走设备 A 的记录", async () => {
  await start();
  try {
    const { id, cookie } = await owner("alice");
    const a = await register(joinToken(id), DEVICE);
    const b = await register(joinToken(id), DEVICE_B);
    assert.notEqual(a.hostId, b.hostId);
    assert.equal(((await get("/api/hosts", cookie)).json.hosts as unknown[]).length, 2);
  } finally {
    await stop();
  }
});

/** 铸造 admin 会话 cookie（管理台登录流本身由 admin.test.ts 覆盖）。 */
async function adminCookie(): Promise<string> {
  const name = `boss-${Math.random().toString(36).slice(2, 8)}`;
  const u = db.createUser(name, await hashPassword("pw12345678"));
  db.setRole(u.id, "admin");
  const secret = generateSecret();
  db.setTotpSecret(u.id, secret);
  const token = authRef.issueAdminSession(u.id, totp(secret));
  assert.ok(token !== null, "admin session should mint");
  return `rdsh_admin_session=${token}`;
}

test("管理面 host 列表不暴露 deviceId（只做内部匹配键）", async () => {
  await start();
  try {
    const { id } = await owner("alice");
    await register(joinToken(id), DEVICE);
    const admin = await adminCookie();
    const res = await get("/api/admin/hosts", admin);
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const hosts = res.json.hosts as Array<Record<string, unknown>>;
    assert.equal(hosts.length, 1);
    assert.equal("deviceId" in hosts[0]!, false, `admin 响应不应带 deviceId：${JSON.stringify(hosts[0])}`);
  } finally {
    await stop();
  }
});

test("reissueHostToken 对不存在的行返回 false（供 API 退回新建）", async () => {
  await start();
  try {
    assert.equal(db.reissueHostToken("no-such-host", sha256("tok")), false);
  } finally {
    await stop();
  }
});

test("管理员吊销后重绑 → 不复活，而是新建（撤销不会被一次重绑洗掉）", async () => {
  await start();
  try {
    const { id, cookie } = await owner("alice");
    const first = await register(joinToken(id), DEVICE);
    // 管理员吊销（admin 角色 + 原因）
    db.setRole(id, "admin");
    await adminRevokeHost(createSqliteStore(db), { actorId: id, role: "admin", ip: "127.0.0.1" }, first.hostId, "abuse");
    const afterAdmin = (await get("/api/hosts", cookie)).json.hosts as Array<{ id: string }>;
    assert.equal(afterAdmin.length, 0, "管理员吊销后列表不可见");

    const again = await register(joinToken(id), DEVICE);
    assert.notEqual(again.hostId, first.hostId, "管理员吊销的行不得被重绑复活");

    const hosts = (await get("/api/hosts", cookie)).json.hosts as Array<{ id: string }>;
    assert.equal(hosts.length, 1, "应只剩新建的那一条");
    assert.equal(hosts[0]!.id, again.hostId);
    // 被管理员吊销的行保持吊销
    const raw = db.db.prepare("SELECT revoked_at, revoked_by, device_id FROM hosts WHERE id = ?").get(first.hostId) as
      | { revoked_at: string | null; revoked_by: string | null; device_id: string | null }
      | undefined;
    assert.ok(raw?.revoked_at !== null && raw?.revoked_at !== undefined, "管理员吊销行必须保持 revoked");
    assert.equal(raw?.revoked_by, "admin");
    assert.equal(raw?.device_id, null, "管理员吊销必须抹掉 device_id 关联，释放唯一槽位");
  } finally {
    await stop();
  }
});

test("老数据（revoked_by = NULL）视为不可复活 → 新建；复活后 revoked_by 被清空", async () => {
  await start();
  try {
    const { id, cookie } = await owner("alice");

    // 1) 老数据：吊销时间有、revoked_by 为空、device_id 也为空（本次改动前留下的行）
    const legacy = await register(joinToken(id), DEVICE);
    db.db
      .prepare("UPDATE hosts SET revoked_at = ?, revoked_by = NULL, device_id = NULL WHERE id = ?")
      .run(new Date().toISOString(), legacy.hostId);
    const afterLegacy = await register(joinToken(id), DEVICE);
    assert.notEqual(afterLegacy.hostId, legacy.hostId, "无法归因的吊销不自动撤销");

    // 2) 用户吊销 → 复活后 revoked_at / revoked_by 都应清空
    assert.equal(db.revokeHostRecord(afterLegacy.hostId), true);
    const revived = await register(joinToken(id), DEVICE);
    assert.equal(revived.hostId, afterLegacy.hostId);
    const raw = db.db.prepare("SELECT revoked_at, revoked_by FROM hosts WHERE id = ?").get(afterLegacy.hostId) as
      | { revoked_at: string | null; revoked_by: string | null }
      | undefined;
    assert.equal(raw?.revoked_at, null);
    assert.equal(raw?.revoked_by, null);
    const hosts = (await get("/api/hosts", cookie)).json.hosts as Array<{ id: string }>;
    assert.equal(hosts.length, 1);
  } finally {
    await stop();
  }
});

test("同 owner + 同 deviceId 的第二行被唯一索引拒绝（并发首绑不会留下两行）", async () => {
  await start();
  try {
    const { id } = await owner("alice");
    const first = await register(joinToken(id), DEVICE);
    // 直接撞 store 层唯一索引：第二次 create 同 (owner, deviceId) 必须失败
    const hostToken2 = randomToken();
    assert.throws(
      () => db.createHost("would-dup", id, "dup", sha256(hostToken2), undefined, undefined, DEVICE),
      /UNIQUE|unique/i,
    );
    // 但 API 层会把它转成复用：再注册一次仍回同一 hostId
    const again = await register(joinToken(id), DEVICE);
    assert.equal(again.hostId, first.hostId);
  } finally {
    await stop();
  }
});
