/**
 * auth.ts — hub 认证：登录/刷新/登出/改密 + 限流 + 用户版本化会话。
 *
 * - access JWT（1h，带 ver）；refresh 随机不透明串（DB 存 SHA-256 摘要，7d，轮换）
 * - 改密 → users.ver + 1 → 全部旧 access 立即失效 + 全部 refresh 吊销
 * - 密码 scrypt（格式与 gateway 一致：`scrypt:$N:$r:$p:$salt:$hash`）
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { HubDb } from "./db.ts";
import type { UserRow } from "./db.ts";
import { Jwt, randomToken, sha256 } from "./jwt.ts";

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

function scryptAsync(password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, derived) => {
      if (err) reject(err);
      else resolve(derived as Buffer);
    });
  });
}

/** scrypt 哈希（格式与 gateway auth.ts 一致）。 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString("base64url")}:${derived.toString("base64url")}`;
}

/** 恒定时间校验密码。 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(":");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const saltB64 = parts[4]!;
  const hashB64 = parts[5]!;
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p) || n < 1 || r < 1 || p < 1) return false;
  try {
    const derived = await scryptAsync(password, Buffer.from(saltB64, "base64url"), KEY_LEN, { N: n, r, p });
    return timingSafeEqual(derived, Buffer.from(hashB64, "base64url"));
  } catch {
    return false;
  }
}

export const ACCESS_TTL_MS = 60 * 60 * 1000; // 1h
export const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7d

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface LoginResult {
  tokens: TokenPair;
  /** 1 = 首次登录须设密码（--no-password 建号）；portal 应强制跳转设密页 */
  mustChangePassword: boolean;
}

export class HubAuth {
  private readonly db: HubDb;
  private readonly jwt: Jwt;

  constructor(db: HubDb, jwt: Jwt) {
    this.db = db;
    this.jwt = jwt;
  }

  /** 登录；失败返回 null（限流由调用方 api.ts 层处理）。 */
  async login(name: string, password: string): Promise<LoginResult | null> {
    const user = this.db.getUserByName(name);
    if (user === null) return null;
    if (!(await verifyPassword(password, user.passwordHash))) return null;
    return { tokens: this.issueTokens(user), mustChangePassword: user.mustChange === 1 };
  }

  /**
   * 首次设密码（--no-password 建号的激活流程）：仅 must_change=1 的用户可用。
   * 成功后签发完整会话。返回 null = 用户名不存在或已设过密码。
   */
  async firstPassword(name: string, newPassword: string): Promise<LoginResult | null> {
    const user = this.db.getUserByName(name);
    if (user === null || user.mustChange !== 1) return null;
    this.db.setPassword(user.id, await hashPassword(newPassword));
    return { tokens: this.issueTokens(user), mustChangePassword: false };
  }

  private issueTokens(user: UserRow): TokenPair {
    const accessToken = this.jwt.sign({
      sub: user.id,
      name: user.name,
      ver: user.ver,
      exp: Date.now() + ACCESS_TTL_MS,
    });
    const refreshToken = randomToken();
    this.db.createRefreshToken(user.id, sha256(refreshToken), Date.now() + REFRESH_TTL_MS);
    return { accessToken, refreshToken };
  }

  /**
   * 刷新：校验旧 refresh（未吊销/未过期）→ 吊销旧 → 发新对（轮换）。
   * 失败返回 null（refresh 无效/过期/已吊销）。
   */
  refresh(refreshToken: string): TokenPair | null {
    const row = this.db.findRefreshByHash(sha256(refreshToken));
    if (row === null || row.revoked === 1 || row.expiresAt <= Date.now()) return null;
    const user = this.db.getUserById(row.userId);
    if (user === null) return null;
    this.db.revokeRefresh(row.id);
    return this.issueTokens(user);
  }

  /** 登出：吊销指定 refresh（access 短期自然过期）。 */
  logout(refreshToken: string): void {
    const row = this.db.findRefreshByHash(sha256(refreshToken));
    if (row !== null) this.db.revokeRefresh(row.id);
  }

  /** 自助改密：验证当前密码 → 更新（ver+1）→ 吊销该用户全部 refresh。 */
  async changePassword(userId: number, currentPassword: string, newPassword: string): Promise<boolean> {
    const user = this.db.getUserById(userId);
    if (user === null) return false;
    if (!(await verifyPassword(currentPassword, user.passwordHash))) return false;
    this.db.setPassword(userId, await hashPassword(newPassword));
    this.db.revokeAllRefreshForUser(userId);
    return true;
  }


/** 签发 host 访问 cookie（HMAC 签名，7 天）。relay 后续只验此 cookie（含会话版本），
 * 进入后 DSH 持续可用，不受 access 1h 过期影响；改密（ver+1）后旧 cookie 立即失效。 */
signHostCookie(hostId: string, userId: number): string {
  const ver = this.db.getUserById(userId)?.ver ?? 1;
  const exp = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const payload = [hostId, userId, ver, exp].join('.');
  const sig = this.hmac(payload);
  return Buffer.from(payload + '.' + sig).toString('base64url');
}

/** 验证 host cookie；返回 {hostId, userId} 或 null（伪造/过期/ver 不匹配）。 */
verifyHostCookie(cookie: string): { hostId: string; userId: number } | null {
  try {
    const raw = Buffer.from(cookie, 'base64url').toString('utf8');
    const parts = raw.split('.');
    if (parts.length !== 5) return null;
    const [hostId, userIdStr, verStr, expStr, sig] = parts as [string, string, string, string, string];
    const payload = [hostId, userIdStr, verStr, expStr].join('.');
    if (sig !== this.hmac(payload)) return null;
    const exp = Number(expStr);
    const userId = Number(userIdStr);
    const ver = Number(verStr);
    if (!Number.isFinite(exp) || !Number.isFinite(userId) || !Number.isFinite(ver)) return null;
    if (exp <= Date.now()) return null;
    const user = this.db.getUserById(userId);
    if (user === null || user.ver !== ver) return null;
    return { hostId, userId };
  } catch {
    return null;
  }
}

private hmac(payload: string): string {
  return this.jwt.hmacSign(payload);
}

  /** 校验 access JWT：签名 + 过期 + ver 与 DB 一致（改密/吊销即时失效）。 */
  verifyAccess(accessToken: string): { user: UserRow; claims: { sub: number; name: string; ver: number } } | null {
    const claims = this.jwt.verify(accessToken);
    if (claims === null) return null;
    const user = this.db.getUserById(claims.sub);
    if (user === null) return null;
    if (user.ver !== claims.ver) return null;
    return { user, claims };
  }
}

/** 登录失败限流（按 IP，5 次/10 分钟 —— 与 M2 一致）。 */
export function createLoginLimiter(maxFails = 5, lockMs = 10 * 60 * 1000) {
  const locks = new Map<string, { fails: number; lockedUntil: number }>();
  return {
    allow(ip: string): number {
      const s = locks.get(ip);
      if (s === undefined) return 0;
      const remain = s.lockedUntil - Date.now();
      return remain > 0 ? remain : 0;
    },
    fail(ip: string): number {
      const s = locks.get(ip) ?? { fails: 0, lockedUntil: 0 };
      s.fails += 1;
      if (s.fails >= maxFails) {
        s.fails = 0;
        s.lockedUntil = Date.now() + lockMs;
      }
      locks.set(ip, s);
      return s.lockedUntil > Date.now() ? s.lockedUntil - Date.now() : 0;
    },
    clear(ip: string): void {
      locks.delete(ip);
    },
  };
}
