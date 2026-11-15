/**
 * pg-store/upstream-cost.ts — 69-upstream-cost: upstream_prices /
 * upstream_usage_daily / voice_upstream_usage_daily 的 PG 端口。
 */
import type { Pool } from "pg";
import { one, q } from "./mappers.ts";
import { txDb, withTransaction } from "../pg.ts";
import type { HubStore } from "../store.ts";

type UpstreamPrice = { provider: string; upstreamModel: string; unit: string; rates: string; updatedAt: number };
type UpstreamUsage = { provider: string; upstreamModel: string; modelAlias: string; date: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number; requests: number; costMicro: number };
type VoiceUpstreamUsage = { provider: string; kind: string; service: string; date: string; cumulative: number; costMicro: number };

function mapPrice(row: Record<string, unknown>): UpstreamPrice {
  return { provider: String(row.provider), upstreamModel: String(row.upstream_model), unit: String(row.unit), rates: String(row.rates), updatedAt: Number(row.updated_at) };
}

function mapUsage(row: Record<string, unknown>): UpstreamUsage {
  return { provider: String(row.provider), upstreamModel: String(row.upstream_model), modelAlias: String(row.model_alias ?? ""), date: String(row.date), inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens), cacheReadTokens: Number(row.cache_read_tokens), cacheWriteTokens: Number(row.cache_write_tokens), reasoningTokens: Number(row.reasoning_tokens), requests: Number(row.requests), costMicro: Number(row.cost_micro) };
}

function mapVoiceUsage(row: Record<string, unknown>): VoiceUpstreamUsage {
  return { provider: String(row.provider), kind: String(row.kind), service: String(row.service), date: String(row.date), cumulative: Number(row.cumulative), costMicro: Number(row.cost_micro) };
}

export function upstreamCost(pool: Pool): Pick<HubStore,
  | "listUpstreamPrices" | "getUpstreamPrice" | "upsertUpstreamPrice"
  | "upsertUpstreamUsageDaily" | "listUpstreamUsageDaily"
  | "upsertVoiceUpstreamUsageDaily" | "listVoiceUpstreamUsageDaily"
