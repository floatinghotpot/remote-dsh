-- 0038: hosts.status / status_at（71 D3：hostStatus 落库，跨实例可见）。
ALTER TABLE hosts ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE hosts ADD COLUMN IF NOT EXISTS status_at bigint;
