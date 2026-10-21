import { test } from "node:test";
import assert from "node:assert/strict";
import { percentEncode, rpcSignature } from "../src/email/aliyun.ts";

test("percentEncode：阿里云 RPC 规范（encodeURIComponent + 补齐 !\"'()*+）", () => {
  // 未保留字符 ~ 保持；! ' ( ) * 需补编码
  assert.equal(percentEncode("~!*'()"), "~%21%2A%27%28%29");
  // + 与空格
  assert.equal(percentEncode("a+b c"), "a%2Bb%20c");
  // 时间戳里的冒号
  assert.equal(percentEncode("2019-05-10T08:00:00Z"), "2019-05-10T08%3A00%3A00Z");
});

test("rpcSignature：确定性 + base64(HMAC-SHA1)", () => {
  const params = { Action: "SingleSendMail", AccessKeyId: "testid", Timestamp: "2019-05-10T08:00:00Z" };
  const s1 = rpcSignature(params, "testsecret", "POST");
  const s2 = rpcSignature({ ...params }, "testsecret", "POST");
  assert.equal(s1, s2); // 确定性
  assert.match(s1, /^[A-Za-z0-9+/=]+$/); // base64
  // 不同 secret → 不同签名
  assert.notEqual(rpcSignature(params, "other", "POST"), s1);
  // 参数顺序无关（内部排序）
  assert.equal(rpcSignature({ Timestamp: "2019-05-10T08:00:00Z", Action: "SingleSendMail", AccessKeyId: "testid" }, "testsecret", "POST"), s1);
});
