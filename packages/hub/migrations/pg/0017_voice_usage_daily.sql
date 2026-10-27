-- 0017: voice usage daily rollup (55-voice-router).
-- One row per (user, date, kind) where kind is 'asr' | 'tts'.
-- `cumulative` is the monotonic watermark (seconds for asr, chars for tts);
-- billing is the DELTA over the last-reported cumulative, so retries/reordering
-- are idempotent (GREATEST/MAX, only the delta is charged). `charged_micro`
-- accumulates the micro actually deducted for this (user,date,kind).
-- This is the ONLY per-voice storage: no per-call / per-session / per-report rows.
CREATE TABLE IF NOT EXISTS voice_usage_daily (
  user_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  kind TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'volcengine',
  cumulative BIGINT NOT NULL DEFAULT 0,
  charged_micro BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, date, kind)
);
