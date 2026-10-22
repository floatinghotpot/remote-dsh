-- llm_usage_daily: per (user, agent, key, model, day) rollup of LLM usage.
-- Replaces per-request llm_requests rows as the usage-page source (bounded growth).
CREATE TABLE IF NOT EXISTS llm_usage_daily (
  user_id INTEGER NOT NULL,
  agent_id TEXT NOT NULL DEFAULT '',
  key_id TEXT NOT NULL DEFAULT '',
  model_alias TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  charged_micro INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, agent_id, key_id, model_alias, date)
);
