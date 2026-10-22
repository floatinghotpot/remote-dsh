/**
 * pg-store/llm-catalog.ts — 51-llm-model-catalog：模型目录 / 上游 key 池 / Router 注册的 PG 端口。
 */
import type { Pool } from "pg";
import { mapLlmModel, mapLlmUpstreamKey, mapLlmRouterJoinToken, mapLlmRouter, one, q } from "./mappers.ts";
import { txDb } from "../pg.ts";
import type { LlmModelRow, LlmUpstreamKeyRow, LlmRouterJoinTokenRow, LlmRouterRow, LlmModelNameSource, LlmRouterStatus } from "../db.ts";
import type { HubStore } from "../store.ts";

export function llmCatalog(
  pool: Pool,
): Pick<
  HubStore,
  | "listLlmModels" | "getLlmModel" | "createLlmModel" | "updateLlmModel" | "syncLlmModelMeta" | "deleteLlmModel"
  | "listLlmUpstreamKeys" | "getLlmUpstreamKey" | "createLlmUpstreamKey" | "updateLlmUpstreamKey" | "revokeLlmUpstreamKey" | "touchLlmUpstreamKeyAssigned"
  | "createLlmRouterJoinToken" | "findLlmRouterJoinTokenByHash" | "markLlmRouterJoinTokenUsed" | "listLlmRouterJoinTokens"
  | "createLlmRouter" | "getLlmRouter" | "getLlmRouterByTokenId" | "listLlmRouters" | "setLlmRouterStatus" | "touchLlmRouterSeen"
