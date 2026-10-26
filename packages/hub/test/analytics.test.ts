/**
 * 57-retention-analytics：analytics_events 幂等 + analytics_daily 聚合正确性。
 *
 * 核心契约（见 API.md §19）：
 *  1. 同一 eventId 重试只记一次（明细幂等），日聚合不重复计数；
 *  2. 匿名事件（userId=null）不进日聚合（留存分母）；
 *  3. computeEventAnalytics 从聚合表算 DAU / 留存，付费尝试按 kind 细分。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { HubDb } from "../src/db.ts";
import { createSqliteStore } from "../src/store.ts";
import { computeEventAnalytics, computeAnalytics } from "../src/admin.ts";

function ev(userId: number | null, event: string, eventId: string, ts: number, props: Record<string, unknown> = {}): {
  event: string; userId: number | null; deviceId: string; ts: number; props: Record<string, unknown>; eventId: string;
} {
  return { event, userId, deviceId: "dev-1", ts, props, eventId };
}

test("analytics：同一 eventId 重试不重复计数（幂等）", async () => {
  const db = new HubDb(":memory:");
  const store = createSqliteStore(db);
  const u = db.createUser("alice", "hash");
  const day = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

  await store.recordAnalyticsEvent(ev(u.id, "app_open", "e-1", Date.now()));
  await store.recordAnalyticsEvent(ev(u.id, "app_open", "e-1", Date.now())); // 重试同 id
  await store.recordAnalyticsEvent(ev(u.id, "app_open", "e-2", Date.now())); // 新事件

  const daily = await store.listAnalyticsDaily(day, day);
  assert.equal(daily.length, 1, "同一 (day,user,event) 只一行");
  assert.equal(daily[0]!.count, 2, "e-1 + e-2 各计 1；重试的 e-1 不重复");
  assert.equal(daily[0]!.userId, u.id);
  assert.equal(daily[0]!.event, "app_open");
});

test("analytics：匿名事件不进日聚合（留存分母）", async () => {
  const db = new HubDb(":memory:");
  const store = createSqliteStore(db);
  const day = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

  await store.recordAnalyticsEvent(ev(null, "app_open", "e-anon", Date.now()));

  const daily = await store.listAnalyticsDaily(day, day);
  assert.equal(daily.length, 0, "匿名事件不写 analytics_daily");
});

test("analytics：computeEventAnalytics 算 DAU / 首注 / 付费尝试（按 kind）", async () => {
  const db = new HubDb(":memory:");
  const store = createSqliteStore(db);
  const u = db.createUser("bob", "hash");
  const now = Date.now();

  await store.recordAnalyticsEvent(ev(u.id, "app_open", "e-a", now));
  await store.recordAnalyticsEvent(ev(u.id, "purchase_start", "e-s", now, { kind: "subscription" }));
  await store.recordAnalyticsEvent(ev(u.id, "purchase_start", "e-c", now, { kind: "credit" }));

  const snap = await computeEventAnalytics(store);
  assert.equal(snap.dau, 1, "今日活跃用户 1 人");
  assert.equal(snap.newUsersToday, 1, "首注用户 1 人");
  assert.equal(snap.purchaseAttempts.subscription, 1, "订阅尝试 1 次");
  assert.equal(snap.purchaseAttempts.credit, 1, "充值尝试 1 次");
});

test("analytics：computeAnalytics 注册/订阅/续订/收入过滤/未来月份 null", async () => {
  const db = new HubDb(":memory:");
  const store = createSqliteStore(db);
  const now = Date.now();
  const monthMs = 30 * 86400_000;

  const u1 = db.createUser("u1", "hash"); // 2 个月前首付 + 续订（两笔订阅订单）
  const u2 = db.createUser("u2", "hash"); // 1 个月前首付（一笔订阅订单）
  const u3 = db.createUser("u3", "hash"); // 只买点数充值

  db.createSubscription(u1.id, "plus_monthly", now - 2 * monthMs, now + monthMs);
  db.createSubscription(u2.id, "pro_monthly", now - monthMs, now + monthMs);

  db.createOrder("o1", u1.id, "plus_monthly", 38);
  db.markOrderPaid("o1", "apple", null);
  db.createOrder("o2", u1.id, "plus_monthly", 38);
  db.markOrderPaid("o2", "apple", null);
  db.createOrder("o3", u2.id, "pro_monthly", 68);
  db.markOrderPaid("o3", "google", null);
  db.createOrder("o4", u3.id, "credits_5", 5);
  db.markOrderPaid("o4", "web", null);

  const snap = await computeAnalytics(store, new Set(["plus_monthly", "pro_monthly"]));

  assert.equal(snap.funnel.registered, 3, "注册 3 人");
  assert.equal(snap.funnel.subscribed, 2, "订阅 2 人（u1/u2）");
  assert.equal(snap.funnel.renewed, 1, "续订 1 人（u1 两笔订阅支付）");
  assert.equal(snap.revenue.payingUsers, 2, "付费用户 2 人（点数充值 u3 排除）");
  assert.equal(snap.revenue.totalAmount, 144, "收入 38+38+68");
  assert.equal(snap.newUsersToday, 3, "三人都是今日创建");

  // 付费留存：两个 cohort（2 个月前、1 个月前），未来月份 m3/m6 为 null
  assert.equal(snap.retention.length, 2);
  for (const r of snap.retention) {
    assert.notEqual(r.m1, null, "已满 1 个月 → m1 可测");
    assert.equal(r.m3, null, "未满 3 个月 → null");
    assert.equal(r.m6, null, "未满 6 个月 → null");
  }
});
