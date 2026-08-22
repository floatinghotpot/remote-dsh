import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashPassword, verifyPassword, UserManager } from "../src/auth.ts";

test("hashPassword/verifyPassword 往返", async () => {
  const hash = await hashPassword("secret123");
  assert.ok(hash.startsWith("scrypt:"));
  assert.equal(await verifyPassword("secret123", hash), true);
  assert.equal(await verifyPassword("wrong", hash), false);
  assert.equal(await verifyPassword("secret123", "garbage"), false);
});

test("同密码两次哈希不同（随机盐）", async () => {
  const a = await hashPassword("pw");
  const b = await hashPassword("pw");
  assert.notEqual(a, b);
});

test("UserManager add/list/verify", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rdsh-auth-"));
  const cfg = join(dir, "config.json");
  const um = new UserManager(cfg);
  await um.add("admin", "pw123");
  assert.deepEqual(await um.list(), ["admin"]);
  assert.notEqual((await um.verify("admin", "pw123")), null);
  assert.equal(await um.verify("admin", "bad"), null);
  assert.equal(await um.verify("nobody", "pw123"), null);
});

test("add 重复用户名报错", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rdsh-auth-"));
  const cfg = join(dir, "config.json");
  const um = new UserManager(cfg);
  await um.add("admin", "pw");
  await assert.rejects(() => um.add("admin", "pw2"), /already exists/);
});

test("passwd 更新哈希并 version+1", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rdsh-auth-"));
  const cfg = join(dir, "config.json");
  const um = new UserManager(cfg);
  await um.add("admin", "oldpw");
  const v1 = await um.version();
  assert.equal(await um.passwd("admin", "newpw"), true);
  const v2 = await um.version();
  assert.equal(v2, v1 + 1);
  assert.equal(await um.verify("admin", "oldpw"), null);
  assert.notEqual(await um.verify("admin", "newpw"), null);
  assert.equal(await um.passwd("ghost", "x"), false);
});

test("remove 删除用户", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rdsh-auth-"));
  const cfg = join(dir, "config.json");
  const um = new UserManager(cfg);
  await um.add("admin", "pw");
  await um.add("bob", "pw");
  assert.equal(await um.remove("admin"), true);
  assert.equal(await um.remove("admin"), false);
  assert.deepEqual(await um.list(), ["bob"]);
});

test("用户名非法字符报错", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rdsh-auth-"));
  const um = new UserManager(join(dir, "config.json"));
  await assert.rejects(() => um.add("bad name!", "pw"), /invalid username/);
});

test("config 文件不存在时默认（version=1）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rdsh-auth-"));
  const um = new UserManager(join(dir, "none.json"));
  assert.equal(await um.version(), 1);
  assert.deepEqual(await um.list(), []);
});

test("预置哈希可直接登录（部署场景）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rdsh-auth-"));
  const cfg = join(dir, "config.json");
  const hash = await hashPassword("preset");
  await writeFile(cfg, JSON.stringify({ auth: { mode: "password", version: 1, users: [{ name: "admin", passwordHash: hash }] } }));
  const um = new UserManager(cfg);
  assert.notEqual(await um.verify("admin", "preset"), null);
});
