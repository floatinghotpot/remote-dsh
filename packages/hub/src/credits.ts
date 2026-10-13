/**
 * credits.ts — 点数账本业务逻辑（09-credits-wallet）。
 *
 * 只做「进」（充值/赠点/退款冲正/结转）；「出」（消费扣减）归 31-relay-billing。
 * 内部一律用整数微单位（1 点数 = 10000），规避浮点误差；余额分桶：
 *   purchased     充值点数（永久）
 *   bonus_carried 上月结转的赠点（本月底到期）
 *   bonus_current 本月新发的赠点（下月底到期）
 */
import type { HubDb } from "./db.ts";

/** 1 点数 = 10000 微单位。 */
export const CREDITS_MICRO_PER_CREDIT = 10000;

/** 6 档点数充值商品（与 assets/iap_products.json 的 credits 档位一致）。 */
export interface CreditProduct {
  id: string;
  credits: number;
  priceUSD: number;
  priceCny: number;
}

export const CREDIT_PRODUCTS: CreditProduct[] = [
  { id: "credits_1_usd", credits: 800, priceUSD: 1.0, priceCny: 8.0 },
  { id: "credits_5_usd", credits: 5000, priceUSD: 5.0, priceCny: 38.0 },
  { id: "credits_10_usd", credits: 12000, priceUSD: 10.0, priceCny: 68.0 },
  { id: "credits_20_usd", credits: 25000, priceUSD: 20.0, priceCny: 138.0 },
  { id: "credits_50_usd", credits: 65000, priceUSD: 50.0, priceCny: 348.0 },
  { id: "credits_100_usd", credits: 140000, priceUSD: 100.0, priceCny: 698.0 },
];

export function creditProductById(id: string): CreditProduct | undefined {
  return CREDIT_PRODUCTS.find((p) => p.id === id);
}

/** 充值入账：purchased 桶 + delta 微单位。返回 false = 幂等键已存在（重复回调）。 */
export function creditRecharge(
  db: HubDb,
  userId: number,
  deltaMicro: number,
  opts: { sourceType: string; sourceId: string; idempotencyKey: string; now?: number },
): boolean {
  return db.appendCreditLedger(userId, deltaMicro, "purchased", "recharge", {
    sourceType: opts.sourceType,
    sourceId: opts.sourceId,
    idempotencyKey: opts.idempotencyKey,
    now: opts.now,
  });
}

/** 订阅赠点入账：bonus_current 桶（每月按档位，幂等键 = bonus_sub:<userId>:<period>）。 */
export function creditBonusMonthly(db: HubDb, userId: number, deltaMicro: number, opts: { period: string; now?: number }): boolean {
  return db.appendCreditLedger(userId, deltaMicro, "bonus_current", "bonus_subscription", {
    sourceType: "subscription",
    sourceId: opts.period,
    idempotencyKey: `bonus_sub:${userId}:${opts.period}`,
    now: opts.now,
  });
}

/** 退款冲正：purchased 桶负 delta（记录冲正流水，不自动撤已消耗权益）。 */
export function creditRefund(
  db: HubDb,
  userId: number,
  deltaMicro: number,
  opts: { platform: string; transactionId: string; now?: number },
): boolean {
  return db.appendCreditLedger(userId, -deltaMicro, "purchased", "refund", {
    sourceType: opts.platform,
    sourceId: opts.transactionId,
    idempotencyKey: `refund:${opts.platform}:${opts.transactionId}`,
    now: opts.now,
  });
}

/**
 * 每月结转（每月 1 号）：bonus_current 剩余 → bonus_carried；旧 bonus_carried 清零。
 * 每笔赠点最多结转一次（当月剩余带下月，下月月底仍未用完即作废）。
 */
export function carryOverCredits(db: HubDb, now = Date.now()): void {
  for (const userId of db.listUsersWithBonusCredits()) {
    const balances = db.getCreditBalances(userId);
    // 单用户结转（expire + current→carried）包一个事务，避免中途崩溃丢赠点（R16 可对账）。
    db.db.exec("BEGIN");
    try {
      // 旧 carried（上月结转）本月底到期 → 清零，不能二次结转。
      if (balances.bonusCarried > 0) {
        db.appendCreditLedger(userId, -balances.bonusCarried, "bonus_carried", "expire", { now });
      }
      // 本月 current 剩余 → 结转成新的 carried。
      if (balances.bonusCurrent > 0) {
        db.appendCreditLedger(userId, -balances.bonusCurrent, "bonus_current", "carry_over", { now });
        db.appendCreditLedger(userId, balances.bonusCurrent, "bonus_carried", "carry_over", { now });
      }
      db.db.exec("COMMIT");
    } catch (e) {
      db.db.exec("ROLLBACK");
      throw e;
    }
  }
}

/** 区域时区月份键 'YYYY-MM'（用于赠点幂等 period）。 */
function localMonthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * 每月结算（由 server 定时器调用，调用方负责「按月幂等」——只在跨月时调用一次）：
 * 1. 结转：bonus_current 剩余 → bonus_carried，旧 bonus_carried 清零；
 * 2. 赠点：订阅用户按档位 bonusCredits 入 bonus_current（幂等键含 period）。
 */
export function sweepCredits(db: HubDb, plans: Array<{ id: string; bonusCredits?: number }>, now = Date.now()): void {
  const period = localMonthKey(new Date(now));
  // 按月幂等：持久化「上次结算月份」，重启后同月不重复结转（否则二次结转会清零赠点）。
  if (db.getMeta("credits_last_sweep_month") === period) return;
  carryOverCredits(db, now);
  for (const user of db.listUsers()) {
    if (user.planStatus !== "subscribed") continue;
    const sub = db.getLatestSubscription(user.id);
    if (sub === null) continue;
    const plan = plans.find((p) => p.id === sub.planId);
    if (plan === undefined || (plan.bonusCredits ?? 0) <= 0) continue;
    creditBonusMonthly(db, user.id, (plan.bonusCredits ?? 0) * CREDITS_MICRO_PER_CREDIT, { period });
  }
  db.setMeta("credits_last_sweep_month", period);
}
