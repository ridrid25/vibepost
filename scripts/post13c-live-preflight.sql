select json_build_object(
  'post12_objects', (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relname in ('creative_telegram_publications', 'telegram_attribution_tokens')),
  'post13c_objects', (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relname in ('telegram_canary_scope_freeze', 'telegram_canary_audit_manifest', 'telegram_canary_runtime_state', 'telegram_attribution_canary_runs', 'telegram_canary_attribution_events')),
  'owner_anchor', (select count(*) from pg_constraint where connamespace = 'public'::regnamespace and conname = 'creative_identity_map_post12_owner_unique'),
  'creative_id_dupes', (select count(*) from (select id, user_id from public.creative_identity_map group by id, user_id having count(*) > 1) d),
  'post_owner_dupes', (select count(*) from (select id, user_id from public.posts group by id, user_id having count(*) > 1) d),
  'migration_12', (select count(*) from supabase_migrations.schema_migrations where version = '20260901000002'),
  'migration_13c', (select count(*) from supabase_migrations.schema_migrations where version = '20260901000003'),
  'ledger_columns', (select json_agg(json_build_object('name', column_name, 'type', data_type, 'nullable', is_nullable) order by ordinal_position)
    from information_schema.columns
    where table_schema = 'supabase_migrations' and table_name = 'schema_migrations'),
  'accepted_prerequisites', (select json_agg(json_build_object('version', version, 'name', name) order by version)
    from supabase_migrations.schema_migrations
    where version in ('20260831235958', '20260831235959'))
) as preflight;
