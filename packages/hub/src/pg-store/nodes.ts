/**
 * pg-store/nodes.ts — 43b-2：nodes / relay join / audit 领域的 PG 端口（从 db.ts 同名方法照搬）。
 *
 * SQLite 方言转换：?→$n、INSERT OR REPLACE→ON CONFLICT、.run/.get/.all→pool.query/q/one、
 * 布尔落库 0/1、bigint 读回用 Number() 归一。复用 ./mappers.ts 的 mapNode/mapAudit/q/one。
 * mapRelayJoinToken / mapRelayJoinEvent 在 db.ts 是 private，mappers.ts 未导出，故在本地内联。
 */
import type { Pool } from "pg";
import { txDb } from "../pg.ts";
import type {
  NodeRow,
  RelayJoinTokenRow,
  RelayJoinEventRow,
  NodeBandwidth,
  AuditEventRow,
} from "../db.ts";
import type { HubStore } from "../store.ts";
import { mapNode, mapAudit, q, one } from "./mappers.ts";

function mapRelayJoinToken(row: Record<string, unknown>): RelayJoinTokenRow {
  return {
    id: String(row.id),
    name: String(row.name),
    tokenHash: String(row.token_hash),
    tokenPlaintext: String(row.token_plaintext),
    createdBy: Number(row.created_by),
    createdAt: Number(row.created_at),
    revokedAt: row.revoked_at === null || row.revoked_at === undefined ? null : Number(row.revoked_at),
  };
}

function mapRelayJoinEvent(row: Record<string, unknown>): RelayJoinEventRow {
  return {
    id: String(row.id),
    tokenId: String(row.token_id),
    nodeId: String(row.node_id),
    srcIp: row.src_ip === null || row.src_ip === undefined ? null : String(row.src_ip),
    at: Number(row.at),
  };
}

export function nodes(pool: Pool): Pick<
  HubStore,
  | "createNode"
  | "getNodeById"
  | "findNodeByTokenHash"
  | "listNodes"
  | "listNodesPage"
  | "createRelayJoinToken"
  | "findRelayJoinTokenByHash"
  | "getRelayJoinToken"
  | "listRelayJoinTokens"
  | "renameRelayJoinToken"
  | "revokeRelayJoinToken"
  | "recordRelayJoinEvent"
  | "listRelayJoinEvents"
  | "setNodeEnabled"
  | "updateNodeLastIp"
  | "updateNodeHeartbeat"
  | "updateNodeStatus"
  | "updateNodeName"
  | "markNodesOffline"
  | "markNodeAlive"
  | "recordNodeMetric"
  | "nodeBandwidth"
  | "removeNode"
  | "pickNode"
  | "recordAudit"
  | "listAudit"
  | "listAuditPage"
  | "pruneAudit"
