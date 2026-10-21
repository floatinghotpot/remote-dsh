/**
 * pg-store/credits.ts — 43b-2：点数账本（09-credits-wallet）的 PostgreSQL 端口。
 *
 * 复用 mappers.ts 的 mapCreditLedger / q / one；事务用 ../pg.ts 的 withTransaction。
 * 与原 SQLite 实现（db.ts）逐条对应：余额三桶、流水幂等、meta 键值。
 */
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { mapCreditHold, mapCreditLedger, one, q, type Db } from "./mappers.ts";
import { withTransaction, txDb } from "../pg.ts";
import type {
  CreditBalances, CreditHoldReserveResult, CreditHoldRow, CreditHoldSettleResult,
  CreditLedgerRow, CreditSpendResult,
} from "../db.ts";
import type { HubStore } from "../store.ts";

export function credits(
  pool: Pool,
): Pick<
  HubStore,
  | "getCreditBalances"
  | "getCreditLedgerByIdempotencyKey"
  | "appendCreditLedger"
  | "getCreditHoldByRequestId"
  | "reserveCreditHold"
  | "settleCreditHold"
  | "releaseCreditHold"
  | "spendCredits"
  | "sweepExpiredCreditHolds"
  | "listCreditLedger"
  | "listUsersWithBonusCredits"
  | "getMeta"
  | "setMeta"
