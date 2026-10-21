/**
 * unicpay.test.ts — feature 121 hub 侧契约修复（H1–H6）行为测试。
 *
 * 覆盖：身份 users.id（H1）、换档 plan_id（H2）、时间戳新鲜度（H3）、金额比对（H4）、
 * 未知单/用户 ack 化（H5）、去 environment（H6a）、乱序单调守卫（H6b）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
import { HubDb } from "../src/db.ts";
import { HubAuth, hashPassword } from "../src/auth.ts";
import { createSqliteStore } from "../src/store.ts";
import { Jwt } from "../src/jwt.ts";
import { TunnelRegistry } from "../src/tunnel.ts";
import { EventHub } from "../src/events.ts";
import { startHubServer } from "../src/server.ts";
import type { RunningHub } from "../src/server.ts";
import type { HubRuntime } from "../src/api.ts";
import { normalizeHubConfig } from "../src/config.ts";
import type { HubConfig } from "../src/config.ts";
import { CREDITS_MICRO_PER_CREDIT } from "../src/credits.ts";

let server: RunningHub | null = null;
let base = "";
let db: HubDb;
let runtime: HubRuntime;
let auth: HubAuth;
let config: HubConfig;

const webhookSecret = "wh-secret-0123456789abcdef";

/** 原始形状的夹具（与 hub.json 一致）；`start()` 里经 normalizeHubConfig 归一化 —— 
 *  生产走 loadHubConfig()，同样会归一化，测试必须对齐否则 `credits` 等派生字段为 undefined。 */
const rawConfig = {
  host: "127.0.0.1",
  port: 0,
  dbPath: ":memory:",
  jwtKeyPath: "",
  behindProxy: false,
  email: { provider: "log", from: "noreply@test.local" },
  sms: { provider: "log" },
  captcha: { provider: "none" },
  registration: "open",
  billing: {
    plans: [
      { id: "plus_monthly", name: "Plus", hosts: 5, priceCny: 30, intervalMonths: 1 },
      { id: "pro_monthly", name: "Pro", hosts: 10, priceCny: 50, intervalMonths: 1 },
    ],
    // 点数档位改由配置提供（原先硬编码在 credits.ts）→ 测试配置里必须给全 6 档。
    credits: [
      { id: "credits_1_usd", package: { credits: 800 }, priceCny: 8, priceUsd: 0.99 },
      { id: "credits_5_usd", package: { credits: 5000 }, priceCny: 38, priceUsd: 4.99 },
      { id: "credits_10_usd", package: { credits: 12000 }, priceCny: 68, priceUsd: 9.99 },
      { id: "credits_20_usd", package: { credits: 25000 }, priceCny: 138, priceUsd: 19.99 },
      { id: "credits_50_usd", package: { credits: 65000 }, priceCny: 348, priceUsd: 49.99 },
      { id: "credits_100_usd", package: { credits: 140000 }, priceCny: 698, priceUsd: 99.99 },
    ],
    unicpay: { appId: "rdsh", baseUrl: "http://127.0.0.1:0", authSecret: "auth-secret-0123456789", webhookSecret },
  },
};

/** 模拟 unicpay 平台 store/verify：捕获转发体并返回 canned 响应。 */
let capturedVerify: { body: Record<string, unknown>; authorization: string } | null = null;
/** A 类下单（initiate）转发给平台的请求体（用于断言 orderType/goodsId）。 */
let capturedInitiate: Record<string, unknown> | null = null;
/** A 类 prepay 转发给平台的请求体（用于断言 openid/clientIp，feature 36）。 */
let capturedPrepay: Record<string, unknown> | null = null;
let mockServer: http.Server | null = null;
/** /v1/pay/order 的 canned 状态（各测试自行设置）。 */
let mockOrderStatus = "pending";
let mockOrderAmount = 800;
let initCounter = 0;
/** store/verify 的 canned 响应（null = 用默认订阅体）；配合 mockVerifyStatus 模拟上游成败。 */
let mockVerifyStatus = 200;
let mockVerifyBody: Record<string, unknown> | null = null;

