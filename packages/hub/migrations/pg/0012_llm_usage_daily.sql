-- llm_usage_daily: per (user, agent, key, model, day) rollup of LLM usage.
-- Replaces per-request llm_requests rows as the usage-page source (bounded growth).
-- Numeric columns are BIGINT: token counts, micro amounts, and ms timestamps all
-- exceed PostgreSQL INTEGER's 32-bit range.
CREATE TABLE IF NOT EXISTS llm_usage_daily (
  user_id INTEGER NOT NULL,
  agent_id TEXT NOT NULL DEFAULT '',
  key_id TEXT NOT NULL DEFAULT '',
  model_alias TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens BIGINT NOT NULL DEFAULT 0,
  cache_write_tokens BIGINT NOT NULL DEFAULT 0,
  reasoning_tokens BIGINT NOT NULL DEFAULT 0,
  requests BIGINT NOT NULL DEFAULT 0,
  charged_micro BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, agent_id, key_id, model_alias, date)
);
