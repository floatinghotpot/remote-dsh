/**
 * pg-store/revocations.ts — 71 B5：主机吊销下行（PG 端口，从 db.ts 同名方法照搬）。
 */
import type { Pool } from "pg";
import { txDb } from "../pg.ts";
import type { HubStore } from "../store.ts";
import { q } from "./mappers.ts";

export function revocations(pool: Pool): Pick<
  HubStore,
  "revokeHost" | "listRecentRevocations" | "pruneRevocations"
> {
  return {
    revokeHost: async (hostId: string, now: number = Date.now()): Promise<void> => {
      await q(
        txDb(pool),
        "INSERT INTO host_revocations (host_id, revoked_at) VALUES ($1, $2) ON CONFLICT (host_id) DO UPDATE SET revoked_at = excluded.revoked_at",
        [hostId, now],
      );
    },

    listRecentRevocations: async (sinceMs: number): Promise<string[]> => {
      const r = await q<{ host_id: string }>(txDb(pool), "SELECT host_id FROM host_revocations WHERE revoked_at >= $1 ORDER BY revoked_at", [sinceMs]);
      return r.rows.map((row) => String(row.host_id));
    },

    pruneRevocations: async (beforeMs: number): Promise<void> => {
      await q(txDb(pool), "DELETE FROM host_revocations WHERE revoked_at < $1", [beforeMs]);
    },
  };
}
