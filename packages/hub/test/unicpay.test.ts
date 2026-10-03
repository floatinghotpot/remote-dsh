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
import { Jwt } from "../src/jwt.ts";
import { TunnelRegistry } from "../src/tunnel.ts";
import { EventHub } from "../src/events.ts";
import { startHubServer } from "../src/server.ts";
import type { RunningHub } from "../src/server.ts";
import type { HubRuntime } from "../src/api.ts";
import type { HubConfig } from "../src/config.ts";

let server: RunningHub | null = null;
let base = "";
let db: HubDb;
let runtime: HubRuntime;
let auth: HubAuth;

const webhookSecret = "wh-secret-0123456789abcdef";

const config: HubConfig = {
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
    unicpay: { appId: "rdsh", baseUrl: "http://127.0.0.1:0", authSecret: "auth-secret-0123456789", webhookSecret },
  },
};

/** 模拟 unicpay 平台 store/verify：捕获转发体并返回 canned 响应。 */
let capturedVerify: { body: Record<string, unknown>; authorization: string } | null = null;
let mockServer: http.Server | null = null;

function startMock(): Promise<string> {
  mockServer = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      if (req.url === "/v1/pay/store/verify" && req.method === "POST") {
        capturedVerify = {
          body: data === "" ? {} : (JSON.parse(data) as Record<string, unknown>),
          authorization: typeof req.headers.authorization === "string" ? req.headers.authorization : "",
        };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ goodsId: "plus_monthly", orderType: "subscription", purchase: "purchased" }));
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
  auth = new HubAuth(db, new Jwt(Buffer.from("test-key-0123456789abcdef")));
  const tunnels = new TunnelRegistry();
  const events = new EventHub();
  runtime = { config, db, auth, tunnels, events };
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
  const token = auth.issueTokens(user).accessToken;
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
