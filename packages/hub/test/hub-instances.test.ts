/**
 * 71 B6/U5：hub 实例自注册（跨实例可见/region 过滤/排序/TTL）+ instanceUrl 必须 https。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeHubConfig } from "../src/config.ts";
import { HubDb } from "../src/db.ts";
import { createSqliteStore } from "../src/store.ts";

test("B6：instanceUrl 必须 https（relay token 不得明文）", () => {
  assert.equal(normalizeHubConfig({ instanceUrl: "https://hub-a.rdsh.cn" }).instanceUrl, "https://hub-a.rdsh.cn");
  assert.throws(() => normalizeHubConfig({ instanceUrl: "http://hub-a.rdsh.cn" }), /must be https/);
  assert.throws(() => normalizeHubConfig({ instanceUrl: "not a url" }), /absolute URL/);
  assert.throws(() => normalizeHubConfig({ instanceUrl: "" }), /non-empty/);
});

test("B6：实例自注册 —— 跨实例可见 / region 过滤 / url 稳定排序", async () => {
  const db = new HubDb(":memory:");
  const a = createSqliteStore(db);
  const b = createSqliteStore(db);
  const now = Date.now();
  await a.upsertHubInstance("https://hub-b.rdsh.cn", "cn", "1.2.3", now);
  await a.upsertHubInstance("https://hub-a.rdsh.cn", "cn", "1.2.3", now);
  await a.upsertHubInstance("https://hub-us.rdsh.cn", "us", "1.2.3", now);

  const all = await b.listHubInstances(now - 90_000);
  assert.deepEqual(all.map((i) => i.url), ["https://hub-a.rdsh.cn", "https://hub-b.rdsh.cn", "https://hub-us.rdsh.cn"], "按 url 稳定排序");
  const cn = await b.listHubInstances(now - 90_000, "cn");
  assert.deepEqual(cn.map((i) => i.url), ["https://hub-a.rdsh.cn", "https://hub-b.rdsh.cn"], "region 过滤");
  assert.equal(cn[0]!.version, "1.2.3");
});

test("B6：touch 刷新活跃；过期实例不返回；prune 清掉", async () => {
  const db = new HubDb(":memory:");
  const s = createSqliteStore(db);
  const now = Date.now();
  await s.upsertHubInstance("https://hub-a.rdsh.cn", "cn", null, now - 10 * 60 * 1000);
  assert.deepEqual(await s.listHubInstances(now - 90_000), [], "超过 90s 未 touch → 不在列表");
  await s.touchHubInstance("https://hub-a.rdsh.cn", now);
  assert.equal((await s.listHubInstances(now - 90_000)).length, 1, "touch 后恢复");
  await s.pruneHubInstances(now + 1);
  assert.equal((await s.listHubInstances(0)).length, 0, "prune 清掉");
});
