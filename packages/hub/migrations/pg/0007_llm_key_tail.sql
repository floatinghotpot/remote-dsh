-- 51-llm-model-catalog: store the last 4 chars of the LLM key token for masked display.
ALTER TABLE llm_keys ADD COLUMN IF NOT EXISTS token_tail4 text NOT NULL DEFAULT '';
