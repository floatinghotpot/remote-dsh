import { test } from "node:test";
import assert from "node:assert/strict";
import { PairManager } from "../src/pair.ts";

test("默认生成 6 位配对码", () => {
  const p = new PairManager();
  assert.match(p.codeValue(), /^\d{6}$/);
});

test("预置配对码生效", () => {
  const p = new PairManager("123456");
  assert.equal(p.codeValue(), "123456");
  assert.equal(p.check("123456", "1.1.1.1").ok, true);
});

test("错误码失败、正确码成功且清零", () => {
  const p = new PairManager("123456");
  assert.equal(p.check("000000", "2.2.2.2").ok, false);
  assert.equal(p.check("000000", "2.2.2.2").ok, false);
  assert.equal(p.check("123456", "2.2.2.2").ok, true); // 成功清零
  // 再失败 4 次也不会锁定（因为已清零）
  for (let i = 0; i < 4; i++) assert.equal(p.check("000000", "2.2.2.2").locked, false);
});

test("连续失败 5 次触发锁定，锁定期间拒绝", () => {
  const p = new PairManager("123456");
  for (let i = 0; i < 5; i++) p.check("000000", "3.3.3.3");
  const r = p.check("123456", "3.3.3.3"); // 即使码对也被锁
  assert.equal(r.ok, false);
  assert.equal(r.locked, true);
  assert.ok(r.retryAfterMs > 0);
  assert.ok(p.lockRemainingMs("3.3.3.3") > 0);
  // 其他 IP 不受影响
  assert.equal(p.check("123456", "4.4.4.4").ok, true);
});

test("配对码忽略首尾空白", () => {
  const p = new PairManager("123456");
  assert.equal(p.check("  123456  ", "5.5.5.5").ok, true);
});

test("非数字/超长输入不崩溃", () => {
  const p = new PairManager("123456");
  assert.equal(p.check("".padEnd(1000, "9"), "6.6.6.6").ok, false);
  assert.equal(p.check("abc", "6.6.6.6").ok, false);
});
