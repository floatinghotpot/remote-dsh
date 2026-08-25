/**
 * ratelimit.ts — 固定窗口计数限流（发信风控三层：收件人/触发者/全局）。
 *
 * 进程内 Map，重启清零（可接受：防刷是软限制，审计兜底；重发 60s 用 email_codes.created_at 判）。
 */
export class DailyWindowLimiter {
  private readonly max: number;
  private readonly state = new Map<string, { day: number; count: number }>();

  constructor(max: number) {
    this.max = max;
  }

  private dayKey(now = Date.now()): number {
    return Math.floor(now / 86_400_000);
  }

  /** 当前窗口已用次数。 */
  used(key: string): number {
    const s = this.state.get(key);
    return s !== undefined && s.day === this.dayKey() ? s.count : 0;
  }

  /** 计数 +1。 */
  count(key: string): void {
    const day = this.dayKey();
    const s = this.state.get(key);
    if (s !== undefined && s.day === day) s.count += 1;
    else this.state.set(key, { day, count: 1 });
  }

  /** 是否已达上限。 */
  isLimited(key: string): boolean {
    return this.used(key) >= this.max;
  }
}
