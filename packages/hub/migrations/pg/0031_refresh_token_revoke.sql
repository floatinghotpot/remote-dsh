-- 0031: refresh_tokens.revoked_at / revoked_reason（refresh 宽限）。
-- 只有 revoked_reason='rotation' 可命中 60s 复用宽限；logout / password_change / admin 与存量 NULL 一律终态。
-- 存量 revoked=1 的行不回填：revoked_reason 保持 NULL ⇒ 不可宽限（保守）。
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS revoked_at bigint;
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS revoked_reason text;
