-- 0036: host_revocations —— 71 B5：多实例下 hub 不持隧道，踢主机改为写吊销表。
--
-- 背景：吊销/删号/到期踢机原本 terminate 进程内 tunnels；多实例时隧道在 relay 上，
-- hub 的 tunnels 是空的。改为写本表，hub 在 N5 响应里下发（TTL 内幂等重发），
-- relay 收到后 terminate 对应 host 的隧道（≤30s 收敛）。
CREATE TABLE IF NOT EXISTS host_revocations (
  host_id    text PRIMARY KEY,
  revoked_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_host_revocations_at ON host_revocations(revoked_at);
