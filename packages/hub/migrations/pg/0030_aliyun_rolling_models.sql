-- 0030: 阿里云 upstream model 统一为「不带日期的滚动名」。
-- 阿里云的「主线」名（deepseek-v4.1-flash / deepseek-v4-pro）会自动跟随最新快照；
-- 带日期的（-1017 / -0813）是固定快照。统一用主线名，避免每次快照升级手动改配置。
UPDATE provider_configs
SET params = REPLACE(REPLACE(params, 'deepseek-v4.1-flash-1017', 'deepseek-v4.1-flash'), 'deepseek-v4-pro-0813', 'deepseek-v4-pro')
WHERE provider = 'aliyun';

UPDATE service_pool
SET upstream_model = CASE upstream_model
  WHEN 'deepseek-v4.1-flash-1017' THEN 'deepseek-v4.1-flash'
  WHEN 'deepseek-v4-pro-0813' THEN 'deepseek-v4-pro'
  ELSE upstream_model END
WHERE provider = 'aliyun';

-- upstream_prices 的 upstream_model 是主键的一部分：先插新名，再删旧名。
INSERT INTO upstream_prices (provider, upstream_model, unit, rates, updated_at)
SELECT 'aliyun', 'deepseek-v4.1-flash', unit, rates, updated_at
FROM upstream_prices WHERE provider = 'aliyun' AND upstream_model = 'deepseek-v4.1-flash-1017'
ON CONFLICT (provider, upstream_model) DO UPDATE SET unit = EXCLUDED.unit, rates = EXCLUDED.rates, updated_at = EXCLUDED.updated_at;
DELETE FROM upstream_prices WHERE provider = 'aliyun' AND upstream_model = 'deepseek-v4.1-flash-1017';

INSERT INTO upstream_prices (provider, upstream_model, unit, rates, updated_at)
SELECT 'aliyun', 'deepseek-v4-pro', unit, rates, updated_at
FROM upstream_prices WHERE provider = 'aliyun' AND upstream_model = 'deepseek-v4-pro-0813'
ON CONFLICT (provider, upstream_model) DO UPDATE SET unit = EXCLUDED.unit, rates = EXCLUDED.rates, updated_at = EXCLUDED.updated_at;
DELETE FROM upstream_prices WHERE provider = 'aliyun' AND upstream_model = 'deepseek-v4-pro-0813';
