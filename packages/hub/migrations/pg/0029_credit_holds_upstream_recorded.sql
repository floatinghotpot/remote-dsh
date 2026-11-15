-- 0029: mark upstream cost recorded per hold (69-upstream-cost) for idempotent
-- recording of incurred upstream cost even when the user's settle was insufficient.
ALTER TABLE credit_holds ADD COLUMN IF NOT EXISTS upstream_recorded INTEGER NOT NULL DEFAULT 0;
