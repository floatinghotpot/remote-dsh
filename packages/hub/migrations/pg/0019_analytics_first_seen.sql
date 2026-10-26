-- 0019: analytics first-seen ledger (57-retention-analytics, Phase 2).
-- Write-time capture of each user's first active day (UTC+8). Populated by
-- recordAnalyticsEvent with INSERT ... ON CONFLICT DO NOTHING, so the read side
-- is O(distinct users) instead of a full MIN(day) GROUP BY scan over the
-- ever-growing analytics_daily.
CREATE TABLE IF NOT EXISTS analytics_first_seen (
  user_id bigint PRIMARY KEY,
  first_day text NOT NULL
);
