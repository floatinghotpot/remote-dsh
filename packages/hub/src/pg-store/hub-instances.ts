/**
 * pg-store/hub-instances.ts — 71 B6：hub 实例自注册（PG 端口，从 db.ts 同名方法照搬）。
 */
import type { Pool } from "pg";
import { txDb } from "../pg.ts";
import type { HubStore } from "../store.ts";
import { q } from "./mappers.ts";

export function hubInstances(pool: Pool): Pick<
  HubStore,
  "upsertHubInstance" | "touchHubInstance" | "listHubInstances" | "pruneHubInstances"
> {
  return {
    upsertHubInstance: async (url: string, region: string, version: string | null, now: number = Date.now()): Promise<void> => {
      await q(
        txDb(pool),
        "INSERT INTO hub_instances (url, region, version, started_at, last_seen_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (url) DO UPDATE SET region = excluded.region, version = excluded.version, started_at = excluded.started_at, last_seen_at = excluded.last_seen_at",
        [url, region, version, now, now],
      );
    },

    touchHubInstance: async (url: string, now: number = Date.now()): Promise<void> => {
      await q(txDb(pool), "UPDATE hub_instances SET last_seen_at = $1 WHERE url = $2", [now, url]);
    },

    listHubInstances: async (sinceMs: number, region?: string): Promise<Array<{ url: string; region: string; version: string | null; lastSeenAt: number }>> => {
      const r = region === undefined
        ? await q<Record<string, unknown>>(txDb(pool), "SELECT url, region, version, last_seen_at FROM hub_instances WHERE last_seen_at > $1 ORDER BY url", [sinceMs])
        : await q<Record<string, unknown>>(txDb(pool), "SELECT url, region, version, last_seen_at FROM hub_instances WHERE last_seen_at > $1 AND region = $2 ORDER BY url", [sinceMs, region]);
      return r.rows.map((row) => ({
        url: String(row.url),
        region: String(row.region),
        version: row.version === null || row.version === undefined ? null : String(row.version),
        lastSeenAt: Number(row.last_seen_at),
      }));
    },

    pruneHubInstances: async (beforeMs: number): Promise<void> => {
      await q(txDb(pool), "DELETE FROM hub_instances WHERE last_seen_at < $1", [beforeMs]);
    },
  };
}