> {
  return {
    listLlmModels: async (opts: { enabledOnly?: boolean } = {}): Promise<LlmModelRow[]> => {
      const where = opts.enabledOnly === true ? "WHERE enabled = 1" : "";
      const rows = (await q(txDb(pool), `SELECT * FROM llm_models ${where} ORDER BY sort_order, id`)).rows;
      return rows.map((r) => mapLlmModel(r));
    },

    getLlmModel: async (id: string): Promise<LlmModelRow | null> => {
      const row = one(await q(txDb(pool), "SELECT * FROM llm_models WHERE id = $1", [id]));
      return row === null ? null : mapLlmModel(row);
    },

    createLlmModel: async (input: {
      id: string; displayName: string; provider: string; upstreamModel: string;
      inputPriceMicro?: number; outputPriceMicro?: number; cacheReadPriceMicro?: number; cacheWritePriceMicro?: number;
      contextWindow?: number; maxTokens?: number; sortOrder?: number; now?: number;
    }): Promise<LlmModelRow> => {
      const now = input.now ?? Date.now();
      await q(txDb(pool),
        "INSERT INTO llm_models (id, display_name, provider, upstream_model, input_price_micro, output_price_micro, cache_read_price_micro, cache_write_price_micro, context_window, max_tokens, name_source, enabled, sort_order, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'manual', 1, $11, $12)",
        [input.id, input.displayName, input.provider, input.upstreamModel, input.inputPriceMicro ?? 0, input.outputPriceMicro ?? 0, input.cacheReadPriceMicro ?? 0, input.cacheWritePriceMicro ?? 0, input.contextWindow ?? 0, input.maxTokens ?? 0, input.sortOrder ?? 0, now]);
      return mapLlmModel(one(await q(txDb(pool), "SELECT * FROM llm_models WHERE id = $1", [input.id]))!);
    },

    updateLlmModel: async (id: string, patch: {
      displayName?: string; provider?: string; upstreamModel?: string;
      inputPriceMicro?: number; outputPriceMicro?: number; cacheReadPriceMicro?: number; cacheWritePriceMicro?: number;
      contextWindow?: number; maxTokens?: number; enabled?: boolean; sortOrder?: number; nameSource?: LlmModelNameSource; now?: number;
    }): Promise<LlmModelRow | null> => {
      const cur = one(await q(txDb(pool), "SELECT * FROM llm_models WHERE id = $1", [id]));
      if (cur === null) return null;
      const c = mapLlmModel(cur);
      const now = patch.now ?? Date.now();
      const displayName = patch.displayName ?? c.displayName;
      const provider = patch.provider ?? c.provider;
      const upstreamModel = patch.upstreamModel ?? c.upstreamModel;
      const inputPriceMicro = patch.inputPriceMicro ?? c.inputPriceMicro;
      const outputPriceMicro = patch.outputPriceMicro ?? c.outputPriceMicro;
      const cacheReadPriceMicro = patch.cacheReadPriceMicro ?? c.cacheReadPriceMicro;
      const cacheWritePriceMicro = patch.cacheWritePriceMicro ?? c.cacheWritePriceMicro;
      const contextWindow = patch.contextWindow ?? c.contextWindow;
      const maxTokens = patch.maxTokens ?? c.maxTokens;
      const enabled = patch.enabled === undefined ? c.enabled : patch.enabled;
      const sortOrder = patch.sortOrder ?? c.sortOrder;
      const nameSource = patch.nameSource ?? c.nameSource;
      await q(txDb(pool),
        "UPDATE llm_models SET display_name = $1, provider = $2, upstream_model = $3, input_price_micro = $4, output_price_micro = $5, cache_read_price_micro = $6, cache_write_price_micro = $7, context_window = $8, max_tokens = $9, name_source = $10, enabled = $11, sort_order = $12, updated_at = $13 WHERE id = $14",
        [displayName, provider, upstreamModel, inputPriceMicro, outputPriceMicro, cacheReadPriceMicro, cacheWritePriceMicro, contextWindow, maxTokens, nameSource, enabled ? 1 : 0, sortOrder, now, id]);
      const row = one(await q(txDb(pool), "SELECT * FROM llm_models WHERE id = $1", [id]));
      return row === null ? null : mapLlmModel(row);
    },

    syncLlmModelMeta: async (id: string, displayName: string, contextWindow: number, maxTokens: number, now: number): Promise<boolean> => {
      const r = await q(txDb(pool), "UPDATE llm_models SET display_name = $1, context_window = $2, max_tokens = $3, name_synced_at = $4, updated_at = $4 WHERE id = $5 AND name_source = 'upstream'", [displayName, contextWindow, maxTokens, now, id]);
      return r.rowCount > 0;
    },

    deleteLlmModel: async (id: string, now = Date.now()): Promise<boolean> => {
      const r = await q(txDb(pool), "UPDATE llm_models SET enabled = 0, updated_at = $1 WHERE id = $2", [now, id]);
      return r.rowCount > 0;
    },

    listLlmUpstreamKeys: async (): Promise<LlmUpstreamKeyRow[]> => {
      const rows = (await q(txDb(pool), "SELECT * FROM llm_upstream_keys ORDER BY created_at")).rows;
      return rows.map((r) => mapLlmUpstreamKey(r));
    },

    getLlmUpstreamKey: async (id: string): Promise<LlmUpstreamKeyRow | null> => {
      const row = one(await q(txDb(pool), "SELECT * FROM llm_upstream_keys WHERE id = $1", [id]));
      return row === null ? null : mapLlmUpstreamKey(row);
    },

    createLlmUpstreamKey: async (input: { id: string; provider: string; label: string; keyCipher: string; dekWrapped: string; kekVersion: number; weight?: number; now?: number }): Promise<LlmUpstreamKeyRow> => {
      const now = input.now ?? Date.now();
      await q(txDb(pool), "INSERT INTO llm_upstream_keys (id, provider, label, key_cipher, dek_wrapped, kek_version, weight, enabled, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8)", [input.id, input.provider, input.label, input.keyCipher, input.dekWrapped, input.kekVersion, input.weight ?? 1, now]);
      return mapLlmUpstreamKey(one(await q(txDb(pool), "SELECT * FROM llm_upstream_keys WHERE id = $1", [input.id]))!);
    },

    updateLlmUpstreamKey: async (id: string, patch: { enabled?: boolean; weight?: number }): Promise<LlmUpstreamKeyRow | null> => {
      const cur = one(await q(txDb(pool), "SELECT * FROM llm_upstream_keys WHERE id = $1", [id]));
      if (cur === null) return null;
      const c = mapLlmUpstreamKey(cur);
      const enabled = patch.enabled === undefined ? c.enabled : patch.enabled;
      const weight = patch.weight ?? c.weight;
      await q(txDb(pool), "UPDATE llm_upstream_keys SET enabled = $1, weight = $2 WHERE id = $3", [enabled ? 1 : 0, weight, id]);
      const row = one(await q(txDb(pool), "SELECT * FROM llm_upstream_keys WHERE id = $1", [id]));
      return row === null ? null : mapLlmUpstreamKey(row);
    },

    revokeLlmUpstreamKey: async (id: string, now = Date.now()): Promise<boolean> => {
      const r = await q(txDb(pool), "UPDATE llm_upstream_keys SET revoked_at = $1, enabled = 0 WHERE id = $2", [now, id]);
      return r.rowCount > 0;
    },

    touchLlmUpstreamKeyAssigned: async (id: string, now = Date.now()): Promise<void> => {
      await q(txDb(pool), "UPDATE llm_upstream_keys SET last_assigned_at = $1 WHERE id = $2", [now, id]);
    },

    createLlmRouterJoinToken: async (id: string, label: string, tokenHash: string, expiresAt: number, createdBy: string | null, now = Date.now()): Promise<LlmRouterJoinTokenRow> => {
      await q(txDb(pool), "INSERT INTO llm_router_join_tokens (id, label, token_hash, expires_at, created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6)", [id, label, tokenHash, expiresAt, createdBy, now]);
      return mapLlmRouterJoinToken(one(await q(txDb(pool), "SELECT * FROM llm_router_join_tokens WHERE id = $1", [id]))!);
    },

    findLlmRouterJoinTokenByHash: async (tokenHash: string): Promise<LlmRouterJoinTokenRow | null> => {
      const row = one(await q(txDb(pool), "SELECT * FROM llm_router_join_tokens WHERE token_hash = $1", [tokenHash]));
      return row === null ? null : mapLlmRouterJoinToken(row);
    },

    markLlmRouterJoinTokenUsed: async (id: string, now = Date.now()): Promise<boolean> => {
      const r = await q(txDb(pool), "UPDATE llm_router_join_tokens SET used_at = $1 WHERE id = $2 AND used_at IS NULL", [now, id]);
      return r.rowCount > 0;
    },

    listLlmRouterJoinTokens: async (): Promise<LlmRouterJoinTokenRow[]> => {
      const rows = (await q(txDb(pool), "SELECT * FROM llm_router_join_tokens ORDER BY created_at DESC")).rows;
      return rows.map((r) => mapLlmRouterJoinToken(r));
    },

    createLlmRouter: async (id: string, name: string, tokenId: string, lastIp: string | null, now = Date.now()): Promise<LlmRouterRow> => {
      await q(txDb(pool), "INSERT INTO llm_routers (id, name, token_id, status, last_ip, created_at) VALUES ($1, $2, $3, 'pending', $4, $5)", [id, name, tokenId, lastIp, now]);
      return mapLlmRouter(one(await q(txDb(pool), "SELECT * FROM llm_routers WHERE id = $1", [id]))!);
    },

    getLlmRouter: async (id: string): Promise<LlmRouterRow | null> => {
      const row = one(await q(txDb(pool), "SELECT * FROM llm_routers WHERE id = $1", [id]));
      return row === null ? null : mapLlmRouter(row);
    },

    getLlmRouterByTokenId: async (tokenId: string): Promise<LlmRouterRow | null> => {
      const row = one(await q(txDb(pool), "SELECT * FROM llm_routers WHERE token_id = $1", [tokenId]));
      return row === null ? null : mapLlmRouter(row);
    },

    listLlmRouters: async (): Promise<LlmRouterRow[]> => {
      const rows = (await q(txDb(pool), "SELECT * FROM llm_routers ORDER BY created_at DESC")).rows;
      return rows.map((r) => mapLlmRouter(r));
    },

    setLlmRouterStatus: async (id: string, status: LlmRouterStatus, actor: string | null, now = Date.now()): Promise<boolean> => {
      const r = status === "active"
        ? await q(txDb(pool), "UPDATE llm_routers SET status = 'active', approved_at = $1, approved_by = $2 WHERE id = $3", [now, actor, id])
        : await q(txDb(pool), "UPDATE llm_routers SET status = $1 WHERE id = $2", [status, id]);
      return r.rowCount > 0;
    },

    touchLlmRouterSeen: async (id: string, lastIp: string | null, now = Date.now()): Promise<void> => {
      await q(txDb(pool), "UPDATE llm_routers SET last_seen_at = $1, last_ip = $2 WHERE id = $3", [now, lastIp, id]);
    },
  };
}
