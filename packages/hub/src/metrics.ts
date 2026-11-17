import { monitorEventLoopDelay } from "node:perf_hooks";
import type { PresenceDirectory } from "./presence.ts";
import type { UsageStats } from "./relay-usage.ts";

/** 42-hub-write-path P0：Hub 运行指标（admin 端点读取）。 */
export class HubMetrics {
  private readonly loop = monitorEventLoopDelay({ resolution: 20 });
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();

  constructor() {
    this.loop.enable();
  }

  /** 自增命名计数器（refresh.ok / refresh.grace / refresh.invalid / refresh.suspectedReuse 等）。 */
  inc(name: string): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + 1);
  }

  private counter(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  /** 设置命名 gauge（如 `node.heartbeat.lastBodyBytes`）。 */
  gauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  /** 读 gauge（缺省 0）。 */
  gaugeValue(name: string): number {
    return this.gauges.get(name) ?? 0;
  }

  snapshot(usage: UsageStats, presence: PresenceDirectory): Record<string, unknown> {
    return {
      at: Date.now(),
      eventLoop: {
        p50Ms: Number((this.loop.percentile(50) / 1e6).toFixed(2)),
        p99Ms: Number((this.loop.percentile(99) / 1e6).toFixed(2)),
        maxMs: Number((this.loop.max / 1e6).toFixed(2)),
      },
      usage,
      presence: { hosts: presence.size() },
      auth: {
        refreshOk: this.counter("refresh.ok"),
        refreshGrace: this.counter("refresh.grace"),
        refreshInvalid: this.counter("refresh.invalid"),
        refreshSuspectedReuse: this.counter("refresh.suspectedReuse"),
      },
    };
  }

  close(): void {
    this.loop.disable();
  }
}
