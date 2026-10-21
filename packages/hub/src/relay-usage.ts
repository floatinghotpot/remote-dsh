import { randomUUID } from "node:crypto";
import type { HubStore } from "./store.ts";
import type { UsageBatchRow, UsageDayValues, UsageValues } from "./db.ts";

/** 本地时区日界 'YYYY-MM-DD'（与 req R13 区域时区切日一致）。 */
export function localDate(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function zeroValues(): UsageValues {
  return {
    relaySeconds: 0,
    relayBytesUp: 0,
    relayBytesDown: 0,
    directBytesUp: 0,
    directBytesDown: 0,
    cloudAsrSeconds: 0,
    localAsrSeconds: 0,
    cloudTtsChars: 0,
    localTtsChars: 0,
    sessions: 0,
  };
}

interface AccRow {
  userId: number;
  hostId: string;
  date: string;
  instanceId: string;
  source: string;
  v: UsageValues;
}

export interface UsageStats {
  rows: number;
  dirty: number;
  pending: number;
  flushCount: number;
  lastFlushMs: number;
  lastFlushRows: number;
  errorCount: number;
  lastError: string | null;
  batchEnabled: boolean;
}

/**
 * Hub 侧统一用量累加器（42-hub-write-path P0；43b 起走异步 store）。
 *
 * - relay 转发：`addRelayBytes` **同步**增量累加（数据面热路径，不落库）；
 * - host 上报：`reportHostUsage` 接收「当日累计值」，同 key 按字段 MAX 合并（async，批量直写降级时 await）；
 * - `flush`：**异步**，把「跨日 pending + dirty」行分批写库（chunk 事务）；
 * - 跨日：`addRelayBytes` 同步把旧日行移入 `pending`（不落库），`flush` 再异步写；午夜窗口不丢。
 */
export class UsageAccumulator {
  readonly instanceId: string = randomUUID();
  private day = localDate();
  private rows = new Map<string, AccRow>();
  private dirty = new Set<string>();
  private pending: AccRow[] = [];
  private readonly batchEnabled = process.env.RDSH_USAGE_BATCH !== "0";
  private readonly chunkSize = (() => {
    const n = Number(process.env.RDSH_USAGE_CHUNK ?? 500);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 500;
  })();
  private flushCount = 0;
  private lastFlushMs = 0;
  private lastFlushRows = 0;
  private errorCount = 0;
  private lastError: string | null = null;

  private readonly store: HubStore;

  constructor(store: HubStore) {
    this.store = store;
  }

  /** 数据面热路径：只做内存累计，绝不落库、绝不 await。 */
  addRelayBytes(userId: number, hostId: string, up: number, down: number): void {
    if (up === 0 && down === 0) return;
    this.rollDayIfNeeded();
    const key = this.key(userId, hostId, this.day, this.instanceId, "relay");
    let r = this.rows.get(key);
    if (r === undefined) {
      r = { userId, hostId, date: this.day, instanceId: this.instanceId, source: "relay", v: zeroValues() };
      r.v.sessions = 1;
      this.rows.set(key, r);
    }
    r.v.relayBytesUp += up;
    r.v.relayBytesDown += down;
    this.dirty.add(key);
  }

  async reportHostUsage(userId: number, hostId: string, instanceId: string, day: UsageDayValues): Promise<void> {
    if (!this.batchEnabled) {
      await this.store.upsertUsageDaily(userId, day, { hostId, instanceId, source: "gateway" });
      return;
    }
    this.rollDayIfNeeded();
    const key = this.key(userId, hostId, day.date, instanceId, "gateway");
    let r = this.rows.get(key);
    if (r === undefined) {
      r = { userId, hostId, date: day.date, instanceId, source: "gateway", v: zeroValues() };
      this.rows.set(key, r);
    }
    mergeMax(r.v, day);
    this.dirty.add(key);
  }

  /** 跨日：同步把旧日全部行移入 pending（不落库），由 flush 异步写。 */
  private rollDayIfNeeded(): void {
    const today = localDate();
    if (today === this.day) return;
    for (const r of this.rows.values()) this.pending.push(r);
    this.rows.clear();
    this.dirty.clear();
    this.day = today;
  }

  /** 异步落库 pending + dirty；失败保留（下次 flush 重试）。 */
  async flush(): Promise<void> {
    this.rollDayIfNeeded();
    const rows: UsageBatchRow[] = [];
    for (const r of this.pending) rows.push(this.toBatch(r));
    for (const key of this.dirty) {
      const r = this.rows.get(key);
      if (r !== undefined) rows.push(this.toBatch(r));
    }
    if (rows.length === 0) {
      this.lastFlushMs = 0;
      this.lastFlushRows = 0;
      return;
    }
    const started = Date.now();
    try {
      const written = await this.store.upsertUsageDailyBatch(rows, this.chunkSize);
      this.lastFlushRows = written;
      this.lastFlushMs = Date.now() - started;
      this.flushCount += 1;
      this.pending = [];
      this.dirty.clear();
      this.lastError = null;
    } catch (err) {
      this.errorCount += 1;
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  stats(): UsageStats {
    return {
      rows: this.rows.size,
      dirty: this.dirty.size,
      pending: this.pending.length,
      flushCount: this.flushCount,
      lastFlushMs: this.lastFlushMs,
      lastFlushRows: this.lastFlushRows,
      errorCount: this.errorCount,
      lastError: this.lastError,
      batchEnabled: this.batchEnabled,
    };
  }

  private key(userId: number, hostId: string, date: string, instanceId: string, source: string): string {
    return `${userId}\u0000${hostId}\u0000${date}\u0000${instanceId}\u0000${source}`;
  }

  private toBatch(r: AccRow): UsageBatchRow {
    return {
      userId: r.userId,
      day: { date: r.date, ...r.v },
      meta: { hostId: r.hostId, instanceId: r.instanceId, source: r.source },
    };
  }
}

function mergeMax(target: UsageValues, incoming: UsageValues): void {
  target.relaySeconds = Math.max(target.relaySeconds, incoming.relaySeconds);
  target.relayBytesUp = Math.max(target.relayBytesUp, incoming.relayBytesUp);
  target.relayBytesDown = Math.max(target.relayBytesDown, incoming.relayBytesDown);
  target.directBytesUp = Math.max(target.directBytesUp, incoming.directBytesUp);
  target.directBytesDown = Math.max(target.directBytesDown, incoming.directBytesDown);
  target.cloudAsrSeconds = Math.max(target.cloudAsrSeconds, incoming.cloudAsrSeconds);
  target.localAsrSeconds = Math.max(target.localAsrSeconds, incoming.localAsrSeconds);
  target.cloudTtsChars = Math.max(target.cloudTtsChars, incoming.cloudTtsChars);
  target.localTtsChars = Math.max(target.localTtsChars, incoming.localTtsChars);
  target.sessions = Math.max(target.sessions, incoming.sessions);
}
