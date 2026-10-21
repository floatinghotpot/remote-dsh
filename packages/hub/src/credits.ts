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
import type { HubStore } from "./store.ts";

/** 1 点数 = 10000 微单位。 */
export const CREDITS_MICRO_PER_CREDIT = 10000;

/**
 * 点数充值档位 —— **来自 `config.billing.credits`，不在代码里写死**（与订阅 `billing.plans` 同构）。
 *
 * 权威清单由 App 仓库的 assets/iap_products.json 维护（App 与商店导出共用），
 * 部署时同步到 hub 配置；hub 只关心「某 goodsId 送多少点数」与「下单记多少钱」。
 */
export interface CreditProduct {
  id: string;
  credits: number;
  priceCny: number;
  /** USD 参考价（可选，仅作展示/对账元数据；hub 逻辑不读）。 */
  priceUsd?: number;
  /** 促销角标「推荐」（来自商品清单；仅展示，hub 逻辑不读）。 */
  isPopular?: boolean;
  /** 促销角标「最划算」（来自商品清单；仅展示，hub 逻辑不读）。 */
  isBestValue?: boolean;
}

export function creditProductById(
  products: readonly CreditProduct[],
  id: string,
): CreditProduct | undefined {
  return products.find((p) => p.id === id);
}

/** 充值入账：purchased 桶 + delta 微单位。返回 false = 幂等键已存在（重复回调）。 */
export async function creditRecharge(
  store: HubStore,
  userId: number,
  deltaMicro: number,
  opts: { sourceType: string; sourceId: string; idempotencyKey: string; now?: number },
): Promise<boolean> {
  return store.appendCreditLedger(userId, deltaMicro, "purchased", "recharge", {
    sourceType: opts.sourceType,
    sourceId: opts.sourceId,
    idempotencyKey: opts.idempotencyKey,
    now: opts.now,
  });
}

/** 订阅赠点入账：bonus_current 桶（每月按档位，幂等键 = bonus_sub:<userId>:<period>）。 */
export async function creditBonusMonthly(store: HubStore, userId: number, deltaMicro: number, opts: { period: string; now?: number }): Promise<boolean> {
  return store.appendCreditLedger(userId, deltaMicro, "bonus_current", "bonus_subscription", {
    sourceType: "subscription",
    sourceId: opts.period,
    idempotencyKey: `bonus_sub:${userId}:${opts.period}`,
    now: opts.now,
  });
}

/** 退款冲正：purchased 桶负 delta（记录冲正流水，不自动撤已消耗权益）。 */
export async function creditRefund(
  store: HubStore,
  userId: number,
  deltaMicro: number,
  opts: { platform: string; transactionId: string; now?: number },
): Promise<boolean> {
  return store.appendCreditLedger(userId, -deltaMicro, "purchased", "refund", {
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
export async function carryOverCredits(store: HubStore, now = Date.now()): Promise<void> {
  for (const userId of await store.listUsersWithBonusCredits()) {
    const balances = await store.getCreditBalances(userId);
    // 单用户结转（expire + current→carried）包一个事务，避免中途崩溃丢赠点（R16 可对账）。
    await store.withTransaction(async () => {
      // 旧 carried（上月结转）本月底到期 → 清零，不能二次结转。
      if (balances.bonusCarried > 0) {
        await store.appendCreditLedger(userId, -balances.bonusCarried, "bonus_carried", "expire", { now });
      }
      // 本月 current 剩余 → 结转成新的 carried。
      if (balances.bonusCurrent > 0) {
        await store.appendCreditLedger(userId, -balances.bonusCurrent, "bonus_current", "carry_over", { now });
        await store.appendCreditLedger(userId, balances.bonusCurrent, "bonus_carried", "carry_over", { now });
      }
    });
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
export async function sweepCredits(store: HubStore, plans: Array<{ id: string; bonusCredits?: number }>, now = Date.now()): Promise<void> {
  const period = localMonthKey(new Date(now));
  // 按月幂等：持久化「上次结算月份」，重启后同月不重复结转（否则二次结转会清零赠点）。
  if ((await store.getMeta("credits_last_sweep_month")) === period) return;
  await carryOverCredits(store, now);
  for (const user of await store.listUsers()) {
    if (user.planStatus !== "subscribed") continue;
    const sub = await store.getLatestSubscription(user.id);
    if (sub === null) continue;
    const plan = plans.find((p) => p.id === sub.planId);
    if (plan === undefined || (plan.bonusCredits ?? 0) <= 0) continue;
    await creditBonusMonthly(store, user.id, (plan.bonusCredits ?? 0) * CREDITS_MICRO_PER_CREDIT, { period });
  }
  await store.setMeta("credits_last_sweep_month", period);
}
