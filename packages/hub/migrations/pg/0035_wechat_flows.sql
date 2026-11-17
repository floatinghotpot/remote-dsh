-- 0035: wechat_flows —— 71 B3：微信 OAuth 流程态入库（跨实例）。
--
-- 现状：4 个进程内 Map（wechatLoginStates / wechatPending / wechatHandoffs / wechatBindTokens）；
-- 多实例下回调落到别的实例 → state/pending/handoff 无效，微信登录/绑定失败。
-- 方案：单表 + kind 区分；一次性靠原子 DELETE ... RETURNING；expires_at 由 prune 清理。
CREATE TABLE IF NOT EXISTS wechat_flows (
  token      text PRIMARY KEY,
  kind       text NOT NULL,
  user_id    integer,
  payload    text NOT NULL,
  ip         text,
  expires_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wechat_flows_exp ON wechat_flows(kind, expires_at);
