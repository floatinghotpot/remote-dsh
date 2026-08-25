/**
 * db.ts — hub 持久化（node:sqlite，零外部依赖）。
 *
 * 表：users / hosts / refresh_tokens / join_tokens。
 * 安全基线（req R10）：密码 scrypt 哈希、host token / refresh token 只存 SHA-256 摘要。
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface UserRow {
  id: number;
  name: string;
  passwordHash: string;
  /** 改密/吊销时 +1：JWT 内嵌 ver，校验时对比 → 即时失效 */
  ver: number;
  createdAt: string;
  /** 1 = 首次登录须设密码（--no-password 建号）；设密后清 0 */
  mustChange: number;
  /** 绑定邮箱（未绑定为 null；唯一） */
  email: string | null;
  /** 1 = 邮箱已验证 */
  emailVerified: number;
  /** TOTP secret（base32）；null = 未开启 2FA */
  totpSecret: string | null;
  /** 连续登录失败次数（账户维度锁定） */
  failedAttempts: number;
  /** 锁定截止时间戳（ms）；null = 未锁定 */
  lockedUntil: number | null;
}

export interface HostRow {
  id: string;
  ownerId: number;
  name: string;
  tokenHash: string;
  createdAt: string;
}

export interface RefreshRow {
  id: number;
  userId: number;
  tokenHash: string;
  expiresAt: number;
  revoked: number;
  createdAt: number;
}

export interface JoinTokenRow {
  id: string;
  label: string | null;
  ownerId: number;
  tokenHash: string;
  expiresAt: number;
  revoked: number;
  createdAt: string;
}

export interface HostShareRow {
  hostId: string;
  userId: number;
  role: string;
  createdAt: string;
}

export interface AuditEventRow {
  id: number;
  userId: number | null;
  event: string;
  detailJson: string;
  ip: string;
  createdAt: number;
}

export interface EmailCodeRow {
  id: number;
  userId: number;
  email: string;
  purpose: string;
  codeHash: string;
  expiresAt: number;
  attempts: number;
  createdAt: number;
}

export class HubDb {
  readonly db: DatabaseSync;
  /** 数据库文件路径（:memory: 测试用） */
  readonly path: string;

