/**
 * pg-store/users.ts — 43b-2：HubDb 用户域方法的 PostgreSQL 端口。
 *
 * SQL 从 packages/hub/src/db.ts 逐条照搬，方言转换：
 *   - ? 占位符 → $1,$2,…（动态 WHERE 按出现顺序重新编号）
 *   - lastInsertRowid → INSERT ... RETURNING *
 *   - 多语句事务（removeUser/deleteAccount）→ withTransaction
 *   - 布尔入参（must_change）落库转 0/1
 */
import type { Pool } from "pg";
import { mapUser, q, one } from "./mappers.ts";
import { withTransaction, txDb } from "../pg.ts";
import type { UserRow } from "../db.ts";
import type { HubStore } from "../store.ts";

export function users(pool: Pool): Pick<
  HubStore,
  | "createUser"
  | "createWechatUser"
  | "createWechatAppUser"
  | "bindWechat"
  | "bindWechatApp"
  | "getUserByName"
  | "getUserById"
  | "listUsers"
  | "countUsers"
  | "countUsersCreatedSince"
  | "listUsersPage"
  | "removeUser"
  | "setPassword"
  | "bumpVersion"
  | "setEmail"
  | "setEmailVerified"
  | "clearEmail"
  | "clearWechat"
  | "clearApple"
  | "setTotpSecret"
  | "clearTotpSecret"
  | "getUserByEmail"
  | "getUserByPhone"
  | "getUserByWxwebOpenid"
  | "getUserByWxappOpenid"
  | "getUserByWechatUnionid"
  | "getUserByAppleSub"
  | "createAppleUser"
  | "bindApple"
  | "storeAppleTokens"
  | "getAppleTokens"
  | "deleteAppleTokens"
  | "incrementFailedAttempts"
  | "lockAccount"
  | "clearFailedAttempts"
  | "touchLastLogin"
  | "unlockAccount"
  | "setPhone"
  | "setPhoneVerified"
  | "clearPhone"
  | "setAccountStatus"
  | "setRole"
  | "startTrial"
  | "setPlan"
  | "setFreeSince"
  | "purgeExpiredFreeHosts"
  | "deleteAccount"
