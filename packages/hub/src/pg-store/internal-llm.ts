/**
 * pg-store/internal-llm.ts — 49-llm-router：内部服务令牌 + LLM key + LLM usage 的 PG 端口。
 */
import type { Pool } from "pg";
import { mapServiceToken, mapLlmKey, one, q } from "./mappers.ts";
import { txDb, withTransaction } from "../pg.ts";
import type { ServiceTokenRow, LlmKeyRow, LlmUsageDailyRow } from "../db.ts";
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
  | "listLlmKeysByUser"
  | "revokeLlmKey"
  | "updateLlmKeyName"
  | "deleteLlmKey"
  | "revokeLlmKeysByHost"
  | "deleteLlmKeysByHost"
  | "addLlmKeySpent"
  | "upsertLlmUsageDaily"
  | "listLlmUsageDaily"
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
      id: string; userId: number; agentId: string | null; hostId: string | null; tokenHash: string; name: string; tokenHead4: string; tokenTail4: string;
      modelAllowlist?: string | null; budgetMicro?: number; expiresAt?: number | null; now?: number;
    }): Promise<LlmKeyRow> => {
      const now = input.now ?? Date.now();
      await q(txDb(pool),
        "INSERT INTO llm_keys (id, user_id, agent_id, host_id, token_hash, name, token_head4, token_tail4, model_allowlist, budget_micro, spent_micro, status, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, 'active', $11, $12)",
        [input.id, input.userId, input.agentId, input.hostId, input.tokenHash, input.name, input.tokenHead4, input.tokenTail4, input.modelAllowlist ?? null, input.budgetMicro ?? 0, input.expiresAt ?? null, now]);
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

    listLlmKeysByUser: async (userId: number): Promise<LlmKeyRow[]> => {
      const rows = (await q(txDb(pool), "SELECT * FROM llm_keys WHERE user_id = $1 ORDER BY created_at DESC", [userId])).rows;
      return rows.map((r) => mapLlmKey(r));
    },

    revokeLlmKey: async (id: string, _now = Date.now()): Promise<boolean> => {
      const r = await q(txDb(pool), "UPDATE llm_keys SET status = 'revoked' WHERE id = $1 AND status = 'active'", [id]);
      return r.rowCount > 0;
    },

    updateLlmKeyName: async (id: string, name: string): Promise<boolean> => {
      const r = await q(txDb(pool), "UPDATE llm_keys SET name = $1 WHERE id = $2", [name, id]);
      return r.rowCount > 0;
    },

    deleteLlmKey: async (id: string): Promise<boolean> => {
      const r = await q(txDb(pool), "DELETE FROM llm_keys WHERE id = $1", [id]);
      return r.rowCount > 0;
    },

    revokeLlmKeysByHost: async (hostId: string, _now = Date.now()): Promise<number> => {
      const r = await q(txDb(pool), "UPDATE llm_keys SET status = 'revoked' WHERE host_id = $1 AND status = 'active'", [hostId]);
      return r.rowCount;
    },

    deleteLlmKeysByHost: async (hostId: string): Promise<number> => {
      const r = await q(txDb(pool), "DELETE FROM llm_keys WHERE host_id = $1", [hostId]);
      return r.rowCount;
    },

    addLlmKeySpent: async (id: string, micro: number): Promise<void> => {
      await q(txDb(pool), "UPDATE llm_keys SET spent_micro = spent_micro + $1, last_used_at = $2 WHERE id = $3", [micro, Date.now(), id]);
    },

    upsertLlmUsageDaily: async (r: { userId: number; agentId: string; keyId: string; modelAlias: string; date: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number; chargedMicro: number; now: number }): Promise<void> => {
      await q(txDb(pool),
        "INSERT INTO llm_usage_daily (user_id, agent_id, key_id, model_alias, date, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, requests, charged_micro, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11,$12) ON CONFLICT (user_id, agent_id, key_id, model_alias, date) DO UPDATE SET input_tokens = llm_usage_daily.input_tokens + excluded.input_tokens, output_tokens = llm_usage_daily.output_tokens + excluded.output_tokens, cache_read_tokens = llm_usage_daily.cache_read_tokens + excluded.cache_read_tokens, cache_write_tokens = llm_usage_daily.cache_write_tokens + excluded.cache_write_tokens, reasoning_tokens = llm_usage_daily.reasoning_tokens + excluded.reasoning_tokens, requests = llm_usage_daily.requests + 1, charged_micro = llm_usage_daily.charged_micro + excluded.charged_micro, updated_at = excluded.updated_at",
        [r.userId, r.agentId, r.keyId, r.modelAlias, r.date, r.inputTokens, r.outputTokens, r.cacheReadTokens, r.cacheWriteTokens, r.reasoningTokens, r.chargedMicro, r.now]);
    },

    listLlmUsageDaily: async (opts: { userId?: number; agentId?: string; keyId?: string; from?: string; to?: string } = {}): Promise<LlmUsageDailyRow[]> => {
      const conds: string[] = [];
      const params: Array<number | string> = [];
      if (opts.userId !== undefined) { conds.push(`user_id = $${params.length + 1}`); params.push(opts.userId); }
      if (opts.agentId !== undefined) { conds.push(`agent_id = $${params.length + 1}`); params.push(opts.agentId); }
      if (opts.keyId !== undefined) { conds.push(`key_id = $${params.length + 1}`); params.push(opts.keyId); }
      if (opts.from !== undefined) { conds.push(`date >= $${params.length + 1}`); params.push(opts.from); }
      if (opts.to !== undefined) { conds.push(`date <= $${params.length + 1}`); params.push(opts.to); }
      const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
      const rows = (await q(txDb(pool), `SELECT * FROM llm_usage_daily ${where} ORDER BY date ASC`, params)).rows;
      return rows.map((r) => ({
        userId: Number(r.user_id),
        agentId: String(r.agent_id ?? ""),
        keyId: String(r.key_id ?? ""),
        modelAlias: String(r.model_alias ?? ""),
        date: String(r.date),
        inputTokens: Number(r.input_tokens ?? 0),
        outputTokens: Number(r.output_tokens ?? 0),
        cacheReadTokens: Number(r.cache_read_tokens ?? 0),
        cacheWriteTokens: Number(r.cache_write_tokens ?? 0),
        reasoningTokens: Number(r.reasoning_tokens ?? 0),
        requests: Number(r.requests ?? 0),
        chargedMicro: Number(r.charged_micro ?? 0),
      }));
    },
  };
}
