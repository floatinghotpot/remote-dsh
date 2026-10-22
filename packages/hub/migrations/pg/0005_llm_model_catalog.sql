-- 51-llm-model-catalog: model catalog + upstream key pool.
CREATE TABLE IF NOT EXISTS llm_models (
  id text PRIMARY KEY,
  display_name text NOT NULL,
  provider text NOT NULL DEFAULT 'deepseek',
  upstream_model text NOT NULL,
  input_price_micro bigint NOT NULL DEFAULT 0,
  output_price_micro bigint NOT NULL DEFAULT 0,
  cache_read_price_micro bigint NOT NULL DEFAULT 0,
  cache_write_price_micro bigint NOT NULL DEFAULT 0,
  context_window bigint NOT NULL DEFAULT 0,
  max_tokens bigint NOT NULL DEFAULT 0,
  name_source text NOT NULL DEFAULT 'upstream',
  name_synced_at bigint,
  enabled integer NOT NULL DEFAULT 1,
  sort_order integer NOT NULL DEFAULT 0,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_upstream_keys (
  id text PRIMARY KEY,
  provider text NOT NULL DEFAULT 'deepseek',
  label text NOT NULL,
  key_cipher text NOT NULL,
  dek_wrapped text NOT NULL,
  kek_version integer NOT NULL,
  weight integer NOT NULL DEFAULT 1,
  enabled integer NOT NULL DEFAULT 1,
  created_at bigint NOT NULL,
  last_assigned_at bigint,
  revoked_at bigint
);

INSERT INTO llm_models
  (id, display_name, provider, upstream_model, input_price_micro, output_price_micro, cache_read_price_micro, cache_write_price_micro, context_window, max_tokens, name_source, enabled, sort_order, updated_at)
VALUES
  ('deepseek-flash',  'DeepSeek-V4.1-Flash', 'deepseek', 'deepseek-flash',  2000000, 8000000,  40000,  0, 1048576, 393216, 'upstream', 1, 0, 0),
  ('deepseek-v4-pro', 'DeepSeek-V4-Pro',     'deepseek', 'deepseek-v4-pro', 9000000, 27000000, 300000, 0, 1048576, 393216, 'upstream', 1, 1, 0)
ON CONFLICT (id) DO NOTHING;
