import { test } from "node:test";
import assert from "node:assert/strict";
import { getWechatOpenid } from "../src/billing/wechat-oauth.ts";

const fetchLike = (body: unknown): typeof fetch =>
  (async () => ({ json: async () => body })) as unknown as typeof fetch;

test("getWechatOpenid：code 换 openid（注入 fetch）", async () => {
  assert.equal(await getWechatOpenid("wx123", "s3", "c1", fetchLike({ openid: "o-abc" })), "o-abc");
  assert.equal(await getWechatOpenid("wx123", "s3", "bad", fetchLike({ errcode: 40029 })), null);
  assert.equal(await getWechatOpenid("wx123", "s3", "bad", fetchLike({ openid: "" })), null);
});
