/**
 * credits.ts — 点数账本业务逻辑（09-credits-wallet）。
 *
 * 只做「进」（充值/赠点/退款冲正/结转）；「出」（消费扣减）归 31-relay-billing。
 * 内部一律用整数微单位（1 点数 = 10000），规避浮点误差；余额分桶：
 *   purchased     充值点数（永久）
 *   bonus_carried 上周期结转的赠点（本周期末作废）
 *   bonus_current 本周期新发的赠点（下周期末作废）
 * 赠点由「订阅生命周期事件」驱动（订阅发首月、续订发下月+结转、到期清零），不再是自然月定时器。
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

/** 订阅赠点入账原语：bonus_current 桶（幂等键 = bonus_sub:<userId>:<period>，微单位）。 */
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

/** 订阅赠点入账（事件驱动，取「点数」为单位）：入 bonus_current，幂等键 = bonus_sub:{userId}:{periodKey}。 */
export async function grantSubscriptionBonus(
  store: HubStore,
  userId: number,
  credits: number,
  periodKey: string,
  now = Date.now(),
): Promise<boolean> {
  return creditBonusMonthly(store, userId, credits * CREDITS_MICRO_PER_CREDIT, { period: periodKey, now });
}

/**
 * 单用户结转（订阅续订事件触发）：旧 bonus_carried 作废，bonus_current 剩余 → bonus_carried。
 * ⚠️ 必须在调用方的 `withTransaction` 内调用（webhook 已包事务，此处不再自开事务，避免 BEGIN 嵌套）。
 * 幂等：用 meta 键标记（`bonus_carry:{userId}:{periodKey}`），续订 webhook 重投时整体跳过，不二次清零 carried，也不污染账本。
 */
export async function carryOverUserBonus(store: HubStore, userId: number, periodKey: string, now = Date.now()): Promise<void> {
  const markerKey = `bonus_carry:${userId}:${periodKey}`;
  if ((await store.getMeta(markerKey)) !== null) return; // 已结转
  const balances = await store.getCreditBalances(userId);
  if (balances.bonusCarried > 0) {
    await store.appendCreditLedger(userId, -balances.bonusCarried, "bonus_carried", "expire", { now });
  }
  if (balances.bonusCurrent > 0) {
    await store.appendCreditLedger(userId, -balances.bonusCurrent, "bonus_current", "carry_over", { now });
    await store.appendCreditLedger(userId, balances.bonusCurrent, "bonus_carried", "carry_over", { now });
  }
  await store.setMeta(markerKey, String(now));
}

/** 到期清零：bonus_current 与 bonus_carried 全部归零（purchased 保留）。余额为零后再次调用为 no-op。 */
export async function clearUserBonus(store: HubStore, userId: number, now = Date.now()): Promise<void> {
  const balances = await store.getCreditBalances(userId);
  await store.withTransaction(async () => {
    if (balances.bonusCarried > 0) {
      await store.appendCreditLedger(userId, -balances.bonusCarried, "bonus_carried", "expire", { now });
    }
    if (balances.bonusCurrent > 0) {
      await store.appendCreditLedger(userId, -balances.bonusCurrent, "bonus_current", "expire", { now });
    }
  });
}
