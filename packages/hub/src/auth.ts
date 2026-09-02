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
import { generateSecret, verifyTotp } from "./totp.ts";
import type { SecurityConfig } from "./config.ts";

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
export const ADMIN_TTL_MS = 30 * 60 * 1000; // 30min（管理面独立短会话）
export const TRUSTED_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d（可信设备免 TOTP）
export const RECENT_TOTP_WINDOW_MS = 30 * 60 * 1000; // 门户会话 30 分钟内验证过 2FA → 管理台免二次输入

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface LoginResult {
  tokens: TokenPair;
  /** 1 = 首次登录须设密码（--no-password 建号）；portal 应强制跳转设密页 */
  mustChangePassword: boolean;
}

export type LoginOutcome =
  | { kind: "locked"; lockedUntil: number }
  | { kind: "bad-credentials" }
  | { kind: "requires-totp"; pendingToken: string; name: string }
  | { kind: "ok"; tokens: TokenPair; mustChangePassword: boolean };

export class HubAuth {
  private readonly db: HubDb;
  private readonly jwt: Jwt;
  private readonly security: SecurityConfig;

  constructor(db: HubDb, jwt: Jwt, security: SecurityConfig = { emailDailyLimit: 5, globalEmailDailyLimit: 200, loginLockThreshold: 10, loginLockMinutes: 15, auditRetentionDays: 90 }) {
    this.db = db;
    this.jwt = jwt;
    this.security = security;
  }

  /**
   * 登录：账户锁定检查 → 密码 → 2FA 分支。
   * 失败计数；达阈值锁账户（admin 解锁）。
   */
  async login(name: string, password: string): Promise<LoginOutcome> {
    const user = this.db.getUserByName(name);
    if (user === null) return { kind: "bad-credentials" };
    if (user.accountStatus !== "active") return { kind: "bad-credentials" }; // pending/banned/deleted 不可登录（防枚举）
    const now = Date.now();
    if (user.lockedUntil !== null && user.lockedUntil > now) {
      return { kind: "locked", lockedUntil: user.lockedUntil };
    }
    if (!(await verifyPassword(password, user.passwordHash))) {
      const fails = this.db.incrementFailedAttempts(user.id);
      if (fails >= this.security.loginLockThreshold) {
        const until = now + this.security.loginLockMinutes * 60_000;
        this.db.lockAccount(user.id, until);
        return { kind: "locked", lockedUntil: until };
      }
      return { kind: "bad-credentials" };
    }
    this.db.clearFailedAttempts(user.id);
    if (user.totpSecret !== null) {
      return { kind: "requires-totp", pendingToken: this.issuePendingToken(user), name: user.name };
    }
    return { kind: "ok", tokens: this.issueTokens(user), mustChangePassword: user.mustChange === 1 };
  }

  /** 2FA 二次校验：pending token + TOTP → 完整会话（含 userId，供可信设备签发）。 */
  verifyTotpLogin(pendingToken: string, code: string): { tokens: TokenPair; mustChangePassword: boolean; userId: number } | null {
    const claims = this.jwt.verify(pendingToken);
    if (claims === null || claims.totpPending !== true) return null;
    const user = this.db.getUserById(claims.sub);
    if (user === null || user.ver !== claims.ver || user.totpSecret === null) return null;
    if (!verifyTotp(user.totpSecret, code)) return null;
    return { tokens: this.issueTokens(user, true), mustChangePassword: user.mustChange === 1, userId: user.id };
  }

  /** 生成 2FA secret（不落库；activate 时由用户带回 secret+code 校验后才启用）。 */
  enableTotp(): { secret: string; otpauthUrl: string } {
    const secret = generateSecret();
    return { secret, otpauthUrl: `otpauth://totp/remote-dsh:?secret=${secret}&issuer=remote-dsh` };
  }

  /** 激活 2FA：用 secret 校验当前 TOTP → 落库。 */
  activateTotp(userId: number, secret: string, code: string): boolean {
    if (!verifyTotp(secret, code)) return false;
    this.db.setTotpSecret(userId, secret);
    return true;
  }

  /** 关闭 2FA（需当前 TOTP）→ 清 secret + ver+1（全端失效）。 */
  disableTotp(userId: number, code: string): boolean {
    const user = this.db.getUserById(userId);
    if (user === null || user.totpSecret === null) return false;
    if (!verifyTotp(user.totpSecret, code)) return false;
    this.db.clearTotpSecret(userId);
    this.db.bumpVersion(userId);
    return true;
  }

  /** admin 重置 2FA（无需 TOTP）→ 清 secret + ver+1。 */
  adminResetTotp(userId: number): void {
    this.db.clearTotpSecret(userId);
    this.db.bumpVersion(userId);
  }

  private issuePendingToken(user: UserRow): string {
    return this.jwt.sign({ sub: user.id, name: user.name, ver: user.ver, exp: Date.now() + 5 * 60 * 1000, totpPending: true });
  }

