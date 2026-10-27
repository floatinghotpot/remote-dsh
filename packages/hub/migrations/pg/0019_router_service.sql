-- 0019: router service scope (55-voice-router).
-- Reuse the LLM router lifecycle for the voice router: routers and join tokens
-- are tagged with the component that owns them (service: llm|voice).
ALTER TABLE llm_routers ADD COLUMN IF NOT EXISTS service TEXT NOT NULL DEFAULT 'llm';
ALTER TABLE llm_router_join_tokens ADD COLUMN IF NOT EXISTS service TEXT NOT NULL DEFAULT 'llm';
