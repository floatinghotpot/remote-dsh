/**
 * pg-store/internal-llm.ts — 49-llm-router：内部服务令牌 + LLM key + LLM usage 的 PG 端口。
 */
import type { Pool } from "pg";
import { mapServiceToken, mapLlmKey, mapLlmRequest, one, q } from "./mappers.ts";
import { txDb, withTransaction } from "../pg.ts";
import type { ServiceTokenRow, LlmKeyRow, LlmRequestRow } from "../db.ts";
import type { HubStore } from "../store.ts";

export function internalLlm(
  pool: Pool,
): Pick<
  HubStore,
  | "createServiceToken"
  | "findServiceTokenByHash"
  | "listServiceTokens"
  | "revokeServiceToken"
  | "createLlmKey"
  | "findLlmKeyByHash"
  | "getLlmKeyById"
  | "revokeLlmKey"
  | "addLlmKeySpent"
  | "createLlmRequest"
  | "listLlmRequests"
> {
  return {
    createServiceToken: async (id, name, tokenHash, scopes, createdAt = Date.now()): Promise<ServiceTokenRow> => {
      await q(txDb(pool), "INSERT INTO service_tokens (id, name, token_hash, scopes, created_at) VALUES ($1, $2, $3, $4, $5)", [id, name, tokenHash, scopes, createdAt]);
      return mapServiceToken(one(await q(txDb(pool), "SELECT * FROM service_tokens WHERE id = $1", [id]))!);
    },

    findServiceTokenByHash: async (tokenHash: string): Promise<ServiceTokenRow | null> => {
      const row = one(await q(txDb(pool), "SELECT * FROM service_tokens WHERE token_hash = $1", [tokenHash]));
      return row === null ? null : mapServiceToken(row);
    },

    listServiceTokens: async (): Promise<ServiceTokenRow[]> => {
      const rows = (await q(txDb(pool), "SELECT * FROM service_tokens ORDER BY created_at")).rows;
      return rows.map((r) => mapServiceToken(r));
    },

    revokeServiceToken: async (id: string, now = Date.now()): Promise<boolean> => {
      const r = await q(txDb(pool), "UPDATE service_tokens SET revoked_at = $1 WHERE id = $2 AND revoked_at IS NULL", [now, id]);
      return r.rowCount > 0;
    },

    createLlmKey: async (input: {
      id: string; userId: number; agentId: string; tokenHash: string; name: string;
      modelAllowlist?: string | null; budgetMicro?: number; expiresAt?: number | null; now?: number;
    }): Promise<LlmKeyRow> => {
      const now = input.now ?? Date.now();
      await q(txDb(pool),
        "INSERT INTO llm_keys (id, user_id, agent_id, token_hash, name, model_allowlist, budget_micro, spent_micro, status, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 'active', $8, $9)",
        [input.id, input.userId, input.agentId, input.tokenHash, input.name, input.modelAllowlist ?? null, input.budgetMicro ?? 0, input.expiresAt ?? null, now]);
      return mapLlmKey(one(await q(txDb(pool), "SELECT * FROM llm_keys WHERE id = $1", [input.id]))!);
    },

    findLlmKeyByHash: async (tokenHash: string): Promise<LlmKeyRow | null> => {
      const row = one(await q(txDb(pool), "SELECT * FROM llm_keys WHERE token_hash = $1", [tokenHash]));
      return row === null ? null : mapLlmKey(row);
    },

    getLlmKeyById: async (id: string): Promise<LlmKeyRow | null> => {
      const row = one(await q(txDb(pool), "SELECT * FROM llm_keys WHERE id = $1", [id]));
      return row === null ? null : mapLlmKey(row);
    },

    revokeLlmKey: async (id: string, _now = Date.now()): Promise<boolean> => {
      const r = await q(txDb(pool), "UPDATE llm_keys SET status = 'revoked' WHERE id = $1 AND status = 'active'", [id]);
      return r.rowCount > 0;
    },

    addLlmKeySpent: async (id: string, micro: number): Promise<void> => {
      await q(txDb(pool), "UPDATE llm_keys SET spent_micro = spent_micro + $1, last_used_at = $2 WHERE id = $3", [micro, Date.now(), id]);
    },

    createLlmRequest: async (r: LlmRequestRow): Promise<void> => {
      await q(txDb(pool),
        "INSERT INTO llm_requests (id, user_id, agent_id, key_id, model_alias, provider, upstream_model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, provider_cost_micro, charged_micro, status, error_code, latency_ms, ttft_ms, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)",
        [r.id, r.userId, r.agentId, r.keyId, r.modelAlias, r.provider, r.upstreamModel, r.inputTokens, r.outputTokens, r.cacheReadTokens, r.cacheWriteTokens, r.reasoningTokens, r.providerCostMicro, r.chargedMicro, r.status, r.errorCode, r.latencyMs, r.ttftMs, r.createdAt]);
    },

    listLlmRequests: async (opts: { userId?: number; agentId?: string; from?: number; to?: number; limit?: number } = {}): Promise<LlmRequestRow[]> => {
      const conds: string[] = [];
      const params: Array<number | string> = [];
      if (opts.userId !== undefined) { conds.push(`user_id = $${params.length + 1}`); params.push(opts.userId); }
      if (opts.agentId !== undefined) { conds.push(`agent_id = $${params.length + 1}`); params.push(opts.agentId); }
      if (opts.from !== undefined) { conds.push(`created_at >= $${params.length + 1}`); params.push(opts.from); }
      if (opts.to !== undefined) { conds.push(`created_at <= $${params.length + 1}`); params.push(opts.to); }
      const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
      const limit = Math.min(Math.max(opts.limit ?? 1000, 1), 10000);
      const rows = (await q(txDb(pool), `SELECT * FROM llm_requests ${where} ORDER BY created_at DESC LIMIT $${params.length + 1}`, [...params, limit])).rows;
      return rows.map((r) => mapLlmRequest(r));
    },
  };
}
