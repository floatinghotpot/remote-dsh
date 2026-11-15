-- 0026: legacy → service-provider model (68) one-time data migration.

-- (a) llm_models prices → services (LLM model proxies). family = provider.
INSERT INTO services (service, capability, display_name, params, unit, prices, enabled, updated_at)
SELECT id, 'llm', display_name,
       jsonb_build_object('family', provider)::text,
       'per_mtok',
       jsonb_build_object('input', input_price_micro, 'output', output_price_micro,
                          'cacheRead', cache_read_price_micro, 'cacheWrite', cache_write_price_micro)::text,
       enabled, updated_at
FROM llm_models
ON CONFLICT (service) DO NOTHING;

-- (b) voice_provider_configs url/resourceId merged into provider_configs (protocols come from 0024 seed).
DO $$
DECLARE
  r RECORD;
  new_params jsonb;
BEGIN
  FOR r IN SELECT provider, params FROM voice_provider_configs LOOP
    new_params := COALESCE((SELECT params::jsonb FROM provider_configs WHERE provider = r.provider), '{}'::jsonb);
    IF r.params::jsonb ? 'asrUrl' AND r.params::jsonb->>'asrUrl' <> '' THEN
      new_params := jsonb_set(new_params, '{asr,url}', to_jsonb(r.params::jsonb->>'asrUrl'), true);
    END IF;
    IF r.params::jsonb ? 'ttsUrl' AND r.params::jsonb->>'ttsUrl' <> '' THEN
      new_params := jsonb_set(new_params, '{tts,url}', to_jsonb(r.params::jsonb->>'ttsUrl'), true);
    END IF;
    IF r.params::jsonb ? 'ttsResourceId' AND r.params::jsonb->>'ttsResourceId' <> '' THEN
      new_params := jsonb_set(new_params, '{tts,resourceId}', to_jsonb(r.params::jsonb->>'ttsResourceId'), true);
    END IF;
    INSERT INTO provider_configs (provider, params, updated_at)
    VALUES (r.provider, new_params::text, (extract(epoch from now()) * 1000)::bigint)
    ON CONFLICT (provider) DO UPDATE SET params = EXCLUDED.params, updated_at = EXCLUDED.updated_at;
  END LOOP;
END $$;
