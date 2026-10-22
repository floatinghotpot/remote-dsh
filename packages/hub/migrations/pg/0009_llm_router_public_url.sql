-- 52-auto-provision-router: Router reports its reachable web address at join.
ALTER TABLE llm_routers ADD COLUMN IF NOT EXISTS public_base_url text;
