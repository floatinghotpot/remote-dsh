/**
 * pg-store/tokens.ts — 43b-2：refresh tokens / join tokens / bind sessions 的 PostgreSQL 端口。
 *
 * 每个方法的 SQL、参数与返回映射均照搬 packages/hub/src/db.ts 的同名方法，
 * 仅做方言转换（? → $n、INSERT … RETURNING 取代「插入后再 SELECT」、rowCount 取代 changes）。
 * 行映射复用 ./mappers.ts 的 mapRefresh / mapJoinToken / mapBindSession。
 */
import type { Pool } from "pg";
import { txDb } from "../pg.ts";
import type { RefreshRow, JoinTokenRow, BindSessionRow } from "../db.ts";
import type { HubStore } from "../store.ts";
import { mapRefresh, mapJoinToken, mapBindSession, q, one } from "./mappers.ts";

export function tokens(pool: Pool): Pick<
  HubStore,
  | "createRefreshToken"
  | "findRefreshByHash"
  | "revokeRefresh"
  | "revokeAllRefreshForUser"
  | "pruneExpiredRefresh"
  | "createJoinToken"
  | "listJoinTokens"
  | "getJoinTokenById"
  | "getJoinTokenByHash"
  | "revokeJoinToken"
  | "pruneExpiredJoinTokens"
  | "createBindSession"
  | "getBindSession"
  | "getBindSessionByConsumeTokenHash"
  | "approveBindSession"
  | "consumeBindSession"
  | "pruneExpiredBindSessions"
> {
  return {
    // ---- refresh tokens ----

    createRefreshToken: async (userId: number, tokenHash: string, expiresAt: number, now: number = Date.now()): Promise<RefreshRow> => {
      const r = await q(txDb(pool),
        "INSERT INTO refresh_tokens (user_id, token_hash, expires_at, created_at) VALUES ($1, $2, $3, $4) RETURNING *",
        [userId, tokenHash, expiresAt, now],
      );
      return mapRefresh(one(r)!);
    },

    findRefreshByHash: async (tokenHash: string): Promise<RefreshRow | null> => {
      const row = one(await q(txDb(pool), "SELECT * FROM refresh_tokens WHERE token_hash = $1", [tokenHash]));
      return row === null ? null : mapRefresh(row);
    },

    revokeRefresh: async (id: number): Promise<void> => {
      await txDb(pool).query("UPDATE refresh_tokens SET revoked = 1 WHERE id = $1", [id]);
    },

    revokeAllRefreshForUser: async (userId: number): Promise<void> => {
      await txDb(pool).query("UPDATE refresh_tokens SET revoked = 1 WHERE user_id = $1", [userId]);
    },

    /** 清理过期 refresh token。 */
    pruneExpiredRefresh: async (now: number = Date.now()): Promise<void> => {
      await txDb(pool).query("DELETE FROM refresh_tokens WHERE expires_at < $1 OR revoked = 1", [now]);
    },

    // ---- join tokens（用户级注册凭证，05-join-easy）----

    createJoinToken: async (
      id: string,
      label: string | null,
      ownerId: number,
      tokenHash: string,
      expiresAt: number,
      now: string = new Date().toISOString(),
    ): Promise<JoinTokenRow> => {
      const r = await q(txDb(pool),
        "INSERT INTO join_tokens (id, label, owner_id, token_hash, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *",
        [id, label, ownerId, tokenHash, expiresAt, now],
      );
      return mapJoinToken(one(r)!);
    },

    listJoinTokens: async (ownerId: number): Promise<JoinTokenRow[]> => {
      const rows = (await q(txDb(pool), "SELECT * FROM join_tokens WHERE owner_id = $1 ORDER BY created_at", [ownerId])).rows;
      return rows.map((r) => mapJoinToken(r));
    },

    getJoinTokenById: async (id: string): Promise<JoinTokenRow | null> => {
      const row = one(await q(txDb(pool), "SELECT * FROM join_tokens WHERE id = $1", [id]));
      return row === null ? null : mapJoinToken(row);
    },

    getJoinTokenByHash: async (tokenHash: string): Promise<JoinTokenRow | null> => {
      const row = one(await q(txDb(pool), "SELECT * FROM join_tokens WHERE token_hash = $1", [tokenHash]));
      return row === null ? null : mapJoinToken(row);
    },

    revokeJoinToken: async (id: string): Promise<boolean> => {
      const r = await txDb(pool).query("UPDATE join_tokens SET revoked = 1 WHERE id = $1", [id]);
      return (r.rowCount ?? 0) > 0;
    },

    pruneExpiredJoinTokens: async (now: number = Date.now()): Promise<void> => {
      await txDb(pool).query("DELETE FROM join_tokens WHERE expires_at < $1", [now]);
    },

    // ---- bind sessions ----

    createBindSession: async (
      id: string,
      consumeTokenHash: string,
      e2eePublicKey: string | null,
      name: string | null,
      expiresAt: number,
      now: string = new Date().toISOString(),
    ): Promise<BindSessionRow> => {
      const r = await q(txDb(pool),
        "INSERT INTO bind_sessions (id, consume_token_hash, e2ee_public_key, name, status, created_at, expires_at) VALUES ($1, $2, $3, $4, 'pending', $5, $6) RETURNING *",
        [id, consumeTokenHash, e2eePublicKey, name, now, expiresAt],
      );
      return mapBindSession(one(r)!);
    },

    getBindSession: async (id: string): Promise<BindSessionRow | null> => {
      const row = one(await q(txDb(pool), "SELECT * FROM bind_sessions WHERE id = $1", [id]));
      return row === null ? null : mapBindSession(row);
    },

    getBindSessionByConsumeTokenHash: async (hash: string): Promise<BindSessionRow | null> => {
      const row = one(await q(txDb(pool), "SELECT * FROM bind_sessions WHERE consume_token_hash = $1", [hash]));
      return row === null ? null : mapBindSession(row);
    },

    approveBindSession: async (id: string, ownerId: number): Promise<boolean> => {
      const r = await txDb(pool).query("UPDATE bind_sessions SET owner_id = $1, status = 'approved' WHERE id = $2 AND status = 'pending'", [ownerId, id]);
      return (r.rowCount ?? 0) > 0;
    },

    consumeBindSession: async (id: string): Promise<boolean> => {
      const r = await txDb(pool).query("UPDATE bind_sessions SET status = 'consumed' WHERE id = $1 AND status = 'approved'", [id]);
      return (r.rowCount ?? 0) > 0;
    },

    pruneExpiredBindSessions: async (now: number = Date.now()): Promise<void> => {
      await txDb(pool).query("DELETE FROM bind_sessions WHERE expires_at < $1", [now]);
    },
  };
}
