/**
 * 42-hub-write-path P0：在线状态内存目录。
 *
 * 由 N2 心跳的 host 列表（或兼容的 N4 单主机事件）驱动，TTL 90s（3× 30s 心跳）。
 * 在线是「可再推导的投影」：Hub 重启后目录为空，节点下一次心跳（≤30s）即恢复。
 * 权威归属仍在 `hosts.node_id`（分配/迁移时写一次）。
 */
export interface PresenceEntry {
  nodeId: string;
  at: number;
}

export class PresenceDirectory {
  private readonly byHost = new Map<string, PresenceEntry>();
  private readonly byNode = new Map<string, Set<string>>();

  private readonly ttlMs: number;

  constructor(ttlMs = 90_000) {
    this.ttlMs = ttlMs;
  }

  /** 用节点上报的完整在线 host 集合替换该节点的 presence；集合外的主机下线。 */
  setNodeHosts(nodeId: string, hostIds: string[], now = Date.now()): void {
    const next = new Set(hostIds);
    const prev = this.byNode.get(nodeId);
    if (prev !== undefined) {
      for (const hostId of prev) {
        if (!next.has(hostId) && this.byHost.get(hostId)?.nodeId === nodeId) this.byHost.delete(hostId);
      }
    }
    for (const hostId of next) this.byHost.set(hostId, { nodeId, at: now });
    this.byNode.set(nodeId, next);
  }

  /** N4 兼容：单主机上线/下线（不写 DB）。 */
  set(hostId: string, nodeId: string, online: boolean, now = Date.now()): void {
    if (online) {
      this.byHost.set(hostId, { nodeId, at: now });
      let hosts = this.byNode.get(nodeId);
      if (hosts === undefined) {
        hosts = new Set();
        this.byNode.set(nodeId, hosts);
      }
      hosts.add(hostId);
      return;
    }
    this.byHost.delete(hostId);
    const hosts = this.byNode.get(nodeId);
    if (hosts !== undefined) {
      hosts.delete(hostId);
      if (hosts.size === 0) this.byNode.delete(nodeId);
    }
  }

  isOnline(hostId: string, now = Date.now()): boolean {
    const entry = this.byHost.get(hostId);
    if (entry === undefined) return false;
    if (now - entry.at > this.ttlMs) {
      this.set(hostId, entry.nodeId, false, now);
      return false;
    }
    return true;
  }

  nodeIdOf(hostId: string, now = Date.now()): string | null {
    return this.isOnline(hostId, now) ? (this.byHost.get(hostId)?.nodeId ?? null) : null;
  }

  size(): number {
    return this.byHost.size;
  }

  /** 清理过期项；返回清理数量（供指标/定时器）。 */
  sweep(now = Date.now()): number {
    let removed = 0;
    for (const [hostId, entry] of this.byHost) {
      if (now - entry.at > this.ttlMs) {
        this.set(hostId, entry.nodeId, false, now);
        removed += 1;
      }
    }
    return removed;
  }
}
