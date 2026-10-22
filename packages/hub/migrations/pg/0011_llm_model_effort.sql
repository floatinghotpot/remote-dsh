-- 52-auto-provision-router: model reasoning-effort levels (from upstream /models effort).
ALTER TABLE llm_models ADD COLUMN IF NOT EXISTS effort_levels text;
ALTER TABLE llm_models ADD COLUMN IF NOT EXISTS effort_default text;
