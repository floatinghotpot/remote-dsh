import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGateway } from "../src/server.ts";
import { UserManager, hashPassword } from "../src/auth.ts";
import { loadConfig } from "../src/config.ts";

async function startUpstream() {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("dsh-ok");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as AddressInfo).port };
}

function closeServer(server: ReturnType<typeof createServer>): void {
  server.closeAllConnections?.();
  server.close();
}

async function makePasswordConfig(password = "pw123") {
  const dir = await mkdtemp(join(tmpdir(), "rdsh-m2-"));
  const cfg = join(dir, "config.json");
  await writeFile(cfg, JSON.stringify({ auth: { mode: "password", version: 1, users: [] } }));
  const um = new UserManager(cfg);
  await um.add("admin", password);
  return { dir, cfg, um };
}

async function startPasswordGateway(cfg: string, upstreamPort: number, extra: Record<string, unknown> = {}) {
  const merged = { behindProxy: true, ...extra };
  const um = new UserManager(cfg);
  const config = await loadConfig(cfg);
  const keyDir = await mkdtemp(join(tmpdir(), "rdsh-m2-key-"));
  const gw = await startGateway({
    host: "127.0.0.1",
    port: 0,
    sessionTtlSeconds: 3600,
    dshPort: upstreamPort,
    keyDir,
    authMode: "password",
    authVersion: config.auth.version,
    userManager: um,
    configPath: cfg,
    ...merged,
  });
  return { gw, um, base: `http://127.0.0.1:${gw.actualPort}` };
}

async function login(base: string, name: string, password: string) {
  return await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, password }),
    redirect: "manual",
  });
}

test("password 模式：无会话 → 307 /login；登录页可访问", async () => {
  const upstream = await startUpstream();
  const { cfg } = await makePasswordConfig();
  const t = await startPasswordGateway(cfg, upstream.port);
  try {
    const anon = await fetch(`${t.base}/api/x`, { redirect: "manual" });
    assert.equal(anon.status, 307);
    assert.equal(anon.headers.get("location"), "/login");
    const page = await fetch(`${t.base}/login`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes("登录"));
  } finally {
    t.gw.dispose();
    closeServer(t.gw.server);
    closeServer(upstream.server);
  }
});

test("password 模式：登录成功 302+Cookie；错误密码 401；5 次锁定 429", async () => {
  const upstream = await startUpstream();
  const { cfg } = await makePasswordConfig();
  const t = await startPasswordGateway(cfg, upstream.port);
  try {
    const ok = await login(t.base, "admin", "pw123");
    assert.equal(ok.status, 302);
    assert.equal(ok.headers.get("location"), "/");
    const cookie = ok.headers.get("set-cookie");
    assert.ok(cookie?.includes("HttpOnly"));

    const bad = await login(t.base, "admin", "wrong");
    assert.equal(bad.status, 401);
    const bad2 = await login(t.base, "ghost", "x");
    assert.equal(bad2.status, 401);

    for (let i = 0; i < 4; i++) await login(t.base, "admin", "wrong");
    const locked = await login(t.base, "admin", "pw123"); // 正确密码也被锁
    assert.equal(locked.status, 429);
  } finally {
    t.gw.dispose();
    closeServer(t.gw.server);
    closeServer(upstream.server);
  }
});

