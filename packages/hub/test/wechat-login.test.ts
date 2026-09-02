/**
 * wechat-login.test.ts — 微信登录（网站应用 OAuth）纯函数 + DB + 配置（离线验证）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { exchangeWechatLoginCode, wechatLoginUrl } from "../src/wechat-login.ts";
import { HubDb } from "../src/db.ts";
import { normalizeHubConfig } from "../src/config.ts";

/** 按调用顺序返回响应体的 mock fetch（只实现 json()）。 */
function mockFetch(bodies: Array<Record<string, unknown>>): typeof fetch {
  let i = 0;
  return (async () => ({ json: async () => bodies[i++] ?? {} })) as unknown as typeof fetch;
}

test("wechatLoginUrl：qrconnect + snsapi_login + redirect_uri + state", () => {
  const url = wechatLoginUrl("app1", "https://rdsh.cn/api/wechat/login/callback", "st_abc");
  assert.ok(url.startsWith("https://open.weixin.qq.com/connect/qrconnect?appid=app1"));
  assert.ok(url.includes("scope=snsapi_login"));
  assert.ok(url.includes(encodeURIComponent("https://rdsh.cn/api/wechat/login/callback")));
  assert.ok(url.includes(encodeURIComponent("st_abc")));
});

test("exchangeWechatLoginCode：成功返回 openid/unionid/nickname/avatar", async () => {
  const fetchImpl = mockFetch([
    { access_token: "AT", openid: "o1", unionid: "u1" },
    { nickname: "小明", headimgurl: "http://img/x.png" },
  ]);
  const id = await exchangeWechatLoginCode("app", "secret", "code", fetchImpl);
  assert.deepEqual(id, { openid: "o1", unionid: "u1", nickname: "小明", avatar: "http://img/x.png" });
});

test("exchangeWechatLoginCode：errcode 返回 null", async () => {
  const fetchImpl = mockFetch([{ errcode: 40029 }]);
  assert.equal(await exchangeWechatLoginCode("app", "secret", "code", fetchImpl), null);
});

test("exchangeWechatLoginCode：无 unionid + userinfo 失败不阻塞登录", async () => {
  const fetchImpl = mockFetch([{ access_token: "AT", openid: "o1" }, { errcode: 1 }]);
  const id = await exchangeWechatLoginCode("app", "secret", "code", fetchImpl);
  assert.deepEqual(id, { openid: "o1", unionid: null, nickname: null, avatar: null });
});

test("db：createWechatUser / getUserByWxwebOpenid / getUserByWechatUnionid / bindWechat", () => {
  const db = new HubDb(":memory:");
  const u = db.createWechatUser("wx_u1", "openid1", "unionid1", "nick", "http://a");
  assert.equal(u.accountStatus, "active");
  assert.equal(u.wxwebOpenid, "openid1");
  assert.equal(u.wechatUnionid, "unionid1");
  assert.equal(u.wechatNickname, "nick");
  assert.equal(db.getUserByWxwebOpenid("openid1")?.id, u.id);
  assert.equal(db.getUserByWechatUnionid("unionid1")?.id, u.id);
  // openid 唯一索引：重复 openid 建号报错
  assert.throws(() => db.createWechatUser("wx_u2", "openid1", "unionid2", null, null));
  // bindWechat：普通账号补绑微信身份
  const other = db.createUser("plain@x.com", "scrypt:1:1:1:a:b");
  db.bindWechat(other.id, "openid2", null, "nick2", null);
  assert.equal(db.getUserByWxwebOpenid("openid2")?.id, other.id);
  assert.equal(db.getUserByWxwebOpenid("openid2")?.wechatUnionid, null);
  db.close();
});

test("config：wechatLogin 校验（appid/appSecret/redirectUri 必填 + URL 合法）", () => {
  const ok = { appid: "a", appSecret: "s", redirectUri: "https://rdsh.cn/api/wechat/login/callback" };
  assert.deepEqual(normalizeHubConfig({ wechatLogin: ok }).wechatLogin, ok);
  assert.throws(() => normalizeHubConfig({ wechatLogin: { appid: "a", appSecret: "s" } }), /wechatLogin.redirectUri/);
  assert.throws(() => normalizeHubConfig({ wechatLogin: { appid: "a", appSecret: "s", redirectUri: "not-a-url" } }), /redirectUri/);
  assert.equal(normalizeHubConfig({}).wechatLogin, undefined);
});
