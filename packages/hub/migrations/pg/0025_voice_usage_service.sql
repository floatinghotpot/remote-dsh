-- 0025: voice usage watermark keyed by service (68).
-- A user may consume multiple sold voice services of the same kind (e.g. two ASR
-- services); the watermark must be per (user, date, kind, service) or deltas
-- across services would be swallowed by a single global max.
ALTER TABLE voice_usage_daily ADD COLUMN IF NOT EXISTS service TEXT NOT NULL DEFAULT '';
-- 历史行按已知 provider+kind 回填到默认售卖服务（无法区分的旧数据留空）。
UPDATE voice_usage_daily SET service = CASE
  WHEN provider = 'deepseek' AND kind = 'asr' THEN 'deepseek-asr'
  WHEN provider = 'deepseek' AND kind = 'tts' THEN 'deepseek-tts'
  WHEN provider = 'volcengine' AND kind = 'asr' THEN 'doubao-asr'
  WHEN provider = 'volcengine' AND kind = 'tts' THEN 'doubao-tts'
  ELSE ''
END
WHERE service = '';
ALTER TABLE voice_usage_daily DROP CONSTRAINT IF EXISTS voice_usage_daily_pkey;
ALTER TABLE voice_usage_daily ADD PRIMARY KEY (user_id, date, kind, service);
