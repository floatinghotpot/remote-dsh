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
        must_change INTEGER NOT NULL DEFAULT 0
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
    `);
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
}
