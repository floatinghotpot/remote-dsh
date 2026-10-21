/**
 * host-quota.test.ts — hostQuota 的配额计算（冻结矩阵 §13.2 的"可云端中转主机数"）。
 *
 * 重点回归：取消订阅（到期不续，status=canceled）或进入宽限期后，
 * plan_status 仍是 subscribed/grace（当前周期仍有效），配额必须保留 ——
 * 旧实现用 getActiveSubscription（只看 status='active'）会把这类用户误判为 0。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { HubDb } from "../src/db.ts";
import { hostQuota } from "../src/api.ts";
import { createSqliteStore } from "../src/store.ts";
import type { HubRuntime } from "../src/server.ts";

const PLANS = [{ id: "plus_monthly", name: "标准版", hosts: 2, priceCny: 38, intervalMonths: 1, vipTier: 1 }];
const DAY = 86_400_000;
const now = Date.now();

function rt(db: HubDb, billing?: Record<string, unknown>): HubRuntime {
  return { db, store: createSqliteStore(db), config: { billing } } as unknown as HubRuntime;
}

test("hostQuota：subscribed + 订阅 active → 套餐台数", async () => {
  const db = new HubDb(":memory:");
  try {
    const u = db.createUser("u", "h");
    db.setPlan(u.id, "subscribed", now + 30 * DAY);
    db.createSubscription(u.id, "plus_monthly", now, now + 30 * DAY);
    assert.equal(await hostQuota(rt(db, { plans: PLANS }), db.getUserById(u.id)!), 2);
  } finally {
    db.close();
  }
});

test("hostQuota：取消订阅（status=canceled）但本周期未到期 → 仍按套餐台数", async () => {
  const db = new HubDb(":memory:");
  try {
    const u = db.createUser("u", "h");
    db.setPlan(u.id, "subscribed", now + 30 * DAY);
    const sub = db.createSubscription(u.id, "plus_monthly", now, now + 30 * DAY);
    db.setSubscriptionStatus(sub.id, "canceled");
    assert.equal(await hostQuota(rt(db, { plans: PLANS }), db.getUserById(u.id)!), 2, "取消后当前周期仍有效，配额不应归 0");
  } finally {
    db.close();
  }
});

test("hostQuota：宽限期 + 订阅仍 active → 保留原套餐台数", async () => {
  const db = new HubDb(":memory:");
  try {
    const u = db.createUser("u", "h");
    db.setPlan(u.id, "grace", now + 3 * DAY);
    db.createSubscription(u.id, "plus_monthly", now - 1 * DAY, now);
    assert.equal(await hostQuota(rt(db, { plans: PLANS }), db.getUserById(u.id)!), 2);
  } finally {
    db.close();
  }
});

test("hostQuota：宽限期 + 订阅已取消 → 仍保留原套餐台数（关键回归）", async () => {
  const db = new HubDb(":memory:");
  try {
    const u = db.createUser("u", "h");
    db.setPlan(u.id, "grace", now + 3 * DAY);
    const sub = db.createSubscription(u.id, "plus_monthly", now - 1 * DAY, now);
    db.setSubscriptionStatus(sub.id, "canceled");
    assert.equal(await hostQuota(rt(db, { plans: PLANS }), db.getUserById(u.id)!), 2, "取消后进入宽限期，原配额仍应保留");
  } finally {
    db.close();
  }
});

test("hostQuota：试用源宽限期（无任何订阅行）→ trialHosts", async () => {
  const db = new HubDb(":memory:");
  try {
    const u = db.createUser("u", "h");
    db.setPlan(u.id, "grace", now + 3 * DAY);
    assert.equal(await hostQuota(rt(db, { trialHosts: 1 }), db.getUserById(u.id)!), 1);
  } finally {
    db.close();
  }
});

test("hostQuota：trial / free / plan=null", async () => {
  const db = new HubDb(":memory:");
  try {
    const a = db.createUser("a", "h");
    db.setPlan(a.id, "trial", now + 7 * DAY);
    const b = db.createUser("b", "h");
    db.setPlan(b.id, "free", null);
    const c = db.createUser("c", "h"); // plan=null（专属账号）
    const r = rt(db, { trialHosts: 1, plans: PLANS });
    assert.equal(await hostQuota(r, db.getUserById(a.id)!), 1);
    assert.equal(await hostQuota(r, db.getUserById(b.id)!), 0);
    assert.equal(await hostQuota(r, db.getUserById(c.id)!), null, "plan=null = 不限");
  } finally {
    db.close();
  }
});
