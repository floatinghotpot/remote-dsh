/**
 * pg-store/credits.ts — 43b-2：点数账本（09-credits-wallet）的 PostgreSQL 端口。
 *
 * 复用 mappers.ts 的 mapCreditLedger / q / one；事务用 ../pg.ts 的 withTransaction。
 * 与原 SQLite 实现（db.ts）逐条对应：余额三桶、流水幂等、meta 键值。
 */
import type { Pool } from "pg";
import { mapCreditLedger, one, q } from "./mappers.ts";
import { withTransaction, txDb } from "../pg.ts";
import type { CreditBalances, CreditLedgerRow } from "../db.ts";
import type { HubStore } from "../store.ts";

export function credits(
  pool: Pool,
): Pick<
  HubStore,
  | "getCreditBalances"
  | "getCreditLedgerByIdempotencyKey"
  | "appendCreditLedger"
  | "listCreditLedger"
  | "listUsersWithBonusCredits"
  | "getMeta"
  | "setMeta"
> {
  return {
    /** 读用户三桶余额（整数微单位）。 */
    getCreditBalances: async (userId: number): Promise<CreditBalances> => {
      const row = one(await q(txDb(pool), "SELECT purchased_credits, bonus_carried, bonus_current FROM users WHERE id = $1", [userId]));
      const purchased = row === null ? 0 : Number(row.purchased_credits);
      const carried = row === null ? 0 : Number(row.bonus_carried);
      const current = row === null ? 0 : Number(row.bonus_current);
      return { purchased, bonusCarried: carried, bonusCurrent: current, total: purchased + carried + current };
    },

    /** 按幂等键查流水（充值/赠点/退款幂等）。 */
    getCreditLedgerByIdempotencyKey: async (key: string): Promise<CreditLedgerRow | null> => {
      const row = one(await q(txDb(pool), "SELECT * FROM credits_ledger WHERE idempotency_key = $1", [key]));
      return row === null ? null : mapCreditLedger(row);
    },

    /**
     * 追加一笔点数流水并原子更新对应桶余额（事务）。
     * 返回 false = 幂等键已存在（重复回调），不重复入账。
     * bucket 仅接受 purchased | bonus_carried | bonus_current（内部契约，由 credits.ts 校验）。
     */
    appendCreditLedger: async (
      userId: number,
      delta: number,
      bucket: string,
      reason: string,
      opts: { sourceType?: string | null; sourceId?: string | null; idempotencyKey?: string | null; now?: number } = {},
    ): Promise<boolean> => {
      const now = opts.now ?? Date.now();
      if (opts.idempotencyKey != null) {
        const existing = one(await q(txDb(pool), "SELECT * FROM credits_ledger WHERE idempotency_key = $1", [opts.idempotencyKey]));
        if (existing !== null) return false;
      }
      // 白名单映射列名，非法 bucket 直接抛错（不静默落到 bonus_current）。
      const BUCKET_COLUMNS: Record<string, string> = {
        purchased: "purchased_credits",
        bonus_carried: "bonus_carried",
        bonus_current: "bonus_current",
      };
      const col = BUCKET_COLUMNS[bucket];
      if (col === undefined) {
        throw new Error(`invalid credit bucket: ${bucket}`);
      }
      return withTransaction(pool, async (c) => {
        await c.query(`UPDATE users SET ${col} = ${col} + $1 WHERE id = $2`, [delta, userId]);
        const row = one(await q(c, "SELECT purchased_credits, bonus_carried, bonus_current FROM users WHERE id = $1", [userId]));
        const purchased = row === null ? 0 : Number(row.purchased_credits);
        const carried = row === null ? 0 : Number(row.bonus_carried);
        const current = row === null ? 0 : Number(row.bonus_current);
        const balanceAfter = bucket === "purchased" ? purchased : bucket === "bonus_carried" ? carried : current;
        await c.query(
          "INSERT INTO credits_ledger (user_id, delta, bucket, reason, source_type, source_id, idempotency_key, balance_after, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
          [userId, delta, bucket, reason, opts.sourceType ?? null, opts.sourceId ?? null, opts.idempotencyKey ?? null, balanceAfter, now],
        );
        return true;
      });
    },

    /** 管理面：某用户账本流水（按 id 倒序）。 */
    listCreditLedger: async (userId: number): Promise<CreditLedgerRow[]> => {
      const rows = (await q(txDb(pool), "SELECT * FROM credits_ledger WHERE user_id = $1 ORDER BY id DESC LIMIT 1000", [userId])).rows;
      return rows.map((r) => mapCreditLedger(r));
    },

    /** 结转用：返回所有 bonus 桶非零的用户 id。 */
    listUsersWithBonusCredits: async (): Promise<number[]> => {
      const rows = (await q(txDb(pool), "SELECT id FROM users WHERE bonus_carried != 0 OR bonus_current != 0")).rows;
      return rows.map((r) => Number(r.id));
    },

    /** 读 meta 键值（点数月度结算等持久化状态）。 */
    getMeta: async (key: string): Promise<string | null> => {
      const row = one(await q(txDb(pool), "SELECT value FROM meta WHERE key = $1", [key]));
      return row === null ? null : String(row.value);
    },

    /** 写 meta 键值（upsert）。 */
    setMeta: async (key: string, value: string): Promise<void> => {
      await txDb(pool).query("INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value]);
    },
  };
}
