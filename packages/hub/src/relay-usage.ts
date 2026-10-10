import { randomUUID } from "node:crypto";
import type { HubDb } from "./db.ts";

/** 本地时区日界 'YYYY-MM-DD'（与 req R13 区域时区切日一致）。 */
export function localDate(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

interface RelayRow {
  userId: number;
  hostId: string;
  relayBytesUp: number;
  relayBytesDown: number;
  sessions: number;
}

/**
 * relay 转发侧计量（11-usage-analytics 第二轮 F6/F8）：
 * 按「访问者 × 主机 × 天」累计中转字节/会话数，只加长度、绝不 hold payload。
 * 一个 hub 进程一个实例；`instanceId` 随进程重启变化 ⇒ 服务端按「同实例 MAX、跨实例 SUM」合并。
 */
export class RelayUsageMeter {
  readonly instanceId: string = randomUUID();
  private day = localDate();
  private rows = new Map<string, RelayRow>();

  private readonly db: HubDb;

  constructor(db: HubDb) {
    this.db = db;
  }

  addBytes(userId: number, hostId: string, up: number, down: number): void {
    if (up === 0 && down === 0) return;
    this.rollDayIfNeeded();
    const key = `${userId}\u0000${hostId}`;
    let r = this.rows.get(key);
    if (r === undefined) {
      r = { userId, hostId, relayBytesUp: 0, relayBytesDown: 0, sessions: 1 };
      this.rows.set(key, r);
    }
    r.relayBytesUp += up;
    r.relayBytesDown += down;
  }

  /** 跨日：先 flush 旧日累计，再清空切到新日（F13：不丢午夜窗口）。 */
  private rollDayIfNeeded(): void {
    const today = localDate();
    if (today !== this.day) {
      this.report(this.day);
      this.rows.clear();
      this.day = today;
    }
  }

  /** 上报当日**累计值**（不清空），保持「同实例 MAX」幂等语义（F9）。时长字段本阶段为 0。 */
  flush(): void {
    this.rollDayIfNeeded();
    this.report(this.day);
  }

  private report(day: string): void {
    for (const r of this.rows.values()) {
      this.db.upsertUsageDaily(
        r.userId,
        {
          date: day,
          relaySeconds: 0,
          relayBytesUp: r.relayBytesUp,
          relayBytesDown: r.relayBytesDown,
          directBytesUp: 0,
          directBytesDown: 0,
          cloudAsrSeconds: 0,
          localAsrSeconds: 0,
          sessions: r.sessions,
        },
        { hostId: r.hostId, instanceId: this.instanceId, source: "relay" },
      );
    }
  }
}