function startMock(): Promise<string> {
  mockServer = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      if (req.url === "/v1/pay/initiate" && req.method === "POST") {
        capturedInitiate = data === "" ? {} : (JSON.parse(data) as Record<string, unknown>);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ticket: "tkt-test", paymentId: "pay-" + ++initCounter }));
      } else if (req.url !== undefined && req.url.startsWith("/v1/pay/order?") && req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: mockOrderStatus, amount: mockOrderAmount, goodsId: "credits_1_usd", orderType: "payment", channelOrderNo: "ch-test" }));
      } else if (req.url === "/v1/pay/prepay" && req.method === "POST") {
        capturedPrepay = data === "" ? {} : (JSON.parse(data) as Record<string, unknown>);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ nativeUrl: "weixin://pay/test" }));
      } else if (req.url === "/v1/pay/store/verify" && req.method === "POST") {
        capturedVerify = {
          body: data === "" ? {} : (JSON.parse(data) as Record<string, unknown>),
          authorization: typeof req.headers.authorization === "string" ? req.headers.authorization : "",
        };
        const vbody = mockVerifyBody ?? { goodsId: "plus_monthly", orderType: "subscription", purchase: "purchased" };
        res.writeHead(mockVerifyStatus, { "content-type": "application/json" });
        res.end(JSON.stringify(vbody));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });
  return new Promise((resolve) => {
    mockServer!.listen(0, "127.0.0.1", () => {
      const a = mockServer!.address();
      resolve(`http://127.0.0.1:${typeof a === "object" && a !== null ? a.port : 0}`);
    });
  });
}

async function start(): Promise<void> {
  db = new HubDb(":memory:");
  auth = new HubAuth(createSqliteStore(db), (id) => db.getUserById(id), new Jwt(Buffer.from("test-key-0123456789abcdef")));
  const tunnels = new TunnelRegistry();
  const events = new EventHub();
  config = normalizeHubConfig(rawConfig);
  runtime = { config, db, store: createSqliteStore(db), auth, tunnels, events };
  const mockUrl = await startMock();
  config.billing!.unicpay!.baseUrl = mockUrl;
  server = await startHubServer({
    host: "127.0.0.1",
    port: 0,
    db,
    auth,
    tunnels,
    events,
    portalDir: "/nonexistent-portal",
    email: config.email,
    sms: config.sms,
    captcha: config.captcha,
    registration: config.registration,
    billing: config.billing,
  });
  base = `http://127.0.0.1:${server.actualPort}`;
}

async function stop(): Promise<void> {
  if (server !== null) {
    await new Promise<void>((r) => server!.server.close(() => r()));
    db.close();
    server = null;
  }
  if (mockServer !== null) {
    await new Promise<void>((r) => mockServer!.close(() => r()));
    mockServer = null;
  }
}

/** 按 unicpay 03-webhook 契约构造签名：canonical = `<ts>.<nonce>.<rawBody>`。 */
function sign(body: string, ts: number, nonce: string): string {
  return createHmac("sha256", webhookSecret).update(`${ts}.${nonce}.${body}`).digest("hex");
}

async function postWebhook(
  payload: unknown,
  opts: { tsSeconds?: number; nonce?: string; secret?: string } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const tsSeconds = opts.tsSeconds ?? Math.floor(Date.now() / 1000);
  const nonce = opts.nonce ?? "0123456789abcdef";
  const body = JSON.stringify(payload);
  const res = await fetch(base + "/api/billing/unicpay/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-webhook-timestamp": String(tsSeconds),
      "x-webhook-nonce": nonce,
      "x-webhook-signature": sign(body, tsSeconds, nonce),
    },
    body,
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

function subEvent(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    eventId: "evt-0000000000000000",
    eventType: "subscription.renewed",
    appId: "rdsh",
    userId: "",
    goodsId: "plus_monthly",
    subscriptionId: "sub-1",
    store: "apple",
    status: "active",
    expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    willRenew: true,
    ...overrides,
  };
}

