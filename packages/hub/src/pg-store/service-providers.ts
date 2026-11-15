/**
 * pg-store/service-providers.ts — 68-multi-service-providers: provider_configs /
 * services / service_pool 的 PG 端口。
 */
import type { Pool } from "pg";
import { one, q } from "./mappers.ts";
import { txDb } from "../pg.ts";
import type { ProviderConfigRow, ServiceRow, ServicePoolRow } from "../db.ts";
import type { HubStore } from "../store.ts";

function mapProviderConfig(row: Record<string, unknown>): ProviderConfigRow {
  return { provider: String(row.provider), params: String(row.params), updatedAt: Number(row.updated_at) };
}

function mapService(row: Record<string, unknown>): ServiceRow {
  return {
    service: String(row.service),
    capability: String(row.capability),
    displayName: row.display_name === null || row.display_name === undefined ? null : String(row.display_name),
    params: row.params === null || row.params === undefined ? null : String(row.params),
    unit: String(row.unit),
    prices: String(row.prices),
    enabled: Number(row.enabled ?? 1) === 1,
    updatedAt: Number(row.updated_at),
  };
}

function mapServicePool(row: Record<string, unknown>): ServicePoolRow {
  return {
    id: String(row.id),
    service: String(row.service),
    provider: String(row.provider),
    upstreamModel: row.upstream_model === null || row.upstream_model === undefined ? null : String(row.upstream_model),
    params: row.params === null || row.params === undefined ? null : String(row.params),
    enabled: Number(row.enabled ?? 1) === 1,
    updatedAt: Number(row.updated_at),
  };
}

export function serviceProviders(
  pool: Pool,
): Pick<
  HubStore,
  | "listProviderConfigs" | "getProviderConfig" | "upsertProviderConfig"
  | "listServices" | "getService" | "upsertService" | "deleteService"
  | "listServicePool" | "listServicePoolByService" | "getServicePoolEntry" | "upsertServicePoolEntry" | "deleteServicePoolEntry"
> {
  return {
    listProviderConfigs: async (): Promise<ProviderConfigRow[]> => {
      const rows = (await q(txDb(pool), "SELECT * FROM provider_configs ORDER BY provider")).rows;
      return rows.map(mapProviderConfig);
    },
    getProviderConfig: async (provider: string): Promise<ProviderConfigRow | null> => {
      const row = one(await q(txDb(pool), "SELECT * FROM provider_configs WHERE provider = $1", [provider]));
      return row === null ? null : mapProviderConfig(row);
    },
    upsertProviderConfig: async (provider: string, params: string, now = Date.now()): Promise<ProviderConfigRow> => {
      await q(txDb(pool), "INSERT INTO provider_configs (provider, params, updated_at) VALUES ($1, $2, $3) ON CONFLICT (provider) DO UPDATE SET params = EXCLUDED.params, updated_at = EXCLUDED.updated_at", [provider, params, now]);
      const row = one(await q(txDb(pool), "SELECT * FROM provider_configs WHERE provider = $1", [provider]));
      return mapProviderConfig(row!);
    },

    listServices: async (): Promise<ServiceRow[]> => {
      const rows = (await q(txDb(pool), "SELECT * FROM services ORDER BY capability, service")).rows;
      return rows.map(mapService);
    },
    getService: async (service: string): Promise<ServiceRow | null> => {
      const row = one(await q(txDb(pool), "SELECT * FROM services WHERE service = $1", [service]));
      return row === null ? null : mapService(row);
    },
    upsertService: async (input): Promise<ServiceRow> => {
      const now = input.now ?? Date.now();
      await q(txDb(pool), "INSERT INTO services (service, capability, display_name, params, unit, prices, enabled, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (service) DO UPDATE SET capability = EXCLUDED.capability, display_name = EXCLUDED.display_name, params = EXCLUDED.params, unit = EXCLUDED.unit, prices = EXCLUDED.prices, enabled = EXCLUDED.enabled, updated_at = EXCLUDED.updated_at", [input.service, input.capability, input.displayName ?? null, input.params ?? null, input.unit, input.prices, input.enabled === false ? 0 : 1, now]);
      const row = one(await q(txDb(pool), "SELECT * FROM services WHERE service = $1", [input.service]));
      return mapService(row!);
    },
    deleteService: async (service: string, now = Date.now()): Promise<boolean> => {
      const r = await q(txDb(pool), "UPDATE services SET enabled = 0, updated_at = $1 WHERE service = $2", [now, service]);
      return r.rowCount > 0;
    },

    listServicePool: async (): Promise<ServicePoolRow[]> => {
      const rows = (await q(txDb(pool), "SELECT * FROM service_pool ORDER BY service, provider")).rows;
      return rows.map(mapServicePool);
    },
    listServicePoolByService: async (service: string): Promise<ServicePoolRow[]> => {
      const rows = (await q(txDb(pool), "SELECT * FROM service_pool WHERE service = $1 ORDER BY provider", [service])).rows;
      return rows.map(mapServicePool);
    },
    getServicePoolEntry: async (id: string): Promise<ServicePoolRow | null> => {
      const row = one(await q(txDb(pool), "SELECT * FROM service_pool WHERE id = $1", [id]));
      return row === null ? null : mapServicePool(row);
    },
    upsertServicePoolEntry: async (input): Promise<ServicePoolRow> => {
      const now = input.now ?? Date.now();
      await q(txDb(pool), "INSERT INTO service_pool (id, service, provider, upstream_model, params, enabled, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (service, provider) DO UPDATE SET upstream_model = EXCLUDED.upstream_model, params = EXCLUDED.params, enabled = EXCLUDED.enabled, updated_at = EXCLUDED.updated_at", [input.id, input.service, input.provider, input.upstreamModel ?? null, input.params ?? null, input.enabled === false ? 0 : 1, now]);
      const row = one(await q(txDb(pool), "SELECT * FROM service_pool WHERE service = $1 AND provider = $2", [input.service, input.provider]));
      return mapServicePool(row!);
    },
    deleteServicePoolEntry: async (id: string): Promise<boolean> => {
      const r = await q(txDb(pool), "DELETE FROM service_pool WHERE id = $1", [id]);
      return r.rowCount > 0;
    },
  };
}
