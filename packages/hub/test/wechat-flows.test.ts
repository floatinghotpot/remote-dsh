/**
 * 71 B3：微信流程态跨实例（同一 DB 两个 store）+ 一次性 + kind 隔离 + 过期。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { HubDb } from "../src/db.ts";
import { createSqliteStore } from "../src/store.ts";

function setup() {
  const db = new HubDb(":memory:");
  // 两个 store 共用一个 DB：模拟两个实例共享同一 PG。
  return { db, a: createSqliteStore(db), b: createSqliteStore(db) };
}

test("B3：A 写入、B 消费（跨实例）+ 一次性", async () => {
  const { a, b } = setup();
  const exp = Date.now() + 60_000;
  await a.setWechatFlow("tok1", "login", null, JSON.stringify({ next: "/portal/hosts" }), "1.2.3.4", exp);
  const got = await b.consumeWechatFlow("tok1", "login", Date.now());
  assert.deepEqual(got, { payload: JSON.stringify({ next: "/portal/hosts" }), userId: null });
  assert.equal(await b.consumeWechatFlow("tok1", "login", Date.now()), null, "一次性：第二次必须失败");
  assert.equal(await a.consumeWechatFlow("tok1", "login", Date.now()), null, "另一实例也拿不到");
});

test("B3：kind 隔离（同 token 不同 flow 不串）", async () => {
  const { a, b } = setup();
  const exp = Date.now() + 60_000;
  await a.setWechatFlow("tok2", "pending", null, JSON.stringify({ openid: "o" }), null, exp);
  assert.equal(await b.consumeWechatFlow("tok2", "handoff", Date.now()), null, "kind 不符 → null");
  const ok = await b.consumeWechatFlow("tok2", "pending", Date.now());
  assert.ok(ok !== null, "正确 kind 仍可消费");
});

test("B3：过期 → 读/消费均为 null；prune 清掉", async () => {
  const { a, b } = setup();
  await a.setWechatFlow("tok3", "handoff", 42, "{}", null, Date.now() - 1);
  assert.equal(await b.getWechatFlow("tok3", "handoff", Date.now()), null);
  assert.equal(await b.consumeWechatFlow("tok3", "handoff", Date.now()), null);
  await b.pruneExpiredWechatFlows(Date.now());
  assert.equal(await b.getWechatFlow("tok3", "handoff", Date.now()), null);
});

test("B3：userId 随 flow 带回（handoff / bind_token 用）", async () => {
  const { a, b } = setup();
  await a.setWechatFlow("tok4", "handoff", 7, "{}", null, Date.now() + 60_000);
  const got = await b.consumeWechatFlow("tok4", "handoff", Date.now());
  assert.deepEqual(got, { payload: "{}", userId: 7 });
});
