/**
 * 71 B5：relay.builtin 配置 + 吊销表（host_revocations）读写/清理。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeHubConfig } from "../src/config.ts";
import { HubDb } from "../src/db.ts";
import { createSqliteStore } from "../src/store.ts";

test("B5：relay.builtin 解析（默认 undefined=内置 relay 开着；false=关）", () => {
  assert.equal(normalizeHubConfig({}).relay, undefined);
  assert.equal(normalizeHubConfig({ relay: { builtin: false } }).relay?.builtin, false);
  assert.equal(normalizeHubConfig({ relay: { builtin: true } }).relay?.builtin, true);
});

test("B5：relay.builtin 非法值必须拒绝", () => {
  assert.throws(() => normalizeHubConfig({ relay: "x" }), /relay.*object/);
  assert.throws(() => normalizeHubConfig({ relay: { builtin: "yes" } }), /relay\.builtin.*boolean/);
});

test("B5：吊销表 —— 写入/近期查询/清理（TTL 幂等重发的基础）", async () => {
  const db = new HubDb(":memory:");
  const store = createSqliteStore(db);
  const now = Date.now();
  await store.revokeHost("hst-a", now);
  await store.revokeHost("hst-b", now - 10 * 60 * 1000); // 10 分钟前
  const recent = await store.listRecentRevocations(now - 5 * 60 * 1000);
  assert.deepEqual(recent, ["hst-a"], "只返回 5 分钟内的吊销");
  // 重复吊销幂等（同 host 不重复）
  await store.revokeHost("hst-a", now + 1);
  assert.deepEqual(await store.listRecentRevocations(now - 5 * 60 * 1000), ["hst-a"]);
  // prune 清掉旧记录
  await store.pruneRevocations(now - 60 * 1000);
  assert.deepEqual(await store.listRecentRevocations(0), ["hst-a"], "1 分钟前的被清，最新的保留");
});