> {
  return {
    createUser: async (name: string, passwordHash: string, now = new Date().toISOString(), mustChange = false): Promise<UserRow> => {
      const row = one(
        await q<Record<string, unknown>>(
          pool,
          "INSERT INTO users (name, password_hash, created_at, must_change) VALUES ($1, $2, $3, $4) RETURNING *",
          [name, passwordHash, now, mustChange ? 1 : 0],
        ),
      );
      return mapUser(row!);
    },

    /** 微信登录自动建号：active + 不可用密码（禁密码登录）+ 微信身份字段。 */
    createWechatUser: async (name: string, openid: string, unionid: string | null, nickname: string | null, avatar: string | null, now = new Date().toISOString()): Promise<UserRow> => {
      const row = one(
        await q<Record<string, unknown>>(
          pool,
          "INSERT INTO users (name, password_hash, created_at, must_change, account_status, wxweb_openid, wechat_unionid, wechat_nickname, wechat_avatar) VALUES ($1, '!wechat', $2, 0, 'active', $3, $4, $5, $6) RETURNING *",
          [name, now, openid, unionid, nickname, avatar],
        ),
      );
      return mapUser(row!);
    },

    /** 绑定微信身份到指定账号（openid/unionid 落库；重绑则覆盖昵称/头像）。 */
    bindWechat: async (id: number, openid: string, unionid: string | null, nickname: string | null, avatar: string | null): Promise<void> => {
      await txDb(pool).query("UPDATE users SET wxweb_openid = $1, wechat_unionid = $2, wechat_nickname = $3, wechat_avatar = $4 WHERE id = $5", [openid, unionid, nickname, avatar, id]);
    },

    /** 微信 App（移动应用）登录自动建号：与门户建号同构，但 openid 存 wxapp_openid。 */
    createWechatAppUser: async (name: string, appOpenid: string, unionid: string | null, nickname: string | null, avatar: string | null, now = new Date().toISOString()): Promise<UserRow> => {
      const row = one(
        await q<Record<string, unknown>>(
          pool,
          "INSERT INTO users (name, password_hash, created_at, must_change, account_status, wxapp_openid, wechat_unionid, wechat_nickname, wechat_avatar) VALUES ($1, '!wechat', $2, 0, 'active', $3, $4, $5, $6) RETURNING *",
          [name, now, appOpenid, unionid, nickname, avatar],
        ),
      );
      return mapUser(row!);
    },

    /** 绑定微信 App（移动应用）身份到指定账号（openid 存 wxapp_openid；unionid 共享）。 */
    bindWechatApp: async (id: number, appOpenid: string, unionid: string | null, nickname: string | null, avatar: string | null): Promise<void> => {
      await txDb(pool).query("UPDATE users SET wxapp_openid = $1, wechat_unionid = $2, wechat_nickname = $3, wechat_avatar = $4 WHERE id = $5", [appOpenid, unionid, nickname, avatar, id]);
    },

    getUserByName: async (name: string): Promise<UserRow | null> => {
      const row = one(await q<Record<string, unknown>>(txDb(pool), "SELECT * FROM users WHERE name = $1", [name]));
      return row === null ? null : mapUser(row);
    },

    getUserById: async (id: number): Promise<UserRow | null> => {
      const row = one(await q<Record<string, unknown>>(txDb(pool), "SELECT * FROM users WHERE id = $1", [id]));
      return row === null ? null : mapUser(row);
    },

    listUsers: async (): Promise<UserRow[]> => {
      return (await q<Record<string, unknown>>(txDb(pool), "SELECT * FROM users ORDER BY id")).rows.map(mapUser);
    },

    /** 全库用户总数（含 pending；注册总量上限用）。 */
    countUsers: async (): Promise<number> => {
      const row = one(await q<{ c: string | number }>(pool, "SELECT COUNT(*) AS c FROM users"));
      return Number(row?.c ?? 0);
    },

    /** 自指定时间点（ms）以来创建的用户数（created_at 为 ISO 字符串，字典序 = 时间序）。 */
    countUsersCreatedSince: async (sinceMs: number): Promise<number> => {
      const iso = new Date(sinceMs).toISOString();
      const row = one(await q<{ c: string | number }>(pool, "SELECT COUNT(*) AS c FROM users WHERE created_at >= $1", [iso]));
      return Number(row?.c ?? 0);
    },

    /** 管理台用户分页 + 过滤（模糊搜索 name/email/phone、角色、状态、登录时间范围）；返回 { rows, total }。 */
    listUsersPage: async (opts: {
      q?: string;
      role?: string;
      status?: string;
      lastLoginFrom?: number;
      lastLoginTo?: number;
      limit?: number;
      offset?: number;
    }): Promise<{ rows: UserRow[]; total: number }> => {
      const conds: string[] = [];
      const params: Array<string | number> = [];
      const search = opts.q !== undefined && opts.q !== "" ? opts.q : null;
      if (search !== null) {
        conds.push(`(name LIKE $${params.length + 1} OR email LIKE $${params.length + 2} OR phone LIKE $${params.length + 3})`);
        params.push(`%${search}%`, `%${search}%`, `%${search}%`);
      }
      if (opts.role !== undefined && opts.role !== "") {
        conds.push(`role = $${params.length + 1}`);
        params.push(opts.role);
      }
      const now = Date.now();
      if (opts.status === "active") {
        conds.push(`account_status = 'active' AND (locked_until IS NULL OR locked_until <= $${params.length + 1})`);
        params.push(now);
      } else if (opts.status === "banned") {
        conds.push("account_status = 'banned'");
      } else if (opts.status === "locked") {
        conds.push(`locked_until IS NOT NULL AND locked_until > $${params.length + 1}`);
        params.push(now);
      }
      if (opts.lastLoginFrom !== undefined) {
        conds.push(`last_login_at IS NOT NULL AND last_login_at >= $${params.length + 1}`);
        params.push(opts.lastLoginFrom);
      }
      if (opts.lastLoginTo !== undefined) {
        conds.push(`last_login_at IS NOT NULL AND last_login_at <= $${params.length + 1}`);
        params.push(opts.lastLoginTo);
      }
      const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
      const total = Number(one(await q<{ c: string | number }>(pool, `SELECT COUNT(*) AS c FROM users ${where}`, params))?.c ?? 0);
      const limit = opts.limit !== undefined ? opts.limit : 50;
      const offset = opts.offset !== undefined ? opts.offset : 0;
      const rows = (
        await q<Record<string, unknown>>(txDb(pool), `SELECT * FROM users ${where} ORDER BY id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, limit, offset])
      ).rows.map(mapUser);
      return { rows, total };
    },

    removeUser: async (id: number): Promise<void> => {
      await withTransaction(pool, async (c) => {
        // 按 FK 依赖顺序删子表 → 父表（users 最后）
        await c.query("DELETE FROM email_codes WHERE user_id = $1", [id]);
        await c.query("DELETE FROM audit_events WHERE user_id = $1", [id]);
        await c.query("DELETE FROM host_share WHERE user_id = $1", [id]); // member 侧
        await c.query("DELETE FROM host_share WHERE host_id IN (SELECT id FROM hosts WHERE owner_id = $1)", [id]); // 其 host 的共享
        await c.query("DELETE FROM join_tokens WHERE owner_id = $1", [id]);
        await c.query("DELETE FROM refresh_tokens WHERE user_id = $1", [id]);
        await c.query("DELETE FROM hosts WHERE owner_id = $1", [id]);
        await c.query("DELETE FROM payments WHERE user_id = $1", [id]);
        await c.query("DELETE FROM orders WHERE user_id = $1", [id]);
        await c.query("DELETE FROM subscriptions WHERE user_id = $1", [id]);
        await c.query("DELETE FROM apple_tokens WHERE user_id = $1", [id]);
        await c.query("DELETE FROM sms_codes WHERE user_id = $1", [id]);
        await c.query("DELETE FROM users WHERE id = $1", [id]);
      });
    },

    setPassword: async (id: number, passwordHash: string): Promise<void> => {
      // 改密 → ver + 1（全部旧 JWT 立即失效）+ 清除首次设密标记
      await txDb(pool).query("UPDATE users SET password_hash = $1, ver = ver + 1, must_change = 0 WHERE id = $2", [passwordHash, id]);
    },

    bumpVersion: async (id: number): Promise<void> => {
      await txDb(pool).query("UPDATE users SET ver = ver + 1 WHERE id = $1", [id]);
    },

    setEmail: async (id: number, email: string): Promise<void> => {
      await txDb(pool).query("UPDATE users SET email = $1, email_verified = 0 WHERE id = $2", [email, id]);
    },

    setEmailVerified: async (id: number): Promise<void> => {
      await txDb(pool).query("UPDATE users SET email_verified = 1 WHERE id = $1", [id]);
    },

    /** 解绑邮箱（清 email + verified）。 */
    clearEmail: async (id: number): Promise<void> => {
      await txDb(pool).query("UPDATE users SET email = NULL, email_verified = 0 WHERE id = $1", [id]);
    },

    /** 解绑微信（清网站应用 openid + 移动应用 openid + unionid + 昵称头像）。 */
    clearWechat: async (id: number): Promise<void> => {
      await txDb(pool).query(
        "UPDATE users SET wxweb_openid = NULL, wxapp_openid = NULL, wechat_unionid = NULL, wechat_nickname = NULL, wechat_avatar = NULL WHERE id = $1",
        [id],
      );
    },

    /** 解绑 Apple（清 sub/email/姓名 + 删令牌）。 */
    clearApple: async (id: number): Promise<void> => {
      await txDb(pool).query("UPDATE users SET apple_sub = NULL, apple_email = NULL, apple_full_name = NULL WHERE id = $1", [id]);
      await txDb(pool).query("DELETE FROM apple_tokens WHERE user_id = $1", [id]);
    },

    setTotpSecret: async (id: number, secret: string): Promise<void> => {
      await txDb(pool).query("UPDATE users SET totp_secret = $1 WHERE id = $2", [secret, id]);
    },

    clearTotpSecret: async (id: number): Promise<void> => {
      await txDb(pool).query("UPDATE users SET totp_secret = NULL WHERE id = $1", [id]);
    },

    getUserByEmail: async (email: string): Promise<UserRow | null> => {
      const row = one(await q<Record<string, unknown>>(txDb(pool), "SELECT * FROM users WHERE email = $1", [email]));
      return row === null ? null : mapUser(row);
    },

    getUserByPhone: async (phone: string): Promise<UserRow | null> => {
      const row = one(await q<Record<string, unknown>>(txDb(pool), "SELECT * FROM users WHERE phone = $1", [phone]));
      return row === null ? null : mapUser(row);
    },

    getUserByWxwebOpenid: async (openid: string): Promise<UserRow | null> => {
      const row = one(await q<Record<string, unknown>>(txDb(pool), "SELECT * FROM users WHERE wxweb_openid = $1", [openid]));
      return row === null ? null : mapUser(row);
    },

    getUserByWxappOpenid: async (appOpenid: string): Promise<UserRow | null> => {
      const row = one(await q<Record<string, unknown>>(txDb(pool), "SELECT * FROM users WHERE wxapp_openid = $1", [appOpenid]));
      return row === null ? null : mapUser(row);
    },

    getUserByWechatUnionid: async (unionid: string): Promise<UserRow | null> => {
      const row = one(await q<Record<string, unknown>>(txDb(pool), "SELECT * FROM users WHERE wechat_unionid = $1", [unionid]));
      return row === null ? null : mapUser(row);
    },

    getUserByAppleSub: async (sub: string): Promise<UserRow | null> => {
      const row = one(await q<Record<string, unknown>>(txDb(pool), "SELECT * FROM users WHERE apple_sub = $1", [sub]));
      return row === null ? null : mapUser(row);
    },

    /** Apple 登录自动建号：active + 不可用密码（禁密码登录）+ apple 身份字段。 */
    createAppleUser: async (name: string, sub: string, email: string | null, fullName: string | null, now = new Date().toISOString()): Promise<UserRow> => {
      const row = one(
        await q<Record<string, unknown>>(
          pool,
          "INSERT INTO users (name, password_hash, created_at, must_change, account_status, apple_sub, apple_email, apple_full_name) VALUES ($1, '!apple', $2, 0, 'active', $3, $4, $5) RETURNING *",
          [name, now, sub, email, fullName],
        ),
      );
      return mapUser(row!);
    },

    /** 绑定/补记 Apple 身份（首次的 email/fullName）。 */
    bindApple: async (id: number, sub: string, email: string | null, fullName: string | null): Promise<void> => {
      await txDb(pool).query("UPDATE users SET apple_sub = $1, apple_email = $2, apple_full_name = $3 WHERE id = $4", [sub, email, fullName, id]);
    },

    /** 存 Apple 令牌（**已加密**密文；加密在调用方，DB 不感知明文）。 */
    storeAppleTokens: async (userId: number, refreshTokenEnc: string | null, accessTokenEnc: string | null, nowMs = Date.now()): Promise<void> => {
      await txDb(pool).query(
        "INSERT INTO apple_tokens (user_id, refresh_token, access_token, updated_at) VALUES ($1, $2, $3, $4) ON CONFLICT(user_id) DO UPDATE SET refresh_token = excluded.refresh_token, access_token = excluded.access_token, updated_at = excluded.updated_at",
        [userId, refreshTokenEnc, accessTokenEnc, nowMs],
      );
    },

    getAppleTokens: async (userId: number): Promise<{ refreshTokenEnc: string | null; accessTokenEnc: string | null; updatedAt: number } | null> => {
      const row = one(await q<Record<string, unknown>>(txDb(pool), "SELECT * FROM apple_tokens WHERE user_id = $1", [userId]));
      if (row === null) return null;
      return {
        refreshTokenEnc: row.refresh_token === null || row.refresh_token === undefined ? null : String(row.refresh_token),
        accessTokenEnc: row.access_token === null || row.access_token === undefined ? null : String(row.access_token),
        updatedAt: Number(row.updated_at ?? 0),
      };
    },

    deleteAppleTokens: async (userId: number): Promise<void> => {
      await txDb(pool).query("DELETE FROM apple_tokens WHERE user_id = $1", [userId]);
    },

    /** 登录失败计数 +1，返回新值。 */
    incrementFailedAttempts: async (id: number): Promise<number> => {
      const r = await txDb(pool).query("UPDATE users SET failed_attempts = failed_attempts + 1 WHERE id = $1 RETURNING failed_attempts", [id]);
      return r.rows.length > 0 ? Number(r.rows[0].failed_attempts) : 0;
    },

    /** 触发锁定：设 locked_until 并清失败计数（解锁后重新计数）。 */
    lockAccount: async (id: number, lockedUntil: number): Promise<void> => {
      await txDb(pool).query("UPDATE users SET locked_until = $1, failed_attempts = 0 WHERE id = $2", [lockedUntil, id]);
    },

    /** 登录成功：清失败计数。 */
    clearFailedAttempts: async (id: number): Promise<void> => {
      await txDb(pool).query("UPDATE users SET failed_attempts = 0 WHERE id = $1", [id]);
    },

    /** 记录最近一次成功登录时间（feature 16；登录成功各通道调用）。 */
    touchLastLogin: async (id: number, now = Date.now()): Promise<void> => {
      await txDb(pool).query("UPDATE users SET last_login_at = $1 WHERE id = $2", [now, id]);
    },

    /** admin 解锁：清失败计数 + 清锁定。 */
    unlockAccount: async (id: number): Promise<void> => {
      await txDb(pool).query("UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $1", [id]);
    },

    setPhone: async (id: number, phone: string): Promise<void> => {
      await txDb(pool).query("UPDATE users SET phone = $1, phone_verified = 0 WHERE id = $2", [phone, id]);
    },

    setPhoneVerified: async (id: number): Promise<void> => {
      await txDb(pool).query("UPDATE users SET phone_verified = 1 WHERE id = $1", [id]);
    },

    clearPhone: async (id: number): Promise<void> => {
      await txDb(pool).query("UPDATE users SET phone = NULL, phone_verified = 0 WHERE id = $1", [id]);
    },

    setAccountStatus: async (id: number, status: string): Promise<void> => {
      await txDb(pool).query("UPDATE users SET account_status = $1 WHERE id = $2", [status, id]);
    },

    /** 设置角色（user | readonly | operator | admin）。 */
    setRole: async (id: number, role: string): Promise<void> => {
      await txDb(pool).query("UPDATE users SET role = $1 WHERE id = $2", [role, id]);
    },

    /** 进入试用：plan_status=trial + 起止时间。 */
    startTrial: async (id: number, nowMs: number, expiresAtMs: number): Promise<void> => {
      await txDb(pool).query("UPDATE users SET plan_status = 'trial', trial_started_at = $1, plan_expires_at = $2 WHERE id = $3", [nowMs, expiresAtMs, id]);
    },

    /** 设置计费状态（subscribed/grace/free/NULL）+ 到期时间；非 free 时清 free_since_at。 */
    setPlan: async (id: number, status: string | null, expiresAtMs: number | null): Promise<void> => {
      await txDb(pool).query("UPDATE users SET plan_status = $1, plan_expires_at = $2, free_since_at = NULL WHERE id = $3", [status, expiresAtMs, id]);
    },

    /** 标记降级到免费档的时间（30 天 host 数据保留起点）。 */
    setFreeSince: async (id: number, ts: number): Promise<void> => {
      await txDb(pool).query("UPDATE users SET free_since_at = $1 WHERE id = $2", [ts, id]);
    },

    /** 删除 free 且超保留期的用户 host（含共享残留）；返回删除 host 数。 */
    purgeExpiredFreeHosts: async (now: number, retentionMs: number): Promise<number> => {
      const rows = (
        await q<{ id: string | number }>(pool, "SELECT id FROM users WHERE plan_status = 'free' AND free_since_at IS NOT NULL AND free_since_at < $1", [now - retentionMs])
      ).rows;
      let count = 0;
      for (const r of rows) {
        await txDb(pool).query("DELETE FROM host_share WHERE host_id IN (SELECT id FROM hosts WHERE owner_id = $1)", [r.id]);
        const info = await txDb(pool).query("DELETE FROM hosts WHERE owner_id = $1", [r.id]);
        count += info.rowCount ?? 0;
      }
      return count;
    },

    /** 账号删除（R7：墓碑化，保留 orders/payments 账务 + audit 留痕）。 */
    deleteAccount: async (id: number): Promise<void> => {
      await withTransaction(pool, async (c) => {
        await c.query("DELETE FROM sms_codes WHERE user_id = $1", [id]);
        await c.query("DELETE FROM email_codes WHERE user_id = $1", [id]);
        await c.query("DELETE FROM host_share WHERE user_id = $1", [id]);
        await c.query("DELETE FROM host_share WHERE host_id IN (SELECT id FROM hosts WHERE owner_id = $1)", [id]);
        await c.query("DELETE FROM join_tokens WHERE owner_id = $1", [id]);
        await c.query("DELETE FROM refresh_tokens WHERE user_id = $1", [id]);
        await c.query("DELETE FROM hosts WHERE owner_id = $1", [id]);
        await c.query("DELETE FROM subscriptions WHERE user_id = $1", [id]);
        await c.query("DELETE FROM apple_tokens WHERE user_id = $1", [id]);
        // 墓碑：抹除个人数据 + 释放 name（可重注册）；orders/payments/audit 保留（账务与留痕）
        await c.query(
          "UPDATE users SET name = $1, password_hash = '!deleted', email = NULL, phone = NULL, email_verified = 0, phone_verified = 0, totp_secret = NULL, account_status = 'deleted', plan_status = NULL, plan_expires_at = NULL, trial_started_at = NULL, wxapp_openid = NULL, apple_sub = NULL, apple_email = NULL, apple_full_name = NULL WHERE id = $2",
          [`deleted-${id}`, id],
        );
      });
    },
  };
}
