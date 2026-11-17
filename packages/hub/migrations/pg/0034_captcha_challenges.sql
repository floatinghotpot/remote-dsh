-- 0034: captcha_challenges —— 71 B2：算术验证码入库（跨实例）。
--
-- 现状：captcha.ts 用进程内 Map 存答案；多实例下 A 发题、B 校验会 BAD_CAPTCHA。
-- 方案：token 一次性（原子 DELETE ... RETURNING），expires_at 由 prune 清理。
CREATE TABLE IF NOT EXISTS captcha_challenges (
  token      text PRIMARY KEY,
  answer     integer NOT NULL,
  expires_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_captcha_challenges_exp ON captcha_challenges(expires_at);
