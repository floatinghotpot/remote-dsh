/**
 * pg-store/wechat.ts — 71 B3：微信 OAuth 流程态（PG 端口，从 db.ts 同名方法照搬）。
 */
import type { Pool } from "pg";
import { txDb } from "../pg.ts";
import type { HubStore } from "../store.ts";
import { q, one } from "./mappers.ts";

interface FlowRow {
  payload: string;
  user_id: number | string | null;
}

function mapFlow(row: FlowRow): { payload: string; userId: number | null } {
  return { payload: String(row.payload), userId: row.user_id === null ? null : Number(row.user_id) };
}

export function wechat(pool: Pool): Pick<
  HubStore,
  "setWechatFlow" | "getWechatFlow" | "consumeWechatFlow" | "pruneExpiredWechatFlows"
> {
  return {
    setWechatFlow: async (
      token: string,
      kind: string,
      userId: number | null,
      payload: string,
      ip: string | null,
      expiresAt: number,
    ): Promise<void> => {
      await q(
        txDb(pool),
        "INSERT INTO wechat_flows (token, kind, user_id, payload, ip, expires_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (token) DO UPDATE SET kind = excluded.kind, user_id = excluded.user_id, payload = excluded.payload, ip = excluded.ip, expires_at = excluded.expires_at",
        [token, kind, userId, payload, ip, expiresAt],
      );
    },

    getWechatFlow: async (token: string, kind: string, now: number = Date.now()): Promise<{ payload: string; userId: number | null } | null> => {
      const row = one<FlowRow>(
        await q<FlowRow>(txDb(pool), "SELECT payload, user_id FROM wechat_flows WHERE token = $1 AND kind = $2 AND expires_at > $3", [token, kind, now]),
      );
      return row === null ? null : mapFlow(row);
    },

    /** 原子消费（一次性）：同一 token 只有一次成功。 */
    consumeWechatFlow: async (token: string, kind: string, now: number = Date.now()): Promise<{ payload: string; userId: number | null } | null> => {
      const row = one<FlowRow>(
        await q<FlowRow>(
          txDb(pool),
          "DELETE FROM wechat_flows WHERE token = $1 AND kind = $2 AND expires_at > $3 RETURNING payload, user_id",
          [token, kind, now],
        ),
      );
      return row === null ? null : mapFlow(row);
    },

    pruneExpiredWechatFlows: async (now: number = Date.now()): Promise<void> => {
      await q(txDb(pool), "DELETE FROM wechat_flows WHERE expires_at <= $1", [now]);
    },
  };
}
