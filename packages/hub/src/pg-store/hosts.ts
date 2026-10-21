/**
 * pg-store/hosts.ts — 43b-2：host 领域方法（createHost / getHostById / shareHost / …）的 PostgreSQL 端口。
 *
 * SQL 逐条从 db.ts 的同名方法搬移：占位符 ? → $n、标量/布尔落库转换、INSERT OR REPLACE → ON CONFLICT、
 * lastInsertRowid 语义由 RETURNING 承担。行映射复用 ./mappers.ts 的 mapHost / mapHostShare。
 */
import type { Pool } from "pg";
import { txDb } from "../pg.ts";
import type { HostRow, HostShareRow } from "../db.ts";
import { mapHost, mapHostShare, q, one } from "./mappers.ts";
import type { HubStore } from "../store.ts";

export function hosts(
  pool: Pool,
): Pick<
  HubStore,
  | "createHost"
  | "getHostById"
  | "findHostByTokenHash"
  | "listHostsByOwner"
  | "listAllHosts"
  | "countHostsByOwner"
  | "listHostsPage"
  | "renameHost"
  | "removeHost"
  | "setHostNode"
  | "setHostOnline"
  | "listHostsByNode"
  | "shareHost"
  | "revokeShare"
  | "getShare"
  | "listShares"
  | "listHostsForUser"
  | "isHostOwner"
