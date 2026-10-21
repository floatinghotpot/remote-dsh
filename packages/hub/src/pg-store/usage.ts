/**
 * pg-store/usage.ts — 43b-2：usage_daily 领域方法（SQLite → PostgreSQL 端口）。
 *
 * 逐字照搬 db.ts 的用量统计方法；方言差异仅三处：
 *  1. 占位符 ? → $1..$16（按列顺序）；
 *  2. 标量 MAX(a,b) → GREATEST(a,b)（ON CONFLICT DO UPDATE 里的逐字段合并）；
 *  3. upsertUsageDailyBatch 的 SAVEPOINT chunk 循环 → withTransaction 事务。
 *
 * usage_daily 是 RANGE(date) 分区表，主键 (user_id, host_id, date, instance_id)，无 id 列；
 * 因此 list 查询只回 date + 各 SUM 列，mapUsageDay 的 id/user_id/updated_at 默认 0（与 SQLite 一致）。
 */
import type { Pool } from "pg";
import { withTransaction, txDb } from "../pg.ts";
import { q } from "./mappers.ts";
import type { HubStore } from "../store.ts";
import type { UsageDayRow, UsageDayValues, UsageBatchRow } from "../db.ts";

/** 幂等 UPSERT：同一 (user_id, host_id, date, instance_id) 内逐字段取 GREATEST 合并。 */
const USAGE_UPSERT_SQL = `INSERT INTO usage_daily (user_id, host_id, date, instance_id, source, relay_seconds, relay_bytes_up, relay_bytes_down, direct_bytes_up, direct_bytes_down, cloud_asr_seconds, local_asr_seconds, cloud_tts_chars, local_tts_chars, sessions, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       ON CONFLICT(user_id, host_id, date, instance_id) DO UPDATE SET
         relay_seconds = GREATEST(usage_daily.relay_seconds, excluded.relay_seconds),
         relay_bytes_up = GREATEST(usage_daily.relay_bytes_up, excluded.relay_bytes_up),
         relay_bytes_down = GREATEST(usage_daily.relay_bytes_down, excluded.relay_bytes_down),
         direct_bytes_up = GREATEST(usage_daily.direct_bytes_up, excluded.direct_bytes_up),
         direct_bytes_down = GREATEST(usage_daily.direct_bytes_down, excluded.direct_bytes_down),
         cloud_asr_seconds = GREATEST(usage_daily.cloud_asr_seconds, excluded.cloud_asr_seconds),
         local_asr_seconds = GREATEST(usage_daily.local_asr_seconds, excluded.local_asr_seconds),
         cloud_tts_chars = GREATEST(usage_daily.cloud_tts_chars, excluded.cloud_tts_chars),
         local_tts_chars = GREATEST(usage_daily.local_tts_chars, excluded.local_tts_chars),
         sessions = GREATEST(usage_daily.sessions, excluded.sessions),
         updated_at = excluded.updated_at`;

/** 行映射：与 db.ts 的私有 mapUsageDay 逐字段一致（list 查询无 id/user_id/updated_at 列，取 0）。 */
function mapUsageDay(r: Record<string, unknown>): UsageDayRow {
  return {
    id: Number(r.id ?? 0),
    userId: Number(r.user_id ?? 0),
    date: String(r.date),
    relaySeconds: Number(r.relay_seconds ?? 0),
    relayBytesUp: Number(r.relay_bytes_up ?? 0),
    relayBytesDown: Number(r.relay_bytes_down ?? 0),
    directBytesUp: Number(r.direct_bytes_up ?? 0),
    directBytesDown: Number(r.direct_bytes_down ?? 0),
    cloudAsrSeconds: Number(r.cloud_asr_seconds ?? 0),
    localAsrSeconds: Number(r.local_asr_seconds ?? 0),
    cloudTtsChars: Number(r.cloud_tts_chars ?? 0),
    localTtsChars: Number(r.local_tts_chars ?? 0),
    sessions: Number(r.sessions ?? 0),
    updatedAt: Number(r.updated_at ?? 0),
  };
}

