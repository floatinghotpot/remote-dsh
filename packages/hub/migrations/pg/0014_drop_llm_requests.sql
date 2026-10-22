-- 0014: drop llm_requests.
-- Per-request rows were replaced by llm_usage_daily (user x key x model x day);
-- no code writes or reads this table anymore, and at scale it grows with request
-- volume (unbounded). Safe to drop.
DROP TABLE IF EXISTS llm_requests;
