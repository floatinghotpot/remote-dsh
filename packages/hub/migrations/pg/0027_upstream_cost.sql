-- 0027: upstream cost accounting (69-upstream-cost).
CREATE TABLE IF NOT EXISTS upstream_prices (
  provider TEXT NOT NULL,
  upstream_model TEXT NOT NULL,
  unit TEXT NOT NULL,
  rates TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (provider, upstream_model)
);

CREATE TABLE IF NOT EXISTS upstream_usage_daily (
  provider TEXT NOT NULL,
  upstream_model TEXT NOT NULL,
  model_alias TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens BIGINT NOT NULL DEFAULT 0,
  cache_write_tokens BIGINT NOT NULL DEFAULT 0,
  reasoning_tokens BIGINT NOT NULL DEFAULT 0,
  requests BIGINT NOT NULL DEFAULT 0,
  cost_micro BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (provider, upstream_model, model_alias, date)
);

CREATE TABLE IF NOT EXISTS voice_upstream_usage_daily (
  provider TEXT NOT NULL,
  kind TEXT NOT NULL,
  service TEXT NOT NULL,
  date TEXT NOT NULL,
  cumulative BIGINT NOT NULL DEFAULT 0,
  cost_micro BIGINT NOT NULL DEFAULT 0,
  unit_micro DOUBLE PRECISION NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (provider, kind, service, date)
);
