/**
 * config.test.ts — hub 配置加载。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHubConfig, normalizeHubConfig, resolveHubConfigPath, DEFAULT_HUB_CONFIG_PATH } from "../src/index.ts";

test("默认值（无文件）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hubcfg-"));
  const cfg = await loadHubConfig(join(dir, "missing.json"));
  assert.equal(cfg.host, "0.0.0.0");
  assert.equal(cfg.port, 8443);
  assert.equal(cfg.tls, undefined);
  assert.ok(cfg.dbPath.endsWith("hub.db"));
  assert.ok(cfg.jwtKeyPath.endsWith("hub-jwt.key"));
});

test("文件加载 + 覆盖默认", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hubcfg-"));
  const path = join(dir, "hub.json");
  await writeFile(path, JSON.stringify({ port: 9443, host: "127.0.0.1", tls: { cert: "/c.pem", key: "/k.pem" } }));
  const cfg = await loadHubConfig(path);
  assert.equal(cfg.port, 9443);
  assert.equal(cfg.host, "127.0.0.1");
  assert.deepEqual(cfg.tls, { cert: "/c.pem", key: "/k.pem" });
  assert.equal(cfg.dbPath.endsWith("hub.db"), true); // 未覆盖项用默认
});

test("路径优先级：--config > $RDSH_HUB_CONFIG > 默认", () => {
  assert.equal(resolveHubConfigPath("/x/hub.json", {}), "/x/hub.json");
  assert.equal(resolveHubConfigPath(undefined, { RDSH_HUB_CONFIG: "/y/hub.json" }), "/y/hub.json");
  assert.equal(resolveHubConfigPath(undefined, {}), DEFAULT_HUB_CONFIG_PATH);
});

test("非法字段明确报错", () => {
  assert.throws(() => normalizeHubConfig({ port: "abc" }), /invalid "port"/);
  assert.throws(() => normalizeHubConfig({ port: 70000 }), /invalid "port"/);
  assert.throws(() => normalizeHubConfig({ tls: { cert: "/c" } }), /"tls.cert" and "tls.key"/);
  assert.throws(() => normalizeHubConfig("nope"), /expected a JSON object/);
});

test("behindProxy 字段（默认 false / 可配置 / 非法报错）", async () => {
  assert.equal(normalizeHubConfig({}).behindProxy, false);
  assert.equal(normalizeHubConfig({ behindProxy: true }).behindProxy, true);
  assert.equal(normalizeHubConfig({ behindProxy: false }).behindProxy, false);
  assert.throws(() => normalizeHubConfig({ behindProxy: "yes" }), /"behindProxy" must be boolean/);
});