> {
  const balancesOf = (row: Record<string, unknown> | null): CreditBalances => {
    const purchased = row === null ? 0 : Number(row.purchased_credits);
    const carried = row === null ? 0 : Number(row.bonus_carried);
    const current = row === null ? 0 : Number(row.bonus_current);
    return { purchased, bonusCarried: carried, bonusCurrent: current, total: purchased + carried + current };
  };

  const getBalancesTx = async (c: PoolClient, userId: number): Promise<CreditBalances> =>
    balancesOf(one(await q(c, "SELECT purchased_credits, bonus_carried, bonus_current FROM users WHERE id = $1", [userId])));

  const getHoldByRequestIdTx = async (c: Db, requestId: string): Promise<CreditHoldRow | null> => {
    const row = one(await q(c, "SELECT * FROM credit_holds WHERE request_id = $1", [requestId]));
    return row === null ? null : mapCreditHold(row);
  };

  const getHoldByIdTx = async (c: PoolClient, holdId: string): Promise<CreditHoldRow | null> => {
    const row = one(await q(c, "SELECT * FROM credit_holds WHERE id = $1", [holdId]));
    return row === null ? null : mapCreditHold(row);
  };

  const heldTx = async (c: PoolClient, userId: number, now: number, excludeId?: string): Promise<number> => {
    const row = excludeId === undefined
      ? one(await q(c, "SELECT COALESCE(SUM(amount_micro), 0) AS s FROM credit_holds WHERE user_id = $1 AND status = 'held' AND expires_at > $2", [userId, now]))
      : one(await q(c, "SELECT COALESCE(SUM(amount_micro), 0) AS s FROM credit_holds WHERE user_id = $1 AND status = 'held' AND expires_at > $2 AND id != $3", [userId, now, excludeId]));
    return row === null ? 0 : Number(row.s);
  };

  const availableTx = async (c: PoolClient, userId: number, now: number): Promise<number> =>
    (await getBalancesTx(c, userId)).total - (await heldTx(c, userId, now));

  const assertMicroAmount = (amountMicro: number, positive: boolean): void => {
    if (!Number.isSafeInteger(amountMicro) || (positive ? amountMicro <= 0 : amountMicro < 0)) {
      throw new Error(`invalid credit micro amount: ${amountMicro}`);
    }
  };

  const debitBucketsTx = async (
    c: PoolClient,
    userId: number,
    amountMicro: number,
    opts: {
      reason: string;
      sourceType: string | null;
      sourceId: string | null;
      idempotencyPrefix: string;
      allowOverdraft: boolean;
      now: number;
    },
  ): Promise<{ ok: boolean; chargedMicro: number; balance: CreditBalances }> => {
    const balances = await getBalancesTx(c, userId);
    if (amountMicro === 0) return { ok: true, chargedMicro: 0, balance: balances };
    const order: Array<{ bucket: string; balance: number }> = [
      { bucket: "bonus_carried", balance: balances.bonusCarried },
      { bucket: "bonus_current", balance: balances.bonusCurrent },
      { bucket: "purchased", balance: balances.purchased },
    ];
    let remaining = amountMicro;
    const parts: Array<{ bucket: string; amount: number; balanceAfter: number }> = [];
    for (const entry of order) {
      if (remaining <= 0) break;
      const take = Math.min(Math.max(0, entry.balance), remaining);
      if (take > 0) {
        parts.push({ bucket: entry.bucket, amount: take, balanceAfter: entry.balance - take });
        remaining -= take;
      }
    }
    if (remaining > 0) {
      if (!opts.allowOverdraft) return { ok: false, chargedMicro: 0, balance: balances };
      const purchasedPart = parts.find((p) => p.bucket === "purchased");
      if (purchasedPart !== undefined) {
        purchasedPart.amount += remaining;
        purchasedPart.balanceAfter -= remaining;
      } else {
        parts.push({ bucket: "purchased", amount: remaining, balanceAfter: balances.purchased - remaining });
      }
    }
    const columns: Record<string, string> = {
      purchased: "purchased_credits",
      bonus_carried: "bonus_carried",
      bonus_current: "bonus_current",
    };
    for (const part of parts) {
      const col = columns[part.bucket];
      if (col === undefined) throw new Error(`invalid credit bucket: ${part.bucket}`);
      await c.query(`UPDATE users SET ${col} = ${col} - $1 WHERE id = $2`, [part.amount, userId]);
      await c.query(
        "INSERT INTO credits_ledger (user_id, delta, bucket, reason, source_type, source_id, idempotency_key, balance_after, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        [userId, -part.amount, part.bucket, opts.reason, opts.sourceType, opts.sourceId, `${opts.idempotencyPrefix}:${part.bucket}`, part.balanceAfter, opts.now],
      );
    }
    return { ok: true, chargedMicro: amountMicro, balance: await getBalancesTx(c, userId) };
  };

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

    /** 按请求幂等键查 hold（reserve/settle/spend 共用）。 */
    getCreditHoldByRequestId: async (requestId: string): Promise<CreditHoldRow | null> =>
      getHoldByRequestIdTx(txDb(pool), requestId),

    /** 预占点数：不扣余额，只创建 hold；available = 三桶总额 - active holds。 */
    reserveCreditHold: async (
      userId: number,
      amountMicro: number,
      opts: { scopeType: string; scopeId?: string | null; requestId: string; ttlMs: number; now?: number },
    ): Promise<CreditHoldReserveResult> => {
      assertMicroAmount(amountMicro, true);
      if (opts.requestId.trim() === "") throw new Error("credit hold requestId required");
      if (!Number.isSafeInteger(opts.ttlMs) || opts.ttlMs <= 0) throw new Error("credit hold ttlMs must be a positive integer");
      const now = opts.now ?? Date.now();
      return withTransaction(pool, async (c) => {
        const existing = await getHoldByRequestIdTx(c, opts.requestId);
        if (existing !== null) {
          if (existing.userId !== userId) throw new Error("credit hold requestId belongs to another user");
          return { status: "existing", hold: existing, availableMicro: await availableTx(c, userId, now) };
        }
        const user = one(await q(c, "SELECT purchased_credits, bonus_carried, bonus_current FROM users WHERE id = $1 FOR UPDATE", [userId]));
        const available = balancesOf(user).total - (await heldTx(c, userId, now));
        if (available < amountMicro) return { status: "insufficient", hold: null, availableMicro: available };
        const hold: CreditHoldRow = {
          id: randomUUID(),
          userId,
          scopeType: opts.scopeType,
          scopeId: opts.scopeId ?? null,
          requestId: opts.requestId,
          amountMicro,
          settledMicro: 0,
          status: "held",
          expiresAt: now + opts.ttlMs,
          createdAt: now,
        };
        await c.query(
          "INSERT INTO credit_holds (id, user_id, scope_type, scope_id, request_id, amount_micro, settled_micro, status, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
          [hold.id, hold.userId, hold.scopeType, hold.scopeId, hold.requestId, hold.amountMicro, hold.settledMicro, hold.status, hold.expiresAt, hold.createdAt],
        );
        return { status: "held", hold, availableMicro: available - amountMicro };
      });
    },

    /** 结算 hold：按实际金额多桶扣减，写 consume 流水，释放差额。 */
    settleCreditHold: async (
      holdId: string,
      actualMicro: number,
      opts: { reason?: string; allowOverdraft?: boolean; now?: number } = {},
    ): Promise<CreditHoldSettleResult> => {
      assertMicroAmount(actualMicro, false);
      const now = opts.now ?? Date.now();
      return withTransaction(pool, async (c) => {
        const holdRow = one(await q(c, "SELECT * FROM credit_holds WHERE id = $1 FOR UPDATE", [holdId]));
        if (holdRow === null) {
          return { status: "not_found", chargedMicro: 0, balance: { purchased: 0, bonusCarried: 0, bonusCurrent: 0, total: 0 }, hold: null };
        }
        const hold = mapCreditHold(holdRow);
        const user = one(await q(c, "SELECT purchased_credits, bonus_carried, bonus_current FROM users WHERE id = $1 FOR UPDATE", [hold.userId]));
        const balance = balancesOf(user);
        if (hold.status === "settled") return { status: "already_settled", chargedMicro: hold.settledMicro, balance, hold };
        if (hold.status === "released") return { status: "released", chargedMicro: 0, balance, hold };
        const heldOther = await heldTx(c, hold.userId, now, holdId);
        if (actualMicro > balance.total - heldOther && opts.allowOverdraft !== true) {
          return { status: "insufficient", chargedMicro: 0, balance, hold };
        }
        const debit = await debitBucketsTx(c, hold.userId, actualMicro, {
          reason: opts.reason ?? "consume",
          sourceType: "credit_hold",
          sourceId: holdId,
          idempotencyPrefix: holdId,
          allowOverdraft: opts.allowOverdraft === true,
          now,
        });
        if (!debit.ok) return { status: "insufficient", chargedMicro: 0, balance, hold };
        await c.query("UPDATE credit_holds SET status = 'settled', settled_micro = $1 WHERE id = $2", [actualMicro, holdId]);
        const updated = await getHoldByIdTx(c, holdId);
        return { status: "settled", chargedMicro: actualMicro, balance: debit.balance, hold: updated };
      });
    },

    /** 释放 hold：只解冻，不写账本；已释放幂等 true，已结算 false。 */
    releaseCreditHold: async (holdId: string): Promise<boolean> =>
      withTransaction(pool, async (c) => {
        const row = one(await q(c, "SELECT * FROM credit_holds WHERE id = $1 FOR UPDATE", [holdId]));
        if (row === null) return false;
        const hold = mapCreditHold(row);
        if (hold.status === "released") return true;
        if (hold.status === "settled") return false;
        const r = await q(c, "UPDATE credit_holds SET status = 'released' WHERE id = $1 AND status IN ('held', 'expired')", [holdId]);
        return r.rowCount > 0;
      }),

    /** 无 hold 的批量扣减（relay 等已知金额场景）。 */
    spendCredits: async (
      userId: number,
      amountMicro: number,
      opts: { reason: string; sourceType?: string | null; sourceId?: string | null; idempotencyKey: string; allowOverdraft?: boolean; now?: number },
    ): Promise<CreditSpendResult> => {
      assertMicroAmount(amountMicro, true);
      if (opts.idempotencyKey.trim() === "") throw new Error("credit spend idempotencyKey required");
      const now = opts.now ?? Date.now();
      return withTransaction(pool, async (c) => {
        const existing = await getHoldByRequestIdTx(c, opts.idempotencyKey);
        if (existing !== null) {
          if (existing.userId !== userId) throw new Error("credit spend requestId belongs to another user");
          return { status: "already_spent", chargedMicro: existing.settledMicro, balance: await getBalancesTx(c, userId) };
        }
        const user = one(await q(c, "SELECT purchased_credits, bonus_carried, bonus_current FROM users WHERE id = $1 FOR UPDATE", [userId]));
        const balance = balancesOf(user);
        const available = balance.total - (await heldTx(c, userId, now));
        if (amountMicro > available && opts.allowOverdraft !== true) return { status: "insufficient", chargedMicro: 0, balance };
        const hold: CreditHoldRow = {
          id: randomUUID(),
          userId,
          scopeType: "spend",
          scopeId: null,
          requestId: opts.idempotencyKey,
          amountMicro,
          settledMicro: amountMicro,
          status: "settled",
          expiresAt: now,
          createdAt: now,
        };
        await c.query(
          "INSERT INTO credit_holds (id, user_id, scope_type, scope_id, request_id, amount_micro, settled_micro, status, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
          [hold.id, hold.userId, hold.scopeType, hold.scopeId, hold.requestId, hold.amountMicro, hold.settledMicro, hold.status, hold.expiresAt, hold.createdAt],
        );
        const debit = await debitBucketsTx(c, userId, amountMicro, {
          reason: opts.reason,
          sourceType: opts.sourceType ?? null,
          sourceId: opts.sourceId ?? null,
          idempotencyPrefix: opts.idempotencyKey,
          allowOverdraft: opts.allowOverdraft === true,
          now,
        });
        if (!debit.ok) {
          // 预检+行锁下不应发生；若发生，删除刚插入的 settled hold 再返回，避免脏幂等记录。
          await c.query("DELETE FROM credit_holds WHERE id = $1", [hold.id]);
          return { status: "insufficient", chargedMicro: 0, balance };
        }
        return { status: "spent", chargedMicro: amountMicro, balance: debit.balance };
      });
    },

    /** 把过期未结算的 hold 标记 expired；返回处理数量。 */
    sweepExpiredCreditHolds: async (now = Date.now()): Promise<number> => {
      const r = await q(txDb(pool), "UPDATE credit_holds SET status = 'expired' WHERE status = 'held' AND expires_at <= $1", [now]);
      return r.rowCount;
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
