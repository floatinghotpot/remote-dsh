-- 52-auto-provision-router: bind an LLM key to a host (auto-provisioned, read-only).
ALTER TABLE llm_keys ADD COLUMN IF NOT EXISTS host_id text;
