/**
 * direct-ticket.ts — 一次性直连票（R4）：host 经 E2EE 通道随候选下发，客户端拼到直连 URL，
 * 直连口校验后 303 换会话 cookie（免重输口令）。
 *
 * 结构复用访问 cookie 的 HMAC 形式（payload = `${exp}.${nonce}`，key = sha256(secret)），
 * 额外做**单次消费**（used 集合）与短 TTL（默认 30s）。secret 用访问口令派生，改口令即吊销未用票。
 */
import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface DirectTicketManager {
  mint(): string;
  consume(ticket: string): boolean;
}

export function createDirectTicketManager(secret: string, ttlMs = 30_000): DirectTicketManager {
  const used = new Set<string>();
  const key = createHash("sha256").update(secret).digest();
  const hmac = (payload: string): string => createHmac("sha256", key).update(payload).digest("base64url");

  return {
    mint(): string {
      const exp = Date.now() + ttlMs;
      const nonce = randomBytes(16).toString("base64url");
      const payload = `${exp}.${nonce}`;
      return `${payload}.${hmac(payload)}`;
    },
    consume(ticket: string): boolean {
      const parts = ticket.split(".");
      if (parts.length !== 3) return false;
      const [expStr, nonce, sig] = parts as [string, string, string];
      if (expStr === "" || nonce === "" || sig === "") return false;
      const exp = Number(expStr);
      if (!Number.isFinite(exp) || exp <= Date.now()) return false;
      const payload = `${expStr}.${nonce}`;
      const expected = Buffer.from(hmac(payload));
      const actual = Buffer.from(sig);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
      if (used.has(ticket)) return false;
      used.add(ticket);
      return true;
    },
  };
}
