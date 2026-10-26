/**
 * pg-store/analytics.ts — 57-retention-analytics（Phase 2）：产品分析事件领域方法。
 *
 * 逐字照搬 db.ts 的 analytics_events / analytics_daily 方法；方言差异：占位符 ? → $1..$7。
 * 幂等：event_id 唯一，ON CONFLICT DO NOTHING，且仅当真正插入（rowCount > 0）才聚合，
 * 保证明细与日聚合一致；明细 + 聚合包在同一事务（withTransaction 嵌套走 SAVEPOINT）。
 */
import type { Pool } from "pg";
import { txDb, withTransaction } from "../pg.ts";
import type { HubStore } from "../store.ts";
import type { AnalyticsDailyRow, AnalyticsEventRow } from "../db.ts";

function mapAnalyticsEvent(r: Record<string, unknown>): AnalyticsEventRow {
  return {
    id: Number(r.id),
    event: String(r.event),
    userId: r.user_id === null || r.user_id === undefined ? null : Number(r.user_id),
    deviceId: String(r.device_id),
    ts: Number(r.ts),
    props: String(r.props),
    eventId: String(r.event_id),
    createdAt: Number(r.created_at),
  };
}

function mapAnalyticsDaily(r: Record<string, unknown>): AnalyticsDailyRow {
  return {
    day: String(r.day),
    userId: Number(r.user_id),
    event: String(r.event),
    count: Number(r.count),
  };
}

export function analytics(
  pool: Pool,
): Pick<HubStore, "recordAnalyticsEvent" | "listAnalyticsEvents" | "listAnalyticsDaily" | "listAnalyticsFirstSeen" | "pruneAnalyticsEvents"> {
  return {
    async recordAnalyticsEvent(input: { event: string; userId: number | null; deviceId: string; ts: number; props?: unknown; eventId: string }): Promise<boolean> {
      const day = new Date(input.ts + 8 * 3600_000).toISOString().slice(0, 10); // UTC+8 日界
      return await withTransaction(pool, async () => {
        const db = txDb(pool);
        const inserted = await db.query(
          `INSERT INTO analytics_events (event, user_id, device_id, ts, props, event_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (event_id) DO NOTHING`,
          [input.event, input.userId, input.deviceId, input.ts, JSON.stringify(input.props ?? {}), input.eventId, Date.now()],
        );
        if ((inserted.rowCount ?? 0) > 0 && input.userId !== null) {
          await db.query(
            `INSERT INTO analytics_daily (day, user_id, event, count)
             VALUES ($1, $2, $3, 1)
             ON CONFLICT (day, user_id, event) DO UPDATE SET count = analytics_daily.count + 1`,
            [day, input.userId, input.event],
          );
          await db.query(
            "INSERT INTO analytics_first_seen (user_id, first_day) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING",
            [input.userId, day],
          );
        }
        return (inserted.rowCount ?? 0) > 0;
      });
    },

    async listAnalyticsEvents(fromMs: number, toMs: number, event?: string): Promise<AnalyticsEventRow[]> {
      const { rows } = event === undefined
        ? await txDb(pool).query(
            "SELECT * FROM analytics_events WHERE ts >= $1 AND ts <= $2 ORDER BY ts ASC",
            [fromMs, toMs],
          )
        : await txDb(pool).query(
            "SELECT * FROM analytics_events WHERE event = $1 AND ts >= $2 AND ts <= $3 ORDER BY ts ASC",
            [event, fromMs, toMs],
          );
      return (rows as Array<Record<string, unknown>>).map(mapAnalyticsEvent);
    },

    async listAnalyticsDaily(fromDay: string, toDay: string): Promise<AnalyticsDailyRow[]> {
      const { rows } = await txDb(pool).query(
        "SELECT * FROM analytics_daily WHERE day >= $1 AND day <= $2 ORDER BY day ASC",
        [fromDay, toDay],
      );
      return (rows as Array<Record<string, unknown>>).map(mapAnalyticsDaily);
    },

    async listAnalyticsFirstSeen(): Promise<Array<{ userId: number; firstDay: string }>> {
      const { rows } = await txDb(pool).query(
        "SELECT user_id, first_day FROM analytics_first_seen",
      );
      return (rows as Array<Record<string, unknown>>).map((r) => ({ userId: Number(r.user_id), firstDay: String(r.first_day) }));
    },

    async pruneAnalyticsEvents(beforeMs: number): Promise<void> {
      await txDb(pool).query("DELETE FROM analytics_events WHERE ts < $1", [beforeMs]);
    },
  };
}
