/**
 * wechat-app-login.test.ts — App 微信登录（feature 27）配置 + DB + 跨应用身份（离线验证）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { HubDb } from "../src/db.ts";
import { normalizeHubConfig } from "../src/config.ts";

function baseConfig() {
  return { host: "0.0.0.0", port: 8443, dbPath: ":memory:", jwtKeyPath: "/tmp/x.key", behindProxy: false };
}

test("config：normalizeWechatAppLogin 校验（移动应用凭据）", () => {
  const ok = normalizeHubConfig({ ...baseConfig(), wechatAppLogin: { appid: "wxapp", appSecret: "s" } });
  assert.equal(ok.wechatAppLogin?.appid, "wxapp");
  assert.equal(ok.wechatAppLogin?.appSecret, "s");
  assert.throws(() => normalizeHubConfig({ ...baseConfig(), wechatAppLogin: { appid: "", appSecret: "s" } }));
  assert.throws(() => normalizeHubConfig({ ...baseConfig(), wechatAppLogin: { appid: "wxapp" } }));
});

test("config：normalizeAppSchemes 校验（scheme 白名单）", () => {
  assert.deepEqual(normalizeHubConfig({ ...baseConfig(), appSchemes: ["rdshapp"] }).appSchemes, ["rdshapp"]);
  // 去掉 `://` 后缀
  assert.deepEqual(normalizeHubConfig({ ...baseConfig(), appSchemes: ["rdshapp://x"] }).appSchemes, ["rdshapp"]);
  assert.equal(normalizeHubConfig({ ...baseConfig() }).appSchemes, undefined);
  assert.throws(() => normalizeHubConfig({ ...baseConfig(), appSchemes: "rdshapp" }));
  assert.throws(() => normalizeHubConfig({ ...baseConfig(), appSchemes: ["1bad"] }));
});

test("db：wxapp_openid 独立列（移动应用 openid 与网站应用 openid 分开）", () => {
  const db = new HubDb(":memory:");
  const u = db.createWechatAppUser("wx_app", "appOpenid1", "unionid1", "nick", "http://a");
  assert.equal(u.wxappOpenid, "appOpenid1");
  assert.equal(u.wxwebOpenid, null);
  assert.equal(u.wechatUnionid, "unionid1");
  assert.equal(db.getUserByWxappOpenid("appOpenid1")?.id, u.id);
  assert.equal(db.getUserByWxwebOpenid("appOpenid1"), null); // 不混存
  assert.throws(() => db.createWechatAppUser("wx_app2", "appOpenid1", "unionid2", null, null));
  db.close();
});

test("db：unionid 跨应用同一人（门户 wxweb + App wxapp 命中同一 unionid）", () => {
  const db = new HubDb(":memory:");
  const portalUser = db.createWechatUser("wx_web", "webOpenid1", "unionid1", "nick", "http://a");
  // App 用 unionid 找到同一账号 → 补绑 App openid
  assert.equal(db.getUserByWechatUnionid("unionid1")?.id, portalUser.id);
  db.bindWechatApp(portalUser.id, "appOpenid1", "unionid1", "nick", "http://a");
  const after = db.getUserById(portalUser.id);
  assert.equal(after?.wxappOpenid, "appOpenid1");
  assert.equal(after?.wechatUnionid, "unionid1");
  // 两个 openid 指向同一账号
  assert.equal(db.getUserByWxwebOpenid("webOpenid1")?.id, portalUser.id);
  assert.equal(db.getUserByWxappOpenid("appOpenid1")?.id, portalUser.id);
  db.close();
});

test("db：删除账号墓碑化清 wxapp_openid（释放唯一索引）", () => {
  const db = new HubDb(":memory:");
  const u = db.createWechatAppUser("wx_app", "appOpenid1", "unionid1", null, null);
  db.deleteAccount(u.id);
  const after = db.getUserById(u.id);
  assert.equal(after?.wxappOpenid, null);
  db.close();
});