> {
  const getHostById = async (id: string): Promise<HostRow | null> => {
    const row = one(await q(txDb(pool), "SELECT * FROM hosts WHERE id = $1", [id]));
    return row === null ? null : mapHost(row);
  };

  return {
    createHost: async (
      id: string,
      ownerId: number,
      name: string,
      tokenHash: string,
      e2eePublicKey?: string,
      now: string = new Date().toISOString(),
    ): Promise<HostRow> => {
      const r = await q(txDb(pool),
        "INSERT INTO hosts (id, owner_id, name, token_hash, e2ee_public_key, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *",
        [id, ownerId, name, tokenHash, e2eePublicKey ?? null, now],
      );
      return mapHost(one(r)!);
    },

    getHostById,

    async findHostByTokenHash(tokenHash: string): Promise<HostRow | null> {
      const row = one(await q(txDb(pool), "SELECT * FROM hosts WHERE token_hash = $1", [tokenHash]));
      return row === null ? null : mapHost(row);
    },

    async listHostsByOwner(ownerId: number): Promise<HostRow[]> {
      const rows = (await q(txDb(pool), "SELECT * FROM hosts WHERE owner_id = $1 ORDER BY created_at", [ownerId])).rows;
      return rows.map((r) => mapHost(r));
    },

    /** 管理员视图：全部 host（rdsh-hub host ls）。 */
    async listAllHosts(): Promise<HostRow[]> {
      const rows = (await q(txDb(pool), "SELECT * FROM hosts ORDER BY created_at")).rows;
      return rows.map((r) => mapHost(r));
    },

    /** 管理员视图：每个 owner 的主机数（GROUP BY owner_id，索引聚合，O(N)）。 */
    async countHostsByOwner(): Promise<Array<{ ownerId: number; count: number }>> {
      const rows = (await q<{ ownerId: unknown; count: unknown }>(
        pool,
        'SELECT owner_id AS "ownerId", COUNT(*) AS count FROM hosts GROUP BY owner_id',
      )).rows;
      return rows.map((r) => ({ ownerId: Number(r.ownerId), count: Number(r.count) }));
    },

    /** 管理台主机分页 + 模糊搜索（主机名/归属用户名），JOIN 出 ownerName；返回 { rows, total }。 */
    async listHostsPage(opts: {
      q?: string;
      e2ee?: "yes" | "no";
      createdFrom?: number;
      createdTo?: number;
      limit?: number;
      offset?: number;
    }): Promise<{ rows: Array<HostRow & { ownerName: string }>; total: number }> {
      const conds: string[] = [];
      const params: Array<string | number> = [];
      const qterm = opts.q !== undefined && opts.q !== "" ? opts.q : null;
      if (qterm !== null) {
        const i = params.length + 1;
        params.push(`%${qterm}%`, `%${qterm}%`);
        conds.push(`(h.name LIKE $${i} OR u.name LIKE $${i + 1})`);
      }
      if (opts.e2ee === "yes") conds.push("h.e2ee_public_key IS NOT NULL");
      else if (opts.e2ee === "no") conds.push("h.e2ee_public_key IS NULL");
      if (opts.createdFrom !== undefined) {
        const i = params.length + 1;
        conds.push(`h.created_at >= $${i}`);
        params.push(new Date(opts.createdFrom).toISOString());
      }
      if (opts.createdTo !== undefined) {
        const i = params.length + 1;
        conds.push(`h.created_at <= $${i}`);
        params.push(new Date(opts.createdTo).toISOString());
      }
      const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
      const total = Number(
        one(await q<{ c: unknown }>(pool, `SELECT COUNT(*) AS c FROM hosts h LEFT JOIN users u ON h.owner_id = u.id ${where}`, params))?.c ?? 0,
      );
      const limit = opts.limit !== undefined ? opts.limit : 50;
      const offset = opts.offset !== undefined ? opts.offset : 0;
      const rows = (
        await q(txDb(pool),
          `SELECT h.*, u.name AS owner_name FROM hosts h LEFT JOIN users u ON h.owner_id = u.id ${where} ORDER BY h.created_at LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, limit, offset],
        )
      ).rows.map((r) => ({
        ...mapHost(r),
        ownerName: r.owner_name === null || r.owner_name === undefined ? String(r.owner_id) : String(r.owner_name),
      }));
      return { rows, total };
    },

    async renameHost(id: string, name: string): Promise<boolean> {
      const r = await txDb(pool).query("UPDATE hosts SET name = $1 WHERE id = $2", [name, id]);
      return (r.rowCount ?? 0) > 0;
    },

    async removeHost(id: string): Promise<boolean> {
      await txDb(pool).query("DELETE FROM host_share WHERE host_id = $1", [id]); // 清共享残留（FK）
      const r = await txDb(pool).query("DELETE FROM hosts WHERE id = $1", [id]);
      return (r.rowCount ?? 0) > 0;
    },

    /** R5/R40：主机 → 节点 映射（动态分配 / 迁移）。 */
    async setHostNode(hostId: string, nodeId: string | null): Promise<void> {
      await txDb(pool).query("UPDATE hosts SET node_id = $1 WHERE id = $2", [nodeId, hostId]);
    },

    /** 节点路由的主机在线状态（N4 上报）。 */
    async setHostOnline(hostId: string, online: boolean): Promise<void> {
      await txDb(pool).query("UPDATE hosts SET online = $1 WHERE id = $2", [online ? 1 : 0, hostId]);
    },

    async listHostsByNode(nodeId: string): Promise<HostRow[]> {
      const rows = (await q(txDb(pool), "SELECT * FROM hosts WHERE node_id = $1 ORDER BY created_at", [nodeId])).rows;
      return rows.map((r) => mapHost(r));
    },

    async shareHost(hostId: string, userId: number, role: string, now = new Date().toISOString()): Promise<void> {
      await txDb(pool).query(
        "INSERT INTO host_share (host_id, user_id, role, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (host_id, user_id) DO UPDATE SET role = excluded.role, created_at = excluded.created_at",
        [hostId, userId, role, now],
      );
    },

    async revokeShare(hostId: string, userId: number): Promise<boolean> {
      const r = await txDb(pool).query("DELETE FROM host_share WHERE host_id = $1 AND user_id = $2", [hostId, userId]);
      return (r.rowCount ?? 0) > 0;
    },

    async getShare(hostId: string, userId: number): Promise<HostShareRow | null> {
      const row = one(await q(txDb(pool), "SELECT * FROM host_share WHERE host_id = $1 AND user_id = $2", [hostId, userId]));
      return row === null ? null : mapHostShare(row);
    },

    /** host 的共享成员列表（join users 取 name）。 */
    async listShares(hostId: string): Promise<Array<{ userId: number; name: string; role: string; createdAt: string }>> {
      const rows = (
        await q(txDb(pool),
          "SELECT s.user_id, s.role, s.created_at, u.name FROM host_share s JOIN users u ON u.id = s.user_id WHERE s.host_id = $1 ORDER BY s.created_at",
          [hostId],
        )
      ).rows;
      return rows.map((r) => ({
        userId: Number(r.user_id),
        name: String(r.name),
        role: String(r.role),
        createdAt: String(r.created_at),
      }));
    },

    /** 用户可见的全部 host（owner ∪ 被共享 member）。 */
    async listHostsForUser(userId: number): Promise<HostRow[]> {
      const rows = (
        await q(txDb(pool),
          "SELECT DISTINCT h.* FROM hosts h LEFT JOIN host_share s ON s.host_id = h.id WHERE h.owner_id = $1 OR s.user_id = $2 ORDER BY h.created_at",
          [userId, userId],
        )
      ).rows;
      return rows.map((r) => mapHost(r));
    },

    async isHostOwner(hostId: string, userId: number): Promise<boolean> {
      const host = await getHostById(hostId);
      return host !== null && host.ownerId === userId;
    },
  };
}
