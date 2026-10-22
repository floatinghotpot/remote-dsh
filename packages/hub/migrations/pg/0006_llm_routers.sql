-- 51-llm-model-catalog: router join tokens + router registry (register → admin approve → active).
CREATE TABLE IF NOT EXISTS llm_router_join_tokens (
  id text PRIMARY KEY,
  label text NOT NULL,
  token_hash text UNIQUE NOT NULL,
  expires_at bigint NOT NULL,
  used_at bigint,
  created_by text,
  created_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_routers (
  id text PRIMARY KEY,
  name text NOT NULL,
  token_id text NOT NULL REFERENCES service_tokens(id),
  status text NOT NULL,
  last_ip text,
  created_at bigint NOT NULL,
  approved_at bigint,
  approved_by text,
  last_seen_at bigint
);
