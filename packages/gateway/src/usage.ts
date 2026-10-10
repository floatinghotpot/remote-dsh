/**
 * usage.ts — 用量计量器（11-usage-analytics T3b）。
 *
 * 只加字节长度 / 会话时长，**绝不 hold payload**（大流不能缓冲）。
 * 中转（relay）与直连（direct）的上下行分开计；按 host×day 由调用方 flush 上报。
 */

export interface UsageSnapshot {
  relayBytesUp: number;
  relayBytesDown: number;
  directBytesUp: number;
  directBytesDown: number;
  relaySeconds: number;
  sessions: number;
}

export class UsageMeter {
  private relayBytesUp = 0;
  private relayBytesDown = 0;
  private directBytesUp = 0;
  private directBytesDown = 0;
  private relaySeconds = 0;
  private sessions = 0;
  private sessionStartedAt = 0;

  addRelayUp(n: number): void {
    this.relayBytesUp += n;
  }

  addRelayDown(n: number): void {
    this.relayBytesDown += n;
  }

  addDirectUp(n: number): void {
    this.directBytesUp += n;
  }

  addDirectDown(n: number): void {
    this.directBytesDown += n;
  }

  /** 一个使用会话开始（join 隧道连上）。 */
  sessionStart(): void {
    this.sessions += 1;
    this.sessionStartedAt = Date.now();
  }

  /** 会话结束，累计时长（秒）。 */
  sessionEnd(): void {
    if (this.sessionStartedAt === 0) return;
    this.relaySeconds += Math.max(0, Math.round((Date.now() - this.sessionStartedAt) / 1000));
    this.sessionStartedAt = 0;
  }

  snapshot(): UsageSnapshot {
    return {
      relayBytesUp: this.relayBytesUp,
      relayBytesDown: this.relayBytesDown,
      directBytesUp: this.directBytesUp,
      directBytesDown: this.directBytesDown,
      relaySeconds: this.relaySeconds,
      sessions: this.sessions,
    };
  }

  /** 跨日清零（日报的累计值已在上一次 flush 上报）。 */
  reset(): void {
    this.relayBytesUp = 0;
    this.relayBytesDown = 0;
    this.directBytesUp = 0;
    this.directBytesDown = 0;
    this.relaySeconds = 0;
    this.sessions = 0;
    this.sessionStartedAt = 0;
  }
}

/** 本地时区日界 'YYYY-MM-DD'（与 req R13 的区域时区切日一致）。 */
export function localDate(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