test("GET /api/credits/tiers：公开返回 6 档（portal 不再写死）", async () => {
  const res = await fetch(base + "/api/credits/tiers");
  assert.equal(res.status, 200);
  const json = (await res.json()) as { tiers: Array<{ id: string; credits: number; priceCny: number; priceUsd?: number }> };
  assert.equal(json.tiers.length, 6);
  assert.deepEqual(json.tiers[0], { id: "credits_1_usd", credits: 800, priceCny: 8, priceUsd: 0.99 });
  assert.equal(json.tiers[5].id, "credits_100_usd");
  assert.equal(json.tiers[5].credits, 140000);
});

test("A 类下单代理：**点数档位**也认（真机发现 unknown goodsId 回归）", async () => {
  const user = db.createUser("wh-recharge", await hashPassword("pw123456"));
  const token = (await auth.issueTokens(user)).accessToken;
  capturedInitiate = null;
  const res = await fetch(base + "/api/billing/unicpay/initiate", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ goodsId: "credits_1_usd", scene: "app" }),
  });
  assert.equal(res.status, 200);
  const json = (await res.json()) as Record<string, unknown>;
  assert.deepEqual(json.payParams, { nativeUrl: "weixin://pay/test" });
  // 转发给平台的是**一次性 payment**（不是 subscription），goodsId 就是点数档位
  assert.equal(capturedInitiate?.goodsId, "credits_1_usd");
  assert.equal(capturedInitiate?.orderType, "payment");
});

test("A 类下单代理：订阅仍走 subscription（不回归）", async () => {
  const user = db.createUser("wh-sub-init", await hashPassword("pw123456"));
  const token = (await auth.issueTokens(user)).accessToken;
  capturedInitiate = null;
  const res = await fetch(base + "/api/billing/unicpay/initiate", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ goodsId: "plus_monthly", scene: "app" }),
  });
  assert.equal(res.status, 200);
  assert.equal(capturedInitiate?.goodsId, "plus_monthly");
  assert.equal(capturedInitiate?.orderType, "subscription");
});

test("A 类下单 h5：prepay 载荷含 clientIp 且不含 openid（R4）", async () => {
  const user = db.createUser("wh-h5", await hashPassword("pw123456"));
  const token = (await auth.issueTokens(user)).accessToken;
  capturedPrepay = null;
  const res = await fetch(base + "/api/billing/unicpay/initiate", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ goodsId: "plus_monthly", scene: "h5" }),
  });
  assert.equal(res.status, 200);
  assert.equal(typeof capturedPrepay?.clientIp, "string");
  assert.ok((capturedPrepay?.clientIp as string).length > 0);
  assert.ok(!("openid" in (capturedPrepay ?? {})));
});

test("A 类下单 jsapi：prepay 载荷含 openid（R3）", async () => {
  const user = db.createUser("wh-jsapi", await hashPassword("pw123456"));
  const token = (await auth.issueTokens(user)).accessToken;
  const openidToken = auth.issueOpenidToken(user.id, "o-test");
  capturedPrepay = null;
  const res = await fetch(base + "/api/billing/unicpay/initiate", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, cookie: `rdsh_openid=${openidToken}` },
    body: JSON.stringify({ goodsId: "plus_monthly", scene: "jsapi" }),
  });
  assert.equal(res.status, 200);
  assert.equal(capturedPrepay?.openid, "o-test");
});

test("A 类下单 jsapi 缺 openid：400 JSAPI_OPENID_REQUIRED（R3）", async () => {
  const user = db.createUser("wh-jsapi-nooid", await hashPassword("pw123456"));
  const token = (await auth.issueTokens(user)).accessToken;
  const res = await fetch(base + "/api/billing/unicpay/initiate", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ goodsId: "plus_monthly", scene: "jsapi" }),
  });
  assert.equal(res.status, 400);
  const json = (await res.json()) as { error: { code: string } };
  assert.equal(json.error.code, "JSAPI_OPENID_REQUIRED");
});

async function makeUserAndInitiate(name: string, goodsId = "credits_1_usd"): Promise<{ user: ReturnType<HubDb["createUser"]>; token: string; appOrderId: string }> {
  const user = db.createUser(name, await hashPassword("pw123456"));
  const token = (await auth.issueTokens(user)).accessToken;
  const res = await fetch(base + "/api/billing/unicpay/initiate", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ goodsId, scene: "app" }),
  });
  assert.equal(res.status, 200);
  const json = (await res.json()) as Record<string, unknown>;
  return { user, token, appOrderId: String(json.appOrderId) };
}

