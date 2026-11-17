-- 0033: users_delete_log —— 70 A1：硬删用户的墓碑（跨实例缓存失效）。
--
-- 为什么需要：A1 的增量刷新按 `change_seq > lastSeq` 拉变更行；但 `rdsh-hub user rm`
-- 是**硬删**（`removeUser` 直接从 users 删行），行消失后增量永远看不到它 —— 其他实例
-- 的缓存会残留该用户（active）→ 已删用户仍可鉴权（安全 bug）。
--
-- 方案：AFTER DELETE trigger 写墓碑（复用同一个 change_seq 序列），reload 拉墓碑并
-- 从缓存删除。墓碑只保留最近 100 万条（足够覆盖任何活实例的水位）。
CREATE TABLE IF NOT EXISTS users_delete_log (
  user_id bigint PRIMARY KEY,
  change_seq bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_delete_log_seq ON users_delete_log(change_seq);

CREATE OR REPLACE FUNCTION users_log_delete() RETURNS trigger AS $$
BEGIN
  INSERT INTO users_delete_log(user_id, change_seq)
  VALUES (OLD.id, nextval('users_change_seq'))
  ON CONFLICT (user_id) DO UPDATE SET change_seq = excluded.change_seq;
  DELETE FROM users_delete_log
    WHERE change_seq < (SELECT COALESCE(MAX(change_seq), 0) - 1000000 FROM users_delete_log);
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_log_delete_trg ON users;
CREATE TRIGGER users_log_delete_trg
AFTER DELETE ON users
FOR EACH ROW EXECUTE FUNCTION users_log_delete();
