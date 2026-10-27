-- 0018: upstream key scope (55-voice-router).
-- A key row is now scoped to the component that consumes it (service: llm|voice)
-- and carries a credential shape (credential_type) plus non-secret params (JSON)
-- for voice providers with non-API-key auth (ak_sk, workspace, region, ...).
ALTER TABLE llm_upstream_keys ADD COLUMN IF NOT EXISTS service TEXT NOT NULL DEFAULT 'llm';
ALTER TABLE llm_upstream_keys ADD COLUMN IF NOT EXISTS credential_type TEXT;
ALTER TABLE llm_upstream_keys ADD COLUMN IF NOT EXISTS params TEXT;
