-- 0023: multi-service-provider model (68).
-- provider_configs / services / service_pool, plus upstream key capability scope
-- and per-key concurrency cap.

CREATE TABLE IF NOT EXISTS provider_configs (
  provider   TEXT PRIMARY KEY,
  params     TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS services (
  service      TEXT PRIMARY KEY,
  capability   TEXT NOT NULL,
  display_name TEXT,
  params       TEXT,
  unit         TEXT NOT NULL,
  prices       TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  updated_at   BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS service_pool (
  id             TEXT PRIMARY KEY,
  service        TEXT NOT NULL,
  provider       TEXT NOT NULL,
  upstream_model TEXT,
  params         TEXT,
  enabled        INTEGER NOT NULL DEFAULT 1,
  updated_at     BIGINT NOT NULL,
  UNIQUE (service, provider)
);

ALTER TABLE llm_upstream_keys ADD COLUMN IF NOT EXISTS capabilities TEXT;
ALTER TABLE llm_upstream_keys ADD COLUMN IF NOT EXISTS max_concurrency INTEGER NOT NULL DEFAULT 0;
