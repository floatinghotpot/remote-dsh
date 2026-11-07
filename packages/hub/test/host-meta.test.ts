/**
 * host-meta.test.ts — 主机上报类型与版本（63-bind-agent-box / req R28–R30）。
 *
 * 覆盖：host token 认证、枚举校验、versions 体积上限、覆盖写、缺省字段不改、
 * 以及 GET /api/hosts 把它们带出来（老数据为 null）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { HubDb } from "../src/db.ts";
import { HubAuth, hashPassword } from "../src/auth.ts";
import { createSqliteStore } from "../src/store.ts";
import { Jwt } from "../src/jwt.ts";
import { TunnelRegistry } from "../src/tunnel.ts";
import { EventHub } from "../src/events.ts";
import { startHubServer } from "../src/server.ts";
import type { RunningHub } from "../src/server.ts";

let server: RunningHub | null = null;
let base = "";
let db: HubDb;

async function start(): Promise<void> {
  db = new HubDb(":memory:");
  const auth = new HubAuth(createSqliteStore(db), (id) => db.getUserById(id), new Jwt(Buffer.from("test-key-0123456789abcdef")));
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

async function loginAs(name: string): Promise<string> {
  const u = db.createUser(name, await hashPassword("pw123456"));
  db.setPlan(u.id, "internal", null);
  const login = await post("/api/auth/login", { name, password: "pw123456" });
  assert.equal(login.status, 200);
  return `rdsh_hub_session=${login.json.accessToken}`;
}

/** 造一台已归属的主机，返回 { hostId, hostToken, cookie }。 */
async function makeHost(name: string): Promise<{ hostId: string; hostToken: string; cookie: string }> {
  const cookie = await loginAs(name);
  const created = await post("/api/bind-sessions", { name: `${name}-box` });
  const { bindId, consumeToken } = created.json as { bindId: string; consumeToken: string };
  await post(`/api/bind-sessions/${bindId}/approve`, {}, cookie);
  const consumed = await post(`/api/bind-sessions/${bindId}/consume`, { consumeToken });
  assert.equal(consumed.status, 200);
  return {
    hostId: consumed.json.hostId as string,
    hostToken: consumed.json.hostToken as string,
    cookie,
  };
}

test.before(start);
test.after(stop);

test("上报成功并在 GET /api/hosts 带出 deviceKind / versions", async () => {
  const { hostId, hostToken, cookie } = await makeHost("alice");

  // 上报前为 null（老数据）
  const before = await get("/api/hosts", cookie);
  const beforeHost = (before.json.hosts as Array<Record<string, unknown>>).find((h) => h.id === hostId)!;
  assert.equal(beforeHost.deviceKind, null);
  assert.equal(beforeHost.versions, null);

  const res = await post("/api/hosts/self/meta", {
    token: hostToken,
    deviceKind: "box",
    versions: { dsh: "0.2.1-rc.2", rdsh: "0.19.1", gateway: "gateway", boxd: "0.2.0" },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.deviceKind, "box");
  assert.deepEqual(res.json.versions, { dsh: "0.2.1-rc.2", rdsh: "0.19.1", gateway: "gateway", boxd: "0.2.0" });

  const after = await get("/api/hosts", cookie);
  const host = (after.json.hosts as Array<Record<string, unknown>>).find((h) => h.id === hostId)!;
  assert.equal(host.deviceKind, "box");
  assert.deepEqual(host.versions, { dsh: "0.2.1-rc.2", rdsh: "0.19.1", gateway: "gateway", boxd: "0.2.0" });
});

test("重复上报覆盖旧值（升级后版本刷新）", async () => {
  const { hostToken } = await makeHost("bob");

  await post("/api/hosts/self/meta", { token: hostToken, versions: { dsh: "0.1.0" } });
  const second = await post("/api/hosts/self/meta", { token: hostToken, versions: { dsh: "0.2.0" } });
  assert.equal(second.status, 200);
  assert.deepEqual(second.json.versions, { dsh: "0.2.0" });
});

test("只报 versions 时不改动已存的 deviceKind", async () => {
  const { hostToken } = await makeHost("carol");
  await post("/api/hosts/self/meta", { token: hostToken, deviceKind: "cli" });
  const res = await post("/api/hosts/self/meta", { token: hostToken, versions: { rdsh: "0.19.1" } });
  assert.equal(res.status, 200);
  assert.equal(res.json.deviceKind, "cli");
  assert.deepEqual(res.json.versions, { rdsh: "0.19.1" });
});

test("鉴权与校验：缺 token 400 / 错 token 401 / 非法枚举 400 / 超大 versions 400", async () => {
  const { hostToken } = await makeHost("dave");

  assert.equal((await post("/api/hosts/self/meta", { deviceKind: "box" })).status, 400);
  assert.equal((await post("/api/hosts/self/meta", { token: "short" })).status, 400);
  assert.equal((await post("/api/hosts/self/meta", { token: "x".repeat(40), deviceKind: "box" })).status, 401);
  assert.equal((await post("/api/hosts/self/meta", { token: hostToken, deviceKind: "tablet" })).status, 400);

  const big = { blob: "y".repeat(5000) };
  const tooBig = await post("/api/hosts/self/meta", { token: hostToken, versions: big });
  assert.equal(tooBig.status, 400);

  // 数组不是合法 versions
  assert.equal((await post("/api/hosts/self/meta", { token: hostToken, versions: [1, 2] })).status, 400);
});

test("status：starting/ready 入库并在 GET /api/hosts 带出，缺省不改，非法 400", async () => {
  const { hostId, hostToken, cookie } = await makeHost("frank");

  const before = await get("/api/hosts", cookie);
  const beforeHost = (before.json.hosts as Array<Record<string, unknown>>).find((h) => h.id === hostId)!;
  assert.equal(beforeHost.status, null);

  const starting = await post("/api/hosts/self/meta", { token: hostToken, status: "starting" });
  assert.equal(starting.status, 200);
  assert.equal(starting.json.status, "starting");
  let host = ((await get("/api/hosts", cookie)).json.hosts as Array<Record<string, unknown>>).find((h) => h.id === hostId)!;
  assert.equal(host.status, "starting");

  // 只报 versions 不改变 status
  const versionsOnly = await post("/api/hosts/self/meta", { token: hostToken, versions: { "remote-dsh": "0.21.0" } });
  assert.equal(versionsOnly.json.status, "starting");

  const ready = await post("/api/hosts/self/meta", { token: hostToken, status: "ready" });
  assert.equal(ready.json.status, "ready");
  host = ((await get("/api/hosts", cookie)).json.hosts as Array<Record<string, unknown>>).find((h) => h.id === hostId)!;
  assert.equal(host.status, "ready");

  assert.equal((await post("/api/hosts/self/meta", { token: hostToken, status: "bogus" })).status, 400);
});

test("未知字段被忽略，不影响已上报值", async () => {
  const { hostToken } = await makeHost("erin");
  const res = await post("/api/hosts/self/meta", {
    token: hostToken,
    deviceKind: "desktop",
    versions: { dsh: "1.0.0" },
    somethingElse: "ignored",
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.deviceKind, "desktop");
  assert.deepEqual(res.json.versions, { dsh: "1.0.0" });
});
