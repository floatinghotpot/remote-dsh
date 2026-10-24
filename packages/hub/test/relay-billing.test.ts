/**
 * relay-billing.test.ts — 31-relay-billing：中转流量增量扣减 + 消耗查询 + 兜底 flush 扣减。
 *
 * 覆盖：累计值→增量扣减、幂等（重复/重放）、多桶顺序、向下取整、透支、流水可追溯、
 * 消耗聚合、UsageAccumulator.flush 兜底扣减。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { HubDb, RELAY_BYTES_PER_CREDIT, relayBytesToMicro, isRelayFreeUser, relayFreePolicy } from "../src/db.ts";
import { createSqliteStore } from "../src/store.ts";
import { CREDITS_MICRO_PER_CREDIT } from "../src/credits.ts";
import { UsageAccumulator } from "../src/relay-usage.ts";

function makeDb(): HubDb {
  return new HubDb(":memory:");
}

function makeUser(db: HubDb, name: string): number {
  const uid = db.createUser(name, "hash").id;
  // 付费档（非试用/非专属 plan_status=NULL），确保走正常计费；免计费用例再显式传 isFree。
  db.setPlan(uid, "subscribed", null);
  return uid;
}

function credit(db: HubDb, userId: number, bucket: string, credits: number): void {
  db.appendCreditLedger(userId, credits * CREDITS_MICRO_PER_CREDIT, bucket, "test");
}

test("chargeRelayBytes：累计值 → 增量扣减 + 重复/递增快照幂等", async () => {
  const db = makeDb();
  const uid = makeUser(db, "alice");
  credit(db, uid, "purchased", 100);
  const store = createSqliteStore(db);

  const r1 = await store.chargeRelayBytes(uid, "h1", "inst1", "2026-10-24", RELAY_BYTES_PER_CREDIT, 0);
  assert.equal(r1.chargedMicro, CREDITS_MICRO_PER_CREDIT);
  assert.equal((await store.getCreditBalances(uid)).purchased, 99 * CREDITS_MICRO_PER_CREDIT);

  // 同一累计快照（重复上报）→ 不重复扣
  const r2 = await store.chargeRelayBytes(uid, "h1", "inst1", "2026-10-24", RELAY_BYTES_PER_CREDIT, 0);
  assert.equal(r2.chargedMicro, 0);
  assert.equal((await store.getCreditBalances(uid)).purchased, 99 * CREDITS_MICRO_PER_CREDIT);

  // 更高累计值 → 只扣增量
  const r3 = await store.chargeRelayBytes(uid, "h1", "inst1", "2026-10-24", RELAY_BYTES_PER_CREDIT * 2, 0);
  assert.equal(r3.chargedMicro, CREDITS_MICRO_PER_CREDIT);
  assert.equal((await store.getCreditBalances(uid)).purchased, 98 * CREDITS_MICRO_PER_CREDIT);
});

test("chargeRelayBytes：小流量向下取整（5 MB → 16666 微单位）", async () => {
  const db = makeDb();
  const uid = makeUser(db, "alice");
  credit(db, uid, "purchased", 100);
  const store = createSqliteStore(db);

  const r = await store.chargeRelayBytes(uid, "h1", "inst1", "d", 5 * 1024 * 1024, 0);
  assert.equal(relayBytesToMicro(5 * 1024 * 1024), 16666);
  assert.equal(r.chargedMicro, 16666);
});

test("chargeRelayBytes：自定义费率 bytesPerCredit 生效（1 点 = 1 MB）", async () => {
  const db = makeDb();
  const uid = makeUser(db, "alice");
  credit(db, uid, "purchased", 100);
  const store = createSqliteStore(db);

  // 覆盖默认 3 MB/点：1 点 = 1 MB → 1 MB 流量扣 1 点（10000 微单位）
  const bytesPerCredit = 1 * 1024 * 1024;
  const r = await store.chargeRelayBytes(uid, "h1", "inst1", "d", bytesPerCredit, 0, bytesPerCredit);
  assert.equal(r.chargedMicro, CREDITS_MICRO_PER_CREDIT);
  assert.equal((await store.getCreditBalances(uid)).purchased, 99 * CREDITS_MICRO_PER_CREDIT);
});

test("chargeRelayBytes：多桶扣减顺序 bonus_carried → bonus_current → purchased", async () => {
  const db = makeDb();
  const uid = makeUser(db, "alice");
  credit(db, uid, "bonus_carried", 1);
  credit(db, uid, "bonus_current", 1);
  credit(db, uid, "purchased", 1);
  const store = createSqliteStore(db);

  const r = await store.chargeRelayBytes(uid, "h1", "inst1", "d", RELAY_BYTES_PER_CREDIT * 2, 0);
  assert.equal(r.chargedMicro, 2 * CREDITS_MICRO_PER_CREDIT);
  const b = await store.getCreditBalances(uid);
  assert.equal(b.bonusCarried, 0);
  assert.equal(b.bonusCurrent, 0);
  assert.equal(b.purchased, CREDITS_MICRO_PER_CREDIT);
});

test("chargeRelayBytes：allowOverdraft 允许透支到负余额（下限由闸门层强制）", async () => {
  const db = makeDb();
  const uid = makeUser(db, "alice");
  credit(db, uid, "purchased", 1);
  const store = createSqliteStore(db);

  const r = await store.chargeRelayBytes(uid, "h1", "inst1", "d", RELAY_BYTES_PER_CREDIT * 3, 0);
  assert.equal(r.chargedMicro, 3 * CREDITS_MICRO_PER_CREDIT);
  assert.equal((await store.getCreditBalances(uid)).purchased, -2 * CREDITS_MICRO_PER_CREDIT);
});

test("chargeRelayBytes：consume_relay 流水可追溯（sourceType/sourceId）", async () => {
  const db = makeDb();
  const uid = makeUser(db, "alice");
  credit(db, uid, "purchased", 100);
  const store = createSqliteStore(db);

  await store.chargeRelayBytes(uid, "h1", "inst1", "2026-10-24", RELAY_BYTES_PER_CREDIT, 0);
  const consume = (await store.listCreditLedger(uid)).filter((l) => l.reason === "consume_relay");
  assert.equal(consume.length, 1);
  assert.equal(consume[0]!.sourceType, "relay");
  assert.equal(consume[0]!.sourceId, "2026-10-24:inst1");
  assert.equal(consume[0]!.delta, -CREDITS_MICRO_PER_CREDIT);
});

test("listRelayConsumption：累计 + 按日序列", async () => {
  const db = makeDb();
  const uid = makeUser(db, "alice");
  credit(db, uid, "purchased", 100);
  const store = createSqliteStore(db);

  await store.chargeRelayBytes(uid, "h1", "inst1", "2026-10-24", RELAY_BYTES_PER_CREDIT, 0);
  await store.chargeRelayBytes(uid, "h1", "inst1", "2026-10-25", RELAY_BYTES_PER_CREDIT * 2, 0);

  const c = await store.listRelayConsumption(uid, "2026-10-24", "2026-10-25");
  assert.equal(c.totalMicro, 3 * CREDITS_MICRO_PER_CREDIT);
  assert.deepEqual(c.days.map((d) => d.date), ["2026-10-24", "2026-10-25"]);
  assert.deepEqual(c.days.map((d) => d.micro), [CREDITS_MICRO_PER_CREDIT, 2 * CREDITS_MICRO_PER_CREDIT]);
});

test("UsageAccumulator.flush：hub 内置 relay 兜底按增量扣减，不重复扣", async () => {
  const db = makeDb();
  const uid = makeUser(db, "alice");
  credit(db, uid, "purchased", 100);
  const store = createSqliteStore(db);
  const acc = new UsageAccumulator(store);

  acc.addRelayBytes(uid, "h1", RELAY_BYTES_PER_CREDIT, 0);
  await acc.flush();
  assert.equal((await store.getCreditBalances(uid)).purchased, 99 * CREDITS_MICRO_PER_CREDIT);

  // 无新数据再 flush 不重复扣
  await acc.flush();
  assert.equal((await store.getCreditBalances(uid)).purchased, 99 * CREDITS_MICRO_PER_CREDIT);

  // 新增流量（累计 +3MB）→ 只扣增量
  acc.addRelayBytes(uid, "h1", RELAY_BYTES_PER_CREDIT, 0);
  await acc.flush();
  assert.equal((await store.getCreditBalances(uid)).purchased, 98 * CREDITS_MICRO_PER_CREDIT);
});

test("chargeRelayBytes：改费率（更贵）不追溯重扣历史（水位存字节）", async () => {
  const db = makeDb();
  const uid = makeUser(db, "alice");
  credit(db, uid, "purchased", 100);
  const store = createSqliteStore(db);

  // 老费率 3MB/点：消费 3MB 扣 1 点
  await store.chargeRelayBytes(uid, "h1", "inst1", "d", RELAY_BYTES_PER_CREDIT, 0, RELAY_BYTES_PER_CREDIT, false);
  assert.equal((await store.getCreditBalances(uid)).purchased, 99 * CREDITS_MICRO_PER_CREDIT);

  // 费率改成 2MB/点（更贵），同一累计值（3MB）再上报 → delta=0，不追溯重扣
  const r = await store.chargeRelayBytes(uid, "h1", "inst1", "d", RELAY_BYTES_PER_CREDIT, 0, 2 * 1024 * 1024, false);
  assert.equal(r.chargedMicro, 0);
  assert.equal((await store.getCreditBalances(uid)).purchased, 99 * CREDITS_MICRO_PER_CREDIT);
});

test("chargeRelayBytes：扣减钳制到欠费下限（不越过 -100 点）", async () => {
  const db = makeDb();
  const uid = makeUser(db, "alice");
  credit(db, uid, "purchased", 1); // 1 点 = 10000 微单位
  const store = createSqliteStore(db);

  // 消费 2 点（6MB）→ 全部可扣，余额 -1 点
  const r1 = await store.chargeRelayBytes(uid, "h1", "inst1", "d", RELAY_BYTES_PER_CREDIT * 2, 0);
  assert.equal(r1.chargedMicro, 2 * CREDITS_MICRO_PER_CREDIT);
  assert.equal((await store.getCreditBalances(uid)).total, -1 * CREDITS_MICRO_PER_CREDIT);

  // 再消费 100 点（累计 102MB），但余额 -1 点 + 可透支到 -100 点 = 还能扣 99 点 → 钳制
  const r2 = await store.chargeRelayBytes(uid, "h1", "inst1", "d", RELAY_BYTES_PER_CREDIT * 102, 0);
  assert.equal(r2.chargedMicro, 99 * CREDITS_MICRO_PER_CREDIT);
  assert.equal((await store.getCreditBalances(uid)).total, -100 * CREDITS_MICRO_PER_CREDIT);

  // 已到底（-100 点）→ 再消费扣 0，不再往下透支
  const r3 = await store.chargeRelayBytes(uid, "h1", "inst1", "d", RELAY_BYTES_PER_CREDIT * 200, 0);
  assert.equal(r3.chargedMicro, 0);
  assert.equal((await store.getCreditBalances(uid)).total, -100 * CREDITS_MICRO_PER_CREDIT);
});

test("chargeRelayBytes：免计费（isFree）不扣点但水位推进，到期后不追溯扣费", async () => {
  const db = makeDb();
  const uid = makeUser(db, "alice");
  credit(db, uid, "purchased", 100);
  const store = createSqliteStore(db);

  // 免费期：3 MB 不扣点
  const r1 = await store.chargeRelayBytes(uid, "h1", "inst1", "d", RELAY_BYTES_PER_CREDIT, 0, RELAY_BYTES_PER_CREDIT, true);
  assert.equal(r1.chargedMicro, 0);
  assert.equal((await store.getCreditBalances(uid)).purchased, 100 * CREDITS_MICRO_PER_CREDIT);

  // 免费期结束（isFree=false）：同累计值不补扣免费期流量（水位已推进）
  const r2 = await store.chargeRelayBytes(uid, "h1", "inst1", "d", RELAY_BYTES_PER_CREDIT, 0, RELAY_BYTES_PER_CREDIT, false);
  assert.equal(r2.chargedMicro, 0);

  // 新增流量（累计 2×3MB）→ 只扣免费期之后的增量
  const r3 = await store.chargeRelayBytes(uid, "h1", "inst1", "d", RELAY_BYTES_PER_CREDIT * 2, 0, RELAY_BYTES_PER_CREDIT, false);
  assert.equal(r3.chargedMicro, CREDITS_MICRO_PER_CREDIT);
  assert.equal((await store.getCreditBalances(uid)).purchased, 99 * CREDITS_MICRO_PER_CREDIT);
});

test("isRelayFreeUser：试用/专属（plan_status=null）判定 + 配置开关", () => {
  const on = { trialFree: true, internalFree: true };
  const off = { trialFree: false, internalFree: false };
  assert.equal(isRelayFreeUser({ planStatus: "trial" }, on), true);
  assert.equal(isRelayFreeUser({ planStatus: null }, on), true); // 专属账号
  assert.equal(isRelayFreeUser({ planStatus: "subscribed" }, on), false);
  assert.equal(isRelayFreeUser({ planStatus: "free" }, on), false);
  assert.equal(isRelayFreeUser({ planStatus: "trial" }, off), false); // 关掉试用免费
  assert.equal(isRelayFreeUser({ planStatus: null }, off), false); // 关掉专属免费
});

test("isRelayFreeUser：试用到期防御（不依赖 sweep，读当前到期时间）", () => {
  const on = { trialFree: true, internalFree: true };
  const now = 1_800_000_000_000; // 固定时间
  // 未到期 → 免费
  assert.equal(isRelayFreeUser({ planStatus: "trial", planExpiresAt: now + 1000 }, on, now), true);
  // 已到期 → 立即不再免费（计费），不等 sweepBilling
  assert.equal(isRelayFreeUser({ planStatus: "trial", planExpiresAt: now - 1000 }, on, now), false);
  // 无到期 = 管理员授的永久试用 → 免费
  assert.equal(isRelayFreeUser({ planStatus: "trial", planExpiresAt: null }, on, now), true);
  assert.equal(isRelayFreeUser({ planStatus: "trial" }, on, now), true); // 缺字段同样视为永久试用
  // 关掉试用免费开关时，即使未到期也不免费
  assert.equal(isRelayFreeUser({ planStatus: "trial", planExpiresAt: now + 1000 }, { trialFree: false, internalFree: false }, now), false);
});

test("relayFreePolicy：缺省回退默认（试用/专属均免费）", () => {
  assert.deepEqual(relayFreePolicy(undefined), { trialFree: true, internalFree: true });
  assert.deepEqual(relayFreePolicy({ relay: { trialFree: false } }), { trialFree: false, internalFree: true });
  assert.deepEqual(relayFreePolicy({ relay: { internalFree: false } }), { trialFree: true, internalFree: false });
});
