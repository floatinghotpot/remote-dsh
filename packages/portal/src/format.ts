/**
 * 点数展示格式：四舍五入到整数并加千分位。
 *
 * 账本以整数微单位存储（1 点数 = 10000 微单位），换算成点数后可能带小数残值；
 * 对用户而言点数是整数，因此展示统一取整（与 App 用量页 / 充值页一致）。
 */
export const CREDITS_MICRO = 10000;

/** `value` 以「点数」为单位（已除过 10000）。 */
export function formatCredits(value: number): string {
  return roundHalfAwayFromZero(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * 四舍五入、`.5` 远离零（与 Dart `num.round()` 一致，保证 App/Portal 对负数
 * 半值取整不漂移；JS 的 `Math.round` 对负半值向 +∞ 取整）。
 */
function roundHalfAwayFromZero(value: number): number {
  return value >= 0 ? Math.round(value) : -Math.round(-value);
}

/** `micro` 以「微点数」为单位（1 点数 = 10000）；内部先换算再格式化。 */
export function formatCreditsFromMicro(micro: number): string {
  return formatCredits(micro / CREDITS_MICRO);
}

/**
 * 价格费率（点/单位，微单位入参）—— 保留最多 4 位小数，与 1/10000 的微单位精度
 * 一致，避免把 0.0004 点/单位 显示成 0.0。
 */
export function formatRatePoints(micro: number): string {
  return (micro / CREDITS_MICRO).toLocaleString(undefined, {
    maximumFractionDigits: 4,
  });
}
