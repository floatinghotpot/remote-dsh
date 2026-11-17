-- 0032: users.change_seq —— 70 A1 增量缓存的水位（单调变更序列）。
--
-- 为什么是「序列」而不是「时间戳 updated_at」：
--   时间戳在同一毫秒内多次写会得到相同的值；reload 用 `> lastTs` 增量拉取时，
--   若第二次写晚于上一次查询快照提交、但时间戳与水位相同，就会永久漏读该行
--   （吊销场景 = 安全问题）。序列值唯一且严格递增，`> lastSeq` 不会漏。
--
-- 为什么用 trigger 而不是逐条 SQL bump：
--   users 表有 30+ 处写路径（SQLite ~30、PG ~30+），逐条加字段易漏；漏一条 =
--   吊销/封号不同步 = 安全 bug。trigger 由数据库保证不变量，INSERT/UPDATE 全覆盖。
--   注：本仓首次引入 trigger，故在此说明。
ALTER TABLE users ADD COLUMN IF NOT EXISTS change_seq bigint NOT NULL DEFAULT 0;

CREATE SEQUENCE IF NOT EXISTS users_change_seq;

-- 存量行回填（新库无行，此语句为 no-op）。
UPDATE users SET change_seq = nextval('users_change_seq') WHERE change_seq = 0;

-- 增量查询走索引（否则每次全表扫，等于没优化）。
CREATE INDEX IF NOT EXISTS idx_users_change_seq ON users(change_seq);

-- 每次写都取新序列值（唯一、单调）。
CREATE OR REPLACE FUNCTION users_touch_change_seq() RETURNS trigger AS $$
BEGIN
  NEW.change_seq := nextval('users_change_seq');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_touch_change_seq_trg ON users;
CREATE TRIGGER users_touch_change_seq_trg
BEFORE INSERT OR UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION users_touch_change_seq();
