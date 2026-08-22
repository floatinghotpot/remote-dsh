import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeConfig, resolveConfigPath } from "../src/config.ts";

test("默认值（空对象）", () => {
  const c = normalizeConfig({});
  assert.equal(c.host, "0.0.0.0");
  assert.equal(c.port, 8443);
  assert.equal(c.sessionTtlSeconds, 12 * 3600);
  assert.equal(c.behindProxy, false);
  assert.deepEqual(c.allowFrom, []);
  assert.equal(c.auth.mode, "pair");
  assert.equal(c.auth.version, 1);
});

test("完整字段解析", () => {
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
  assert.equal(c.host, "127.0.0.1");
  assert.equal(c.port, 9000);
  assert.equal(c.tls?.cert, "/c.pem");
  assert.equal(c.behindProxy, true);
  assert.deepEqual(c.allowFrom, ["192.168.1.0/24", "10.0.0.5"]);
  assert.equal(c.auth.mode, "password");
  assert.equal(c.auth.version, 3);
  assert.equal(c.auth.users[0]?.name, "admin");
});

test("非法字段报错", () => {
  assert.throws(() => normalizeConfig({ port: 70000 }));
  assert.throws(() => normalizeConfig({ port: "abc" }));
  assert.throws(() => normalizeConfig({ auth: { mode: "otp" } }));
  assert.throws(() => normalizeConfig({ auth: { users: [{ name: "a" }] } }));
  assert.throws(() => normalizeConfig({ allowFrom: [1] }));
  assert.throws(() => normalizeConfig("nope"));
  assert.throws(() => normalizeConfig({ tls: { cert: 1, key: 2 } }));
});

test("resolveConfigPath 优先级", () => {
  assert.equal(resolveConfigPath("/a.json", {}), "/a.json");
  assert.equal(resolveConfigPath(undefined, { RDSH_CONFIG: "/b.json" }), "/b.json");
  assert.ok(resolveConfigPath(undefined, {}).endsWith(".rdsh/config.json"));
  assert.equal(resolveConfigPath("/a.json", { RDSH_CONFIG: "/b.json" }), "/a.json"); // CLI 优先
});
