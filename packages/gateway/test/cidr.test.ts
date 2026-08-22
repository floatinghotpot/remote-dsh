import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCidr, ipToInt, ipInCidrs } from "../src/cidr.ts";

test("parseCidr 基本", () => {
  assert.equal(parseCidr("192.168.1.0/24")?.prefix, 24);
  assert.equal(parseCidr("10.0.0.5")?.prefix, 32); // 无前缀默认 /32
  assert.equal(parseCidr("bad"), null);
  assert.equal(parseCidr("1.2.3.4/33"), null);
  assert.equal(parseCidr("1.2.3.4/-1"), null);
  assert.equal(parseCidr("256.1.1.1/24"), null);
  assert.equal(parseCidr("1.2.3"), null);
});

test("ipToInt 与 IPv4-mapped", () => {
  assert.equal(ipToInt("192.168.1.1"), 0xc0a80101);
  assert.equal(ipToInt("::ffff:192.168.1.1"), 0xc0a80101);
  assert.equal(ipToInt("::1"), null); // IPv6 不支持
});

test("ipInCidrs 命中/边界", () => {
  assert.equal(ipInCidrs("192.168.1.5", ["192.168.1.0/24"]), true);
  assert.equal(ipInCidrs("192.168.2.5", ["192.168.1.0/24"]), false);
  assert.equal(ipInCidrs("10.0.0.5", ["10.0.0.5/32"]), true);
  assert.equal(ipInCidrs("10.0.0.6", ["10.0.0.5/32"]), false);
  assert.equal(ipInCidrs("8.8.8.8", ["0.0.0.0/0"]), true); // /0 全放行
  assert.equal(ipInCidrs("1.2.3.4", ["10.0.0.0/8", "1.2.3.0/24"]), true); // 多条目
  assert.equal(ipInCidrs("5.6.7.8", ["10.0.0.0/8"]), false);
  assert.equal(ipInCidrs("::1", ["0.0.0.0/0"]), false); // IPv6 不支持 → 不放行
  assert.equal(ipInCidrs("9.9.9.9", ["not-a-cidr"]), false); // 非法条目跳过
});
