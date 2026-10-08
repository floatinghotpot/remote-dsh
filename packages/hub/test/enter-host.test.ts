/**
 * enter-host.test.ts — 进入主机入口 `/h/<hostId>/` 的认证行为（2026-10-08 fix）。
 *
 * 覆盖：access 失效后回退 7d `rdsh_host` capability（R1）、导航 401 友好 HTML（R2）、
 * 改密失效（AC4）、跨主机隔离（AC5）、access 路径不回归（AC6）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { HubDb } from "../src/db.ts";
import { HubAuth, hashPassword } from "../src/auth.ts";
import { Jwt, randomToken, sha256 } from "../src/jwt.ts";
import { TunnelRegistry } from "../src/tunnel.ts";
import { EventHub } from "../src/events.ts";
import { startHubServer } from "../src/server.ts";
import type { RunningHub } from "../src/server.ts";

interface Ctx {
  db: HubDb;
  auth: HubAuth;
  server: RunningHub;
  base: string;
}

async function boot(): Promise<Ctx> {
  const db = new HubDb(":memory:");
  const auth = new HubAuth(db, new Jwt(Buffer.from("test-key-0123456789abcdef")));
  const server = await startHubServer({
    host: "127.0.0.1",
    port: 0,
    db,
    auth,
    tunnels: new TunnelRegistry(),
    events: new EventHub(),
    portalDir: "/nonexistent-portal",
  });
  return { db, auth, server, base: `http://127.0.0.1:${server.actualPort}` };
}

async function close(ctx: Ctx): Promise<void> {
  await new Promise<void>((r) => ctx.server.server.close(() => r()));
  ctx.db.close();
}

/** 登录拿 access token（AC6 回归用）。 */
async function loginAccessToken(ctx: Ctx, name: string, password: string): Promise<string> {
  const res = await fetch(`${ctx.base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, password }),
  });
  assert.equal(res.status, 200, "登录应成功");
  const json = (await res.json()) as { accessToken?: string };
  assert.equal(typeof json.accessToken, "string");
  return json.accessToken as string;
}

test("AC1：带有效 rdsh_host 进 /h/<id>/ → 302 滑动续期（无 access）", async () => {
  const ctx = await boot();
  try {
    const alice = ctx.db.createUser("alice", await hashPassword("pw"));
    ctx.db.createHost("host-abc", alice.id, "abc", sha256(randomToken()));
    const cookie = `rdsh_host=${ctx.auth.signHostCookie("host-abc", alice.id)}`;
    const res = await fetch(`${ctx.base}/h/host-abc/`, { headers: { cookie }, redirect: "manual" });
    assert.equal(res.status, 302, "有效 capability 应放行");
    assert.equal(res.headers.get("location"), "/");
    assert.match(res.headers.get("set-cookie") ?? "", /rdsh_host=/, "应重签 host cookie（滑动续期）");
  } finally {
    await close(ctx);
  }
});

test("AC5：用主机 A 的 rdsh_host 请求 /h/B/ → 401（跨主机隔离）", async () => {
  const ctx = await boot();
  try {
    const alice = ctx.db.createUser("alice", await hashPassword("pw"));
    ctx.db.createHost("host-abc", alice.id, "abc", sha256(randomToken()));
    ctx.db.createHost("host-xyz", alice.id, "xyz", sha256(randomToken()));
    const cookie = `rdsh_host=${ctx.auth.signHostCookie("host-abc", alice.id)}`;
    const res = await fetch(`${ctx.base}/h/host-xyz/`, { headers: { cookie }, redirect: "manual" });
    assert.equal(res.status, 401, "A 的 cookie 不得进入 B");
  } finally {
    await close(ctx);
  }
});

test("AC4：改密（ver+1）后旧 rdsh_host 进 /h/ → 401", async () => {
  const ctx = await boot();
  try {
    const alice = ctx.db.createUser("alice", await hashPassword("pw"));
    ctx.db.createHost("host-abc", alice.id, "abc", sha256(randomToken()));
    const token = ctx.auth.signHostCookie("host-abc", alice.id);
    ctx.db.setPassword(alice.id, "scrypt:newpw");
    const res = await fetch(`${ctx.base}/h/host-abc/`, { headers: { cookie: `rdsh_host=${token}` }, redirect: "manual" });
    assert.equal(res.status, 401, "改密后旧 capability 应失效");
  } finally {
    await close(ctx);
  }
});

test("AC3：无凭据导航请求（Accept text/html）→ 401 友好 HTML；JSON 请求 → 401 JSON", async () => {
  const ctx = await boot();
  try {
    const alice = ctx.db.createUser("alice", await hashPassword("pw"));
    ctx.db.createHost("host-abc", alice.id, "abc", sha256(randomToken()));

    const html = await fetch(`${ctx.base}/h/host-abc/`, { headers: { accept: "text/html" }, redirect: "manual" });
    assert.equal(html.status, 401);
    assert.match(html.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await html.text(), /会话已过期/);

    const json = await fetch(`${ctx.base}/h/host-abc/`, { redirect: "manual" });
    assert.equal(json.status, 401);
    const body = (await json.json()) as { error?: { code?: string } };
    assert.equal(body.error?.code, "UNAUTHORIZED");
  } finally {
    await close(ctx);
  }
});

test("AC6 回归：带 access（Bearer）进 /h/<id>/ 仍 302", async () => {
  const ctx = await boot();
  try {
    const alice = ctx.db.createUser("alice", await hashPassword("pw"));
    ctx.db.createHost("host-abc", alice.id, "abc", sha256(randomToken()));
    const access = await loginAccessToken(ctx, "alice", "pw");
    const res = await fetch(`${ctx.base}/h/host-abc/`, { headers: { authorization: `Bearer ${access}` }, redirect: "manual" });
    assert.equal(res.status, 302, "access 路径不得回归");
    assert.equal(res.headers.get("location"), "/");
  } finally {
    await close(ctx);
  }
});

test("AC4b：撤销共享后，成员的 rdsh_host capability → 403", async () => {
  const ctx = await boot();
  try {
    const owner = ctx.db.createUser("bob", await hashPassword("pw"));
    const member = ctx.db.createUser("alice", await hashPassword("pw"));
    ctx.db.createHost("host-abc", owner.id, "abc", sha256(randomToken()));
    ctx.db.shareHost("host-abc", member.id, "member");
    const cookie = `rdsh_host=${ctx.auth.signHostCookie("host-abc", member.id)}`;
    const ok = await fetch(`${ctx.base}/h/host-abc/`, { headers: { cookie }, redirect: "manual" });
    assert.equal(ok.status, 302, "共享成员应可进入");
    ctx.db.revokeShare("host-abc", member.id);
    const revoked = await fetch(`${ctx.base}/h/host-abc/`, { headers: { cookie }, redirect: "manual" });
    assert.equal(revoked.status, 403, "撤销共享后 capability 归属校验应拒绝");
  } finally {
    await close(ctx);
  }
});

test("AC4c：封禁 accountStatus 后，rdsh_host capability → 401", async () => {
  const ctx = await boot();
  try {
    const alice = ctx.db.createUser("alice", await hashPassword("pw"));
    ctx.db.createHost("host-abc", alice.id, "abc", sha256(randomToken()));
    const token = ctx.auth.signHostCookie("host-abc", alice.id);
    ctx.db.setAccountStatus(alice.id, "banned");
    const res = await fetch(`${ctx.base}/h/host-abc/`, { headers: { cookie: `rdsh_host=${token}` }, redirect: "manual" });
    assert.equal(res.status, 401, "封禁后 capability 应失效");
  } finally {
    await close(ctx);
  }
});

test("capability 通过但 host 不存在 → 404", async () => {
  const ctx = await boot();
  try {
    const alice = ctx.db.createUser("alice", await hashPassword("pw"));
    // signHostCookie 只验签名 + 用户，不验 host 是否存在；存在性在 handleEnterHost 查库。
    const cookie = `rdsh_host=${ctx.auth.signHostCookie("host-ghost", alice.id)}`;
    const res = await fetch(`${ctx.base}/h/host-ghost/`, { headers: { cookie }, redirect: "manual" });
    assert.equal(res.status, 404, "capability 通过但主机不存在应 404");
  } finally {
    await close(ctx);
  }
});

test("AC6b 回归：rdsh_hub_session cookie 进 /h/<id>/ 仍 302", async () => {
  const ctx = await boot();
  try {
    const alice = ctx.db.createUser("alice", await hashPassword("pw"));
    ctx.db.createHost("host-abc", alice.id, "abc", sha256(randomToken()));
    const access = await loginAccessToken(ctx, "alice", "pw");
    const res = await fetch(`${ctx.base}/h/host-abc/`, { headers: { cookie: `rdsh_hub_session=${access}` }, redirect: "manual" });
    assert.equal(res.status, 302, "session cookie 路径不得回归");
    assert.equal(res.headers.get("location"), "/");
  } finally {
    await close(ctx);
  }
});