async function checkOrder(token: string, appOrderId: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(base + "/api/billing/order/check", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ appOrderId }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

test("order/check：平台已支付但 webhook 未达 ⇒ 主动查单并补发（AC1+AC2）", async () => {
  mockOrderStatus = "paid"; mockOrderAmount = 800;
  const { user, token, appOrderId } = await makeUserAndInitiate("wh-check");
  // 下单即落库 ticket + paymentId（AC1）
  const order = db.getOrder(appOrderId);
  assert.equal(order?.ticket, "tkt-test");
  assert.ok(order?.paymentId !== null && order?.paymentId !== undefined && order.paymentId.startsWith("pay-"));
  assert.equal(db.getCreditBalances(user.id).total, 0);

  const r = await checkOrder(token, appOrderId);
  assert.equal(r.status, 200);
  assert.equal(r.json.status, "paid");
  assert.equal(r.json.delivered, true);
  // 800 点数 → 8,000,000 微单位
  assert.equal(db.getCreditBalances(user.id).total, 8000000);
});

test("order/check：webhook 已入账后再查 ⇒ 不重复发放（AC3）", async () => {
  mockOrderStatus = "paid"; mockOrderAmount = 800;
  const { user, token, appOrderId } = await makeUserAndInitiate("wh-idem");
  const orderPaymentId = db.getOrder(appOrderId)?.paymentId ?? "";
  const wh = await postWebhook({ eventType: "payment.succeeded", paymentId: orderPaymentId, appOrderId, amount: 800, goodsType: "consumable" });
  assert.equal(wh.status, 200);
  assert.equal(db.getCreditBalances(user.id).total, 8000000);

  const r = await checkOrder(token, appOrderId);
  assert.equal(r.status, 200);
  assert.equal(r.json.status, "paid");
  assert.equal(r.json.delivered, true);
  assert.equal(db.getCreditBalances(user.id).total, 8000000); // 不变
});

test("order/check：他人订单 ⇒ 404 且不泄露（AC4）", async () => {
  mockOrderStatus = "pending";
  const a = await makeUserAndInitiate("wh-own");
  const bUser = db.createUser("wh-other", await hashPassword("pw123456"));
  const bToken = (await auth.issueTokens(bUser)).accessToken;
  const r = await checkOrder(bToken, a.appOrderId);
  assert.equal(r.status, 404);
});

test("order/check：平台未支付 ⇒ pending；已支付但金额不符 ⇒ 不入账（AC5+AC6）", async () => {
  mockOrderStatus = "pending";
  const p = await makeUserAndInitiate("wh-pending");
  const rp = await checkOrder(p.token, p.appOrderId);
  assert.equal(rp.status, 200);
  assert.equal(rp.json.status, "pending");
  assert.equal(rp.json.delivered, false);
  assert.equal(db.getCreditBalances(p.user.id).total, 0);

  mockOrderStatus = "paid"; mockOrderAmount = 999; // 与订单 ¥8（800 分）不符
  const m = await makeUserAndInitiate("wh-mismatch");
  const rm = await checkOrder(m.token, m.appOrderId);
  assert.equal(rm.status, 502);
  assert.equal(db.getCreditBalances(m.user.id).total, 0);
});

test("order/check：订阅补发（平台已支付但 webhook 未达）⇒ 激活订阅（R7）", async () => {
  mockOrderStatus = "paid"; mockOrderAmount = 3000; // 测试配置里 plus_monthly ¥30 → 3000 分
  const { user, token, appOrderId } = await makeUserAndInitiate("wh-sub-check", "plus_monthly");
  assert.notEqual(db.getUserById(user.id).planStatus, "subscribed"); // 新用户默认无套餐
  const r = await checkOrder(token, appOrderId);
  assert.equal(r.status, 200);
  assert.equal(r.json.status, "paid");
  assert.equal(r.json.delivered, true);
  assert.equal(db.getUserById(user.id).planStatus, "subscribed");
});

test("markOrderPaidIfCreated 原子守卫：第二次跃迁返回 false", async () => {
  const user = db.createUser("wh-atomic", await hashPassword("pw123456"));
  const order = db.createOrder("ord-atomic", user.id, "credits_1_usd", 8);
  assert.equal(db.markOrderPaidIfCreated(order.id, "unicpay", "p1"), true);
  assert.equal(db.markOrderPaidIfCreated(order.id, "unicpay", "p2"), false);
  assert.equal(db.getOrder("ord-atomic")?.status, "paid");
});

test.before(start);
test.after(stop);

test("H1: subscription 事件按不可变 users.id 反查并落订阅", async () => {
  const user = db.createUser("wh-user", await hashPassword("pw123456"));
  const r = await postWebhook(subEvent({ userId: String(user.id) }));
  assert.equal(r.status, 200);
  const sub = db.getSubscriptionBySubscriptionId("sub-1");
  assert.ok(sub !== null);
  assert.equal(sub.userId, user.id);
  assert.equal(sub.planId, "plus_monthly");
  assert.equal(sub.status, "active");
  assert.equal(db.getUserById(user.id).planStatus, "subscribed");
});

test("H5: 未知用户 → 200 ack（不再 4xx）", async () => {
  const r = await postWebhook(subEvent({ userId: "999999", subscriptionId: "sub-unknown" }));
  assert.equal(r.status, 200);
  assert.equal(r.json.ignored, "unknown userId");
  assert.equal(db.getSubscriptionBySubscriptionId("sub-unknown"), null);
});

test("H2: subscription.changed 换档 → plan_id 更新为新档", async () => {
  const user = db.getUserByName("wh-user")!;
  const r = await postWebhook(subEvent({ eventType: "subscription.changed", userId: String(user.id), goodsId: "pro_monthly" }));
  assert.equal(r.status, 200);
  const sub = db.getSubscriptionBySubscriptionId("sub-1");
  assert.equal(sub!.planId, "pro_monthly");
});

test("H6b: 到期时间只延长（旧事件不改短）", async () => {
  const user = db.getUserByName("wh-user")!;
  const later = new Date(Date.now() + 60 * 86_400_000).toISOString();
  const earlier = new Date(Date.now() + 10 * 86_400_000).toISOString();
  await postWebhook(subEvent({ userId: String(user.id), expiresAt: later }));
  await postWebhook(subEvent({ userId: String(user.id), expiresAt: earlier }));
  const sub = db.getSubscriptionBySubscriptionId("sub-1")!;
  assert.equal(sub.expiresAt, Date.parse(later));
});

test("H6b: revoked 为终态，迟到的 renewed 不回退", async () => {
  const user = db.getUserByName("wh-user")!;
  await postWebhook(subEvent({ eventType: "subscription.revoked", userId: String(user.id), status: "revoked" }));
  assert.equal(db.getSubscriptionBySubscriptionId("sub-1")!.status, "revoked");
  const r = await postWebhook(subEvent({ userId: String(user.id), expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString() }));
  assert.equal(r.status, 200);
  assert.equal(db.getSubscriptionBySubscriptionId("sub-1")!.status, "revoked");
});

test("H6b: revoked 后迟到的 expired 也不撤权（plan_status 保持 subscribed）", async () => {
  const user = db.createUser("wh-revoked", await hashPassword("pw123456"));
  const uid = String(user.id);
  await postWebhook(subEvent({ userId: uid, subscriptionId: "sub-rev", status: "active", expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() }));
  assert.equal(db.getUserById(user.id).planStatus, "subscribed");
  await postWebhook(subEvent({ eventType: "subscription.revoked", userId: uid, subscriptionId: "sub-rev", status: "revoked" }));
  assert.equal(db.getSubscriptionBySubscriptionId("sub-rev")!.status, "revoked");
  assert.equal(db.getUserById(user.id).planStatus, "subscribed");
  // 迟到的 expired：revoked 终态应整条忽略，不得 setPlan(null) 撤权
  await postWebhook(subEvent({ eventType: "subscription.expired", userId: uid, subscriptionId: "sub-rev", status: "expired", expiresAt: new Date(Date.now() - 86_400_000).toISOString() }));
  assert.equal(db.getSubscriptionBySubscriptionId("sub-rev")!.status, "revoked");
  assert.equal(db.getUserById(user.id).planStatus, "subscribed");
});

test("H3: 陈旧时间戳 → 401", async () => {
  const stale = Math.floor(Date.now() / 1000) - 600;
  const r = await postWebhook(subEvent({}), { tsSeconds: stale });
  assert.equal(r.status, 401);
});

test("H4: 金额不符 → 422 且不发货；金额一致 → 200 并激活订阅", async () => {
  const user = db.createUser("wh-payer", await hashPassword("pw123456"));
  db.createOrder("o1", user.id, "plus_monthly", 30); // 30 元 = 3000 分

  const wrong = await postWebhook({
    eventType: "payment.succeeded",
    paymentId: "p1",
    appOrderId: "o1",
    amount: 5000,
    currency: "CNY",
  });
  assert.equal(wrong.status, 422);
  assert.equal(db.getPaymentByChannelOrderId("unicpay", "p1"), null);

  const ok = await postWebhook({
    eventType: "payment.succeeded",
    paymentId: "p1",
    appOrderId: "o1",
    amount: 3000,
    currency: "CNY",
  });
  assert.equal(ok.status, 200);
  assert.ok(db.getPaymentByChannelOrderId("unicpay", "p1") !== null);
  assert.equal(db.getUserById(user.id).planStatus, "subscribed");
});

test("H5: 未知订单 → 200 ack", async () => {
  const r = await postWebhook({ eventType: "payment.succeeded", paymentId: "p2", appOrderId: "nope", amount: 3000 });
  assert.equal(r.status, 200);
  assert.equal(r.json.ignored, "unknown or closed order");
});

test("H6a + H1: store/verify 转发用 users.id 且不带 environment", async () => {
  const user = db.createUser("wh-iap", await hashPassword("pw123456"));
  const token = (await auth.issueTokens(user)).accessToken;
  const res = await fetch(base + "/api/billing/unicpay/store/verify", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ store: "apple", storeProductId: "com.x.plus", receipt: "jws-receipt" }),
  });
  assert.equal(res.status, 200);
  const json = (await res.json()) as Record<string, unknown>;
  assert.equal(json.purchase, "purchased");
  assert.ok(capturedVerify !== null);
  assert.equal(capturedVerify.body.userId, String(user.id));
  assert.ok(!("environment" in capturedVerify.body));
  assert.equal(capturedVerify.authorization, "UnicPay-App rdsh");
});

