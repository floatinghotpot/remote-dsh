import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeConfig, resolveConfigPath } from "../src/config.ts";

test("默认值（空对象）→ mode 推断为 lan", () => {
  const c = normalizeConfig({});
  assert.equal(c.mode, "lan");
  assert.equal(c.host, "0.0.0.0");
  assert.equal(c.port, 8443);
  assert.equal(c.sessionTtlSeconds, 12 * 3600);
  assert.equal(c.behindProxy, false);
  assert.deepEqual(c.allowFrom, []);
  assert.equal(c.auth.mode, "pair");
  assert.equal(c.auth.version, 1);
});

test("完整字段解析（tls+password 缺 mode → 推断 cloud）", () => {
  const c = normalizeConfig({
    host: "127.0.0.1",
    port: 9000,
    sessionTtlSeconds: 7200,
    tls: { cert: "/c.pem", key: "/k.pem" },
    behindProxy: true,
    allowFrom: ["192.168.1.0/24", "10.0.0.5"],
    auth: { mode: "password", version: 3, users: [{ name: "admin", passwordHash: "scrypt:x" }] },
    dshPath: "/usr/bin/dsh",
  });
  assert.equal(c.mode, "cloud");
  assert.equal(c.host, "127.0.0.1");
  assert.equal(c.port, 9000);
  assert.equal(c.tls?.cert, "/c.pem");
  assert.equal(c.behindProxy, true);
  assert.deepEqual(c.allowFrom, ["192.168.1.0/24", "10.0.0.5"]);
  assert.equal(c.auth.mode, "password");
  assert.equal(c.auth.version, 3);
  assert.equal(c.auth.users[0]?.name, "admin");
});

test("三模式显式解析 + join 字段", () => {
  assert.equal(normalizeConfig({ mode: "lan" }).mode, "lan");
  assert.equal(normalizeConfig({ mode: "cloud" }).mode, "cloud");
  const j = normalizeConfig({ mode: "join", hub: "https://hub.example.com", name: "my-laptop", insecure: true });
  assert.equal(j.mode, "join");
  assert.equal(j.hub, "https://hub.example.com");
  assert.equal(j.name, "my-laptop");
  assert.equal(j.insecure, true);
});

test("mode 推断：tls 存在 → cloud；password → cloud；其余 → lan", () => {
  assert.equal(normalizeConfig({ tls: { cert: "/c", key: "/k" } }).mode, "cloud");
  assert.equal(normalizeConfig({ auth: { mode: "password" } }).mode, "cloud");
  assert.equal(normalizeConfig({ auth: { mode: "pair" } }).mode, "lan");
  assert.equal(normalizeConfig({ auth: { mode: "none" } }).mode, "lan");
});

test("非法字段报错", () => {
  assert.throws(() => normalizeConfig({ mode: "otp" }));
  assert.throws(() => normalizeConfig({ mode: "join", insecure: "yes" }));
  assert.throws(() => normalizeConfig({ port: 70000 }));
  assert.throws(() => normalizeConfig({ port: "abc" }));
  assert.throws(() => normalizeConfig({ auth: { mode: "otp" } }));
  assert.throws(() => normalizeConfig({ auth: { users: [{ name: "a" }] } }));
  assert.throws(() => normalizeConfig({ allowFrom: [1] }));
  assert.throws(() => normalizeConfig("nope"));
  assert.throws(() => normalizeConfig({ tls: { cert: 1, key: 2 } }));
});

test("resolveConfigPath 优先级（默认 host.json）", () => {
  assert.equal(resolveConfigPath("/a.json", {}), "/a.json");
  assert.equal(resolveConfigPath(undefined, { RDSH_CONFIG: "/b.json" }), "/b.json");
  assert.ok(resolveConfigPath(undefined, {}).endsWith(".rdsh/host.json"));
  assert.equal(resolveConfigPath("/a.json", { RDSH_CONFIG: "/b.json" }), "/a.json"); // CLI 优先
});

test("gateway.accessCode 折叠语义 + ≥4 校验", () => {
  // 缺失 / null / "" → null（gate off）
  assert.equal(normalizeConfig({}).gateway?.accessCode, null);
  assert.equal(normalizeConfig({ gateway: {} }).gateway?.accessCode, null);
  assert.equal(normalizeConfig({ gateway: { accessCode: null } }).gateway?.accessCode, null);
  assert.equal(normalizeConfig({ gateway: { accessCode: "" } }).gateway?.accessCode, null);
  // 非空 ≥4 → 保留（gate on）
  assert.equal(normalizeConfig({ gateway: { accessCode: "abcd" } }).gateway?.accessCode, "abcd");
  assert.equal(normalizeConfig({ gateway: { accessCode: "长密码123" } }).gateway?.accessCode, "长密码123");
  // <4 / 非字符串 → 报错
  assert.throws(() => normalizeConfig({ gateway: { accessCode: "abc" } }), /at least 4/);
  assert.throws(() => normalizeConfig({ gateway: { accessCode: 1234 } }), /must be a string/);
  assert.throws(() => normalizeConfig({ gateway: "x" }), /"gateway" must be an object/);
});
