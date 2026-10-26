-- 可重入：ALTER COLUMN TYPE 为同类型时是 no-op，重复应用无副作用。
-- 0013: widen llm_usage_daily numeric columns to BIGINT.
-- 0012 initially used INTEGER; ms timestamps (updated_at) and token/micro counts
-- overflow PostgreSQL's 32-bit INTEGER, causing settle to fail with
-- "value ... is out of range for type integer".
ALTER TABLE llm_usage_daily ALTER COLUMN input_tokens TYPE BIGINT;
ALTER TABLE llm_usage_daily ALTER COLUMN output_tokens TYPE BIGINT;
ALTER TABLE llm_usage_daily ALTER COLUMN cache_read_tokens TYPE BIGINT;
ALTER TABLE llm_usage_daily ALTER COLUMN cache_write_tokens TYPE BIGINT;
ALTER TABLE llm_usage_daily ALTER COLUMN reasoning_tokens TYPE BIGINT;
ALTER TABLE llm_usage_daily ALTER COLUMN requests TYPE BIGINT;
ALTER TABLE llm_usage_daily ALTER COLUMN charged_micro TYPE BIGINT;
ALTER TABLE llm_usage_daily ALTER COLUMN updated_at TYPE BIGINT;
