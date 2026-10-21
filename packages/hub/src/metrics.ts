import { monitorEventLoopDelay } from "node:perf_hooks";
import type { PresenceDirectory } from "./presence.ts";
import type { UsageStats } from "./relay-usage.ts";

/** 42-hub-write-path P0：Hub 运行指标（admin 端点读取）。 */
export class HubMetrics {
  private readonly loop = monitorEventLoopDelay({ resolution: 20 });

  constructor() {
    this.loop.enable();
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
    };
  }

  close(): void {
    this.loop.disable();
  }
}
