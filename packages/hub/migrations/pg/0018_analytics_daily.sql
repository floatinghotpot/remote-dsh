-- 0018: analytics daily aggregate (57-retention-analytics, Phase 2).
-- Pre-aggregated per (day, user_id, event) with an occurrence count, so the
-- dashboard reads O(aggregate rows) instead of O(raw events). Written by
-- recordAnalyticsEvent only when the raw event is genuinely new (idempotent
-- against client retries via event_id).
CREATE TABLE IF NOT EXISTS analytics_daily (
  day text NOT NULL,
  user_id bigint NOT NULL,
  event text NOT NULL,
  count bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (day, user_id, event)
);

CREATE INDEX IF NOT EXISTS idx_analytics_daily_event_day ON analytics_daily(event, day);
