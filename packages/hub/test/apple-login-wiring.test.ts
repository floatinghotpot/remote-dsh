/**
 * apple-login-wiring.test.ts — 接线回归：hub.json 的 App 登录配置必须真的到达运行时。
 *
 * 背景（2026-10-05 缺陷）：Apple 登录与 App 微信登录的配置最初只加进了
 * `src/config.ts` 与 `src/api.ts`，但 `startHubServer` 的运行时 `config: {…}`
 * 是逐字段列举组装的，漏了 `appleLogin` / `wechatAppLogin` / `appSchemes`，
 * 且 `serveHub` 也没传 —— 结果是任何部署下端点恒返回 `*_DISABLED`。
 * 既有单测直接构造 runtime（自己塞 `config.appleLogin`），因此全绿却漏掉了这条缝。
 *
 * 本测试从 `startHubServer` 入口断言「传入配置 → 能力开关与端点行为随之变化」，
 * 从而锁住此类"配置到运行时的接线"回归。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { HubDb } from "../src/db.ts";
import { HubAuth } from "../src/auth.ts";
import { Jwt } from "../src/jwt.ts";
import { TunnelRegistry } from "../src/tunnel.ts";
import { EventHub } from "../src/events.ts";
import { startHubServer } from "../src/server.ts";
import type { HubServerOptions, RunningHub } from "../src/server.ts";

/** 起一个内存 hub，把额外配置透传给 startHubServer（正是待测的接线）。 */
async function withHub<T>(extra: Partial<HubServerOptions>, fn: (base: string) => Promise<T>): Promise<T> {
  const db = new HubDb(":memory:");
  const auth = new HubAuth(db, new Jwt(Buffer.from("test-key-0123456789abcdef")));
  const server: RunningHub = await startHubServer({
    host: "127.0.0.1",
    port: 0,
    db,
    auth,
    tunnels: new TunnelRegistry(),
    events: new EventHub(),
    portalDir: "/nonexistent-portal", // 本测试不依赖 portal
    ...extra,
  });
  const base = `http://127.0.0.1:${server.actualPort}`;
  try {
    return await fn(base);
  } finally {
    await new Promise<void>((resolve) => server.server.close(() => resolve()));
    db.close();
  }
}

async function post(base: string, path: string): Promise<{ status: number; code: string }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const body = (await res.json()) as { error?: { code?: string } };
  return { status: res.status, code: body.error?.code ?? "" };
}

test("未配置：能力开关为 false，端点返回 *_DISABLED", async () => {
  await withHub({}, async (base) => {
    const cap = (await (await fetch(`${base}/api/capabilities`)).json()) as { appleLoginEnabled: boolean };
    assert.equal(cap.appleLoginEnabled, false);
    assert.deepEqual(await post(base, "/api/app/apple/login"), { status: 404, code: "APPLE_LOGIN_DISABLED" });
    assert.deepEqual(await post(base, "/api/app/wechat/login"), { status: 404, code: "WECHAT_LOGIN_DISABLED" });
  });
});

test("配置 appleLogin：能力开关为 true，端点进入业务校验（400 而非 404）", async () => {
  await withHub(
    {
      appleLogin: {
        teamId: "TEAMID1234",
        keyId: "KEYID12345",
        clientId: "com.example.app",
        privateKeyPath: "/nonexistent/AuthKey_KEYID12345.p8",
        tokenEncKey: "a".repeat(64),
      },
    },
    async (base) => {
      const cap = (await (await fetch(`${base}/api/capabilities`)).json()) as { appleLoginEnabled: boolean };
      assert.equal(cap.appleLoginEnabled, true);
      // 空 body 走到 handler 的参数校验（说明配置已到达运行时，而不是被 *_DISABLED 短路）
      assert.deepEqual(await post(base, "/api/app/apple/login"), { status: 400, code: "BAD_REQUEST" });
    },
  );
});

test("配置 wechatAppLogin + appSchemes：端点进入业务校验（400 而非 404）", async () => {
  await withHub(
    { wechatAppLogin: { appid: "wx1234567890abcdef", appSecret: "secret" }, appSchemes: ["rdshapp"] },
    async (base) => {
      assert.deepEqual(await post(base, "/api/app/wechat/login"), { status: 400, code: "BAD_REQUEST" });
    },
  );
});
