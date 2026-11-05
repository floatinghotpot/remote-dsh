-- 0021: hosts.device_kind / versions_json（63-bind-agent-box）。
-- 主机自报设备类型（desktop/cli/box/unknown）与版本对象；未上报保持 NULL，
-- 读路径照常返回 null（App 视为 unknown）。
ALTER TABLE hosts ADD COLUMN IF NOT EXISTS device_kind text;
ALTER TABLE hosts ADD COLUMN IF NOT EXISTS versions_json text;
