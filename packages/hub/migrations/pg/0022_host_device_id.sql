-- 0022: hosts.device_id + hosts.revoked_by（2026-11-06 重绑去重）。
-- rdsh 安装期生成的设备标识，随注册上送；hub 按 (owner_id, device_id) 复用旧记录，
-- 避免「解绑→绑定」每轮新建一条 host。老客户端不上送 → NULL，退化为新建。
ALTER TABLE hosts ADD COLUMN IF NOT EXISTS device_id text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_hosts_owner_device_uniq ON hosts(owner_id, device_id) WHERE device_id IS NOT NULL;

-- 吊销来源：user（解绑/用户删除，重绑可复活）/ admin（管理员吊销，不可复活）。
-- 老数据为 NULL → 视为不可复活（保守：无法归因的吊销不自动撤销）。
ALTER TABLE hosts ADD COLUMN IF NOT EXISTS revoked_by text;