test("store.purchase.succeeded → 入账 purchased 桶（幂等去重）", async () => {
  const user = db.createUser("wh-store", await hashPassword("pw123456"));
  const evt = {
    eventType: "store.purchase.succeeded",
    goodsId: "credits_1_usd",
    goodsType: "consumable",
    store: "apple",
    storeTransactionId: "tx-1001",
    userId: String(user.id),
    amount: 800,
    currency: "CNY",
  };
  const r1 = await postWebhook(evt);
  assert.equal(r1.status, 200);
  assert.equal(db.getCreditBalances(user.id).purchased, 800 * CREDITS_MICRO_PER_CREDIT);
  // 重复事件：幂等去重，不重复入账
  const r2 = await postWebhook(evt);
  assert.equal(r2.status, 200);
  assert.equal(db.getCreditBalances(user.id).purchased, 800 * CREDITS_MICRO_PER_CREDIT);
});

test("store.purchase.refunded → 冲正 purchased 桶", async () => {
  const user = db.getUserByName("wh-store")!;
  const before = db.getCreditBalances(user.id).purchased;
  const r = await postWebhook({
    eventType: "store.purchase.refunded",
    goodsId: "credits_1_usd",
    goodsType: "consumable",
    store: "apple",
    storeTransactionId: "tx-1001",
    userId: String(user.id),
  });
  assert.equal(r.status, 200);
  assert.equal(db.getCreditBalances(user.id).purchased, before - 800 * CREDITS_MICRO_PER_CREDIT);
});