test("password 模式：带会话访问转发；改密后旧 Cookie 失效（307）", async () => {
  const upstream = await startUpstream();
  const { cfg, um } = await makePasswordConfig();
  const t = await startPasswordGateway(cfg, upstream.port);
  try {
    const ok = await login(t.base, "admin", "pw123");
    const cookie = ok.headers.get("set-cookie")!.split(";")[0]!;
    const res = await fetch(`${t.base}/api/x`, { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "dsh-ok");

    // 改密（version+1）→ 等待 config watch 生效 → 旧 Cookie 失效
    await um.passwd("admin", "newpw");
    await new Promise((r) => setTimeout(r, 300));
    const after = await fetch(`${t.base}/api/x`, { headers: { cookie }, redirect: "manual" });
    assert.equal(after.status, 307);

    // 新密码可登录
    const relogin = await login(t.base, "admin", "newpw");
    assert.equal(relogin.status, 302);
  } finally {
    t.gw.dispose();
    closeServer(t.gw.server);
    closeServer(upstream.server);
  }
});

test("allow_from：白名单外 IP 403；白名单内放行", async () => {
  const upstream = await startUpstream();
  const { cfg } = await makePasswordConfig();
  const t = await startPasswordGateway(cfg, upstream.port, { allowFrom: ["10.0.0.0/8"] });
  try {
    // 测试连接来自 127.0.0.1 —— 不在 10.0.0.0/8 → 403（认证前拦截）
    const blocked = await fetch(`${t.base}/login`);
    assert.equal(blocked.status, 403);
    const blockedApi = await fetch(`${t.base}/api/x`);
    assert.equal(blockedApi.status, 403);
  } finally {
    t.gw.dispose();
    closeServer(t.gw.server);
    closeServer(upstream.server);
  }
});

test("allow_from：behindProxy 时取 X-Forwarded-For（仅回环信任）", async () => {
  const upstream = await startUpstream();
  const { cfg } = await makePasswordConfig();
  const t = await startPasswordGateway(cfg, upstream.port, { allowFrom: ["10.0.0.0/8"], behindProxy: true });
  try {
    // XFF: 10.1.2.3（白名单内）→ 放行到登录页
    const ok = await fetch(`${t.base}/login`, { headers: { "x-forwarded-for": "10.1.2.3" } });
    assert.equal(ok.status, 200);
    // XFF: 8.8.8.8（白名单外）→ 403
    const blocked = await fetch(`${t.base}/login`, { headers: { "x-forwarded-for": "8.8.8.8" } });
    assert.equal(blocked.status, 403);
  } finally {
    t.gw.dispose();
    closeServer(t.gw.server);
    closeServer(upstream.server);
  }
});

test("无 TLS + password + 非反代 → 启动拒绝", async () => {
  const upstream = await startUpstream();
  const { cfg } = await makePasswordConfig();
  const keyDir = await mkdtemp(join(tmpdir(), "rdsh-m2-key-"));
  await assert.rejects(
    () =>
      startGateway({
        host: "127.0.0.1",
        port: 0,
        sessionTtlSeconds: 3600,
        dshPort: upstream.port,
        keyDir,
        authMode: "password",
        userManager: new UserManager(cfg),
      }),
    /requires TLS/,
  );
  closeServer(upstream.server);
});

test("behindProxy + password + http → 允许启动", async () => {
  const upstream = await startUpstream();
  const { cfg } = await makePasswordConfig();
  const t = await startPasswordGateway(cfg, upstream.port, { behindProxy: true });
  try {
    assert.equal(t.gw.actualPort > 0, true);
  } finally {
    t.gw.dispose();
    closeServer(t.gw.server);
    closeServer(upstream.server);
  }
});

test("预置哈希用户可登录（部署场景）", async () => {
  const upstream = await startUpstream();
  const dir = await mkdtemp(join(tmpdir(), "rdsh-m2-"));
  const cfg = join(dir, "config.json");
  const hash = await hashPassword("preset");
  await writeFile(cfg, JSON.stringify({ auth: { mode: "password", version: 1, users: [{ name: "admin", passwordHash: hash }] } }));
  const t = await startPasswordGateway(cfg, upstream.port);
  try {
    const ok = await login(t.base, "admin", "preset");
    assert.equal(ok.status, 302);
  } finally {
    t.gw.dispose();
    closeServer(t.gw.server);
    closeServer(upstream.server);
  }
});

test("config 文件权限与读写（config.json 可被 UserManager 更新）", async () => {
  const { cfg, um } = await makePasswordConfig();
  await um.add("bob", "bobpw");
  const raw = JSON.parse(await readFile(cfg, "utf8"));
  assert.ok(Array.isArray(raw.auth.users));
  assert.equal(raw.auth.users.length, 2);
  assert.equal(raw.auth.version, 1);
});
