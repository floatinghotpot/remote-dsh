/**
 * subscription-effective.test.ts — getEffectiveSubscription 的「生效订阅」读法回归。
 *
 * 修 2026-11-04 的跨渠道多有效订阅取错档 bug：有有效行 → 取最高档（vipTier 降序）、
 * 同档取到期最晚；无有效行（grace 期/刚过期）→ 取最近到期行。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { HubDb } from "../src/db.ts";
import { getEffectiveSubscription } from "../src/api.ts";
import { createSqliteStore } from "../src/store.ts";
import type { HubRuntime } from "../src/server.ts";

const PLANS = [
  { id: "plus_monthly", name: "标准版", hosts: 2, priceCny: 38, intervalMonths: 1, vipTier: 1 },
  { id: "pro_monthly", name: "专业版", hosts: 5, priceCny: 68, intervalMonths: 1, vipTier: 2 },
];
const DAY = 86_400_000;
const now = Date.now();

function rt(db: HubDb): HubRuntime {
  return { db, store: createSqliteStore(db), config: { billing: { plans: PLANS } } } as unknown as HubRuntime;
}

test("① 单个有效订阅 → 返回它", async () => {
  const db = new HubDb(":memory:");
  try {
    const u = db.createUser("u", "h");
    db.setPlan(u.id, "subscribed", now + 30 * DAY);
    db.createSubscription(u.id, "plus_monthly", now, now + 30 * DAY);
    const sub = await getEffectiveSubscription(rt(db), db.getUserById(u.id)!);
    assert.equal(sub?.planId, "plus_monthly");
  } finally {
    db.close();
  }
});

test("② 一 active 一 expired → 返回 active（不再取最新行）", async () => {
  const db = new HubDb(":memory:");
  try {
    const u = db.createUser("u", "h");
    db.setPlan(u.id, "subscribed", now + 30 * DAY);
    // 早创建但已过期（旧档）；晚创建且有效
    db.createSubscription(u.id, "plus_monthly", now - 60 * DAY, now - 30 * DAY);
    db.createSubscription(u.id, "pro_monthly", now, now + 30 * DAY);
    const sub = await getEffectiveSubscription(rt(db), db.getUserById(u.id)!);
    assert.equal(sub?.planId, "pro_monthly");
  } finally {
    db.close();
  }
});

test("③ 双 active 跨渠道 → 返回 vipTier 最高者", async () => {
  const db = new HubDb(":memory:");
  try {
    const u = db.createUser("u", "h");
    db.setPlan(u.id, "subscribed", now + 30 * DAY);
    db.createSubscription(u.id, "plus_monthly", now, now + 30 * DAY);
    db.createSubscription(u.id, "pro_monthly", now, now + 30 * DAY);
    const sub = await getEffectiveSubscription(rt(db), db.getUserById(u.id)!);
    assert.equal(sub?.planId, "pro_monthly");
  } finally {
    db.close();
  }
});

test("④ 无有效行（grace）→ 返回最近到期那行", async () => {
  const db = new HubDb(":memory:");
  try {
    const u = db.createUser("u", "h");
    db.setPlan(u.id, "grace", now + 3 * DAY);
    db.createSubscription(u.id, "plus_monthly", now - 60 * DAY, now - 30 * DAY);
    db.createSubscription(u.id, "pro_monthly", now - 40 * DAY, now - 10 * DAY);
    const sub = await getEffectiveSubscription(rt(db), db.getUserById(u.id)!);
    assert.equal(sub?.planId, "pro_monthly", "grace 期取最近到期行（pro 到期 10 天前，晚于 plus 30 天前）");
  } finally {
    db.close();
  }
});

test("⑤ 取消自动续费（status=canceled）但本周期未到期 → 仍有效", async () => {
  const db = new HubDb(":memory:");
  try {
    const u = db.createUser("u", "h");
    db.setPlan(u.id, "subscribed", now + 30 * DAY);
    const sub = db.createSubscription(u.id, "plus_monthly", now, now + 30 * DAY);
    db.setSubscriptionStatus(sub.id, "canceled");
    const eff = await getEffectiveSubscription(rt(db), db.getUserById(u.id)!);
    assert.equal(eff?.planId, "plus_monthly", "canceled 但未到期，应仍视为有效");
  } finally {
    db.close();
  }
});