  constructor(path: string) {
    this.path = path;
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        ver INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        must_change INTEGER NOT NULL DEFAULT 0,
        email TEXT,
        email_verified INTEGER NOT NULL DEFAULT 0,
        totp_secret TEXT,
        failed_attempts INTEGER NOT NULL DEFAULT 0,
        locked_until INTEGER
      );
      CREATE TABLE IF NOT EXISTS hosts (
        id TEXT PRIMARY KEY,
        owner_id INTEGER NOT NULL REFERENCES users(id),
        name TEXT NOT NULL,
        token_hash TEXT UNIQUE NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        token_hash TEXT UNIQUE NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS join_tokens (
        id TEXT PRIMARY KEY,
        label TEXT,
        owner_id INTEGER NOT NULL REFERENCES users(id),
        token_hash TEXT UNIQUE NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS host_share (
        host_id TEXT NOT NULL REFERENCES hosts(id),
        user_id INTEGER NOT NULL REFERENCES users(id),
        role TEXT NOT NULL DEFAULT 'member',
        created_at TEXT NOT NULL,
        PRIMARY KEY (host_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY,
        user_id INTEGER,
        event TEXT NOT NULL,
        detail_json TEXT NOT NULL DEFAULT '{}',
        ip TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS email_codes (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL,
        email TEXT NOT NULL,
        purpose TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
    `);
    // 迁移守卫：既有库补列（SQLite ALTER ADD COLUMN 不支持 UNIQUE，邮箱唯一用独立索引）
    const userCols = new Set(
      (this.db.prepare("PRAGMA table_info(users)").all() as unknown as Array<{ name: string }>).map((c) => c.name),
    );
    const addCols: Array<[string, string]> = [
      ["email", "email TEXT"],
      ["email_verified", "email_verified INTEGER NOT NULL DEFAULT 0"],
      ["totp_secret", "totp_secret TEXT"],
      ["failed_attempts", "failed_attempts INTEGER NOT NULL DEFAULT 0"],
      ["locked_until", "locked_until INTEGER"],
    ];
    for (const [name, ddl] of addCols) {
      if (!userCols.has(name)) this.db.exec(`ALTER TABLE users ADD COLUMN ${ddl}`);
    }
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);`);
  }


  // ---- 行映射（SQL snake_case → TS camelCase 接口） ----

  private mapUser(row: Record<string, unknown>): UserRow {
    return {
      id: Number(row.id),
      name: String(row.name),
      passwordHash: String(row.password_hash),
      ver: Number(row.ver),
      createdAt: String(row.created_at),
      mustChange: Number(row.must_change ?? 0),
      email: row.email === null || row.email === undefined ? null : String(row.email),
      emailVerified: Number(row.email_verified ?? 0),
      totpSecret: row.totp_secret === null || row.totp_secret === undefined ? null : String(row.totp_secret),
      failedAttempts: Number(row.failed_attempts ?? 0),
      lockedUntil: row.locked_until === null || row.locked_until === undefined ? null : Number(row.locked_until),
    };
  }

  private mapHost(row: Record<string, unknown>): HostRow {
    return {
      id: String(row.id),
      ownerId: Number(row.owner_id),
      name: String(row.name),
      tokenHash: String(row.token_hash),
      createdAt: String(row.created_at),
    };
  }

  private mapRefresh(row: Record<string, unknown>): RefreshRow {
    return {
      id: Number(row.id),
      userId: Number(row.user_id),
      tokenHash: String(row.token_hash),
      expiresAt: Number(row.expires_at),
      revoked: Number(row.revoked),
      createdAt: Number(row.created_at),
    };
  }

  private mapJoinToken(row: Record<string, unknown>): JoinTokenRow {
    return {
      id: String(row.id),
      label: row.label === null || row.label === undefined ? null : String(row.label),
      ownerId: Number(row.owner_id),
      tokenHash: String(row.token_hash),
      expiresAt: Number(row.expires_at),
      revoked: Number(row.revoked),
      createdAt: String(row.created_at),
    };
  }

  private mapHostShare(row: Record<string, unknown>): HostShareRow {
    return {
      hostId: String(row.host_id),
      userId: Number(row.user_id),
      role: String(row.role),
      createdAt: String(row.created_at),
    };
  }

  private mapAudit(row: Record<string, unknown>): AuditEventRow {
    return {
      id: Number(row.id),
      userId: row.user_id === null || row.user_id === undefined ? null : Number(row.user_id),
      event: String(row.event),
      detailJson: String(row.detail_json ?? "{}"),
      ip: String(row.ip ?? ""),
      createdAt: Number(row.created_at),
    };
  }

  private mapEmailCode(row: Record<string, unknown>): EmailCodeRow {
    return {
      id: Number(row.id),
      userId: Number(row.user_id),
      email: String(row.email),
      purpose: String(row.purpose),
      codeHash: String(row.code_hash),
      expiresAt: Number(row.expires_at),
      attempts: Number(row.attempts ?? 0),
      createdAt: Number(row.created_at),
    };
  }

  close(): void {
    this.db.close();
  }

  // ---- users ----

  createUser(name: string, passwordHash: string, now = new Date().toISOString(), mustChange = false): UserRow {
    const info = this.db
      .prepare("INSERT INTO users (name, password_hash, created_at, must_change) VALUES (?, ?, ?, ?)")
      .run(name, passwordHash, now, mustChange ? 1 : 0);
    const id = Number(info.lastInsertRowid);
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id);
    return this.mapUser(row as unknown as Record<string, unknown>);
  }

  getUserByName(name: string): UserRow | null {
    const row = this.db.prepare("SELECT * FROM users WHERE name = ?").get(name);
    return row === undefined ? null : this.mapUser(row as unknown as Record<string, unknown>);
  }

  getUserById(id: number): UserRow | null {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id);
    return row === undefined ? null : this.mapUser(row as unknown as Record<string, unknown>);
  }

  listUsers(): UserRow[] {
    return (this.db.prepare("SELECT * FROM users ORDER BY id").all() as unknown as Array<Record<string, unknown>>).map((r) => this.mapUser(r));
  }

  removeUser(id: number): void {
    this.db.prepare("DELETE FROM users WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM hosts WHERE owner_id = ?").run(id);
    this.db.prepare("DELETE FROM refresh_tokens WHERE user_id = ?").run(id);
  }

  setPassword(id: number, passwordHash: string): void {
    // 改密 → ver + 1（全部旧 JWT 立即失效）+ 清除首次设密标记
    this.db.prepare("UPDATE users SET password_hash = ?, ver = ver + 1, must_change = 0 WHERE id = ?").run(passwordHash, id);
  }

  bumpVersion(id: number): void {
    this.db.prepare("UPDATE users SET ver = ver + 1 WHERE id = ?").run(id);
  }

  // ---- hosts ----

  createHost(id: string, ownerId: number, name: string, tokenHash: string, now = new Date().toISOString()): HostRow {
    this.db.prepare("INSERT INTO hosts (id, owner_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(
      id,
      ownerId,
      name,
      tokenHash,
      now,
    );
    const row = this.db.prepare("SELECT * FROM hosts WHERE id = ?").get(id);
    return this.mapHost(row as unknown as Record<string, unknown>);
  }

  getHostById(id: string): HostRow | null {
    const row = this.db.prepare("SELECT * FROM hosts WHERE id = ?").get(id);
    return row === undefined ? null : this.mapHost(row as unknown as Record<string, unknown>);
  }

  findHostByTokenHash(tokenHash: string): HostRow | null {
    const row = this.db.prepare("SELECT * FROM hosts WHERE token_hash = ?").get(tokenHash);
    return row === undefined ? null : this.mapHost(row as unknown as Record<string, unknown>);
  }

  listHostsByOwner(ownerId: number): HostRow[] {
    return (this.db.prepare("SELECT * FROM hosts WHERE owner_id = ? ORDER BY created_at").all(ownerId) as unknown as Array<Record<string, unknown>>).map((r) => this.mapHost(r));
  }

  /** 管理员视图：全部 host（rdsh hub host ls）。 */
  listAllHosts(): HostRow[] {
    return (this.db.prepare("SELECT * FROM hosts ORDER BY created_at").all() as unknown as Array<Record<string, unknown>>).map((r) => this.mapHost(r));
  }

  renameHost(id: string, name: string): boolean {
    const info = this.db.prepare("UPDATE hosts SET name = ? WHERE id = ?").run(name, id);
    return info.changes > 0;
  }

  removeHost(id: string): boolean {
    const info = this.db.prepare("DELETE FROM hosts WHERE id = ?").run(id);
    return info.changes > 0;
  }

  // ---- refresh tokens ----

  createRefreshToken(userId: number, tokenHash: string, expiresAt: number, now = Date.now()): RefreshRow {
    this.db.prepare("INSERT INTO refresh_tokens (user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?)").run(
      userId,
      tokenHash,
      expiresAt,
      now,
    );
    const row = this.db.prepare("SELECT * FROM refresh_tokens WHERE token_hash = ?").get(tokenHash);
    return this.mapRefresh(row as unknown as Record<string, unknown>);
  }

  findRefreshByHash(tokenHash: string): RefreshRow | null {
    const row = this.db.prepare("SELECT * FROM refresh_tokens WHERE token_hash = ?").get(tokenHash);
    return row === undefined ? null : this.mapRefresh(row as unknown as Record<string, unknown>);
  }

  revokeRefresh(id: number): void {
    this.db.prepare("UPDATE refresh_tokens SET revoked = 1 WHERE id = ?").run(id);
  }

  revokeAllRefreshForUser(userId: number): void {
    this.db.prepare("UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?").run(userId);
  }

  /** 清理过期 refresh token。 */
  pruneExpiredRefresh(now = Date.now()): void {
    this.db.prepare("DELETE FROM refresh_tokens WHERE expires_at < ? OR revoked = 1").run(now);
  }

  // ---- join tokens（用户级注册凭证，05-join-easy）----

  createJoinToken(id: string, label: string | null, ownerId: number, tokenHash: string, expiresAt: number, now = new Date().toISOString()): JoinTokenRow {
    this.db
      .prepare("INSERT INTO join_tokens (id, label, owner_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, label, ownerId, tokenHash, expiresAt, now);
    const row = this.db.prepare("SELECT * FROM join_tokens WHERE id = ?").get(id);
    return this.mapJoinToken(row as unknown as Record<string, unknown>);
  }

  listJoinTokens(ownerId: number): JoinTokenRow[] {
    return (this.db.prepare("SELECT * FROM join_tokens WHERE owner_id = ? ORDER BY created_at").all(ownerId) as unknown as Array<Record<string, unknown>>).map((r) => this.mapJoinToken(r));
  }

  getJoinTokenById(id: string): JoinTokenRow | null {
    const row = this.db.prepare("SELECT * FROM join_tokens WHERE id = ?").get(id);
    return row === undefined ? null : this.mapJoinToken(row as unknown as Record<string, unknown>);
  }

  getJoinTokenByHash(tokenHash: string): JoinTokenRow | null {
    const row = this.db.prepare("SELECT * FROM join_tokens WHERE token_hash = ?").get(tokenHash);
    return row === undefined ? null : this.mapJoinToken(row as unknown as Record<string, unknown>);
  }

  revokeJoinToken(id: string): boolean {
    const info = this.db.prepare("UPDATE join_tokens SET revoked = 1 WHERE id = ?").run(id);
    return info.changes > 0;
  }

  pruneExpiredJoinTokens(now = Date.now()): void {
    this.db.prepare("DELETE FROM join_tokens WHERE expires_at < ?").run(now);
  }

  // ---- users：邮箱 / 2FA / 锁定 ----

  /** 绑定/换绑邮箱（email_verified 清零，需重新验证）。 */
  setEmail(id: number, email: string): void {
    this.db.prepare("UPDATE users SET email = ?, email_verified = 0 WHERE id = ?").run(email, id);
  }

  setEmailVerified(id: number): void {
    this.db.prepare("UPDATE users SET email_verified = 1 WHERE id = ?").run(id);
  }

  /** 解绑邮箱（清 email + verified）。 */
  clearEmail(id: number): void {
    this.db.prepare("UPDATE users SET email = NULL, email_verified = 0 WHERE id = ?").run(id);
  }

  setTotpSecret(id: number, secret: string): void {
    this.db.prepare("UPDATE users SET totp_secret = ? WHERE id = ?").run(secret, id);
  }

  clearTotpSecret(id: number): void {
    this.db.prepare("UPDATE users SET totp_secret = NULL WHERE id = ?").run(id);
  }

  getUserByEmail(email: string): UserRow | null {
    const row = this.db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    return row === undefined ? null : this.mapUser(row as unknown as Record<string, unknown>);
  }

  /** 登录失败计数 +1，返回新值。 */
  incrementFailedAttempts(id: number): number {
    this.db.prepare("UPDATE users SET failed_attempts = failed_attempts + 1 WHERE id = ?").run(id);
    return this.getUserById(id)?.failedAttempts ?? 0;
  }

  /** 触发锁定：设 locked_until 并清失败计数（解锁后重新计数）。 */
  lockAccount(id: number, lockedUntil: number): void {
    this.db.prepare("UPDATE users SET locked_until = ?, failed_attempts = 0 WHERE id = ?").run(lockedUntil, id);
  }

  /** 登录成功：清失败计数。 */
  clearFailedAttempts(id: number): void {
    this.db.prepare("UPDATE users SET failed_attempts = 0 WHERE id = ?").run(id);
  }

  /** admin 解锁：清失败计数 + 清锁定。 */
  unlockAccount(id: number): void {
    this.db.prepare("UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?").run(id);
  }

  // ---- host 共享（owner/member）----

  shareHost(hostId: string, userId: number, role: string, now = new Date().toISOString()): void {
    this.db.prepare("INSERT OR REPLACE INTO host_share (host_id, user_id, role, created_at) VALUES (?, ?, ?, ?)").run(hostId, userId, role, now);
  }

  revokeShare(hostId: string, userId: number): boolean {
    const info = this.db.prepare("DELETE FROM host_share WHERE host_id = ? AND user_id = ?").run(hostId, userId);
    return info.changes > 0;
  }

  getShare(hostId: string, userId: number): HostShareRow | null {
    const row = this.db.prepare("SELECT * FROM host_share WHERE host_id = ? AND user_id = ?").get(hostId, userId);
    return row === undefined ? null : this.mapHostShare(row as unknown as Record<string, unknown>);
  }

  /** host 的共享成员列表（join users 取 name）。 */
  listShares(hostId: string): Array<{ userId: number; name: string; role: string; createdAt: string }> {
    return (this.db
      .prepare("SELECT s.user_id, s.role, s.created_at, u.name FROM host_share s JOIN users u ON u.id = s.user_id WHERE s.host_id = ? ORDER BY s.created_at")
      .all(hostId) as unknown as Array<Record<string, unknown>>).map((r) => ({
      userId: Number(r.user_id),
      name: String(r.name),
      role: String(r.role),
      createdAt: String(r.created_at),
    }));
  }

  /** 用户可见的全部 host（owner ∪ 被共享 member）。 */
  listHostsForUser(userId: number): HostRow[] {
    return (this.db
      .prepare(
        "SELECT DISTINCT h.* FROM hosts h LEFT JOIN host_share s ON s.host_id = h.id WHERE h.owner_id = ? OR s.user_id = ? ORDER BY h.created_at",
      )
      .all(userId, userId) as unknown as Array<Record<string, unknown>>).map((r) => this.mapHost(r));
  }

  isHostOwner(hostId: string, userId: number): boolean {
    const host = this.getHostById(hostId);
    return host !== null && host.ownerId === userId;
  }

  // ---- 审计 ----

  recordAudit(userId: number | null, event: string, detail: unknown, ip: string, now = Date.now()): void {
    this.db.prepare("INSERT INTO audit_events (user_id, event, detail_json, ip, created_at) VALUES (?, ?, ?, ?, ?)").run(
      userId,
      event,
      JSON.stringify(detail ?? {}),
      ip,
      now,
    );
  }

  listAudit(filter: { userId?: number; event?: string; since?: number } = {}): AuditEventRow[] {
    const clauses: string[] = [];
    const params: Array<number | string> = [];
    if (filter.userId !== undefined) {
      clauses.push("user_id = ?");
      params.push(filter.userId);
    }
    if (filter.event !== undefined) {
      clauses.push("event = ?");
      params.push(filter.event);
    }
    if (filter.since !== undefined) {
      clauses.push("created_at >= ?");
      params.push(filter.since);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    return (this.db.prepare(`SELECT * FROM audit_events${where} ORDER BY id DESC LIMIT 1000`).all(...params) as unknown as Array<
      Record<string, unknown>
    >).map((r) => this.mapAudit(r));
  }

  pruneAudit(beforeMs: number): void {
    this.db.prepare("DELETE FROM audit_events WHERE created_at < ?").run(beforeMs);
  }

  // ---- 邮件验证码 / 重置码 ----

  createEmailCode(userId: number, email: string, purpose: string, codeHash: string, expiresAt: number, now = Date.now()): EmailCodeRow {
    // 同 email+purpose 只留最新一条
    this.db.prepare("DELETE FROM email_codes WHERE email = ? AND purpose = ?").run(email, purpose);
    this.db
      .prepare("INSERT INTO email_codes (user_id, email, purpose, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(userId, email, purpose, codeHash, expiresAt, now);
    const row = this.db.prepare("SELECT * FROM email_codes WHERE email = ? AND purpose = ? ORDER BY id DESC LIMIT 1").get(email, purpose);
    return this.mapEmailCode(row as unknown as Record<string, unknown>);
  }

  getEmailCodeByEmail(email: string, purpose: string): EmailCodeRow | null {
    const row = this.db.prepare("SELECT * FROM email_codes WHERE email = ? AND purpose = ? ORDER BY id DESC LIMIT 1").get(email, purpose);
    return row === undefined ? null : this.mapEmailCode(row as unknown as Record<string, unknown>);
  }

  incrementCodeAttempts(id: number): void {
    this.db.prepare("UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?").run(id);
  }

  deleteEmailCodes(email: string): void {
    this.db.prepare("DELETE FROM email_codes WHERE email = ?").run(email);
  }
}
