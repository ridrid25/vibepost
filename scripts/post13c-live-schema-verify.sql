select json_build_object(
  'post12_tables', (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relname in ('creative_telegram_publications', 'telegram_attribution_tokens')),
  'post13c_tables', (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relname in ('telegram_canary_scope_freeze', 'telegram_canary_audit_manifest', 'telegram_canary_runtime_state', 'telegram_attribution_canary_runs', 'telegram_canary_attribution_events')),
  'rls_tables', (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relrowsecurity and relname in ('telegram_canary_scope_freeze', 'telegram_canary_audit_manifest', 'telegram_canary_runtime_state', 'telegram_attribution_canary_runs', 'telegram_canary_attribution_events')),
  'owner_read_policies', (select count(*) from pg_policies where schemaname = 'public' and tablename in ('telegram_canary_scope_freeze', 'telegram_attribution_canary_runs', 'telegram_canary_attribution_events')),
  'post12_version', (select count(*) from supabase_migrations.schema_migrations where version = '20260901000002'),
  'post13c_version', (select count(*) from supabase_migrations.schema_migrations where version = '20260901000003'),
  'schema_version', (select max(schema_version) from public.telegram_canary_audit_manifest where singleton_key = 'POST13C_AUDIT'),
  'schema_hash_match', (select public.compute_content_factory_leads_canary_schema_hash() = max(expected_schema_hash) from public.telegram_canary_audit_manifest where singleton_key = 'POST13C_AUDIT'),
  'scope_count', (select count(*) from public.telegram_canary_scope_freeze),
  'runtime_count', (select count(*) from public.telegram_canary_runtime_state),
  'run_count', (select count(*) from public.telegram_attribution_canary_runs),
  'token_count', (select count(*) from public.telegram_attribution_tokens where destination = 'content_factory_leads_canary'),
  'event_count', (select count(*) from public.telegram_canary_attribution_events)
) as verification;