export function usage(
  pool: Pool,
): Pick<HubStore, "upsertUsageDaily" | "upsertUsageDailyBatch" | "listUsageDaily" | "listUsageDailyByHost" | "deleteUsageOlderThan"> {
  return {
    async upsertUsageDaily(
      userId: number,
      day: UsageDayValues,
      meta: { hostId?: string; instanceId?: string; source?: string } = {},
      now = Date.now(),
    ): Promise<void> {
      await txDb(pool).query(USAGE_UPSERT_SQL, [
        userId,
        meta.hostId ?? "",
        day.date,
        meta.instanceId ?? "",
        meta.source ?? "",
        day.relaySeconds,
        day.relayBytesUp,
        day.relayBytesDown,
        day.directBytesUp,
        day.directBytesDown,
        day.cloudAsrSeconds,
        day.localAsrSeconds,
        day.cloudTtsChars,
        day.localTtsChars,
        day.sessions,
        now,
      ]);
    },

    async upsertUsageDailyBatch(rows: UsageBatchRow[], chunkSize = 500): Promise<number> {
      if (rows.length === 0) return 0;
      let written = 0;
      for (let i = 0; i < rows.length; i += chunkSize) {
        const chunk = rows.slice(i, i + chunkSize);
        await withTransaction(pool, async (c) => {
          for (const r of chunk) {
            await c.query(USAGE_UPSERT_SQL, [
              r.userId,
              r.meta.hostId ?? "",
              r.day.date,
              r.meta.instanceId ?? "",
              r.meta.source ?? "",
              r.day.relaySeconds,
              r.day.relayBytesUp,
              r.day.relayBytesDown,
              r.day.directBytesUp,
              r.day.directBytesDown,
              r.day.cloudAsrSeconds,
              r.day.localAsrSeconds,
              r.day.cloudTtsChars,
              r.day.localTtsChars,
              r.day.sessions,
              Date.now(),
            ]);
          }
        });
        written += chunk.length;
      }
      return written;
    },

    async listUsageDaily(userId: number, from: string, to: string): Promise<UsageDayRow[]> {
      const rows = (
        await q(txDb(pool),
          `SELECT date,
                  SUM(relay_seconds) AS relay_seconds,
                  SUM(relay_bytes_up) AS relay_bytes_up,
                  SUM(relay_bytes_down) AS relay_bytes_down,
                  SUM(direct_bytes_up) AS direct_bytes_up,
                  SUM(direct_bytes_down) AS direct_bytes_down,
                  SUM(cloud_asr_seconds) AS cloud_asr_seconds,
                  SUM(local_asr_seconds) AS local_asr_seconds,
                  SUM(cloud_tts_chars) AS cloud_tts_chars,
                  SUM(local_tts_chars) AS local_tts_chars,
                  SUM(sessions) AS sessions
           FROM usage_daily WHERE user_id = $1 AND date >= $2 AND date <= $3 GROUP BY date ORDER BY date`,
          [userId, from, to],
        )
      ).rows;
      return rows.map(mapUsageDay);
    },

    async listUsageDailyByHost(hostId: string, from: string, to: string): Promise<UsageDayRow[]> {
      const rows = (
        await q(txDb(pool),
          `SELECT date,
                  SUM(relay_seconds) AS relay_seconds,
                  SUM(relay_bytes_up) AS relay_bytes_up,
                  SUM(relay_bytes_down) AS relay_bytes_down,
                  SUM(direct_bytes_up) AS direct_bytes_up,
                  SUM(direct_bytes_down) AS direct_bytes_down,
                  SUM(cloud_asr_seconds) AS cloud_asr_seconds,
                  SUM(local_asr_seconds) AS local_asr_seconds,
                  SUM(cloud_tts_chars) AS cloud_tts_chars,
                  SUM(local_tts_chars) AS local_tts_chars,
                  SUM(sessions) AS sessions
           FROM usage_daily WHERE host_id = $1 AND date >= $2 AND date <= $3 GROUP BY date ORDER BY date`,
          [hostId, from, to],
        )
      ).rows;
      return rows.map(mapUsageDay);
    },

    async deleteUsageOlderThan(date: string): Promise<void> {
      await txDb(pool).query("DELETE FROM usage_daily WHERE date < $1", [date]);
    },
  };
}
