/**
 * jwt.ts — 手写 HMAC-SHA256 JWT（标准三段式 header.payload.signature，零依赖）。
 *
 * 偏离 proposal 的 jose（solution §5.2 记录）：单进程自托管够用；格式标准，
 * 未来 Go 标准库 / 第三方均可解析。密钥 ~/.rdsh/hub-jwt.key（0600，自动生成）。
 */
import { createHmac, createHash, randomBytes } from "node:crypto";

const HEADER = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");

export interface JwtClaims {
  /** user id */
  sub: number;
  name: string;
  /** 用户版本（改密/吊销 +1 → 旧 token 即时失效） */
  ver: number;
  /** 过期时间（毫秒） */
  exp: number;
}

export class Jwt {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    this.key = key;
  }

  sign(claims: JwtClaims): string {
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const sig = createHmac("sha256", this.key).update(`${HEADER}.${payload}`).digest("base64url");
    return `${HEADER}.${payload}.${sig}`;
  }

  /** 校验签名 + 过期；失败返回 null。 */
  verify(token: string): JwtClaims | null {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [h, p, s] = parts as [string, string, string];
    if (h !== HEADER) return null;
    const expected = createHmac("sha256", this.key).update(`${h}.${p}`).digest("base64url");
    const actual = Buffer.from(s);
    const expBuf = Buffer.from(expected);
    if (actual.length !== expBuf.length || !timingSafeEqual(actual, expBuf)) return null;
    try {
      const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as JwtClaims;
      if (typeof claims.sub !== "number" || typeof claims.exp !== "number") return null;
      if (claims.exp <= Date.now()) return null;
      return claims;
    } catch {
      return null;
    }
  }
}

import { timingSafeEqual } from "node:crypto";

/** 生成随机不透明 token（refresh / host token 用；DB 存 SHA-256 摘要）。 */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** SHA-256 摘要（存储用，不落明文 token）。 */
export function sha256(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