> {
  return {
    listUpstreamPrices: async (): Promise<UpstreamPrice[]> => {
      const rows = (await q(txDb(pool), "SELECT * FROM upstream_prices ORDER BY provider, upstream_model")).rows;
      return rows.map(mapPrice);
    },

    getUpstreamPrice: async (provider: string, upstreamModel: string): Promise<UpstreamPrice | null> => {
      const row = one(await q(txDb(pool), "SELECT * FROM upstream_prices WHERE provider = $1 AND upstream_model = $2", [provider, upstreamModel]));
      return row === null ? null : mapPrice(row);
    },

    upsertUpstreamPrice: async (input: { provider: string; upstreamModel: string; unit: string; rates: string; now?: number }): Promise<void> => {
      await q(txDb(pool), "INSERT INTO upstream_prices (provider, upstream_model, unit, rates, updated_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (provider, upstream_model) DO UPDATE SET unit = EXCLUDED.unit, rates = EXCLUDED.rates, updated_at = EXCLUDED.updated_at", [input.provider, input.upstreamModel, input.unit, input.rates, input.now ?? Date.now()]);
    },

    upsertUpstreamUsageDaily: async (r: { provider: string; upstreamModel: string; modelAlias: string; date: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number; costMicro: number; now: number }): Promise<void> => {
      await q(txDb(pool),
        "INSERT INTO upstream_usage_daily (provider, upstream_model, model_alias, date, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, requests, cost_micro, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10, $11) ON CONFLICT (provider, upstream_model, model_alias, date) DO UPDATE SET input_tokens = upstream_usage_daily.input_tokens + EXCLUDED.input_tokens, output_tokens = upstream_usage_daily.output_tokens + EXCLUDED.output_tokens, cache_read_tokens = upstream_usage_daily.cache_read_tokens + EXCLUDED.cache_read_tokens, cache_write_tokens = upstream_usage_daily.cache_write_tokens + EXCLUDED.cache_write_tokens, reasoning_tokens = upstream_usage_daily.reasoning_tokens + EXCLUDED.reasoning_tokens, requests = upstream_usage_daily.requests + 1, cost_micro = upstream_usage_daily.cost_micro + EXCLUDED.cost_micro, updated_at = EXCLUDED.updated_at",
        [r.provider, r.upstreamModel, r.modelAlias, r.date, r.inputTokens, r.outputTokens, r.cacheReadTokens, r.cacheWriteTokens, r.reasoningTokens, r.costMicro, r.now]);
    },

    listUpstreamUsageDaily: async (opts: { provider?: string; upstreamModel?: string; modelAlias?: string; from?: string; to?: string } = {}): Promise<UpstreamUsage[]> => {
      const conds: string[] = [];
      const params: Array<string> = [];
      if (opts.provider !== undefined) { conds.push(`provider = $${params.length + 1}`); params.push(opts.provider); }
      if (opts.upstreamModel !== undefined) { conds.push(`upstream_model = $${params.length + 1}`); params.push(opts.upstreamModel); }
      if (opts.modelAlias !== undefined) { conds.push(`model_alias = $${params.length + 1}`); params.push(opts.modelAlias); }
      if (opts.from !== undefined) { conds.push(`date >= $${params.length + 1}`); params.push(opts.from); }
      if (opts.to !== undefined) { conds.push(`date <= $${params.length + 1}`); params.push(opts.to); }
      const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
      return (await q(txDb(pool), `SELECT * FROM upstream_usage_daily ${where} ORDER BY date ASC, provider ASC, upstream_model ASC`, params)).rows.map(mapUsage);
    },

    upsertVoiceUpstreamUsageDaily: async (r: { provider: string; kind: string; service: string; date: string; cumulative: number; perUnitMicro: number; now: number }): Promise<{ delta: number; costMicro: number; storedCumulative: number }> =>
      withTransaction(pool, async (c) => {
        await q(c, "INSERT INTO voice_upstream_usage_daily (provider, kind, service, date, cumulative, cost_micro, updated_at) VALUES ($1, $2, $3, $4, 0, 0, $5) ON CONFLICT (provider, kind, service, date) DO NOTHING", [r.provider, r.kind, r.service, r.date, r.now]);
        const row = one(await q(c, "SELECT cumulative, cost_micro, unit_micro FROM voice_upstream_usage_daily WHERE provider = $1 AND kind = $2 AND service = $3 AND date = $4 FOR UPDATE", [r.provider, r.kind, r.service, r.date]));
        const stored = row === null ? 0 : Number(row.cumulative);
        const storedCost = row === null ? 0 : Number(row.cost_micro);
        const storedUnit = row === null ? 0 : Number(row.unit_micro);
        const delta = Math.max(0, r.cumulative - stored);
        const newCumulative = Math.max(stored, r.cumulative);
        // 单价为 0（缺价）时只推水位、不动成本，避免把已记成本清零（P2-1）。
        let newCost = storedCost;
        let unitMicro = storedUnit;
        if (r.perUnitMicro > 0) {
          if (storedUnit === r.perUnitMicro) {
            newCost = Math.round(newCumulative * r.perUnitMicro);
          } else {
            newCost = storedCost + Math.round(delta * r.perUnitMicro);
          }
          unitMicro = r.perUnitMicro;
        }
        const costMicro = Math.max(0, newCost - storedCost);
        await q(c, "UPDATE voice_upstream_usage_daily SET cumulative = GREATEST(cumulative, $1), cost_micro = $2, unit_micro = $3, updated_at = $4 WHERE provider = $5 AND kind = $6 AND service = $7 AND date = $8", [newCumulative, newCost, unitMicro, r.now, r.provider, r.kind, r.service, r.date]);
        return { delta, costMicro, storedCumulative: newCumulative };
      }),

    listVoiceUpstreamUsageDaily: async (opts: { provider?: string; kind?: string; service?: string; from?: string; to?: string } = {}): Promise<VoiceUpstreamUsage[]> => {
      const conds: string[] = [];
      const params: Array<string> = [];
      if (opts.provider !== undefined) { conds.push(`provider = $${params.length + 1}`); params.push(opts.provider); }
      if (opts.kind !== undefined) { conds.push(`kind = $${params.length + 1}`); params.push(opts.kind); }
      if (opts.service !== undefined) { conds.push(`service = $${params.length + 1}`); params.push(opts.service); }
      if (opts.from !== undefined) { conds.push(`date >= $${params.length + 1}`); params.push(opts.from); }
      if (opts.to !== undefined) { conds.push(`date <= $${params.length + 1}`); params.push(opts.to); }
      const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
      return (await q(txDb(pool), `SELECT * FROM voice_upstream_usage_daily ${where} ORDER BY date ASC, provider ASC`, params)).rows.map(mapVoiceUsage);
    },
  };
}
