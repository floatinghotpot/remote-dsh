-- 51-llm-model-catalog: store the first 4 chars after "sk-rdsh-" for masked display.
ALTER TABLE llm_keys ADD COLUMN IF NOT EXISTS token_head4 text NOT NULL DEFAULT '';
