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
import { createSqliteStore } from "../src/store.ts";
import { Jwt, randomToken, sha256 } from "../src/jwt.ts";
import { TunnelRegistry, TunnelConn } from "../src/tunnel.ts";
import { EventHub } from "../src/events.ts";
import { startHubServer } from "../src/server.ts";
import type { RunningHub } from "../src/server.ts";

interface Ctx {
  db: HubDb;
  auth: HubAuth;
  server: RunningHub;
  base: string;
  tunnels: TunnelRegistry;
}

async function boot(): Promise<Ctx> {
  const db = new HubDb(":memory:");
  const auth = new HubAuth(createSqliteStore(db), (id) => db.getUserById(id), new Jwt(Buffer.from("test-key-0123456789abcdef")));
  const tunnels = new TunnelRegistry();
  const server = await startHubServer({
    host: "127.0.0.1",
    port: 0,
    db,
    auth,
    tunnels,
    events: new EventHub(),
    portalDir: "/nonexistent-portal",
  });
  return { db, auth, server, base: `http://127.0.0.1:${server.actualPort}`, tunnels };
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

/** 注册一个假隧道：openStream 立即回 200 text/html 并关闭（供数据面/滑动续期测试）。 */
function registerFakeTunnel(ctx: Ctx, hostId: string, html = "<!doctype html><html><body>ok</body></html>"): void {
  ctx.tunnels.register({
    hostId,
    openStream(_kind, _path, _method, _headers, handler) {
      handler.onResponse?.(200, "", { "content-type": "text/html; charset=utf-8" });
      handler.onData?.(Buffer.from(html));
      handler.onClose?.();
      return 1;
    },
    sendData() {},
    endRequest() {},
    abortStream() {},
    terminate() {},
  } as unknown as TunnelConn);
}

test("AC1：带有效 rdsh_host 进 /h/<id>/ → 直接进数据面（200 HTML + 滑动续期）", async () => {
  const ctx = await boot();
  try {
    const alice = ctx.db.createUser("alice", await hashPassword("pw"));
    ctx.db.createHost("host-abc", alice.id, "abc", sha256(randomToken()));
    registerFakeTunnel(ctx, "host-abc");
    const cookie = `rdsh_host=${ctx.auth.signHostCookie("host-abc", alice.id)}`;
    const res = await fetch(`${ctx.base}/h/host-abc/`, { headers: { cookie, accept: "text/html" }, redirect: "manual" });
    assert.equal(res.status, 200, "有效 capability 应放行并进数据面");
    assert.match(res.headers.get("set-cookie") ?? "", /rdsh_host=/, "应重签 host cookie（滑动续期）");
  } finally {
    await close(ctx);
  }
});

test("AC5：path 指定 host + 归属校验（A 的 cookie 进 B 但 B 非自己/共享 → 401）", async () => {
  const ctx = await boot();
  try {
    const alice = ctx.db.createUser("alice", await hashPassword("pw"));
    const bob = ctx.db.createUser("bob", await hashPassword("pw"));
    ctx.db.createHost("host-abc", alice.id, "abc", sha256(randomToken()));
    ctx.db.createHost("host-xyz", bob.id, "xyz", sha256(randomToken()));
    // alice 的 cookie 访问 bob 的 host → path 指 B，但 alice 无 B 的归属 → 401
    const cookie = `rdsh_host=${ctx.auth.signHostCookie("host-abc", alice.id)}`;
    const res = await fetch(`${ctx.base}/h/host-xyz/`, { headers: { cookie }, redirect: "manual" });
    assert.equal(res.status, 401, "无归属的 path host 应 401");
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

test("AC6 回归：带 access（Bearer）进 /h/<id>/ 仍 302（到带前缀的路径）", async () => {
  const ctx = await boot();
  try {
    const alice = ctx.db.createUser("alice", await hashPassword("pw"));
    ctx.db.createHost("host-abc", alice.id, "abc", sha256(randomToken()));
    const access = await loginAccessToken(ctx, "alice", "pw");
    const res = await fetch(`${ctx.base}/h/host-abc/`, { headers: { authorization: `Bearer ${access}` }, redirect: "manual" });
    assert.equal(res.status, 302, "access 路径不得回归");
    assert.equal(res.headers.get("location"), "/h/host-abc/");
  } finally {
    await close(ctx);
  }
});

test("AC4b：撤销共享后，成员的 rdsh_host capability → 401", async () => {
  const ctx = await boot();
  try {
    const owner = ctx.db.createUser("bob", await hashPassword("pw"));
    const member = ctx.db.createUser("alice", await hashPassword("pw"));
    ctx.db.createHost("host-abc", owner.id, "abc", sha256(randomToken()));
    ctx.db.shareHost("host-abc", member.id, "member");
    registerFakeTunnel(ctx, "host-abc");
    const cookie = `rdsh_host=${ctx.auth.signHostCookie("host-abc", member.id)}`;
    const ok = await fetch(`${ctx.base}/h/host-abc/`, { headers: { cookie, accept: "text/html" }, redirect: "manual" });
    assert.equal(ok.status, 200, "共享成员应可进入");
    ctx.db.revokeShare("host-abc", member.id);
    const revoked = await fetch(`${ctx.base}/h/host-abc/`, { headers: { cookie }, redirect: "manual" });
    assert.equal(revoked.status, 401, "撤销共享后 capability 归属校验应拒绝");
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

test("capability 通过但 host 不存在 → 401", async () => {
  const ctx = await boot();
  try {
    const alice = ctx.db.createUser("alice", await hashPassword("pw"));
    // signHostCookie 只验签名 + 用户，不验 host 是否存在；存在性在 authorizeHost 查库。
    const cookie = `rdsh_host=${ctx.auth.signHostCookie("host-ghost", alice.id)}`;
    const res = await fetch(`${ctx.base}/h/host-ghost/`, { headers: { cookie }, redirect: "manual" });
    assert.equal(res.status, 401, "capability 通过但主机不存在应 401");
  } finally {
    await close(ctx);
  }
});

test("AC6b 回归：rdsh_hub_session cookie 进 /h/<id>/ 仍 302（到带前缀的路径）", async () => {
  const ctx = await boot();
  try {
    const alice = ctx.db.createUser("alice", await hashPassword("pw"));
    ctx.db.createHost("host-abc", alice.id, "abc", sha256(randomToken()));
    const access = await loginAccessToken(ctx, "alice", "pw");
    const res = await fetch(`${ctx.base}/h/host-abc/`, { headers: { cookie: `rdsh_hub_session=${access}` }, redirect: "manual" });
    assert.equal(res.status, 302, "session cookie 路径不得回归");
    assert.equal(res.headers.get("location"), "/h/host-abc/");
  } finally {
    await close(ctx);
  }
});

test("多标签隔离：cookie(A) + /h/B/ 路由到 B 的隧道（path 决定 host）", async () => {
  const ctx = await boot();
  try {
    const alice = ctx.db.createUser("alice", await hashPassword("pw"));
    ctx.db.createHost("host-abc", alice.id, "abc", sha256(randomToken()));
    ctx.db.createHost("host-xyz", alice.id, "xyz", sha256(randomToken()));
    registerFakeTunnel(ctx, "host-abc", "<html>host-A</html>");
    registerFakeTunnel(ctx, "host-xyz", "<html>host-B</html>");
    const cookie = `rdsh_host=${ctx.auth.signHostCookie("host-abc", alice.id)}`;
    const res = await fetch(`${ctx.base}/h/host-xyz/`, { headers: { cookie, accept: "text/html" }, redirect: "manual" });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /host-B/, "path 的 B 应路由到 B 的隧道，而非 cookie 的 A");
  } finally {
    await close(ctx);
  }
});

test("无尾斜杠 /h/<id> → 301 到 /h/<id>/", async () => {
  const ctx = await boot();
  try {
    const alice = ctx.db.createUser("alice", await hashPassword("pw"));
    ctx.db.createHost("host-abc", alice.id, "abc", sha256(randomToken()));
    const cookie = `rdsh_host=${ctx.auth.signHostCookie("host-abc", alice.id)}`;
    const res = await fetch(`${ctx.base}/h/host-abc`, { headers: { cookie }, redirect: "manual" });
    assert.equal(res.status, 301);
    assert.equal(res.headers.get("location"), "/h/host-abc/");
  } finally {
    await close(ctx);
  }
});

test("节点路由 host：带旧 rdsh_host cookie 进 /h/<id>/ → 302 到节点而非本 Hub 503", async () => {
  const ctx = await boot();
  try {
    const alice = ctx.db.createUser("alice", await hashPassword("pw"));
    ctx.db.createHost("host-abc", alice.id, "abc", sha256(randomToken()));
    // 节点路由：分配在线节点（隧道在节点上，不在 Hub 本机）
    ctx.db.createNode("node-1", "cn-relay-01", "https://cn-relay-01.rdsh.cn", sha256(randomToken()), "", 0, 100, true, null);
    ctx.db.setHostNode("host-abc", "node-1");
    // 浏览器残留的旧 cookie（哪怕有效）不应让 Hub 误判为“已进入”而在本机直连
    const cookie = `rdsh_host=${ctx.auth.signHostCookie("host-abc", alice.id)}`;
    const res = await fetch(`${ctx.base}/h/host-abc/`, { headers: { cookie }, redirect: "manual" });
    assert.equal(res.status, 302, "节点路由必须 302 到节点，而不是在本 Hub 直连 503");
    assert.equal(res.headers.get("location"), "https://cn-relay-01.rdsh.cn/h/host-abc/");
  } finally {
    await close(ctx);
  }
});

test("Hub 路由 host：gate 303 回跳 Location 重写回 /h/<id>/ 前缀", async () => {
  const ctx = await boot();
  try {
    const alice = ctx.db.createUser("alice", await hashPassword("pw"));
    ctx.db.createHost("host-abc", alice.id, "abc", sha256(randomToken()));
    // 假隧道：上游返回 303 Location: /（gate 登录成功回跳）
    ctx.tunnels.register({
      hostId: "host-abc",
      openStream(_k, _p, _m, _h, handler) {
        handler.onResponse?.(303, "", { location: "/" });
        handler.onClose?.();
        return 1;
      },
      sendData() {},
      endRequest() {},
      abortStream() {},
      terminate() {},
    } as unknown as TunnelConn);
    const cookie = `rdsh_host=${ctx.auth.signHostCookie("host-abc", alice.id)}`;
    const res = await fetch(`${ctx.base}/h/host-abc/`, { headers: { cookie }, redirect: "manual" });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/h/host-abc/", "Location 应带上前缀，不能丢 path");
  } finally {
    await close(ctx);
  }
});
