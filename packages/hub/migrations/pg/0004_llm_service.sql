-- 49-llm-router: internal service tokens, per-agent LLM keys, and request usage.
CREATE TABLE IF NOT EXISTS service_tokens (
  id text PRIMARY KEY,
  name text NOT NULL,
  token_hash text UNIQUE NOT NULL,
  scopes text NOT NULL,
  created_at bigint NOT NULL,
  revoked_at bigint
);

CREATE TABLE IF NOT EXISTS llm_keys (
  id text PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id),
  agent_id text NOT NULL,
  token_hash text UNIQUE NOT NULL,
  name text NOT NULL,
  model_allowlist text,
  budget_micro bigint NOT NULL DEFAULT 0,
  spent_micro bigint NOT NULL DEFAULT 0,
  status text NOT NULL,
  expires_at bigint,
  created_at bigint NOT NULL,
  last_used_at bigint
);

CREATE INDEX IF NOT EXISTS idx_llm_keys_agent ON llm_keys(agent_id);

CREATE TABLE IF NOT EXISTS llm_requests (
  id text PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id),
  agent_id text NOT NULL,
  key_id text NOT NULL,
  model_alias text NOT NULL,
  provider text NOT NULL,
  upstream_model text NOT NULL,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  cache_read_tokens bigint NOT NULL DEFAULT 0,
  cache_write_tokens bigint NOT NULL DEFAULT 0,
  reasoning_tokens bigint NOT NULL DEFAULT 0,
  provider_cost_micro bigint NOT NULL DEFAULT 0,
  charged_micro bigint NOT NULL DEFAULT 0,
  status text NOT NULL,
  error_code text,
  latency_ms bigint,
  ttft_ms bigint,
  created_at bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_llm_requests_user ON llm_requests(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_llm_requests_agent ON llm_requests(agent_id, created_at);
