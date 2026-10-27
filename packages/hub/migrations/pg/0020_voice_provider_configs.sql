-- 0020: voice provider config (55-voice-router).
-- Provider-level, non-secret voice config (URLs, resource IDs, voice whitelist),
-- separated from the key pool (llm_upstream_keys) which holds only secrets.
CREATE TABLE IF NOT EXISTS voice_provider_configs (
  provider   TEXT PRIMARY KEY,
  params     TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);