> {
  const listAuditPage = async (
    filter: { userId?: number; event?: string; since?: number; source?: string } = {},
    limit = 50,
    offset = 0,
  ): Promise<{ rows: AuditEventRow[]; total: number }> => {
    const clauses: string[] = [];
    const params: Array<number | string> = [];
    if (filter.userId !== undefined) {
      clauses.push(`user_id = $${params.length + 1}`);
      params.push(filter.userId);
    }
    if (filter.event !== undefined) {
      clauses.push(`event = $${params.length + 1}`);
      params.push(filter.event);
    }
    if (filter.since !== undefined) {
      clauses.push(`created_at >= $${params.length + 1}`);
      params.push(filter.since);
    }
    if (filter.source !== undefined) {
      clauses.push(`source = $${params.length + 1}`);
      params.push(filter.source);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const total = Number(one(await q(txDb(pool), `SELECT COUNT(*) AS c FROM audit_events${where}`, params))?.c ?? 0);
    const rows = (await q(txDb(pool), `SELECT * FROM audit_events${where} ORDER BY id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, limit, offset])).rows.map((r) =>
      mapAudit(r),
    );
    return { rows, total };
  };

  return {
    createNode: async (
      id: string,
      name: string,
      advertiseUrl: string,
      tokenHash: string,
      region: string,
      capacity: number,
      weight: number,
      enabled: boolean,
      lastIp: string | null,
      now: number = Date.now(),
    ): Promise<NodeRow> => {
      const r = await q(txDb(pool),
        "INSERT INTO nodes (id, name, advertise_url, token_hash, region, status, enabled, last_ip, capacity, weight, created_at) VALUES ($1, $2, $3, $4, $5, 'online', $6, $7, $8, $9, $10) RETURNING *",
        [id, name, advertiseUrl, tokenHash, region, enabled ? 1 : 0, lastIp, capacity, weight, now],
      );
      return mapNode(one(r)!);
    },

    getNodeById: async (id: string): Promise<NodeRow | null> => {
      const row = one(await q(txDb(pool), "SELECT * FROM nodes WHERE id = $1", [id]));
      return row === null ? null : mapNode(row);
    },

    findNodeByTokenHash: async (tokenHash: string): Promise<NodeRow | null> => {
      const row = one(await q(txDb(pool), "SELECT * FROM nodes WHERE token_hash = $1", [tokenHash]));
      return row === null ? null : mapNode(row);
    },

    listNodes: async (): Promise<NodeRow[]> => {
      const rows = (await q(txDb(pool), "SELECT * FROM nodes ORDER BY created_at")).rows;
      return rows.map((r) => mapNode(r));
    },

    listNodesPage: async (limit = 50, offset = 0): Promise<{ rows: NodeRow[]; total: number }> => {
      const total = Number(one(await q(txDb(pool), "SELECT COUNT(*) AS c FROM nodes"))?.c ?? 0);
      const rows = (await q(txDb(pool), "SELECT * FROM nodes ORDER BY created_at, id LIMIT $1 OFFSET $2", [limit, offset])).rows.map((r) =>
        mapNode(r),
      );
      return { rows, total };
    },

    createRelayJoinToken: async (
      id: string,
      name: string,
      tokenHash: string,
      tokenPlaintext: string,
      createdBy: number,
      now: number = Date.now(),
    ): Promise<RelayJoinTokenRow> => {
      const r = await q(txDb(pool),
        "INSERT INTO relay_join_tokens (id, name, token_hash, token_plaintext, created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *",
        [id, name, tokenHash, tokenPlaintext, createdBy, now],
      );
      return mapRelayJoinToken(one(r)!);
    },

    findRelayJoinTokenByHash: async (tokenHash: string): Promise<RelayJoinTokenRow | null> => {
      const row = one(await q(txDb(pool), "SELECT * FROM relay_join_tokens WHERE token_hash = $1", [tokenHash]));
      return row === null ? null : mapRelayJoinToken(row);
    },

    getRelayJoinToken: async (id: string): Promise<RelayJoinTokenRow | null> => {
      const row = one(await q(txDb(pool), "SELECT * FROM relay_join_tokens WHERE id = $1", [id]));
      return row === null ? null : mapRelayJoinToken(row);
    },

    listRelayJoinTokens: async (): Promise<Array<{ id: string; name: string; createdAt: number; revokedAt: number | null; joinCount: number; tokenTail4: string; tokenPlaintext: string }>> => {
      const rows = (
        await q(txDb(pool),
          "SELECT t.id, t.name, t.created_at, t.revoked_at, t.token_plaintext, substr(t.token_plaintext, -4) AS token_tail4, (SELECT COUNT(*) FROM relay_join_events e WHERE e.token_id = t.id) AS join_count FROM relay_join_tokens t ORDER BY t.created_at",
        )
      ).rows;
      return rows.map((r) => ({
        id: String(r.id),
        name: String(r.name),
        createdAt: Number(r.created_at),
        revokedAt: r.revoked_at === null || r.revoked_at === undefined ? null : Number(r.revoked_at),
        joinCount: Number(r.join_count ?? 0),
        tokenTail4: String(r.token_tail4 ?? ""),
        tokenPlaintext: String(r.token_plaintext ?? ""),
      }));
    },

    renameRelayJoinToken: async (id: string, name: string): Promise<boolean> => {
      const r = await q(txDb(pool), "UPDATE relay_join_tokens SET name = $1 WHERE id = $2", [name, id]);
      return r.rowCount > 0;
    },

    revokeRelayJoinToken: async (id: string, now: number = Date.now()): Promise<boolean> => {
      const r = await q(txDb(pool), "UPDATE relay_join_tokens SET revoked_at = $1 WHERE id = $2 AND revoked_at IS NULL", [now, id]);
      return r.rowCount > 0;
    },

    recordRelayJoinEvent: async (id: string, tokenId: string, nodeId: string, srcIp: string | null, now: number = Date.now()): Promise<void> => {
      await txDb(pool).query("INSERT INTO relay_join_events (id, token_id, node_id, src_ip, at) VALUES ($1, $2, $3, $4, $5)", [id, tokenId, nodeId, srcIp, now]);
    },

    listRelayJoinEvents: async (tokenId: string): Promise<RelayJoinEventRow[]> => {
      const rows = (await q(txDb(pool), "SELECT * FROM relay_join_events WHERE token_id = $1 ORDER BY at DESC", [tokenId])).rows;
      return rows.map((r) => mapRelayJoinEvent(r));
    },

    setNodeEnabled: async (id: string, enabled: boolean): Promise<boolean> => {
      const r = await q(txDb(pool), "UPDATE nodes SET enabled = $1 WHERE id = $2", [enabled ? 1 : 0, id]);
      return r.rowCount > 0;
    },

    updateNodeLastIp: async (id: string, lastIp: string | null): Promise<void> => {
      await txDb(pool).query("UPDATE nodes SET last_ip = $1 WHERE id = $2", [lastIp, id]);
    },

    updateNodeHeartbeat: async (id: string, lastHeartbeat: number): Promise<void> => {
      await txDb(pool).query("UPDATE nodes SET last_heartbeat = $1 WHERE id = $2", [lastHeartbeat, id]);
    },

    updateNodeStatus: async (id: string, status: string): Promise<boolean> => {
      const r = await q(txDb(pool), "UPDATE nodes SET status = $1 WHERE id = $2", [status, id]);
      return r.rowCount > 0;
    },

    updateNodeName: async (id: string, name: string): Promise<boolean> => {
      const r = await q(txDb(pool), "UPDATE nodes SET name = $1 WHERE id = $2", [name, id]);
      return r.rowCount > 0;
    },

    markNodesOffline: async (since: number): Promise<void> => {
      await txDb(pool).query("UPDATE nodes SET status = 'offline' WHERE status = 'online' AND last_heartbeat > 0 AND last_heartbeat < $1", [since]);
    },

    markNodeAlive: async (id: string): Promise<void> => {
      await txDb(pool).query("UPDATE nodes SET status = 'online' WHERE id = $1 AND status = 'offline'", [id]);
    },

    recordNodeMetric: async (
      nodeId: string,
      m: { connections: number; activeStreams: number; bytesIn: number; bytesOut: number },
      now: number = Date.now(),
    ): Promise<void> => {
      await txDb(pool).query(
        "UPDATE nodes SET connections=$1, active_streams=$2, bytes_in=$3, bytes_out=$4, last_heartbeat=$5 WHERE id=$6",
        [m.connections, m.activeStreams, m.bytesIn, m.bytesOut, now, nodeId],
      );
      await txDb(pool).query(
        "INSERT INTO node_metrics (node_id, ts, connections, active_streams, bytes_in, bytes_out) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (node_id, ts) DO UPDATE SET connections = excluded.connections, active_streams = excluded.active_streams, bytes_in = excluded.bytes_in, bytes_out = excluded.bytes_out",
        [nodeId, now, m.connections, m.activeStreams, m.bytesIn, m.bytesOut],
      );
    },

    nodeBandwidth: async (nodeId: string, now: number = Date.now()): Promise<NodeBandwidth> => {
      const total = (r: { bytes_in: number; bytes_out: number } | null): number => (r === null ? 0 : r.bytes_in + r.bytes_out);
      const latest = one(
        await q(txDb(pool), "SELECT bytes_in, bytes_out, connections, active_streams FROM node_metrics WHERE node_id=$1 ORDER BY ts DESC LIMIT 1", [nodeId]),
      ) as unknown as { bytes_in: number; bytes_out: number; connections: number; active_streams: number } | null;
      const connections = latest?.connections ?? 0;
      const activeStreams = latest?.active_streams ?? 0;
      const rate = async (windowMs: number): Promise<number> => {
        if (latest === null) return 0;
        const at = one(
          await q(txDb(pool), "SELECT bytes_in, bytes_out FROM node_metrics WHERE node_id=$1 AND ts <= $2 ORDER BY ts DESC LIMIT 1", [nodeId, now - windowMs]),
        ) as unknown as { bytes_in: number; bytes_out: number } | null;
        if (at === null) return 0;
        const delta = total(latest) - total(at);
        return delta > 0 ? Math.round((delta / windowMs) * 1000) : 0;
      };
      let currentBps = 0;
      const lastTwo = (await q(txDb(pool), "SELECT ts, bytes_in, bytes_out FROM node_metrics WHERE node_id=$1 ORDER BY ts DESC LIMIT 2", [nodeId])).rows as unknown as Array<{ ts: string; bytes_in: number; bytes_out: number }>;
      if (lastTwo.length === 2) {
        const [a, b] = lastTwo as [{ ts: string; bytes_in: number; bytes_out: number }, { ts: string; bytes_in: number; bytes_out: number }];
        const dt = Number(a.ts) - Number(b.ts);
        if (dt > 0) currentBps = Math.round(((total(a) - total(b)) / dt) * 1000);
      }
      return {
        currentBps,
        avg5mBps: await rate(5 * 60 * 1000),
        avg1hBps: await rate(60 * 60 * 1000),
        avg24hBps: await rate(24 * 60 * 60 * 1000),
        connections,
        activeStreams,
      };
    },

    removeNode: async (id: string): Promise<boolean> => {
      const r = await q(txDb(pool), "DELETE FROM nodes WHERE id = $1", [id]);
      return r.rowCount > 0;
    },

    pickNode: async (): Promise<NodeRow | null> => {
      const row = one(
        await q(txDb(pool),
          "SELECT n.* FROM nodes n WHERE n.status = 'online' AND n.enabled = 1 AND (n.capacity = 0 OR (SELECT COUNT(*) FROM hosts h WHERE h.node_id = n.id) < n.capacity) ORDER BY n.weight DESC, n.created_at ASC LIMIT 1",
        ),
      );
      return row === null ? null : mapNode(row);
    },

    recordAudit: async (
      userId: number | null,
      event: string,
      detail: unknown,
      ip: string,
      now: number = Date.now(),
      opts?: { source?: string; actorUserId?: number | null },
    ): Promise<void> => {
      await txDb(pool).query(
        "INSERT INTO audit_events (user_id, event, detail_json, ip, created_at, source, actor_user_id) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [userId, event, JSON.stringify(detail ?? {}), ip, now, opts?.source ?? "user", opts?.actorUserId ?? null],
      );
    },

    listAudit: async (filter: { userId?: number; event?: string; since?: number; source?: string } = {}): Promise<AuditEventRow[]> => {
      return (await listAuditPage(filter, 1000, 0)).rows;
    },

    listAuditPage,

    pruneAudit: async (beforeMs: number): Promise<void> => {
      await txDb(pool).query("DELETE FROM audit_events WHERE created_at < $1", [beforeMs]);
    },
  };
}
