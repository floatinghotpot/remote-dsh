-- 0015: hosts.revoked_at（软删）。
-- leave / 管理员吊销不再物理删除 host 行：保留行可保住历史流量（usage_daily.host_id）、
-- 主机名与共享关系，避免产生孤儿引用；读路径统一过滤 revoked_at IS NULL。
ALTER TABLE hosts ADD COLUMN IF NOT EXISTS revoked_at text;
CREATE INDEX IF NOT EXISTS idx_hosts_live ON hosts(owner_id) WHERE revoked_at IS NULL;
