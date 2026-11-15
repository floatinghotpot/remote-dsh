/**
 * upstream-cost.test.ts — 69：上游成本规则与落账。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { HubDb } from "../src/db.ts";
import { beijingParts, computeUpstreamCost, isAliyunBusy, isDeepseekPeak } from "../src/pricing/index.ts";

const MTOK = 1_000_000;

test("isDeepseekPeak：工作日 9–12、14–18，周末不算", () => {
  // 2026-11-16 是周一；UTC 01:00 = 北京 09:00
  assert.equal(isDeepseekPeak(new Date(Date.UTC(2026, 10, 16, 1, 0))), true); // 北京 09:00
  assert.equal(isDeepseekPeak(new Date(Date.UTC(2026, 10, 16, 3, 59))), true); // 北京 11:59
  assert.equal(isDeepseekPeak(new Date(Date.UTC(2026, 10, 16, 4, 0))), false); // 北京 12:00 边界
  assert.equal(isDeepseekPeak(new Date(Date.UTC(2026, 10, 16, 6, 0))), true); // 北京 14:00
  assert.equal(isDeepseekPeak(new Date(Date.UTC(2026, 10, 16, 9, 59))), true); // 北京 17:59
  assert.equal(isDeepseekPeak(new Date(Date.UTC(2026, 10, 16, 10, 0))), false); // 北京 18:00 边界
  assert.equal(isDeepseekPeak(new Date(Date.UTC(2026, 10, 14, 1, 0))), false); // 周六
});

test("isAliyunBusy：每天 08:00–22:00", () => {
  assert.equal(isAliyunBusy(new Date(Date.UTC(2026, 10, 16, 0, 0))), true); // 北京 08:00
  assert.equal(isAliyunBusy(new Date(Date.UTC(2026, 10, 16, 14, 0))), false); // 北京 22:00
  assert.equal(isAliyunBusy(new Date(Date.UTC(2026, 10, 16, 13, 59))), true);
});

test("computeUpstreamCost：DeepSeek 峰时/闲时 + 缓存三项", () => {
  const rates = {
    peak: { input: 2_000_000, output: 8_000_000, cacheRead: 40_000, cacheWrite: 2_000_000 },
    offPeak: { input: 1_000_000, output: 4_000_000, cacheRead: 20_000, cacheWrite: 1_000_000 },
  };
  const at = new Date(Date.UTC(2026, 10, 16, 1, 0)); // 周一 北京 09:00 = 峰
  const usage = { inputTokens: MTOK, outputTokens: MTOK, cacheReadTokens: MTOK, cacheWriteTokens: 0 };
  assert.equal(computeUpstreamCost({ provider: "deepseek", upstreamModel: "deepseek-flash", capability: "llm", usage, at, rates }), 2_000_000 + 8_000_000 + 40_000);
  const off = new Date(Date.UTC(2026, 10, 16, 16, 0)); // 北京 次日 00:00 = 闲
  assert.equal(computeUpstreamCost({ provider: "deepseek", upstreamModel: "deepseek-flash", capability: "llm", usage, at: off, rates }), 1_000_000 + 4_000_000 + 20_000);
});

test("computeUpstreamCost：语音按秒/字符", () => {
  assert.equal(computeUpstreamCost({ provider: "deepseek", upstreamModel: "ds.asr", capability: "asr", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, units: 3600 }, at: new Date(), rates: { perSecond: 216.6667 } }), 780_000);
  assert.equal(computeUpstreamCost({ provider: "volcengine", upstreamModel: "seed-tts-2.0", capability: "tts", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, units: 10_000 }, at: new Date(), rates: { perChar: 280 } }), 2_800_000);
});

test("beijingParts：UTC 转北京时间", () => {
  const { day, minute } = beijingParts(new Date(Date.UTC(2026, 10, 16, 1, 30)));
  assert.equal(day, 1); // 周一
  assert.equal(minute, 9 * 60 + 30);
});

test("seed：upstream_prices 8 条，LLM 分时价可读", () => {
  const db = new HubDb(":memory:");
  const rows = db.listUpstreamPrices();
  assert.equal(rows.length, 8);
  const flash = db.getUpstreamPrice("deepseek", "deepseek-flash");
  assert.notEqual(flash, null);
  const rates = JSON.parse(flash!.rates) as { peak: { input: number }; offPeak: { input: number } };
  assert.equal(rates.peak.input, 2_000_000);
  assert.equal(rates.offPeak.input, 1_000_000);
});

test("voice 上游用量：水位 delta + 成本累加、乱序不重复扣", () => {
  const db = new HubDb(":memory:");
  const r1 = db.upsertVoiceUpstreamUsageDaily({ provider: "volcengine", kind: "tts", service: "doubao-tts", date: "2026-11-15", cumulative: 100, perUnitMicro: 280, now: 1 });
  assert.equal(r1.delta, 100);
  assert.equal(r1.costMicro, 28_000);
  const r2 = db.upsertVoiceUpstreamUsageDaily({ provider: "volcengine", kind: "tts", service: "doubao-tts", date: "2026-11-15", cumulative: 150, perUnitMicro: 280, now: 2 });
  assert.equal(r2.delta, 50);
  assert.equal(r2.costMicro, 14_000);
  const r3 = db.upsertVoiceUpstreamUsageDaily({ provider: "volcengine", kind: "tts", service: "doubao-tts", date: "2026-11-15", cumulative: 120, perUnitMicro: 280, now: 3 });
  assert.equal(r3.delta, 0);
  assert.equal(r3.costMicro, 0);
  const rows = db.listVoiceUpstreamUsageDaily({ service: "doubao-tts" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.cumulative, 150);
  assert.equal(rows[0]!.costMicro, 42_000);
});

test("LLM 上游用量：写读回聚合", () => {
  const db = new HubDb(":memory:");
  db.upsertUpstreamUsageDaily({ provider: "deepseek", upstreamModel: "deepseek-flash", modelAlias: "deepseek-flash", date: "2026-11-15", inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 0, reasoningTokens: 0, costMicro: 100, now: 1 });
  db.upsertUpstreamUsageDaily({ provider: "deepseek", upstreamModel: "deepseek-flash", modelAlias: "deepseek-flash", date: "2026-11-15", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costMicro: 50, now: 2 });
  const rows = db.listUpstreamUsageDaily({ provider: "deepseek" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.inputTokens, 11);
  assert.equal(rows[0]!.outputTokens, 6);
  assert.equal(rows[0]!.requests, 2);
  assert.equal(rows[0]!.costMicro, 150);
});

test("settleLlmHold：LLM 结算写上游用量与成本（分时取当前窗口）", () => {
  const db = new HubDb(":memory:");
  const uid = db.createUser("cost-user", "hash").id;
  db.appendCreditLedger(uid, 1_000 * 1_000_000, "purchased", "test");
  const hold = db.reserveCreditHold(uid, 1_000_000, { scopeType: "llm", requestId: "req-cost-1", ttlMs: 600_000 });
  assert.notEqual(hold.hold, null);
  db.settleLlmHold(hold.hold!.id, 100_000, {
    keyId: "k1", agentId: "", userId: uid, modelAlias: "deepseek-flash", date: "2026-11-15",
    inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
    provider: "deepseek", upstreamModel: "deepseek-flash",
  });
  const rows = db.listUpstreamUsageDaily({ provider: "deepseek" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.inputTokens, 1_000_000);
  assert.equal(rows[0]!.outputTokens, 1_000_000);
  // 峰时 2M+8M，闲时 1M+4M（按结算时刻所在窗口）。
  assert.ok(rows[0]!.costMicro === 10_000_000 || rows[0]!.costMicro === 5_000_000, `costMicro=${rows[0]!.costMicro}`);
  const usage = db.listLlmUsageDaily({ userId: uid });
  assert.equal(usage.length, 1);
});

test("settleLlmHold：provider/upstream 缺失时不写上游成本（旧 Router 兼容）", () => {
  const db = new HubDb(":memory:");
  const uid = db.createUser("cost-user2", "hash").id;
  db.appendCreditLedger(uid, 1_000 * 1_000_000, "purchased", "test");
  const hold = db.reserveCreditHold(uid, 1_000_000, { scopeType: "llm", requestId: "req-cost-2", ttlMs: 600_000 });
  db.settleLlmHold(hold.hold!.id, 100_000, {
    keyId: "k1", agentId: "", userId: uid, modelAlias: "deepseek-flash", date: "2026-11-15",
    inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
  });
  assert.equal(db.listUpstreamUsageDaily({}).length, 0);
});

test("settleLlmHold：欠费未结(insufficient)也记上游成本，且重试不重复记", () => {
  const db = new HubDb(":memory:");
  const uid = db.createUser("cost-insufficient", "hash").id;
  db.appendCreditLedger(uid, 2_000_000, "purchased", "test"); // 2 元
  const hold = db.reserveCreditHold(uid, 1_000_000, { scopeType: "llm", requestId: "req-insuf-1", ttlMs: 600_000 });
  const usage = {
    keyId: "k1", agentId: "", userId: uid, modelAlias: "deepseek-flash", date: "2026-11-15",
    inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
    provider: "deepseek", upstreamModel: "deepseek-flash",
  };
  // 结算 5 元 > 余额 2 元 → insufficient
  const s1 = db.settleLlmHold(hold.hold!.id, 5_000_000, usage);
  assert.equal(s1.status, "insufficient");
  assert.equal(db.listUpstreamUsageDaily({ provider: "deepseek" }).length, 1);
  // 重试（Router 重放）→ 不重复记
  const s2 = db.settleLlmHold(hold.hold!.id, 5_000_000, usage);
  assert.equal(s2.status, "insufficient");
  assert.equal(db.listUpstreamUsageDaily({ provider: "deepseek" }).length, 1);
});
