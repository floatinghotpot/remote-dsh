import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyCaptchaParam } from "../src/captcha/aliyun.ts";
import type { AliyunCaptchaConfig } from "../src/captcha/aliyun.ts";

const CONFIG: AliyunCaptchaConfig = {
  accessKeyId: "testid",
  accessKeySecret: "testsecret",
  sceneId: "1nlmkade",
  prefix: "q3xdq8",
  endpoint: "https://captcha.test/",
};

type Seen = { url?: string; params?: URLSearchParams };

/** 用假响应替换全局 fetch（不触网），记录请求 URL 与表单体；返回恢复函数。 */
function stubFetch(status: number, body: unknown, seen: Seen): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.url = String(input);
    seen.params = new URLSearchParams(String(init?.body ?? ""));
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** 用网络异常替换全局 fetch；返回恢复函数。 */
function stubFetchThrow(message: string): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error(message);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test("verifyCaptchaParam：成功响应 Code=Success + VerifyResult=true → ok（回归：曾按 RPC 的 OK 判定，导致注册永远 BAD_CAPTCHA）", async () => {
  const seen: Seen = {};
  const restore = stubFetch(200, { RequestId: "r1", Message: "success", Code: "Success", Success: true, Result: { VerifyResult: true } }, seen);
  try {
    const r = await verifyCaptchaParam(CONFIG, "param-from-sdk");
    assert.equal(r.ok, true);
    assert.equal(r.code, "Success");
    assert.equal(r.requestId, "r1");
    assert.equal(r.error, null);
  } finally {
    restore();
  }
  assert.equal(seen.url, "https://captcha.test/");
  assert.equal(seen.params?.get("Action"), "VerifyCaptcha");
  assert.equal(seen.params?.get("SceneId"), CONFIG.sceneId);
  assert.equal(seen.params?.get("CaptchaVerifyParam"), "param-from-sdk");
  assert.match(seen.params?.get("Signature") ?? "", /^[A-Za-z0-9+/=]+$/); // 签名由 rpcSignature 生成
});

test("verifyCaptchaParam：Code=Success 但 VerifyResult=false → 判定为 rejected（error 为 null，区别于调用出错）", async () => {
  const restore = stubFetch(200, { RequestId: "r2", Message: "success", Code: "Success", Success: true, Result: { VerifyResult: false } }, {});
  try {
    const r = await verifyCaptchaParam(CONFIG, "stale-param");
    assert.equal(r.ok, false);
    assert.equal(r.error, null);
    assert.equal(r.code, "Success");
    assert.equal(r.requestId, "r2");
  } finally {
    restore();
  }
});

test("verifyCaptchaParam：真正的错误响应（非 Success 的 Code）→ ok=false 且带错误码（不再抛异常，交给调用方记日志）", async () => {
  const restore = stubFetch(200, { RequestId: "r3", Code: "InvalidAccessKeyId", Message: "invalid access key" }, {});
  try {
    const r = await verifyCaptchaParam(CONFIG, "param");
    assert.equal(r.ok, false);
    assert.equal(r.code, "InvalidAccessKeyId");
    assert.equal(r.error, "aliyun code InvalidAccessKeyId");
  } finally {
    restore();
  }
});

test("verifyCaptchaParam：HTTP 非 2xx → ok=false 且 error 记录状态码", async () => {
  const restore = stubFetch(500, { Code: "InternalError" }, {});
  try {
    const r = await verifyCaptchaParam(CONFIG, "param");
    assert.equal(r.ok, false);
    assert.equal(r.error, "http 500");
  } finally {
    restore();
  }
});

test("verifyCaptchaParam：网络异常 → ok=false 且 error 带原因（绝不向上抛，否则会被吞成 BAD_CAPTCHA 而无法排查）", async () => {
  const restore = stubFetchThrow("fetch failed");
  try {
    const r = await verifyCaptchaParam(CONFIG, "param");
    assert.equal(r.ok, false);
    assert.equal(r.error, "network: fetch failed");
  } finally {
    restore();
  }
});
