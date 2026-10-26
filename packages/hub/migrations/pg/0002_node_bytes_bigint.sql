-- 可重入：ALTER COLUMN TYPE 为同类型时是 no-op，重复应用无副作用。
-- Node bandwidth counters are cumulative: a relay can easily exceed 2 GiB,
-- so int4 overflows and the node heartbeat starts failing.
ALTER TABLE nodes
  ALTER COLUMN bytes_in TYPE bigint,
  ALTER COLUMN bytes_out TYPE bigint;

ALTER TABLE node_metrics
  ALTER COLUMN bytes_in TYPE bigint,
  ALTER COLUMN bytes_out TYPE bigint;
