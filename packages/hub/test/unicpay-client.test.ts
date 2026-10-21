/**
 * unicpay-client.test.ts — UnicPayClient 出站超时/传输错误兜底（R3）单元测试。
 *
 * 覆盖 doFetch 的两种非 HTTP 失败：传输错误（断连/拒绝连接）→ 502 + upstream_unreachable；
 * 超时（AbortSignal.timeout 到期）→ 504 + upstream_timeout。二者都不再向上抛异常。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { UnicPayClient } from "../src/billing/unicpay.ts";
import type { UnicPayConfig } from "../src/billing/unicpay.ts";

const cfg: UnicPayConfig = {
  appId: "rdsh",
  baseUrl: "http://127.0.0.1:9",
  authSecret: "auth-secret-0123456789",
  webhookSecret: "wh-secret-0123456789",
};

test("doFetch：fetch 抛错 ⇒ 502 + upstream_unreachable（不再抛异常）", async () => {
  const throwing: typeof fetch = async () => {
    throw new Error("ECONNREFUSED");
  };
  const client = new UnicPayClient(cfg, throwing);
  const res = await client.storeVerify({ userId: "1", store: "apple", storeProductId: "credits_1_usd", receipt: "jws" });
  assert.equal(res.status, 502);
  const d = res.data as Record<string, unknown>;
  assert.equal(d.code, "upstream_unreachable");
  assert.ok(String(d.message).includes("ECONNREFUSED"));
});

test("doFetch：超时 ⇒ 504 + upstream_timeout", async () => {
  let sawSignal = false;
  const hangs: typeof fetch = (_input, init) => {
    sawSignal = init?.signal instanceof AbortSignal;
    return new Promise<Response>((_resolve, reject) => {
      // AbortSignal.timeout() 的定时器是 unref 的：若这个 pending promise 不占任何句柄，
      // 事件循环会立刻空转，node:test 便会把本用例判为 cancelled（Node 22 实测
      // cancelledByParent），20ms 的 abort 根本等不到。用一个 ref 的 interval 把事件
      // 循环撑到 abort 落地 —— 生产无此问题（真实 fetch 有 socket 占着句柄）。
      const keepAlive = setInterval(() => {}, 1000);
      init?.signal?.addEventListener("abort", () => {
        clearInterval(keepAlive);
        const e = new Error("aborted");
        (e as Error & { name: string }).name = "AbortError";
        reject(e);
      });
    });
  };
  const client = new UnicPayClient(cfg, hangs, 20); // 20ms 超时，测试快速
  const res = await client.getOrder("tkt");
  assert.equal(sawSignal, true, "doFetch 必须把 abort signal 传给 fetch");
  assert.equal(res.status, 504);
  const d = res.data as Record<string, unknown>;
  assert.equal(d.code, "upstream_timeout");
});
