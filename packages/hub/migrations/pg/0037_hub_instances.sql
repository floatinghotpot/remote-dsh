-- 0037: hub_instances —— 71 B6：hub 实例自注册（relay 经 N5 拿同区实例列表，逐个推 N2 心跳）。
--
-- 为什么用表不用配置：配置法的 N 份副本会漂移；实例 listen 后 UPSERT 自身、每 30s 刷
-- last_seen_at，活跃判定 > now()-90s，每日 prune（< now()-7d）。
-- url 必须是 relay 可达地址（公网/专线域名，HTTPS），不是内网 IP。
CREATE TABLE IF NOT EXISTS hub_instances (
  url          text PRIMARY KEY,
  region       text NOT NULL DEFAULT 'cn',
  version      text,
  started_at   bigint NOT NULL,
  last_seen_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hub_instances_seen ON hub_instances(last_seen_at);
