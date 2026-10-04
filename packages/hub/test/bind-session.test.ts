/**
 * bind-session.test.ts — 绑定会话端点端到端（内存 DB）。
 *
 * 覆盖 req.md R1/R2/R8：状态机 pending→approved→consumed、越权反例（错误 consumeToken、
 * 未登录批准、他人 consume）、过期、以及"扫码生成二维码 data URI"。
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

async function start(): Promise<void> {
  db = new HubDb(":memory:");
  const auth = new HubAuth(db, new Jwt(Buffer.from("test-key-0123456789abcdef")));
  server = await startHubServer({
    host: "127.0.0.1",
    port: 0,
    db,
    auth,
    tunnels: new TunnelRegistry(),
    events: new EventHub(),
    portalDir: "/nonexistent-portal",
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

/** 建一个已登录用户，返回会话 cookie。 */
async function loginAs(name: string): Promise<string> {
  db.createUser(name, await hashPassword("pw123456"));
  const login = await post("/api/auth/login", { name, password: "pw123456" });
  assert.equal(login.status, 200);
  return `rdsh_hub_session=${login.json.accessToken}`;
}

test.before(start);
test.after(stop);

test("完整状态机：pending → 批准 approved → 领取 consumed → 主机归属账号", async () => {
  const cookie = await loginAs("alice");

  // 1) 创建
  const created = await post("/api/bind-sessions", { name: "my-pi", e2eePublicKey: "pubkey" });
  assert.equal(created.status, 200);
  const { bindId, consumeToken, qrDataUri } = created.json as { bindId: string; consumeToken: string; qrDataUri: string };
  assert.ok(typeof bindId === "string" && bindId.length > 0);
  assert.ok(typeof consumeToken === "string" && consumeToken.length >= 16);
  assert.ok(typeof qrDataUri === "string" && qrDataUri.startsWith("data:image/"), "应返回二维码 data URI");

  // 2) 查询 pending
  const pending = await get(`/api/bind-sessions/${bindId}`);
  assert.equal(pending.status, 200);
  assert.equal(pending.json.status, "pending");

  // 3) 批准（登录态）
  const approved = await post(`/api/bind-sessions/${bindId}/approve`, {}, cookie);
  assert.equal(approved.status, 200);
  assert.equal(approved.json.name, "my-pi");
  const approvedState = await get(`/api/bind-sessions/${bindId}`);
  assert.equal(approvedState.json.status, "approved");

  // 4) 领取（consumeToken）
  const consumed = await post(`/api/bind-sessions/${bindId}/consume`, { consumeToken });
  assert.equal(consumed.status, 200);
  const { hostId, hostToken } = consumed.json as { hostId: string; hostToken: string };
  assert.ok(typeof hostId === "string" && hostId.length > 0);
  assert.ok(typeof hostToken === "string" && hostToken.length > 0);

  // 5) 状态 consumed
  const done = await get(`/api/bind-sessions/${bindId}`);
  assert.equal(done.json.status, "consumed");

  // 6) 主机已归属该账号（门户主机列表可见）
  const hosts = await get("/api/hosts", cookie);
  assert.equal(hosts.status, 200);
  const list = hosts.json.hosts as Array<{ id: string }>;
  assert.ok(list.some((h) => h.id === hostId), "领取后主机应出现在账号主机列表");
});

test("安全反例：未登录批准 401；错误/缺失 consumeToken 不能领取", async () => {
  const created = await post("/api/bind-sessions", { name: "h" });
  const { bindId, consumeToken } = created.json as { bindId: string; consumeToken: string };

  // 未登录批准 → 401
  assert.equal((await post(`/api/bind-sessions/${bindId}/approve`, {})).status, 401);

  // 未批准就领取 → 409
  assert.equal((await post(`/api/bind-sessions/${bindId}/consume`, { consumeToken })).status, 409);

  // 错误 consumeToken → 401
  const carol = await loginAs("carol");
  await post(`/api/bind-sessions/${bindId}/approve`, {}, carol);
  assert.equal((await post(`/api/bind-sessions/${bindId}/consume`, { consumeToken: "wrong-token-wrong" })).status, 401);

  // 正确的 consumeToken 才能领取
  assert.equal((await post(`/api/bind-sessions/${bindId}/consume`, { consumeToken })).status, 200);
  // 重放 → 409
  assert.equal((await post(`/api/bind-sessions/${bindId}/consume`, { consumeToken })).status, 409);
});

test("越权反例：A 的会话不能被 B 批准；B 也拿不到 host 归属", async () => {
  const created = await post("/api/bind-sessions", { name: "a-host" });
  const { bindId, consumeToken } = created.json as { bindId: string; consumeToken: string };

  const dave = await loginAs("dave");
  const eve = await loginAs("eve");

  // dave 批准 → 归属 dave
  assert.equal((await post(`/api/bind-sessions/${bindId}/approve`, {}, dave)).status, 200);
  assert.equal((await post(`/api/bind-sessions/${bindId}/consume`, { consumeToken })).status, 200);

  // eve 的主机列表不应出现该主机
  const eveHosts = await get("/api/hosts", eve);
  const eveList = eveHosts.json.hosts as Array<{ id: string }>;
  assert.equal(eveList.length, 0, "eve 不得拥有 dave 绑定会话产生的主机");
});

test("已批准会话：他人重复扫返回 409，本人重复扫幂等 200", async () => {
  const created = await post("/api/bind-sessions", { name: "h" });
  const { bindId } = created.json as { bindId: string };

  const grace = await loginAs("grace");
  const henry = await loginAs("henry");

  assert.equal((await post(`/api/bind-sessions/${bindId}/approve`, {}, grace)).status, 200);
  assert.equal((await post(`/api/bind-sessions/${bindId}/approve`, {}, henry)).status, 409);
  assert.equal((await post(`/api/bind-sessions/${bindId}/approve`, {}, grace)).status, 200);
});

test("过期会话：批准 410、领取 409", async () => {
  // 直接造一个已过期的会话（expiresAt 在过去）
  const id = "expired-session-id";
  const consumeToken = randomToken();
  db.createBindSession(id, sha256(consumeToken), null, "old", Date.now() - 1000);

  const cookie = await loginAs("frank");
  assert.equal((await post(`/api/bind-sessions/${id}/approve`, {}, cookie)).status, 410);
  assert.equal((await post(`/api/bind-sessions/${id}/consume`, { consumeToken })).status, 409);
  // 查询也返回 expired
  assert.equal((await get(`/api/bind-sessions/${id}`)).json.status, "expired");
});

test("未知会话：GET 404；consume 凭据错误 401（不泄露存在性）", async () => {
  assert.equal((await get("/api/bind-sessions/does-not-exist")).status, 404);
  assert.equal((await post("/api/bind-sessions/does-not-exist/consume", { consumeToken: "x".repeat(20) })).status, 401);
});

test("周期清理：pruneExpiredBindSessions 只删过期行", async () => {
  const expiredId = "expired-prune-1";
  const validId = "valid-prune-1";
  db.createBindSession(expiredId, sha256(randomToken()), null, "expired", Date.now() - 1000);
  db.createBindSession(validId, sha256(randomToken()), null, "valid", Date.now() + 60_000);

  db.pruneExpiredBindSessions();

  assert.equal(db.getBindSession(expiredId), null, "过期会话应被清理");
  assert.notEqual(db.getBindSession(validId), null, "未过期会话应保留");
});
