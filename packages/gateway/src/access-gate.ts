/**
 * access-gate.ts — host 侧访问口令（feature 15）：访问 cookie 签发/验签 + code 恒定时间比对。
 *
 * - cookie 名 `rdsh_gate`（hub relay D12 白名单需同名透传，见 packages/hub/src/relay.ts）；
 * - 无状态验签：HMAC-SHA256(payload, key=sha256(accessCode))，payload = `${exp}.${nonce}`；
 * - 改 code → key 变 → 旧 cookie 全失效（无需版本/黑名单）。
 */
import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 网关访问 cookie 名（hub 侧 relay 白名单同名硬编码，注释互指）。 */
export const GATE_COOKIE = "rdsh_gate";

/** 访问 cookie 有效期（对齐 host cookie 7 天）。 */
export const GATE_COOKIE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 派生 HMAC 密钥：sha256(accessCode)（改 code 即吊销旧 cookie）。 */
function keyFor(accessCode: string): Buffer {
  return createHash("sha256").update(accessCode).digest();
}

function hmac(payload: string, accessCode: string): string {
  return createHmac("sha256", keyFor(accessCode)).update(payload).digest("base64url");
}

/** 签发访问 cookie；返回 value + 过期时间（毫秒）。 */
export function signGateCookie(accessCode: string, now = Date.now()): { value: string; expiresAt: number } {
  const exp = now + GATE_COOKIE_TTL_MS;
  const nonce = randomBytes(16).toString("base64url");
  const payload = `${exp}.${nonce}`;
  return { value: `${payload}.${hmac(payload, accessCode)}`, expiresAt: exp };
}

/** 验签访问 cookie：签名（恒定时间）+ 未过期。 */
export function verifyGateCookie(accessCode: string, value: string, now = Date.now()): boolean {
  const parts = value.split(".");
  if (parts.length !== 3) return false;
  const [expStr, nonce, sig] = parts as [string, string, string];
  if (expStr === "" || nonce === "" || sig === "") return false;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp <= now) return false;
  const payload = `${expStr}.${nonce}`;
  const expected = Buffer.from(hmac(payload, accessCode));
  const actual = Buffer.from(sig);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** code 恒定时间比对（对 sha256 摘要比较，避免长度侧信道）。 */
export function verifyGateCode(input: string, accessCode: string): boolean {
  const a = createHash("sha256").update(input).digest();
  const b = createHash("sha256").update(accessCode).digest();
  return timingSafeEqual(a, b);
}
