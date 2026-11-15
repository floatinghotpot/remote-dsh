-- 0028: upstream cost price list seed (69). micro: 1 CNY = 1,000,000.
INSERT INTO upstream_prices (provider, upstream_model, unit, rates, updated_at) VALUES
  ('deepseek', 'deepseek-flash', 'per_mtok', '{"peak":{"input":2000000,"cacheRead":40000,"cacheWrite":0,"output":8000000},"offPeak":{"input":1000000,"cacheRead":20000,"cacheWrite":0,"output":4000000}}', (extract(epoch from now())*1000)::bigint),
  ('deepseek', 'deepseek-v4-pro', 'per_mtok', '{"peak":{"input":9000000,"cacheRead":300000,"cacheWrite":0,"output":27000000},"offPeak":{"input":4500000,"cacheRead":150000,"cacheWrite":0,"output":13500000}}', (extract(epoch from now())*1000)::bigint),
  ('aliyun', 'deepseek-v4.1-flash', 'per_mtok', '{"busy":{"input":2000000,"cacheRead":200000,"cacheWrite":0,"output":8000000},"idle":{"input":1000000,"cacheRead":100000,"cacheWrite":0,"output":4000000}}', (extract(epoch from now())*1000)::bigint),
  ('aliyun', 'deepseek-v4-pro', 'per_mtok', '{"busy":{"input":9000000,"cacheRead":900000,"cacheWrite":0,"output":27000000},"idle":{"input":4500000,"cacheRead":450000,"cacheWrite":0,"output":13500000}}', (extract(epoch from now())*1000)::bigint),
  ('deepseek', 'ds.asr', 'per_second', '{"perSecond":216.6667}', (extract(epoch from now())*1000)::bigint),
  ('volcengine', 'volc.seedasr.sauc.duration', 'per_second', '{"perSecond":277.7778}', (extract(epoch from now())*1000)::bigint),
  ('deepseek', 'deepseek-tts', 'per_char', '{"perChar":300}', (extract(epoch from now())*1000)::bigint),
  ('volcengine', 'seed-tts-2.0', 'per_char', '{"perChar":280}', (extract(epoch from now())*1000)::bigint)
ON CONFLICT (provider, upstream_model) DO NOTHING;
