-- 0024: initial multi-service-provider data (68).
-- Idempotent: ON CONFLICT DO NOTHING, so admin edits are never overwritten.
-- Keys are NOT seeded (encrypted, created via Hub application layer).

INSERT INTO provider_configs (provider, params, updated_at) VALUES
  ('deepseek', '{"llm":{"models":["deepseek-flash","deepseek-v4-pro"],"modelFamilies":{"deepseek-flash":"deepseek","deepseek-v4-pro":"deepseek"},"protocols":{"anthropic-messages":{"baseURL":"https://api.deepseek.com/anthropic"}}},"asr":{"url":"","protocol":"deepseek-asr-multipart","modelFamilies":{"ds.asr":"deepseek"}},"tts":{"url":"","protocol":"deepseek-tts-json"}}', (extract(epoch from now()) * 1000)::bigint),
  ('volcengine', '{"asr":{"url":"wss://openspeech.bytedance.com/api/v3/sauc/bigmodel","protocol":"volc-sauc-ws","models":["volc.seedasr.sauc.duration"],"modelFamilies":{"volc.seedasr.sauc.duration":"doubao"}},"tts":{"url":"https://openspeech.bytedance.com/api/v3/tts/unidirectional","protocol":"volc-tts-unidirectional","models":["seed-tts-2.0"],"modelFamilies":{"seed-tts-2.0":"doubao"},"voices":[{"id":"zh_female_vv_uranus_bigtts","name":"Vivi 2.0","gender":"female"}]}}', (extract(epoch from now()) * 1000)::bigint),
  ('aliyun', '{"llm":{"models":["deepseek-v4.1-flash-1017","deepseek-v4-pro-0813"],"modelFamilies":{"deepseek-v4.1-flash-1017":"deepseek","deepseek-v4-pro-0813":"deepseek"},"protocols":{"anthropic-messages":{"baseURL":"https://maas.qianwenaiapi.com/apps/anthropic"}}}}', (extract(epoch from now()) * 1000)::bigint)
ON CONFLICT (provider) DO NOTHING;

INSERT INTO services (service, capability, display_name, params, unit, prices, enabled, updated_at) VALUES
  ('deepseek-flash', 'llm', 'DeepSeek Flash', '{"family":"deepseek"}', 'per_mtok', '{"input":4000000,"output":16000000,"cacheRead":80000,"cacheWrite":0}', 1, (extract(epoch from now()) * 1000)::bigint),
  ('deepseek-v4-pro', 'llm', 'DeepSeek V4 Pro', '{"family":"deepseek"}', 'per_mtok', '{"input":18000000,"output":54000000,"cacheRead":600000,"cacheWrite":0}', 1, (extract(epoch from now()) * 1000)::bigint),
  ('deepseek-asr', 'asr', 'DeepSeek ASR', '{"family":"deepseek","aliases":["ds.asr"]}', 'per_second', '{"price":2000}', 1, (extract(epoch from now()) * 1000)::bigint),
  ('doubao-asr', 'asr', '豆包 ASR', '{"family":"doubao","aliases":["volc.bigmodel"]}', 'per_second', '{"price":2000}', 1, (extract(epoch from now()) * 1000)::bigint),
  ('deepseek-tts', 'tts', 'DeepSeek TTS', '{"family":"deepseek","voices":["ds.stella","ds.tide"]}', 'per_char', '{"price":1200}', 1, (extract(epoch from now()) * 1000)::bigint),
  ('doubao-tts', 'tts', '豆包 TTS', '{"family":"doubao","voices":["volc.zh_female_vv_uranus_bigtts"]}', 'per_char', '{"price":1200}', 1, (extract(epoch from now()) * 1000)::bigint)
ON CONFLICT (service) DO NOTHING;

INSERT INTO service_pool (id, service, provider, upstream_model, params, enabled, updated_at) VALUES
  ('sp-deepseek-flash-deepseek', 'deepseek-flash', 'deepseek', 'deepseek-flash', NULL, 1, (extract(epoch from now()) * 1000)::bigint),
  ('sp-deepseek-flash-aliyun', 'deepseek-flash', 'aliyun', 'deepseek-v4.1-flash-1017', NULL, 0, (extract(epoch from now()) * 1000)::bigint),
  ('sp-deepseek-v4-pro-deepseek', 'deepseek-v4-pro', 'deepseek', 'deepseek-v4-pro', NULL, 1, (extract(epoch from now()) * 1000)::bigint),
  ('sp-deepseek-asr-deepseek', 'deepseek-asr', 'deepseek', 'ds.asr', NULL, 1, (extract(epoch from now()) * 1000)::bigint),
  ('sp-doubao-asr-volcengine', 'doubao-asr', 'volcengine', 'volc.seedasr.sauc.duration', NULL, 1, (extract(epoch from now()) * 1000)::bigint),
  ('sp-deepseek-tts-deepseek', 'deepseek-tts', 'deepseek', NULL, '{"voiceMap":{"ds.stella":"stella","ds.tide":"tide"}}', 1, (extract(epoch from now()) * 1000)::bigint),
  ('sp-doubao-tts-volcengine', 'doubao-tts', 'volcengine', NULL, '{"voiceMap":{"volc.zh_female_vv_uranus_bigtts":"zh_female_vv_uranus_bigtts"}}', 1, (extract(epoch from now()) * 1000)::bigint)
ON CONFLICT (service, provider) DO NOTHING;
