import { test } from "node:test";
import assert from "node:assert/strict";
import { HubDb } from "../src/db.ts";
import { HubAuth, hashPassword } from "../src/auth.ts";
import { Jwt, randomToken, sha256 } from "../src/jwt.ts";
import { TunnelRegistry } from "../src/tunnel.ts";
import { EventHub } from "../src/events.ts";
import { startHubServer } from "../src/server.ts";
import type { RunningHub } from "../src/server.ts";
import { totp } from "../src/totp.ts";
import { createChallenge, verifyChallenge } from "../src/captcha.ts";
import { verifyEmailCode } from "../src/api.ts";

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
    portalDir: "/nonexistent-portal",
    email: { provider: "log", from: "noreply@test.local" },
    captcha: { provider: "arithmetic" },
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

const cookieOf = (t: { accessToken: string }): string => `rdsh_session=${t.accessToken}`;

test.before(start);
test.after(stop);

test("算术验证码：挑战 + 一次性校验", () => {
  const { token, question } = createChallenge();
  assert.match(question, /\d \+ \d = \?/);
  const m = /(\d+) \+ (\d+) = \?/.exec(question)!;
  const answer = String(Number(m[1]) + Number(m[2]));
  assert.equal(verifyChallenge(token, answer), true);
  assert.equal(verifyChallenge(token, answer), false); // 一次性
});

test("找回密码：不存在邮箱也返回 ok（反枚举）", async () => {
  const c = await post("/api/captcha/arithmetic", {});
  const m = /(\d+) \+ (\d+) = \?/.exec(c.json.question as string)!;
  const answer = String(Number(m[1]) + Number(m[2]));
  const r = await post("/api/auth/password/reset", { email: "ghost@test.local", captchaToken: c.json.token, captchaAnswer: answer });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
});

test("邮件验证码：正确一次性 / 错误计数 / 过期", () => {
  db.createUser("eve", "hash");
  const eve = db.getUserByName("eve")!;
  db.createEmailCode(eve.id, "eve@test.local", "verify", sha256("123456"), Date.now() + 60_000);
  assert.equal(verifyEmailCode(db, "eve@test.local", "verify", "123456"), true);
  assert.equal(verifyEmailCode(db, "eve@test.local", "verify", "123456"), false); // 已一次性删除

  db.createEmailCode(eve.id, "eve@test.local", "verify", sha256("000000"), Date.now() + 60_000);
  for (let i = 0; i < 5; i++) assert.equal(verifyEmailCode(db, "eve@test.local", "verify", "wrong"), false);
  assert.equal(verifyEmailCode(db, "eve@test.local", "verify", "000000"), false); // 5 次错误后锁死（正确码也拒）

  db.createEmailCode(eve.id, "eve@test.local", "verify", sha256("111111"), Date.now() - 1); // 过期
  assert.equal(verifyEmailCode(db, "eve@test.local", "verify", "111111"), false);
});

test("2FA：开启 → 激活 → 登录 requires-totp → 校验 → 会话", async () => {
  db.createUser("carol", await hashPassword("pw123456"));
  const login = await post("/api/auth/login", { name: "carol", password: "pw123456" });
  assert.equal(login.status, 200);
  const cookie = cookieOf({ accessToken: login.json.accessToken as string });

  const en = await post("/api/account/2fa/enable", {}, cookie);
  assert.equal(en.status, 200);
  const secret = en.json.secret as string;
  assert.ok(secret.length >= 32);

  const act = await post("/api/account/2fa/verify", { secret, code: totp(secret, Date.now(), 30, 6) }, cookie);
  assert.equal(act.status, 200);

  const login2 = await post("/api/auth/login", { name: "carol", password: "pw123456" });
  assert.equal(login2.json.requiresTotp, true);
  const pending = login2.json.pendingToken as string;

  const tl = await post("/api/auth/totp", { pendingToken: pending, code: totp(secret, Date.now(), 30, 6) });
  assert.equal(tl.status, 200);
  assert.equal(typeof tl.json.accessToken, "string");
});

test("账户锁定（auth 层）：10 次失败锁 15 分钟；unlock 恢复", async () => {
  db.createUser("dave", await hashPassword("pw123456"));
  for (let i = 0; i < 9; i++) {
    assert.equal((await auth.login("dave", "wrong")).kind, "bad-credentials");
  }
  assert.equal((await auth.login("dave", "wrong")).kind, "locked");
  assert.equal((await auth.login("dave", "pw123456")).kind, "locked"); // 锁定中正确密码也拒
  db.unlockAccount(db.getUserByName("dave")!.id);
  assert.equal((await auth.login("dave", "pw123456")).kind, "ok");
});

test("共享：member 可见可进入，不可管理", async () => {
  db.createUser("alice", await hashPassword("pw123456"));
  db.createUser("bob", await hashPassword("pw123456"));
  const alice = db.getUserByName("alice")!;
  const bob = db.getUserByName("bob")!;
  db.createHost("host-share", alice.id, "shared-host", sha256(randomToken()));

  const aliceLogin = await post("/api/auth/login", { name: "alice", password: "pw123456" });
  const aliceCookie = cookieOf({ accessToken: aliceLogin.json.accessToken as string });
  const share = await post("/api/hosts/host-share/share", { name: "bob" }, aliceCookie);
  assert.equal(share.status, 200);

  const bobLogin = await post("/api/auth/login", { name: "bob", password: "pw123456" });
  const bobCookie = cookieOf({ accessToken: bobLogin.json.accessToken as string });
  const list = await get("/api/hosts", bobCookie);
  const hosts = list.json.hosts as Array<Record<string, unknown>>;
  assert.equal(hosts.length, 1);
  assert.equal(hosts[0]!.role, "member");

  // member 改名 → 403
  const rename = await fetch(base + "/api/hosts/host-share", {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: bobCookie },
    body: JSON.stringify({ name: "x" }),
  });
  assert.equal(rename.status, 403);

  // member 进入 host → 302
  const enter = await fetch(base + "/h/host-share/", { headers: { cookie: bobCookie }, redirect: "manual" });
  assert.equal(enter.status, 302);

  // 解除共享后 member 不可见
  const revoke = await fetch(base + "/api/hosts/host-share/share/" + bob.id, { method: "DELETE", headers: { cookie: aliceCookie } });
  assert.equal(revoke.status, 200);
  const after = await get("/api/hosts", bobCookie);
  assert.equal((after.json.hosts as Array<Record<string, unknown>>).length, 0);
});

test("审计：关键操作有事件", () => {
  assert.ok(db.listAudit({ event: "2fa.enabled" }).length > 0);
  assert.ok(db.listAudit({ event: "host.share" }).length > 0);
  assert.ok(db.listAudit({ event: "login.ok" }).length > 0);
});