test("store.purchase: 非 consumable（买断）→ ack 忽略", async () => {
  const r = await postWebhook({
    eventType: "store.purchase.succeeded",
    goodsId: "unlock_forever",
    goodsType: "non_consumable",
    store: "apple",
    storeTransactionId: "tx-2001",
    userId: "1",
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.ignored, "goodsType=non_consumable");
});

test("store.purchase: 未知用户 → ack 忽略", async () => {
  const r = await postWebhook({
    eventType: "store.purchase.succeeded",
    goodsId: "credits_1_usd",
    goodsType: "consumable",
    store: "apple",
    storeTransactionId: "tx-3001",
    userId: "999999",
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.ignored, "unknown userId");
});

test("store.purchase: refunded 先于 succeeded（乱序）→ 503 重试；succeeded 到达后冲正成功", async () => {
  const user = db.createUser("wh-store-oob", await hashPassword("pw123456"));
  const refundEvt = {
    eventType: "store.purchase.refunded",
    goodsId: "credits_1_usd",
    goodsType: "consumable",
    store: "apple",
    storeTransactionId: "tx-oob-1",
    userId: String(user.id),
  };
  // 乱序：refunded 先到，无入账流水 → 503（不冲成负余额）
  const r1 = await postWebhook(refundEvt);
  assert.equal(r1.status, 503);
  assert.equal(db.getCreditBalances(user.id).purchased, 0);
  // succeeded 到达 → 入账
  const r2 = await postWebhook({ ...refundEvt, eventType: "store.purchase.succeeded" });
  assert.equal(r2.status, 200);
  assert.equal(db.getCreditBalances(user.id).purchased, 800 * CREDITS_MICRO_PER_CREDIT);
  // refunded 重试 → 冲正
  const r3 = await postWebhook(refundEvt);
  assert.equal(r3.status, 200);
  assert.equal(db.getCreditBalances(user.id).purchased, 0);
});

test("store.purchase.revoked → 冲正 purchased 桶", async () => {
  const user = db.createUser("wh-store-rev", await hashPassword("pw123456"));
  const evt = {
    eventType: "store.purchase.succeeded",
    goodsId: "credits_1_usd",
    goodsType: "consumable",
    store: "apple",
    storeTransactionId: "tx-rev-1",
    userId: String(user.id),
  };
  await postWebhook(evt);
  assert.equal(db.getCreditBalances(user.id).purchased, 800 * CREDITS_MICRO_PER_CREDIT);
  const r = await postWebhook({ ...evt, eventType: "store.purchase.revoked" });
  assert.equal(r.status, 200);
  assert.equal(db.getCreditBalances(user.id).purchased, 0);
});

test("A 类 payment.succeeded + goodsType=consumable → 入账", async () => {
  const user = db.createUser("wh-a-consumable", await hashPassword("pw123456"));
  db.createOrder("o-credits", user.id, "credits_1_usd", 8); // 8 元 = 800 分
  const r = await postWebhook({
    eventType: "payment.succeeded",
    paymentId: "p-credits",
    appOrderId: "o-credits",
    amount: 800,
    currency: "CNY",
    goodsType: "consumable",
  });
  assert.equal(r.status, 200);
  assert.equal(db.getCreditBalances(user.id).purchased, 800 * CREDITS_MICRO_PER_CREDIT);
});

test("A 类 payment.succeeded + goodsType 缺失 → planId 兜底入账（P1-2 回归）", async () => {
  const user = db.createUser("wh-a-fallback", await hashPassword("pw123456"));
  db.createOrder("o-fallback", user.id, "credits_1_usd", 8);
  const r = await postWebhook({
    eventType: "payment.succeeded",
    paymentId: "p-fallback",
    appOrderId: "o-fallback",
    amount: 800,
    currency: "CNY",
  });
  assert.equal(r.status, 200);
  assert.equal(db.getCreditBalances(user.id).purchased, 800 * CREDITS_MICRO_PER_CREDIT);
});

test("store.purchase.succeeded（google）→ 入账，幂等键 google:<purchaseToken>", async () => {
  const user = db.createUser("wh-store-g", await hashPassword("pw123456"));
  const evt = {
    eventType: "store.purchase.succeeded",
    goodsId: "credits_5_usd",
    goodsType: "consumable",
    store: "google",
    storeTransactionId: "purchase-token-1",
    userId: String(user.id),
  };
  await postWebhook(evt);
  assert.equal(db.getCreditBalances(user.id).purchased, 5000 * CREDITS_MICRO_PER_CREDIT);
  await postWebhook(evt); // 重复 → 幂等
  assert.equal(db.getCreditBalances(user.id).purchased, 5000 * CREDITS_MICRO_PER_CREDIT);
});

test("store.purchase: 未知 goodsId → ack 忽略", async () => {
  const user = db.createUser("wh-store-ug", await hashPassword("pw123456"));
  const r = await postWebhook({
    eventType: "store.purchase.succeeded",
    goodsId: "no_such_product",
    goodsType: "consumable",
    store: "apple",
    storeTransactionId: "tx-ug-1",
    userId: String(user.id),
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.ignored, "unknown goods");
});

test("store.purchase.refunded 幂等：两次 refunded 只冲正一次", async () => {
  const user = db.createUser("wh-store-r2", await hashPassword("pw123456"));
  const succ = { eventType: "store.purchase.succeeded", goodsId: "credits_1_usd", goodsType: "consumable", store: "apple", storeTransactionId: "tx-r2-1", userId: String(user.id) };
  const refund = { ...succ, eventType: "store.purchase.refunded" };
  await postWebhook(succ);
  assert.equal(db.getCreditBalances(user.id).purchased, 800 * CREDITS_MICRO_PER_CREDIT);
  await postWebhook(refund);
  await postWebhook(refund); // 重复 refunded → 幂等，不重复冲正
  assert.equal(db.getCreditBalances(user.id).purchased, 0);
});

test("R1: store/verify consumable 成功 ⇒ 就地入账，webhook 到达不重复", async () => {
  mockVerifyStatus = 200;
  mockVerifyBody = { goodsId: "credits_1_usd", goodsType: "consumable", storeTransactionId: "tx-iap-1", purchase: "purchased" };
  const user = db.createUser("wh-iap-credit", await hashPassword("pw123456"));
  const token = (await auth.issueTokens(user)).accessToken;
  const res = await fetch(base + "/api/billing/unicpay/store/verify", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ store: "apple", storeProductId: "credits_1_usd", receipt: "jws-receipt" }),
  });
  assert.equal(res.status, 200);
  assert.equal(db.getCreditBalances(user.id).purchased, 800 * CREDITS_MICRO_PER_CREDIT);
  // webhook 随后到达：同一幂等键 apple:tx-iap-1 → 不重复入账
  const wh = await postWebhook({
    eventType: "store.purchase.succeeded",
    goodsId: "credits_1_usd", goodsType: "consumable", store: "apple",
    storeTransactionId: "tx-iap-1", userId: String(user.id),
  });
  assert.equal(wh.status, 200);
  assert.equal(db.getCreditBalances(user.id).purchased, 800 * CREDITS_MICRO_PER_CREDIT);
  mockVerifyBody = null;
});

test("R3: store/verify 平台非 200 ⇒ 透传上游状态与错误码（不再一律 502）", async () => {
  mockVerifyStatus = 401;
  mockVerifyBody = { code: "unauthenticated", message: "store verify failed: google: purchases.get status 403" };
  const user = db.createUser("wh-iap-err", await hashPassword("pw123456"));
  const token = (await auth.issueTokens(user)).accessToken;
  const res = await fetch(base + "/api/billing/unicpay/store/verify", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ store: "google", storeProductId: "credits_1_usd", receipt: "purchase-token" }),
  });
  assert.equal(res.status, 401);
  const json = (await res.json()) as { error: { code: string; message: string } };
  assert.equal(json.error.code, "unauthenticated");
  assert.ok(json.error.message.includes("store verify failed"));
  mockVerifyStatus = 200;
  mockVerifyBody = null;
});
