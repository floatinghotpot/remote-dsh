import { test } from "node:test";
import assert from "node:assert/strict";
import { createDirectTicketManager } from "../src/direct-ticket.ts";

test("一次性直连票：mint → 首次 consume 成功，二次 consume 失败（单次）", () => {
  const tm = createDirectTicketManager("secret");
  const ticket = tm.mint();
  assert.equal(tm.consume(ticket), true);
  assert.equal(tm.consume(ticket), false, "同一张票不得重复消费");
});

test("一次性直连票：篡改签名/负载 → 拒绝", () => {
  const tm = createDirectTicketManager("secret");
  const ticket = tm.mint();
  const [exp, nonce, sig] = ticket.split(".");
  assert.equal(tm.consume(`${exp}.${nonce}.${"A".repeat(sig.length)}`), false, "改签名应拒绝");
  assert.equal(tm.consume(`${exp}.${"B".repeat(nonce.length)}.${sig}`), false, "改 nonce 应拒绝");
  assert.equal(tm.consume(`1.2.3`), false, "结构不符应拒绝");
  assert.equal(tm.consume(""), false);
});

test("一次性直连票：TTL 过期 → 拒绝", () => {
  const tm = createDirectTicketManager("secret", 0); // exp = now，立即过期
  const ticket = tm.mint();
  assert.equal(tm.consume(ticket), false, "过期票应拒绝");
});

test("一次性直连票：不同 secret 派生不同票（改口令吊销未用票）", () => {
  const a = createDirectTicketManager("old-secret");
  const b = createDirectTicketManager("new-secret");
  const ticket = a.mint();
  assert.equal(b.consume(ticket), false, "换 secret 后旧票应失效");
});