  /** 签发完整会话对（access + 轮换 refresh）；改密后 ver+1 使旧 access 失效。 */
  issueTokens(user: UserRow, totpVerified = false): TokenPair {
    const accessToken = this.jwt.sign({
      sub: user.id,
      name: user.name,
      ver: user.ver,
      exp: Date.now() + ACCESS_TTL_MS,
      ...(totpVerified ? { totpVerifiedAt: Date.now() } : {}),
    });
    const refreshToken = randomToken();
    this.db.createRefreshToken(user.id, sha256(refreshToken), Date.now() + REFRESH_TTL_MS);
    return { accessToken, refreshToken };
  }

  /** 为已激活用户直接签发会话（注册验证后自动登录）；非 active 返回 null。 */
  issueSession(userId: number): TokenPair | null {
    const user = this.db.getUserById(userId);
    if (user === null || user.accountStatus !== "active") return null;
    return this.issueTokens(user);
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
    if (user === null || user.ver !== ver || user.accountStatus !== "active") return null;
    return { hostId, userId };
  } catch {
    return null;
  }
}

private hmac(payload: string): string {
  return this.jwt.hmacSign(payload);
}

  /** 校验 access JWT：签名 + 过期 + ver 与 DB 一致（改密/吊销即时失效）。 */
  verifyAccess(accessToken: string): { user: UserRow; claims: { sub: number; name: string; ver: number; totpVerifiedAt?: number } } | null {
    const claims = this.jwt.verify(accessToken);
    if (claims === null) return null;
    if (claims.totpPending === true) return null; // pending token 不可作完整会话
    const user = this.db.getUserById(claims.sub);
    if (user === null) return null;
    if (user.ver !== claims.ver) return null;
    return { user, claims };
  }

  /** 管理面角色集合（RBAC 三档，req R1）。 */
  static isAdminRole(role: string): boolean {
    return role === "readonly" || role === "operator" || role === "admin";
  }

  /**
   * 签发管理面会话（独立短效 access token，30min）：需 role ∈ 三档 + 2FA 已启用 + TOTP 校验通过。
   * 返回 null = 无权限 / 未开 2FA / TOTP 错误 / 非 active。
   */
  issueAdminSession(userId: number, totpCode: string, trustedDevice = false, recentTotp = false): string | null {
    const user = this.db.getUserById(userId);
    if (user === null || user.accountStatus !== "active") return null;
    if (!HubAuth.isAdminRole(user.role)) return null;
    if (user.totpSecret === null) return null; // 强制 2FA（req R2）
    // 可信设备（30 天 cookie）或门户会话 30 分钟内验证过 2FA → 跳过本次 TOTP 输入
    if (!trustedDevice && !recentTotp && !verifyTotp(user.totpSecret, totpCode)) return null;
    return this.jwt.sign({ sub: user.id, name: user.name, ver: user.ver, exp: Date.now() + ADMIN_TTL_MS, admin: true });
  }

  /** 可信设备 cookie token：签名含 ver（改密即全体失效），30 天有效。 */
  signTrustedDevice(userId: number): string {
    const user = this.db.getUserById(userId);
    if (user === null) return "";
    return this.jwt.sign({ sub: user.id, name: user.name, ver: user.ver, exp: Date.now() + TRUSTED_TTL_MS, trusted: true });
  }

  /** 校验可信设备 token；有效返回 userId，否则 null。 */
  verifyTrustedDevice(token: string): number | null {
    const claims = this.jwt.verify(token);
    if (claims === null || claims.trusted !== true) return null;
    const user = this.db.getUserById(claims.sub);
    if (user === null || user.ver !== claims.ver) return null;
    return user.id;
  }

  /** 校验管理面会话 token：admin 标记 + 签名/过期/ver + 角色仍在三档。 */
  verifyAdminAccess(adminToken: string): { user: UserRow } | null {
    const claims = this.jwt.verify(adminToken);
    if (claims === null || claims.admin !== true || claims.totpPending === true) return null;
    const user = this.db.getUserById(claims.sub);
    if (user === null || user.ver !== claims.ver) return null;
    if (!HubAuth.isAdminRole(user.role)) return null;
    return { user };
  }

  /** JSAPI 微信 openid 短期 token（OAuth 回调后签发；独立 Cookie，非会话 token）。 */
  issueOpenidToken(userId: number, openid: string): string {
    return this.jwt.sign({ sub: userId, name: "", ver: 0, exp: Date.now() + 10 * 60 * 1000, openid });
  }

  /** 校验 openid token：签名 + 过期 + 含 openid。 */
  verifyOpenidToken(token: string): { userId: number; openid: string } | null {
    const claims = this.jwt.verify(token);
    if (claims === null || claims.totpPending === true) return null;
    if (typeof claims.openid !== "string" || claims.openid === "") return null;
    return { userId: claims.sub, openid: claims.openid };
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
