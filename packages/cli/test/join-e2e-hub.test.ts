/**
 * join-e2e-hub.test.ts — 真实 hub + 真实 CLI 的端到端绑定（63-bind-agent-box）。
 *
 * 覆盖 req R1–R6 的可自动化部分：CLI 建会话 → 打印 bindId → 账号批准 → CLI 消费
 * → host 归属该账号（`GET /api/hosts`）。设备/App 部分仍由真机验收。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HubDb } from "../../hub/src/db.ts";
import { HubAuth, hashPassword } from "../../hub/src/auth.ts";
import { createSqliteStore } from "../../hub/src/store.ts";
import { Jwt } from "../../hub/src/jwt.ts";
import { TunnelRegistry } from "../../hub/src/tunnel.ts";
import { EventHub } from "../../hub/src/events.ts";
import { startHubServer } from "../../hub/src/server.ts";

const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "bin.js");

test("CLI --headless 走完 bind-sessions → approve → consume，host 出现在账号下", async () => {
  const db = new HubDb(":memory:");
  const auth = new HubAuth(createSqliteStore(db), (id) => db.getUserById(id), new Jwt(Buffer.from("test-key-0123456789abcdef")));
  const server = await startHubServer({
    host: "127.0.0.1",
    port: 0,
    db,
    auth,
    tunnels: new TunnelRegistry(),
    events: new EventHub(),
    portalDir: "/nonexistent-portal",
  });
  const base = `http://127.0.0.1:${server.actualPort}`;
  const home = mkdtempSync(join(tmpdir(), "rdsh-e2e-"));

  try {
    const user = db.createUser("alice", await hashPassword("pw123456"));
    db.setPlan(user.id, "internal", null);
    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "alice", password: "pw123456" }),
    });
    assert.equal(login.status, 200);
    const cookie = `rdsh_hub_session=${((await login.json()) as { accessToken: string }).accessToken}`;

    // 起 CLI（非 TTY，模拟 boxd 拉起）；逐行读 stdout 直到 RDSH_BIND
    const child = execFile(
      process.execPath,
      [bin, "join", base, "--headless", "--name", "测试盒子"],
      {
        env: { ...process.env, HOME: home, RDSH_CONFIG: join(home, "host.json") },
        // node 默认 execFile 无 TTY
      },
      (err) => {
        if (err) process.stderr.write(`cli failed: ${String(err)}\n`);
      },
    );
    child.stdin?.end();

    const bindLine = await new Promise<string>((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error(`no RDSH_BIND line; got: ${buf}`)), 15_000);
      child.stdout?.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        const line = buf.split(/\r?\n/).find((l) => l.startsWith("RDSH_BIND "));
        if (line !== undefined) {
          clearTimeout(timer);
          resolve(line);
        }
      });
    });

    const { bindId } = JSON.parse(bindLine.slice("RDSH_BIND ".length)) as { bindId: string };
    assert.ok(bindId.length > 0);

    // 账号批准（模拟 App 的 approve）
    const approve = await fetch(`${base}/api/bind-sessions/${bindId}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: "{}",
    });
    assert.equal(approve.status, 200, "批准应成功");

    // CLI 自己轮询 → consume → 写 host.json → 退出 0
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    assert.equal(code, 0, "CLI 应正常退出");

    // 主机归属该账号
    const list = await fetch(`${base}/api/hosts`, { headers: { cookie } });
    assert.equal(list.status, 200);
    const hosts = ((await list.json()) as { hosts: Array<{ name: string; deviceKind: string | null }> }).hosts;
    const host = hosts.find((h) => h.name === "测试盒子");
    assert.ok(host !== undefined, `host 应出现在列表：${JSON.stringify(hosts)}`);
    assert.equal(host.deviceKind, null, "绑定本身不上报类型（由 meta 端点补）");

    // host.json 落在隔离 HOME 下
    const cfg = JSON.parse(readFileSync(join(home, "host.json"), "utf8")) as { mode?: string };
    assert.equal(cfg.mode, "join");
  } finally {
    await new Promise<void>((r) => server.server.close(() => r()));
    db.close();
  }
});

/**
 * 重绑去重（fix 20261106-box-rebind-duplicate-host）：同一台机器（同一 HOME →
 * 同一 `~/.rdsh/device-id`）用新的 join token 再接入一次，必须复用同一个 hostId，
 * 而不是在账号里再新建一条。
 */
