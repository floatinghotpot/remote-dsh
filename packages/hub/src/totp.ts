/**
 * totp.ts — TOTP（RFC 6238），node:crypto 零依赖。
 *
 * - generateSecret：随机 secret（base32）
 * - totp：当前窗口码（HMAC-SHA1，6 位）
 * - verifyTotp：窗口 ±1 容差校验（时钟漂移）
 */
import { createHmac, randomBytes } from "node:crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** 生成 base32 secret（默认 20 字节 = 160 bit，RFC 6238 推荐）。 */
export function generateSecret(bytes = 20): string {
  const buf = randomBytes(bytes);
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]!;
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]!;
  return out;
}

/** 计算指定时间戳的 TOTP 码（默认 6 位、30s 步长）。 */
export function totp(secret: string, time = Date.now(), timeStep = 30, digits = 6): string {
  const counter = Math.floor(time / 1000 / timeStep);
  const key = base32Decode(secret);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter), 0);
  const hmac = createHmac("sha1", key).update(msg).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const code =
    ((hmac[offset]! & 0x7f) << 24) | (hmac[offset + 1]! << 16) | (hmac[offset + 2]! << 8) | hmac[offset + 3]!;
  return String(code % 10 ** digits).padStart(digits, "0");
}

/** 校验 TOTP（窗口 ±window 容差）。 */
export function verifyTotp(secret: string, code: string, window = 1, time = Date.now(), timeStep = 30, digits = 6): boolean {
  if (typeof code !== "string" || code.length !== digits || !/^\d+$/.test(code)) return false;
  for (let i = -window; i <= window; i++) {
    if (totp(secret, time + i * timeStep * 1000, timeStep, digits) === code) return true;
  }
  return false;
}

function base32Decode(input: string): Buffer {
  const s = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const c of s) {
    const idx = BASE32.indexOf(c);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
