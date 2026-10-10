import { test } from "node:test";
import assert from "node:assert/strict";
import { UsageMeter, localDate } from "../src/usage.ts";

test("UsageMeter 字节计数：中转/直连 × 上行/下行分别累加", () => {
  const m = new UsageMeter();
  m.addRelayUp(10);
  m.addRelayDown(20);
  m.addDirectUp(30);
  m.addDirectDown(40);
  m.addRelayUp(5);

  const s = m.snapshot();
  assert.equal(s.relayBytesUp, 15);
  assert.equal(s.relayBytesDown, 20);
  assert.equal(s.directBytesUp, 30);
  assert.equal(s.directBytesDown, 40);
});

test("UsageMeter 会话：sessions 递增 + relaySeconds 累计非负", () => {
  const m = new UsageMeter();
  m.sessionStart();
  m.sessionEnd();
  m.sessionStart();
  m.sessionEnd();
  const s = m.snapshot();
  assert.equal(s.sessions, 2);
  assert.ok(s.relaySeconds >= 0);
});

test("UsageMeter reset 清空全部计数", () => {
  const m = new UsageMeter();
  m.addRelayUp(10);
  m.addRelayDown(20);
  m.addDirectUp(30);
  m.addDirectDown(40);
  m.sessionStart();
  m.sessionEnd();
  m.reset();
  const s = m.snapshot();
  assert.equal(s.relayBytesUp, 0);
  assert.equal(s.relayBytesDown, 0);
  assert.equal(s.directBytesUp, 0);
  assert.equal(s.directBytesDown, 0);
  assert.equal(s.relaySeconds, 0);
  assert.equal(s.sessions, 0);
});

test("localDate 返回 YYYY-MM-DD", () => {
  assert.match(localDate(new Date(2026, 9, 10)), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(localDate(new Date(2026, 9, 10)), "2026-10-10");
});