test("同一台机器换 join token 重绑 → 复用同一 hostId", async () => {
  const db = new HubDb(":memory:");
  const auth = new HubAuth(createSqliteStore(db), (id) => db.getUserById(id), new Jwt(Buffer.from("test-key-0123456789abcdef")));
  const server = await startHubServer({
    host: "127.0.0.1",
    port: 0,
    db,
    auth,
    tunnels: new TunnelRegistry(),
    events: new EventHub(),
    portalDir: "/nonexistent-portal",
    // register 按 IP 限流（10 次/分钟）；测试里用 XFF 换桶。
    behindProxy: true,
  });
  const base = `http://127.0.0.1:${server.actualPort}`;
  const home = mkdtempSync(join(tmpdir(), "rdsh-rebind-"));
  const env = { ...process.env, HOME: home, RDSH_CONFIG: join(home, "host.json") };
  let ip = 0;
  let cookie = "";
  const mintToken = async (name: string): Promise<string> => {
    const res = await fetch(`${base}/api/hosts/join-token`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "x-forwarded-for": `10.1.0.${++ip}` },
      body: JSON.stringify({ ttlSeconds: 300 }),
    });
    assert.equal(res.status, 200, `mint join token failed: ${name}`);
    return ((await res.json()) as { token: string }).token;
  };

  try {
    const user = db.createUser("bob", await hashPassword("pw123456"));
    db.setPlan(user.id, "internal", null);
    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "10.1.0.1" },
      body: JSON.stringify({ name: "bob", password: "pw123456" }),
    });
    assert.equal(login.status, 200);
    cookie = `rdsh_hub_session=${((await login.json()) as { accessToken: string }).accessToken}`;

    // 1) 首次接入
    const t1 = await mintToken("first");
    await new Promise<void>((resolve, reject) => {
      execFile(process.execPath, [bin, "join", base, "--token", t1, "--name", "rebind-box"], { env, timeout: 30_000 }, (err) =>
        err ? reject(err) : resolve(),
      );
    });
    const metaPath = join(home, ".rdsh");
    assert.ok(existsSync(metaPath), "隔离 HOME 下应出现 .rdsh");

    const firstId = ((await (await fetch(`${base}/api/hosts`, { headers: { cookie } })).json()) as {
      hosts: Array<{ id: string }>;
    }).hosts[0]!.id;
    // device-id 已持久化
    const deviceIdFile = join(metaPath, "device-id");
    assert.ok(existsSync(deviceIdFile), "应持久化 ~/.rdsh/device-id");
    const deviceId = readFileSync(deviceIdFile, "utf8").trim();

    // 2) 换一个新 join token 再接入（模拟「解绑→绑定」）
    const t2 = await mintToken("second");
    assert.notEqual(t2, t1);
    await new Promise<void>((resolve, reject) => {
      execFile(process.execPath, [bin, "join", base, "--token", t2, "--name", "rebind-box"], { env, timeout: 30_000 }, (err) =>
        err ? reject(err) : resolve(),
      );
    });

    const hosts = ((await (await fetch(`${base}/api/hosts`, { headers: { cookie } })).json()) as {
      hosts: Array<{ id: string }>;
    }).hosts;
    assert.equal(hosts.length, 1, `重绑不应新建记录：${JSON.stringify(hosts)}`);
    assert.equal(hosts[0]!.id, firstId, "同一设备必须复用 hostId");
    assert.equal(readFileSync(deviceIdFile, "utf8").trim(), deviceId, "device-id 必须稳定不变");
  } finally {
    await new Promise<void>((r) => server.server.close(() => r()));
    db.close();
  }
});
