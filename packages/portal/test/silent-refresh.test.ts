/**
 * silent-refresh.test.ts —— 方案①：门户静默续期走「空 body POST + HttpOnly cookie」，
 * 不再把 refreshToken 放进请求体、也不读写 sessionStorage。
 *
 * 守卫点：若未来有人把续期令牌改回 body/sessionStorage，本测例的
 * `body === undefined` / `headers === undefined` 断言会红。
 */
import { describe, expect, it, afterEach } from "vitest";
import { api } from "../src/api.ts";

const origFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = origFetch;
});

describe("silentRefresh（HttpOnly cookie 空 POST）", () => {
  it("401 → 静默续期发空 body POST（无 refreshToken）→ 重试一次成功", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let accountCalls = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === "/api/auth/refresh") {
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }
      accountCalls += 1;
      if (accountCalls === 1) {
        return new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "expired" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    await api.accountInfo({ probe: true });

    const refresh = calls.find((c) => c.url === "/api/auth/refresh");
    expect(refresh, "应触发一次静默续期").toBeDefined();
    expect(refresh?.init?.method).toBe("POST");
    expect(refresh?.init?.credentials).toBe("include");
    expect(refresh?.init?.body).toBeUndefined(); // 空 body：令牌在 HttpOnly cookie，JS 不发送
    expect(refresh?.init?.headers).toBeUndefined(); // 不再发 content-type JSON
    expect(accountCalls).toBe(2); // 续期成功后重试了一次 account
  });
});
