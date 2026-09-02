-- META-FIRST closed content loop v1.
-- Provider access is GET-only; this migration stores normalized, PII-free facts.

create table public.creative_analysis_dimensions (
  id uuid constraint creative_analysis_dimensions_pkey primary key default gen_random_uuid(),
  user_id uuid not null constraint creative_analysis_dimensions_user_fk references auth.users(id) on delete cascade,
  identity_map_id uuid not null,
  creative_id text not null constraint creative_analysis_dimensions_creative_id_check check (creative_id ~ '^creative-[0-9a-f]{64}$'),
  product_key text not null,
  audience_key text not null,
  topic_key text not null,
  format_key text not null,
  angle_key text not null,
  source_kind text not null,
  source_ref text not null,
  source_hash text not null,
  created_at timestamptz not null default now(),
  constraint creative_analysis_dimensions_id_user_key unique(id,user_id),
  constraint creative_analysis_dimensions_owner_creative_key unique(user_id,creative_id),
  constraint creative_analysis_dimensions_identity_owner_fk foreign key(identity_map_id,user_id,creative_id)
    references public.creative_identity_map(id,user_id,creative_id),
  constraint creative_analysis_dimensions_keys_check check (
    product_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and audience_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    and topic_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and format_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    and angle_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  constraint creative_analysis_dimensions_source_check check (source_kind in ('OWNER_ASSERTED','TEXT_HANDOFF')),
  constraint creative_analysis_dimensions_source_ref_check check (source_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  constraint creative_analysis_dimensions_source_hash_check check (source_hash ~ '^[0-9a-f]{64}$')
);

create table public.meta_provider_objects (
  id uuid constraint meta_provider_objects_pkey primary key default gen_random_uuid(),
  user_id uuid not null constraint meta_provider_objects_user_fk references auth.users(id) on delete cascade,
  provider_account_id text not null,
  object_kind text not null,
  external_id text not null,
  parent_external_id text,
  campaign_external_id text,
  adset_external_id text,
  creative_external_id text,
  objective_key text,
  optimization_goal text,
  api_version text not null,
  payload_hash text not null,
  observed_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint meta_provider_objects_id_user_key unique(id,user_id),
  constraint meta_provider_objects_kind_check check (object_kind in ('ACCOUNT','CAMPAIGN','ADSET','AD','CREATIVE')),
  constraint meta_provider_objects_ids_check check (
    provider_account_id ~ '^[0-9]{1,64}$' and external_id ~ '^[0-9]{1,64}$'
    and (parent_external_id is null or parent_external_id ~ '^[0-9]{1,64}$')
    and (campaign_external_id is null or campaign_external_id ~ '^[0-9]{1,64}$')
    and (adset_external_id is null or adset_external_id ~ '^[0-9]{1,64}$')
    and (creative_external_id is null or creative_external_id ~ '^[0-9]{1,64}$')),
  constraint meta_provider_objects_hierarchy_check check (
    (object_kind='ACCOUNT' and external_id=provider_account_id and parent_external_id is null and campaign_external_id is null and adset_external_id is null and creative_external_id is null)
    or (object_kind='CAMPAIGN' and parent_external_id=provider_account_id and campaign_external_id=external_id and adset_external_id is null and creative_external_id is null)
    or (object_kind='ADSET' and parent_external_id=campaign_external_id and campaign_external_id is not null and adset_external_id=external_id and creative_external_id is null)
    or (object_kind='CREATIVE' and parent_external_id=provider_account_id and campaign_external_id is null and adset_external_id is null and creative_external_id=external_id)
    or (object_kind='AD' and parent_external_id=adset_external_id and campaign_external_id is not null and adset_external_id is not null and creative_external_id is not null)),
  constraint meta_provider_objects_metadata_check check (
    (objective_key is null or objective_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
    and (optimization_goal is null or optimization_goal ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
    and api_version ~ '^(v[0-9]+\.[0-9]+|v-fixture)$'),
  constraint meta_provider_objects_payload_hash_check check (payload_hash ~ '^[0-9a-f]{64}$')
);
create unique index meta_provider_objects_owner_kind_external_unique
  on public.meta_provider_objects(user_id,provider_account_id,object_kind,external_id);

create table public.meta_creative_ad_bindings (
  id uuid constraint meta_creative_ad_bindings_pkey primary key default gen_random_uuid(),
  user_id uuid not null constraint meta_creative_ad_bindings_user_fk references auth.users(id) on delete cascade,
  identity_map_id uuid not null,
  creative_id text not null,
  provider_account_id text not null,
  provider_ad_id text not null,
  provider_creative_id text not null,
  ad_object_id uuid not null,
  creative_object_id uuid not null,
  binding_source text not null,
  binding_evidence_hash text not null,
  bound_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint meta_creative_ad_bindings_id_user_key unique(id,user_id),
  constraint meta_creative_ad_bindings_creative_id_check check (creative_id ~ '^creative-[0-9a-f]{64}$'),
  constraint meta_creative_ad_bindings_ids_check check (provider_account_id ~ '^[0-9]{1,64}$' and provider_ad_id ~ '^[0-9]{1,64}$' and provider_creative_id ~ '^[0-9]{1,64}$'),
  constraint meta_creative_ad_bindings_source_check check (binding_source in ('OWNER_ASSERTED','TEXT_HANDOFF')),
  constraint meta_creative_ad_bindings_hash_check check (binding_evidence_hash ~ '^[0-9a-f]{64}$'),
  constraint meta_creative_ad_bindings_identity_owner_fk foreign key(identity_map_id,user_id,creative_id)
    references public.creative_identity_map(id,user_id,creative_id),
  constraint meta_creative_ad_bindings_ad_owner_fk foreign key(ad_object_id,user_id)
    references public.meta_provider_objects(id,user_id),
  constraint meta_creative_ad_bindings_creative_owner_fk foreign key(creative_object_id,user_id)
    references public.meta_provider_objects(id,user_id)
);
create unique index meta_creative_ad_bindings_owner_ad_unique
  on public.meta_creative_ad_bindings(user_id,provider_account_id,provider_ad_id);

create table public.meta_insight_snapshots (
  id uuid constraint meta_insight_snapshots_pkey primary key default gen_random_uuid(),
  user_id uuid not null constraint meta_insight_snapshots_user_fk references auth.users(id) on delete cascade,
  binding_id uuid not null,
  provider_account_id text not null,
  provider_ad_id text not null,
  date_start date not null,
  date_stop date not null,
  collected_at timestamptz not null,
  currency text not null,
  attribution_setting text,
  placement_key text not null,
  audience_key text not null,
  optimization_goal text,
  cohort_hash text not null,
  field_set_version text not null,
  api_version text not null,
  payload_hash text not null,
  snapshot_key text not null,
  spend numeric,
  spend_state text not null,
  impressions bigint,
  impressions_state text not null,
  reach bigint,
  reach_state text not null,
  frequency numeric,
  frequency_state text not null,
  clicks bigint,
  clicks_state text not null,
  ctr numeric,
  ctr_state text not null,
  cpc numeric,
  cpc_state text not null,
  cpm numeric,
  cpm_state text not null,
  limitations text[] not null default '{}',
  created_at timestamptz not null default now(),
  constraint meta_insight_snapshots_id_user_key unique(id,user_id),
  constraint meta_insight_snapshots_binding_owner_fk foreign key(binding_id,user_id)
    references public.meta_creative_ad_bindings(id,user_id),
  constraint meta_insight_snapshots_ids_check check (provider_account_id ~ '^[0-9]{1,64}$' and provider_ad_id ~ '^[0-9]{1,64}$'),
  constraint meta_insight_snapshots_dates_check check (date_start <= date_stop),
  constraint meta_insight_snapshots_currency_check check (currency ~ '^[A-Z]{3}$' or currency = 'UNKNOWN'),
  constraint meta_insight_snapshots_metadata_check check (
    (attribution_setting is null or attribution_setting ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
    and placement_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    and audience_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    and (optimization_goal is null or optimization_goal ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
    and field_set_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    and api_version ~ '^(v[0-9]+\.[0-9]+|v-fixture)$'),
  constraint meta_insight_snapshots_hashes_check check (cohort_hash ~ '^[0-9a-f]{64}$' and payload_hash ~ '^[0-9a-f]{64}$' and snapshot_key ~ '^[0-9a-f]{64}$'),
  constraint meta_insight_snapshots_states_check check (
    spend_state in ('KNOWN','UNKNOWN') and impressions_state in ('KNOWN','UNKNOWN') and reach_state in ('KNOWN','UNKNOWN')
    and frequency_state in ('KNOWN','UNKNOWN') and clicks_state in ('KNOWN','UNKNOWN') and ctr_state in ('KNOWN','UNKNOWN')
    and cpc_state in ('KNOWN','UNKNOWN') and cpm_state in ('KNOWN','UNKNOWN')),
  constraint meta_insight_snapshots_values_check check (
    ((spend_state='KNOWN' and spend>=0) or (spend_state='UNKNOWN' and spend is null))
    and ((impressions_state='KNOWN' and impressions>=0) or (impressions_state='UNKNOWN' and impressions is null))
    and ((reach_state='KNOWN' and reach>=0) or (reach_state='UNKNOWN' and reach is null))
    and ((frequency_state='KNOWN' and frequency>=0) or (frequency_state='UNKNOWN' and frequency is null))
    and ((clicks_state='KNOWN' and clicks>=0) or (clicks_state='UNKNOWN' and clicks is null))
    and ((ctr_state='KNOWN' and ctr>=0) or (ctr_state='UNKNOWN' and ctr is null))
    and ((cpc_state='KNOWN' and cpc>=0) or (cpc_state='UNKNOWN' and cpc is null))
    and ((cpm_state='KNOWN' and cpm>=0) or (cpm_state='UNKNOWN' and cpm is null)))
);
create unique index meta_insight_snapshots_owner_subject_hash_unique
  on public.meta_insight_snapshots(user_id,provider_account_id,provider_ad_id,snapshot_key);

create table public.meta_insight_actions (
  id uuid constraint meta_insight_actions_pkey primary key default gen_random_uuid(),
  user_id uuid not null constraint meta_insight_actions_user_fk references auth.users(id) on delete cascade,
  snapshot_id uuid not null,
  action_type text not null,
  value numeric,
  value_state text not null,
  currency text,
  authoritative boolean not null default false,
  created_at timestamptz not null default now(),
  constraint meta_insight_actions_id_user_key unique(id,user_id),
  constraint meta_insight_actions_snapshot_owner_fk foreign key(snapshot_id,user_id)
    references public.meta_insight_snapshots(id,user_id),
  constraint meta_insight_actions_type_check check (action_type ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  constraint meta_insight_actions_state_check check (value_state in ('KNOWN','UNKNOWN')),
  constraint meta_insight_actions_value_check check ((value_state='KNOWN' and value>=0) or (value_state='UNKNOWN' and value is null)),
  constraint meta_insight_actions_currency_check check (currency is null or currency ~ '^[A-Z]{3}$')
);
create unique index meta_insight_actions_snapshot_type_unique
  on public.meta_insight_actions(snapshot_id,action_type);

alter table public.experiments
  add column control_meta_binding_id uuid,
  add column variant_meta_binding_id uuid;
alter table public.content_analysis_results add column meta_snapshot_id uuid;
alter table public.content_lessons add column meta_lesson_key text;
alter table public.content_hypotheses
  add column topic_family_key text,
  add column topic_action text,
  add column decision_context_hash text;

alter table public.experiments
  add constraint experiments_control_meta_binding_owner_fk foreign key(control_meta_binding_id,user_id) references public.meta_creative_ad_bindings(id,user_id),
  add constraint experiments_variant_meta_binding_owner_fk foreign key(variant_meta_binding_id,user_id) references public.meta_creative_ad_bindings(id,user_id);
alter table public.content_analysis_results
  add constraint content_analysis_meta_snapshot_owner_fk foreign key(meta_snapshot_id,user_id) references public.meta_insight_snapshots(id,user_id);
alter table public.content_hypotheses
  add constraint content_hypotheses_topic_action_check check (topic_action is null or topic_action in ('CONTINUE','MUTATE','RETEST','PAUSE','EXPLORE_ADJACENT','NEW_TOPIC')),
  add constraint content_hypotheses_decision_hash_check check (decision_context_hash is null or decision_context_hash ~ '^[0-9a-f]{64}$');
alter table public.content_lessons
  add constraint content_lessons_meta_key_check check (meta_lesson_key is null or meta_lesson_key ~ '^[0-9a-f]{64}$');

alter table public.experiments drop constraint experiments_platform_check;
alter table public.experiments drop constraint experiments_metric_source_check;
alter table public.experiments drop constraint experiments_youtube_subject_check;
alter table public.experiments
  add constraint experiments_platform_check check (platform in ('tiktok','youtube_shorts','meta_ads')),
  add constraint experiments_metric_source_check check (metric_source is null or metric_source in ('tiktok','youtube','meta')),
  add constraint experiments_youtube_subject_check check (
    (platform='tiktok' and control_youtube_short_id is null and variant_youtube_short_id is null
      and control_identity_map_id is null and variant_identity_map_id is null and control_creative_id is null
      and variant_creative_id is null and control_material_vector is null and variant_material_vector is null
      and control_meta_binding_id is null and variant_meta_binding_id is null)
    or (platform='youtube_shorts' and control_video_id is null and control_youtube_short_id is not null and variant_youtube_short_id is not null
      and control_identity_map_id is not null and variant_identity_map_id is not null and control_creative_id ~ '^creative-[0-9a-f]{64}$'
      and variant_creative_id ~ '^creative-[0-9a-f]{64}$' and control_material_vector is not null and variant_material_vector is not null
      and metric_source='youtube' and control_meta_binding_id is null and variant_meta_binding_id is null)
    or (platform='meta_ads' and control_video_id is null and control_youtube_short_id is null and variant_youtube_short_id is null
      and control_identity_map_id is null and variant_identity_map_id is null and control_creative_id ~ '^creative-[0-9a-f]{64}$'
      and variant_creative_id ~ '^creative-[0-9a-f]{64}$' and jsonb_typeof(control_material_vector)='object'
      and jsonb_typeof(variant_material_vector)='object' and metric_source='meta'
      and control_meta_binding_id is not null and variant_meta_binding_id is not null)
  );

alter table public.content_analysis_results drop constraint content_analysis_platform_check;
alter table public.content_analysis_results drop constraint content_analysis_subject_check;
alter table public.content_analysis_results
  add constraint content_analysis_platform_check check (platform in ('tiktok','youtube_shorts','meta_ads')),
  add constraint content_analysis_subject_check check (
    (platform='tiktok' and video_id is not null and youtube_short_id is null and youtube_snapshot_polled_at is null and meta_snapshot_id is null)
    or (platform='youtube_shorts' and video_id is null and youtube_short_id is not null and youtube_snapshot_polled_at is not null and meta_snapshot_id is null)
    or (platform='meta_ads' and video_id is null and youtube_short_id is null and youtube_snapshot_polled_at is null and meta_snapshot_id is not null)
  );
create unique index content_analysis_meta_subject_unique
  on public.content_analysis_results(user_id,meta_snapshot_id,checkpoint,experiment_id) where platform='meta_ads';

alter table public.content_lessons drop constraint content_lessons_source_platform_check;
alter table public.content_lessons drop constraint content_lessons_platform_evidence_check;
alter table public.content_lessons
  add constraint content_lessons_source_platform_check check (source_platform in ('tiktok','youtube_shorts','meta_ads')),
  add constraint content_lessons_platform_evidence_check check (
    (source_platform='tiktok' and cardinality(creative_ids_used)=0 and metric_provenance='[]'::jsonb and limitations='[]'::jsonb and meta_lesson_key is null)
    or (source_platform='youtube_shorts' and cardinality(videos_used)=0 and changed_variable is not null and cardinality(creative_ids_used)>0
      and jsonb_array_length(metric_provenance)>0 and meta_lesson_key is null)
    or (source_platform='meta_ads' and cardinality(videos_used)=0 and changed_variable is not null and cardinality(creative_ids_used)>0
      and jsonb_array_length(metric_provenance)>0 and youtube_lesson_key is null and meta_lesson_key is not null)
  );
create unique index content_lessons_meta_key_unique on public.content_lessons(user_id,meta_lesson_key) where meta_lesson_key is not null;
create unique index content_hypotheses_decision_context_unique on public.content_hypotheses(user_id,decision_context_hash) where decision_context_hash is not null;

create table public.meta_experiment_evidence (
  id uuid constraint meta_experiment_evidence_pkey primary key default gen_random_uuid(),
  user_id uuid not null constraint meta_experiment_evidence_user_fk references auth.users(id) on delete cascade,
  experiment_id uuid not null,
  control_binding_id uuid not null,
  variant_binding_id uuid not null,
  control_snapshot_id uuid not null,
  variant_snapshot_id uuid not null,
  cohort_hash text not null,
  policy_version text not null,
  evidence_hash text not null,
  created_at timestamptz not null default now(),
  constraint meta_experiment_evidence_id_user_key unique(id,user_id),
  constraint meta_experiment_evidence_experiment_owner_fk foreign key(experiment_id,user_id) references public.experiments(id,user_id),
  constraint meta_experiment_evidence_control_binding_owner_fk foreign key(control_binding_id,user_id) references public.meta_creative_ad_bindings(id,user_id),
  constraint meta_experiment_evidence_variant_binding_owner_fk foreign key(variant_binding_id,user_id) references public.meta_creative_ad_bindings(id,user_id),
  constraint meta_experiment_evidence_control_snapshot_owner_fk foreign key(control_snapshot_id,user_id) references public.meta_insight_snapshots(id,user_id),
  constraint meta_experiment_evidence_variant_snapshot_owner_fk foreign key(variant_snapshot_id,user_id) references public.meta_insight_snapshots(id,user_id),
  constraint meta_experiment_evidence_pair_check check (control_binding_id<>variant_binding_id and control_snapshot_id<>variant_snapshot_id),
  constraint meta_experiment_evidence_hashes_check check (cohort_hash ~ '^[0-9a-f]{64}$' and evidence_hash ~ '^[0-9a-f]{64}$' and policy_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
);
create unique index meta_experiment_evidence_experiment_unique on public.meta_experiment_evidence(experiment_id);

create table public.content_analysis_meta_evidence (
  analysis_id uuid constraint content_analysis_meta_evidence_pkey primary key,
  user_id uuid not null constraint content_analysis_meta_evidence_user_fk references auth.users(id) on delete cascade,
  meta_experiment_evidence_id uuid not null,
  evidence_hash text not null,
  created_at timestamptz not null default now(),
  constraint content_analysis_meta_evidence_analysis_user_key unique(analysis_id,user_id),
  constraint content_analysis_meta_evidence_lineage_key unique(analysis_id,user_id,meta_experiment_evidence_id),
  constraint content_analysis_meta_evidence_analysis_owner_fk foreign key(analysis_id,user_id) references public.content_analysis_results(id,user_id),
  constraint content_analysis_meta_evidence_experiment_owner_fk foreign key(meta_experiment_evidence_id,user_id) references public.meta_experiment_evidence(id,user_id),
  constraint content_analysis_meta_evidence_hash_check check (evidence_hash ~ '^[0-9a-f]{64}$')
);
create unique index content_analysis_meta_evidence_meta_unique on public.content_analysis_meta_evidence(meta_experiment_evidence_id);

create table public.content_lesson_meta_evidence (
  lesson_id uuid constraint content_lesson_meta_evidence_pkey primary key,
  user_id uuid not null constraint content_lesson_meta_evidence_user_fk references auth.users(id) on delete cascade,
  analysis_id uuid not null,
  meta_experiment_evidence_id uuid not null,
  evidence_hash text not null,
  created_at timestamptz not null default now(),
  constraint content_lesson_meta_evidence_lesson_user_key unique(lesson_id,user_id),
  constraint content_lesson_meta_evidence_lesson_owner_fk foreign key(lesson_id,user_id) references public.content_lessons(id,user_id),
  constraint content_lesson_meta_evidence_analysis_owner_fk foreign key(analysis_id,user_id,meta_experiment_evidence_id)
    references public.content_analysis_meta_evidence(analysis_id,user_id,meta_experiment_evidence_id),
  constraint content_lesson_meta_evidence_experiment_owner_fk foreign key(meta_experiment_evidence_id,user_id) references public.meta_experiment_evidence(id,user_id),
  constraint content_lesson_meta_evidence_hash_check check (evidence_hash ~ '^[0-9a-f]{64}$')
);
create unique index content_lesson_meta_evidence_analysis_unique on public.content_lesson_meta_evidence(analysis_id);
create unique index content_lesson_meta_evidence_experiment_unique on public.content_lesson_meta_evidence(meta_experiment_evidence_id);

alter table public.creative_analysis_dimensions enable row level security;
alter table public.meta_provider_objects enable row level security;
alter table public.meta_creative_ad_bindings enable row level security;
alter table public.meta_insight_snapshots enable row level security;
alter table public.meta_insight_actions enable row level security;
alter table public.meta_experiment_evidence enable row level security;
alter table public.content_analysis_meta_evidence enable row level security;
alter table public.content_lesson_meta_evidence enable row level security;

create policy creative_analysis_dimensions_owner_read on public.creative_analysis_dimensions for select using ((select auth.uid())=user_id);
create policy meta_provider_objects_owner_read on public.meta_provider_objects for select using ((select auth.uid())=user_id);
create policy meta_creative_ad_bindings_owner_read on public.meta_creative_ad_bindings for select using ((select auth.uid())=user_id);
create policy meta_insight_snapshots_owner_read on public.meta_insight_snapshots for select using ((select auth.uid())=user_id);
create policy meta_insight_actions_owner_read on public.meta_insight_actions for select using ((select auth.uid())=user_id);
create policy meta_experiment_evidence_owner_read on public.meta_experiment_evidence for select using ((select auth.uid())=user_id);
create policy content_analysis_meta_evidence_owner_read on public.content_analysis_meta_evidence for select using ((select auth.uid())=user_id);
create policy content_lesson_meta_evidence_owner_read on public.content_lesson_meta_evidence for select using ((select auth.uid())=user_id);

revoke all on public.creative_analysis_dimensions,public.meta_provider_objects,public.meta_creative_ad_bindings,
  public.meta_insight_snapshots,public.meta_insight_actions,public.meta_experiment_evidence,
  public.content_analysis_meta_evidence,public.content_lesson_meta_evidence from public,anon,authenticated,service_role;
grant select on public.creative_analysis_dimensions,public.meta_provider_objects,public.meta_creative_ad_bindings,
  public.meta_insight_snapshots,public.meta_insight_actions,public.meta_experiment_evidence,
  public.content_analysis_meta_evidence,public.content_lesson_meta_evidence to authenticated,service_role;

-- Normalized RPCs are the only mutation entry points for the new service-owned rows.
create or replace function public.persist_meta_readonly_batch(p_batch jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid; v_row jsonb; v_metric text; v_expected_hash text; v_count integer:=0;
begin
  if coalesce((select auth.role()),'')<>'service_role' then raise exception 'META_SERVICE_ROLE_REQUIRED'; end if;
  if jsonb_typeof(p_batch)<>'object' or not p_batch ?& array['schema','user_id','profiles','objects','bindings','snapshots','actions','batch_hash']
    or p_batch-array['schema','user_id','profiles','objects','bindings','snapshots','actions','batch_hash']<>'{}'::jsonb
    or p_batch->>'schema'<>'meta-normalized-batch-v1' or p_batch->>'batch_hash' !~ '^[0-9a-f]{64}$'
    or p_batch::text~* '"(name|email|phone|ip|device_id|headline|description|message|body|copy|url|targeting|custom_audiences|lead_form|comments|raw|raw_payload|access_token)"[[:space:]]*:'
    then raise exception 'META_NORMALIZED_BATCH_INVALID'; end if;
  v_user:=(p_batch->>'user_id')::uuid;
  v_expected_hash:=encode(extensions.digest(convert_to(public.canonical_jsonb_text(p_batch-'batch_hash'),'UTF8'),'sha256'),'hex');
  if p_batch->>'batch_hash'<>v_expected_hash then raise exception 'META_BATCH_HASH_INVALID'; end if;
  if jsonb_typeof(p_batch->'profiles')<>'array' or jsonb_typeof(p_batch->'objects')<>'array'
    or jsonb_typeof(p_batch->'bindings')<>'array' or jsonb_typeof(p_batch->'snapshots')<>'array'
    or jsonb_typeof(p_batch->'actions')<>'array' then raise exception 'META_NORMALIZED_BATCH_INVALID'; end if;

  for v_row in select value from jsonb_array_elements(p_batch->'profiles') loop
    if jsonb_typeof(v_row)<>'object'
      or not v_row ?& array['id','user_id','identity_map_id','creative_id','product_key','audience_key','topic_key','format_key','angle_key','source_kind','source_ref','source_hash']
      or v_row-array['id','user_id','identity_map_id','creative_id','product_key','audience_key','topic_key','format_key','angle_key','source_kind','source_ref','source_hash']<>'{}'::jsonb
      then raise exception 'META_NORMALIZED_BATCH_INVALID'; end if;
    if (v_row->>'user_id')::uuid<>v_user or not exists(select 1 from public.creative_identity_map m where m.id=(v_row->>'identity_map_id')::uuid and m.user_id=v_user and m.creative_id=v_row->>'creative_id') then raise exception 'META_IDENTITY_ANCHOR_UNKNOWN'; end if;
    insert into public.creative_analysis_dimensions(id,user_id,identity_map_id,creative_id,product_key,audience_key,topic_key,format_key,angle_key,source_kind,source_ref,source_hash)
    values((v_row->>'id')::uuid,v_user,(v_row->>'identity_map_id')::uuid,v_row->>'creative_id',v_row->>'product_key',v_row->>'audience_key',v_row->>'topic_key',v_row->>'format_key',v_row->>'angle_key',v_row->>'source_kind',v_row->>'source_ref',v_row->>'source_hash') on conflict do nothing;
    if not exists(select 1 from public.creative_analysis_dimensions d where d.id=(v_row->>'id')::uuid and d.user_id=v_user and d.identity_map_id=(v_row->>'identity_map_id')::uuid and d.creative_id=v_row->>'creative_id' and d.product_key=v_row->>'product_key' and d.audience_key=v_row->>'audience_key' and d.topic_key=v_row->>'topic_key' and d.format_key=v_row->>'format_key' and d.angle_key=v_row->>'angle_key' and d.source_kind=v_row->>'source_kind' and d.source_ref=v_row->>'source_ref' and d.source_hash=v_row->>'source_hash') then raise exception 'META_IMMUTABLE_CONFLICT'; end if; v_count:=v_count+1;
  end loop;
  for v_row in select value from jsonb_array_elements(p_batch->'objects') loop
    if jsonb_typeof(v_row)<>'object'
      or not v_row ?& array['id','user_id','provider_account_id','object_kind','external_id','parent_external_id','campaign_external_id','adset_external_id','creative_external_id','objective_key','optimization_goal','api_version','payload_hash','observed_at']
      or v_row-array['id','user_id','provider_account_id','object_kind','external_id','parent_external_id','campaign_external_id','adset_external_id','creative_external_id','objective_key','optimization_goal','api_version','payload_hash','observed_at']<>'{}'::jsonb
      or (v_row->>'user_id')::uuid<>v_user then raise exception 'META_NORMALIZED_BATCH_INVALID'; end if;
    v_expected_hash:=encode(extensions.digest(convert_to(public.canonical_jsonb_text(jsonb_build_object(
      'provider_account_id',v_row->'provider_account_id','object_kind',v_row->'object_kind','external_id',v_row->'external_id',
      'parent_external_id',v_row->'parent_external_id','campaign_external_id',v_row->'campaign_external_id',
      'adset_external_id',v_row->'adset_external_id','creative_external_id',v_row->'creative_external_id',
      'objective_key',v_row->'objective_key','optimization_goal',v_row->'optimization_goal')),'UTF8'),'sha256'),'hex');
    if v_row->>'payload_hash'<>v_expected_hash then raise exception 'META_PROVIDER_HASH_INVALID'; end if;
    insert into public.meta_provider_objects(id,user_id,provider_account_id,object_kind,external_id,parent_external_id,campaign_external_id,adset_external_id,creative_external_id,objective_key,optimization_goal,api_version,payload_hash,observed_at)
    values((v_row->>'id')::uuid,v_user,v_row->>'provider_account_id',v_row->>'object_kind',v_row->>'external_id',v_row->>'parent_external_id',v_row->>'campaign_external_id',v_row->>'adset_external_id',v_row->>'creative_external_id',v_row->>'objective_key',v_row->>'optimization_goal',v_row->>'api_version',v_row->>'payload_hash',(v_row->>'observed_at')::timestamptz) on conflict do nothing;
    if not exists(select 1 from public.meta_provider_objects o where o.id=(v_row->>'id')::uuid and o.user_id=v_user
      and o.provider_account_id=v_row->>'provider_account_id' and o.object_kind=v_row->>'object_kind' and o.external_id=v_row->>'external_id'
      and o.parent_external_id is not distinct from v_row->>'parent_external_id' and o.campaign_external_id is not distinct from v_row->>'campaign_external_id'
      and o.adset_external_id is not distinct from v_row->>'adset_external_id' and o.creative_external_id is not distinct from v_row->>'creative_external_id'
      and o.objective_key is not distinct from v_row->>'objective_key' and o.optimization_goal is not distinct from v_row->>'optimization_goal'
      and o.api_version=v_row->>'api_version' and o.payload_hash=v_row->>'payload_hash' and o.observed_at=(v_row->>'observed_at')::timestamptz)
      then raise exception 'META_IMMUTABLE_CONFLICT'; end if; v_count:=v_count+1;
  end loop;
  for v_row in select value from jsonb_array_elements(p_batch->'objects') loop
    if (v_row->>'object_kind'='CAMPAIGN' and not exists(select 1 from public.meta_provider_objects p
          where p.user_id=v_user and p.provider_account_id=v_row->>'provider_account_id' and p.object_kind='ACCOUNT'
            and p.external_id=v_row->>'parent_external_id'))
      or (v_row->>'object_kind'='ADSET' and not exists(select 1 from public.meta_provider_objects p
          where p.user_id=v_user and p.provider_account_id=v_row->>'provider_account_id' and p.object_kind='CAMPAIGN'
            and p.external_id=v_row->>'campaign_external_id' and p.external_id=v_row->>'parent_external_id'))
      or (v_row->>'object_kind'='CREATIVE' and not exists(select 1 from public.meta_provider_objects p
          where p.user_id=v_user and p.provider_account_id=v_row->>'provider_account_id' and p.object_kind='ACCOUNT'
            and p.external_id=v_row->>'parent_external_id'))
      or (v_row->>'object_kind'='AD' and not exists(select 1 from public.meta_provider_objects s,public.meta_provider_objects c
          where s.user_id=v_user and s.provider_account_id=v_row->>'provider_account_id' and s.object_kind='ADSET'
            and s.external_id=v_row->>'adset_external_id' and s.campaign_external_id=v_row->>'campaign_external_id'
            and c.user_id=v_user and c.provider_account_id=v_row->>'provider_account_id' and c.object_kind='CREATIVE'
            and c.external_id=v_row->>'creative_external_id'))
      then raise exception 'META_PROVIDER_HIERARCHY_INVALID'; end if;
  end loop;
  for v_row in select value from jsonb_array_elements(p_batch->'bindings') loop
    if jsonb_typeof(v_row)<>'object'
      or not v_row ?& array['id','user_id','identity_map_id','creative_id','provider_account_id','provider_ad_id','provider_creative_id','ad_object_id','creative_object_id','binding_source','binding_evidence_hash','bound_at']
      or v_row-array['id','user_id','identity_map_id','creative_id','provider_account_id','provider_ad_id','provider_creative_id','ad_object_id','creative_object_id','binding_source','binding_evidence_hash','bound_at']<>'{}'::jsonb
      then raise exception 'META_NORMALIZED_BATCH_INVALID'; end if;
    if (v_row->>'user_id')::uuid<>v_user or not exists(select 1 from public.creative_identity_map m where m.id=(v_row->>'identity_map_id')::uuid and m.user_id=v_user and m.creative_id=v_row->>'creative_id') then raise exception 'META_IDENTITY_ANCHOR_UNKNOWN'; end if;
    if not exists(select 1 from public.meta_provider_objects a,public.meta_provider_objects c
      where a.id=(v_row->>'ad_object_id')::uuid and a.user_id=v_user and a.object_kind='AD'
        and a.provider_account_id=v_row->>'provider_account_id' and a.external_id=v_row->>'provider_ad_id'
        and a.creative_external_id=v_row->>'provider_creative_id'
        and c.id=(v_row->>'creative_object_id')::uuid and c.user_id=v_user and c.object_kind='CREATIVE'
        and c.provider_account_id=v_row->>'provider_account_id' and c.external_id=v_row->>'provider_creative_id')
      then raise exception 'META_PROVIDER_HIERARCHY_INVALID'; end if;
    v_expected_hash:=encode(extensions.digest(convert_to(public.canonical_jsonb_text(jsonb_build_object(
      'id',v_row->'id','identity_map_id',v_row->'identity_map_id','creative_id',v_row->'creative_id',
      'account_id',v_row->'provider_account_id','ad_id',v_row->'provider_ad_id','provider_creative_id',v_row->'provider_creative_id',
      'binding_source',v_row->'binding_source','bound_at',v_row->'bound_at')),'UTF8'),'sha256'),'hex');
    if v_row->>'binding_evidence_hash'<>v_expected_hash then raise exception 'META_BINDING_HASH_INVALID'; end if;
    insert into public.meta_creative_ad_bindings(id,user_id,identity_map_id,creative_id,provider_account_id,provider_ad_id,provider_creative_id,ad_object_id,creative_object_id,binding_source,binding_evidence_hash,bound_at)
    values((v_row->>'id')::uuid,v_user,(v_row->>'identity_map_id')::uuid,v_row->>'creative_id',v_row->>'provider_account_id',v_row->>'provider_ad_id',v_row->>'provider_creative_id',(v_row->>'ad_object_id')::uuid,(v_row->>'creative_object_id')::uuid,v_row->>'binding_source',v_row->>'binding_evidence_hash',(v_row->>'bound_at')::timestamptz) on conflict do nothing;
    if not exists(select 1 from public.meta_creative_ad_bindings b where b.id=(v_row->>'id')::uuid and b.user_id=v_user
      and b.identity_map_id=(v_row->>'identity_map_id')::uuid and b.creative_id=v_row->>'creative_id'
      and b.provider_account_id=v_row->>'provider_account_id' and b.provider_ad_id=v_row->>'provider_ad_id'
      and b.provider_creative_id=v_row->>'provider_creative_id' and b.ad_object_id=(v_row->>'ad_object_id')::uuid
      and b.creative_object_id=(v_row->>'creative_object_id')::uuid and b.binding_source=v_row->>'binding_source'
      and b.binding_evidence_hash=v_row->>'binding_evidence_hash' and b.bound_at=(v_row->>'bound_at')::timestamptz)
      then raise exception 'META_IMMUTABLE_CONFLICT'; end if; v_count:=v_count+1;
  end loop;
  for v_row in select value from jsonb_array_elements(p_batch->'snapshots') loop
    if jsonb_typeof(v_row)<>'object'
      or not v_row ?& array['id','user_id','binding_id','provider_account_id','provider_ad_id','date_start','date_stop','collected_at','currency','attribution_setting','placement_key','audience_key','optimization_goal','cohort_hash','field_set_version','api_version','payload_hash','snapshot_key','metrics','limitations']
      or v_row-array['id','user_id','binding_id','provider_account_id','provider_ad_id','date_start','date_stop','collected_at','currency','attribution_setting','placement_key','audience_key','optimization_goal','cohort_hash','field_set_version','api_version','payload_hash','snapshot_key','metrics','limitations']<>'{}'::jsonb
      or (v_row->>'user_id')::uuid<>v_user
      or jsonb_typeof(v_row->'metrics')<>'object'
      or not (v_row->'metrics') ?& array['spend','impressions','reach','frequency','clicks','ctr','cpc','cpm']
      or (v_row->'metrics')-array['spend','impressions','reach','frequency','clicks','ctr','cpc','cpm']<>'{}'::jsonb
      then raise exception 'META_NORMALIZED_BATCH_INVALID'; end if;
    foreach v_metric in array array['spend','impressions','reach','frequency','clicks','ctr','cpc','cpm'] loop
      if jsonb_typeof(v_row->'metrics'->v_metric)<>'object'
        or not (v_row->'metrics'->v_metric) ?& array['state','value']
        or (v_row->'metrics'->v_metric)-array['state','value']<>'{}'::jsonb
        then raise exception 'META_NORMALIZED_BATCH_INVALID'; end if;
    end loop;
    if not exists(select 1 from public.meta_creative_ad_bindings b where b.id=(v_row->>'binding_id')::uuid and b.user_id=v_user
      and b.provider_account_id=v_row->>'provider_account_id' and b.provider_ad_id=v_row->>'provider_ad_id')
      then raise exception 'META_SNAPSHOT_BINDING_INVALID'; end if;
    v_expected_hash:=encode(extensions.digest(convert_to(public.canonical_jsonb_text(jsonb_build_object(
      'provider_account_id',v_row->'provider_account_id','provider_ad_id',v_row->'provider_ad_id',
      'date_start',v_row->'date_start','date_stop',v_row->'date_stop','currency',v_row->'currency',
      'attribution_setting',v_row->'attribution_setting','placement_key',v_row->'placement_key','audience_key',v_row->'audience_key',
      'optimization_goal',v_row->'optimization_goal','cohort_hash',v_row->'cohort_hash','metrics',v_row->'metrics',
      'actions',(select coalesce(jsonb_agg(jsonb_build_object('action_type',x->'action_type','value',x->'value','state',x->'state','currency',x->'currency','authoritative',x->'authoritative') order by x->>'action_type'),'[]'::jsonb)
        from jsonb_array_elements(p_batch->'actions') x where x->>'snapshot_id'=v_row->>'id'),
      'limitations',v_row->'limitations')),'UTF8'),'sha256'),'hex');
    if v_row->>'payload_hash'<>v_expected_hash then raise exception 'META_SNAPSHOT_HASH_INVALID'; end if;
    v_expected_hash:=encode(extensions.digest(convert_to(public.canonical_jsonb_text(jsonb_build_object(
      'binding_id',v_row->'binding_id','date_start',v_row->'date_start','date_stop',v_row->'date_stop',
      'cohort_hash',v_row->'cohort_hash','field_set_version',v_row->'field_set_version','payload_hash',v_row->'payload_hash')),'UTF8'),'sha256'),'hex');
    if v_row->>'snapshot_key'<>v_expected_hash then raise exception 'META_SNAPSHOT_KEY_INVALID'; end if;
    insert into public.meta_insight_snapshots(id,user_id,binding_id,provider_account_id,provider_ad_id,date_start,date_stop,collected_at,currency,attribution_setting,placement_key,audience_key,optimization_goal,cohort_hash,field_set_version,api_version,payload_hash,snapshot_key,spend,spend_state,impressions,impressions_state,reach,reach_state,frequency,frequency_state,clicks,clicks_state,ctr,ctr_state,cpc,cpc_state,cpm,cpm_state,limitations)
    values((v_row->>'id')::uuid,v_user,(v_row->>'binding_id')::uuid,v_row->>'provider_account_id',v_row->>'provider_ad_id',(v_row->>'date_start')::date,(v_row->>'date_stop')::date,(v_row->>'collected_at')::timestamptz,v_row->>'currency',v_row->>'attribution_setting',v_row->>'placement_key',v_row->>'audience_key',v_row->>'optimization_goal',v_row->>'cohort_hash',v_row->>'field_set_version',v_row->>'api_version',v_row->>'payload_hash',v_row->>'snapshot_key',(v_row#>>'{metrics,spend,value}')::numeric,v_row#>>'{metrics,spend,state}',(v_row#>>'{metrics,impressions,value}')::bigint,v_row#>>'{metrics,impressions,state}',(v_row#>>'{metrics,reach,value}')::bigint,v_row#>>'{metrics,reach,state}',(v_row#>>'{metrics,frequency,value}')::numeric,v_row#>>'{metrics,frequency,state}',(v_row#>>'{metrics,clicks,value}')::bigint,v_row#>>'{metrics,clicks,state}',(v_row#>>'{metrics,ctr,value}')::numeric,v_row#>>'{metrics,ctr,state}',(v_row#>>'{metrics,cpc,value}')::numeric,v_row#>>'{metrics,cpc,state}',(v_row#>>'{metrics,cpm,value}')::numeric,v_row#>>'{metrics,cpm,state}',array(select jsonb_array_elements_text(v_row->'limitations'))) on conflict do nothing;
    if not exists(select 1 from public.meta_insight_snapshots s where s.id=(v_row->>'id')::uuid and s.user_id=v_user
      and s.binding_id=(v_row->>'binding_id')::uuid and s.provider_account_id=v_row->>'provider_account_id' and s.provider_ad_id=v_row->>'provider_ad_id'
      and s.date_start=(v_row->>'date_start')::date and s.date_stop=(v_row->>'date_stop')::date and s.collected_at=(v_row->>'collected_at')::timestamptz
      and s.currency=v_row->>'currency' and s.attribution_setting is not distinct from v_row->>'attribution_setting'
      and s.placement_key=v_row->>'placement_key' and s.audience_key=v_row->>'audience_key'
      and s.optimization_goal is not distinct from v_row->>'optimization_goal' and s.cohort_hash=v_row->>'cohort_hash'
      and s.field_set_version=v_row->>'field_set_version' and s.api_version=v_row->>'api_version'
      and s.payload_hash=v_row->>'payload_hash' and s.snapshot_key=v_row->>'snapshot_key'
      and s.spend is not distinct from (v_row#>>'{metrics,spend,value}')::numeric and s.spend_state=v_row#>>'{metrics,spend,state}'
      and s.impressions is not distinct from (v_row#>>'{metrics,impressions,value}')::bigint and s.impressions_state=v_row#>>'{metrics,impressions,state}'
      and s.reach is not distinct from (v_row#>>'{metrics,reach,value}')::bigint and s.reach_state=v_row#>>'{metrics,reach,state}'
      and s.frequency is not distinct from (v_row#>>'{metrics,frequency,value}')::numeric and s.frequency_state=v_row#>>'{metrics,frequency,state}'
      and s.clicks is not distinct from (v_row#>>'{metrics,clicks,value}')::bigint and s.clicks_state=v_row#>>'{metrics,clicks,state}'
      and s.ctr is not distinct from (v_row#>>'{metrics,ctr,value}')::numeric and s.ctr_state=v_row#>>'{metrics,ctr,state}'
      and s.cpc is not distinct from (v_row#>>'{metrics,cpc,value}')::numeric and s.cpc_state=v_row#>>'{metrics,cpc,state}'
      and s.cpm is not distinct from (v_row#>>'{metrics,cpm,value}')::numeric and s.cpm_state=v_row#>>'{metrics,cpm,state}'
      and s.limitations=array(select jsonb_array_elements_text(v_row->'limitations')))
      then raise exception 'META_IMMUTABLE_CONFLICT'; end if; v_count:=v_count+1;
  end loop;
  for v_row in select value from jsonb_array_elements(p_batch->'actions') loop
    if jsonb_typeof(v_row)<>'object'
      or not v_row ?& array['id','user_id','snapshot_id','action_type','value','state','currency','authoritative']
      or v_row-array['id','user_id','snapshot_id','action_type','value','state','currency','authoritative']<>'{}'::jsonb
      or (v_row->>'user_id')::uuid<>v_user then raise exception 'META_NORMALIZED_BATCH_INVALID'; end if;
    if not exists(select 1 from public.meta_insight_snapshots s where s.id=(v_row->>'snapshot_id')::uuid and s.user_id=v_user)
      then raise exception 'META_ACTION_SNAPSHOT_INVALID'; end if;
    insert into public.meta_insight_actions(id,user_id,snapshot_id,action_type,value,value_state,currency,authoritative)
    values((v_row->>'id')::uuid,v_user,(v_row->>'snapshot_id')::uuid,v_row->>'action_type',(v_row->>'value')::numeric,v_row->>'state',v_row->>'currency',(v_row->>'authoritative')::boolean) on conflict do nothing;
    if not exists(select 1 from public.meta_insight_actions a where a.id=(v_row->>'id')::uuid and a.user_id=v_user and a.snapshot_id=(v_row->>'snapshot_id')::uuid and a.action_type=v_row->>'action_type' and a.value_state=v_row->>'state' and a.value is not distinct from (v_row->>'value')::numeric and a.currency is not distinct from v_row->>'currency' and a.authoritative=(v_row->>'authoritative')::boolean) then raise exception 'META_IMMUTABLE_CONFLICT'; end if; v_count:=v_count+1;
  end loop;
  return jsonb_build_object('status','STORED','rows',v_count,'batch_hash',p_batch->>'batch_hash');
end $$;

create or replace function public.persist_meta_learning_result(p_result jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid; h jsonb; e jsonb; me jsonb; a jsonb; ae jsonb; l jsonb; le jsonb; v_expected_hash text;
begin
  if coalesce((select auth.role()),'')<>'service_role' then raise exception 'META_SERVICE_ROLE_REQUIRED'; end if;
  if jsonb_typeof(p_result)<>'object' or not p_result ?& array['schema','user_id','hypothesis','experiment','experiment_evidence','analysis','analysis_evidence','lesson','lesson_evidence']
    or p_result-array['schema','user_id','hypothesis','experiment','experiment_evidence','analysis','analysis_evidence','lesson','lesson_evidence']<>'{}'::jsonb
    or p_result->>'schema'<>'meta-learning-result-v1'
    or p_result::text~* '"(name|email|phone|ip|device_id|headline|description|message|body|copy|url|targeting|custom_audiences|lead_form|comments|raw|raw_payload|access_token)"[[:space:]]*:'
    then raise exception 'META_LEARNING_RESULT_INVALID'; end if;
  v_user:=(p_result->>'user_id')::uuid; h:=p_result->'hypothesis'; e:=p_result->'experiment'; me:=p_result->'experiment_evidence'; a:=p_result->'analysis'; ae:=p_result->'analysis_evidence'; l:=p_result->'lesson'; le:=p_result->'lesson_evidence';
  if jsonb_typeof(h)<>'object' or not h ?& array['id','statement','changed_variable','expected_effect','rationale','evidence','status','confidence','topic_family_key','topic_action','decision_context_hash']
    or h-array['id','statement','changed_variable','expected_effect','rationale','evidence','status','confidence','topic_family_key','topic_action','decision_context_hash']<>'{}'::jsonb
    or jsonb_typeof(e)<>'object' or not e ?& array['id','hypothesis_id','hypothesis','changed_variable','constants','success_metrics','result','confidence','lessons','status','control_creative_id','variant_creative_id','control_material_vector','variant_material_vector','control_meta_binding_id','variant_meta_binding_id']
    or e-array['id','hypothesis_id','hypothesis','changed_variable','constants','success_metrics','result','confidence','lessons','status','control_creative_id','variant_creative_id','control_material_vector','variant_material_vector','control_meta_binding_id','variant_meta_binding_id']<>'{}'::jsonb
    or jsonb_typeof(me)<>'object' or not me ?& array['id','experiment_id','control_binding_id','variant_binding_id','control_snapshot_id','variant_snapshot_id','cohort_hash','policy_version','evidence_hash']
    or me-array['id','experiment_id','control_binding_id','variant_binding_id','control_snapshot_id','variant_snapshot_id','cohort_hash','policy_version','evidence_hash']<>'{}'::jsonb
    or jsonb_typeof(a)<>'object' or not a ?& array['id','experiment_id','checkpoint','conclusion','evidence','metrics','metric_sources','confidence','sample_size','limitations','expected','actual','meta_snapshot_id']
    or a-array['id','experiment_id','checkpoint','conclusion','evidence','metrics','metric_sources','confidence','sample_size','limitations','expected','actual','meta_snapshot_id']<>'{}'::jsonb
    or jsonb_typeof(ae)<>'object' or not ae ?& array['analysis_id','meta_experiment_evidence_id','evidence_hash']
    or ae-array['analysis_id','meta_experiment_evidence_id','evidence_hash']<>'{}'::jsonb
    or jsonb_typeof(l)<>'object' or not l ?& array['id','lesson','category','evidence','sample_size','confidence','status','applicable_topics','changed_variable','creative_ids_used','metric_provenance','limitations','meta_lesson_key']
    or l-array['id','lesson','category','evidence','sample_size','confidence','status','applicable_topics','changed_variable','creative_ids_used','metric_provenance','limitations','meta_lesson_key']<>'{}'::jsonb
    or jsonb_typeof(le)<>'object' or not le ?& array['lesson_id','analysis_id','meta_experiment_evidence_id','evidence_hash']
    or le-array['lesson_id','analysis_id','meta_experiment_evidence_id','evidence_hash']<>'{}'::jsonb
    then raise exception 'META_LEARNING_RESULT_INVALID'; end if;
  if e->>'changed_variable' not in ('topic','audience','format','angle','hook','opening','cta','visual','duration')
    or jsonb_typeof(e->'constants')<>'object' or (select count(*) from jsonb_object_keys(e->'constants'))<>8
    or (e->'constants') ? (e->>'changed_variable')
    or (e->'constants')-array['topic','audience','format','angle','hook','opening','cta','visual','duration']<>'{}'::jsonb
    or exists(select 1 from jsonb_each(e->'constants') x where jsonb_typeof(x.value)<>'string')
    or jsonb_typeof(e->'success_metrics')<>'object'
    or not (e->'success_metrics') ?& array['primary','downstream']
    or (e->'success_metrics')-array['primary','downstream']<>'{}'::jsonb
    or jsonb_typeof(e->'success_metrics'->'primary')<>'string' or jsonb_typeof(e->'success_metrics'->'downstream')<>'string'
    or jsonb_typeof(e->'control_material_vector')<>'object'
    or not (e->'control_material_vector') ?& array['topic','audience','format','angle','hook','opening','cta','visual','duration']
    or (e->'control_material_vector')-array['topic','audience','format','angle','hook','opening','cta','visual','duration']<>'{}'::jsonb
    or exists(select 1 from jsonb_each(e->'control_material_vector') x where jsonb_typeof(x.value)<>'string')
    or jsonb_typeof(e->'variant_material_vector')<>'object'
    or not (e->'variant_material_vector') ?& array['topic','audience','format','angle','hook','opening','cta','visual','duration']
    or (e->'variant_material_vector')-array['topic','audience','format','angle','hook','opening','cta','visual','duration']<>'{}'::jsonb
    or exists(select 1 from jsonb_each(e->'variant_material_vector') x where jsonb_typeof(x.value)<>'string')
    or (e->'control_material_vector'->(e->>'changed_variable')) is not distinct from (e->'variant_material_vector'->(e->>'changed_variable'))
    or (select count(*) from jsonb_each(e->'control_material_vector') c join jsonb_each(e->'variant_material_vector') v on v.key=c.key where c.value is distinct from v.value)<>1
    or e->'constants'<>(e->'variant_material_vector')-(e->>'changed_variable')
    then raise exception 'META_LEARNING_EXPERIMENT_INVALID'; end if;
  if jsonb_typeof(a->'metrics')<>'object'
    or not (a->'metrics') ?& array['ctr_lift','downstream_quality_ratio','conversion','cpa','roas']
    or (a->'metrics')-array['ctr_lift','downstream_quality_ratio','conversion','cpa','roas']<>'{}'::jsonb
    or jsonb_typeof(a->'metrics'->'ctr_lift') not in ('number','null')
    or jsonb_typeof(a->'metrics'->'downstream_quality_ratio') not in ('number','null')
    or jsonb_typeof(a->'metrics'->'conversion')<>'object'
    or not (a->'metrics'->'conversion') ?& array['state','value']
    or (a->'metrics'->'conversion')-array['state','value']<>'{}'::jsonb
    or a->'metrics'->'conversion'->>'state' not in ('KNOWN','UNKNOWN')
    or (a->'metrics'->'conversion'->>'state'='KNOWN' and jsonb_typeof(a->'metrics'->'conversion'->'value')<>'number')
    or (a->'metrics'->'conversion'->>'state'='UNKNOWN' and jsonb_typeof(a->'metrics'->'conversion'->'value')<>'null')
    or jsonb_typeof(a->'metrics'->'cpa')<>'object'
    or not (a->'metrics'->'cpa') ?& array['state','value','currency']
    or (a->'metrics'->'cpa')-array['state','value','currency']<>'{}'::jsonb
    or a->'metrics'->'cpa'->>'state' not in ('KNOWN','UNKNOWN')
    or (a->'metrics'->'cpa'->>'state'='KNOWN' and (jsonb_typeof(a->'metrics'->'cpa'->'value')<>'number' or coalesce(a->'metrics'->'cpa'->>'currency','') !~ '^[A-Z]{3}$'))
    or (a->'metrics'->'cpa'->>'state'='UNKNOWN' and (jsonb_typeof(a->'metrics'->'cpa'->'value')<>'null' or jsonb_typeof(a->'metrics'->'cpa'->'currency')<>'null'))
    or jsonb_typeof(a->'metrics'->'roas')<>'object'
    or not (a->'metrics'->'roas') ?& array['state','value','currency']
    or (a->'metrics'->'roas')-array['state','value','currency']<>'{}'::jsonb
    or a->'metrics'->'roas'->>'state' not in ('KNOWN','UNKNOWN')
    or (a->'metrics'->'roas'->>'state'='KNOWN' and (jsonb_typeof(a->'metrics'->'roas'->'value')<>'number' or coalesce(a->'metrics'->'roas'->>'currency','') !~ '^[A-Z]{3}$'))
    or (a->'metrics'->'roas'->>'state'='UNKNOWN' and (jsonb_typeof(a->'metrics'->'roas'->'value')<>'null' or jsonb_typeof(a->'metrics'->'roas'->'currency')<>'null'))
    or jsonb_typeof(a->'metric_sources')<>'object'
    or not (a->'metric_sources') ?& array['provider','source']
    or (a->'metric_sources')-array['provider','source']<>'{}'::jsonb
    or a->'metric_sources'->>'provider'<>'meta_ads' or jsonb_typeof(a->'metric_sources'->'source')<>'string'
    or jsonb_typeof(a->'sample_size')<>'object' or not (a->'sample_size') ?& array['impressions']
    or (a->'sample_size')-array['impressions']<>'{}'::jsonb or jsonb_typeof(a->'sample_size'->'impressions')<>'number'
    or jsonb_typeof(a->'limitations')<>'array'
    or exists(select 1 from jsonb_array_elements(a->'limitations') x where jsonb_typeof(x)<>'string')
    or jsonb_typeof(a->'expected')<>'object' or not (a->'expected') ?& array['ctr_lift']
    or (a->'expected')-array['ctr_lift']<>'{}'::jsonb or jsonb_typeof(a->'expected'->'ctr_lift') not in ('number','null')
    or jsonb_typeof(a->'actual')<>'object' or not (a->'actual') ?& array['ctr_lift']
    or (a->'actual')-array['ctr_lift']<>'{}'::jsonb or jsonb_typeof(a->'actual'->'ctr_lift') not in ('number','null')
    then raise exception 'META_LEARNING_ANALYSIS_INVALID'; end if;
  if jsonb_typeof(l->'sample_size')<>'object' or not (l->'sample_size') ?& array['impressions']
    or (l->'sample_size')-array['impressions']<>'{}'::jsonb or jsonb_typeof(l->'sample_size'->'impressions')<>'number'
    or l->'sample_size'<>a->'sample_size'
    or jsonb_typeof(l->'applicable_topics')<>'array'
    or exists(select 1 from jsonb_array_elements(l->'applicable_topics') x where jsonb_typeof(x)<>'string')
    or l->'applicable_topics'<>jsonb_build_array(h->>'topic_family_key')
    or jsonb_typeof(l->'creative_ids_used')<>'array'
    or exists(select 1 from jsonb_array_elements(l->'creative_ids_used') x where jsonb_typeof(x)<>'string')
    or jsonb_typeof(l->'metric_provenance')<>'array'
    or exists(select 1 from jsonb_array_elements(l->'metric_provenance') x where jsonb_typeof(x)<>'string')
    or jsonb_typeof(l->'limitations')<>'array'
    or exists(select 1 from jsonb_array_elements(l->'limitations') x where jsonb_typeof(x)<>'string')
    then raise exception 'META_LEARNING_LESSON_INVALID'; end if;
  if e->>'hypothesis_id'<>h->>'id' or e->>'hypothesis'<>h->>'statement' or e->>'changed_variable'<>h->>'changed_variable'
    or me->>'experiment_id'<>e->>'id' or me->>'control_binding_id'<>e->>'control_meta_binding_id'
    or me->>'variant_binding_id'<>e->>'variant_meta_binding_id'
    or a->>'experiment_id'<>e->>'id' or a->>'meta_snapshot_id'<>me->>'variant_snapshot_id'
    or ae->>'analysis_id'<>a->>'id' or ae->>'meta_experiment_evidence_id'<>me->>'id'
    or l->>'changed_variable'<>e->>'changed_variable'
    or le->>'lesson_id'<>l->>'id' or le->>'analysis_id'<>a->>'id' or le->>'meta_experiment_evidence_id'<>me->>'id'
    or jsonb_typeof(h->'evidence')<>'array' or jsonb_array_length(h->'evidence')<>1
    or h->'evidence'->>0<>'decision-'||(h->>'decision_context_hash')
    or jsonb_typeof(a->'evidence')<>'array' or a->'evidence'<>jsonb_build_array(me->>'id')
    or jsonb_typeof(l->'evidence')<>'array' or l->'evidence'<>h->'evidence'
    or jsonb_typeof(l->'creative_ids_used')<>'array'
    or l->'creative_ids_used'<>jsonb_build_array(e->>'control_creative_id',e->>'variant_creative_id')
    or jsonb_typeof(l->'metric_provenance')<>'array'
    or l->'metric_provenance'<>jsonb_build_array(me->>'control_snapshot_id',me->>'variant_snapshot_id')
    then raise exception 'META_LEARNING_LINEAGE_INVALID'; end if;
  if not exists(select 1 from public.meta_creative_ad_bindings cb,public.meta_creative_ad_bindings vb,
      public.meta_insight_snapshots cs,public.meta_insight_snapshots vs
      where cb.id=(e->>'control_meta_binding_id')::uuid and cb.user_id=v_user and cb.creative_id=e->>'control_creative_id'
        and vb.id=(e->>'variant_meta_binding_id')::uuid and vb.user_id=v_user and vb.creative_id=e->>'variant_creative_id'
        and cs.id=(me->>'control_snapshot_id')::uuid and cs.user_id=v_user and cs.binding_id=cb.id and cs.cohort_hash=me->>'cohort_hash'
        and vs.id=(me->>'variant_snapshot_id')::uuid and vs.user_id=v_user and vs.binding_id=vb.id and vs.cohort_hash=me->>'cohort_hash')
    then raise exception 'META_LEARNING_SOURCE_INVALID'; end if;
  v_expected_hash:=encode(extensions.digest(convert_to(public.canonical_jsonb_text(jsonb_build_object(
    'hypothesis',h,'experiment',e,'experiment_evidence',me-'evidence_hash')),'UTF8'),'sha256'),'hex');
  if me->>'evidence_hash'<>v_expected_hash then raise exception 'META_LEARNING_HASH_INVALID'; end if;
  v_expected_hash:=encode(extensions.digest(convert_to(public.canonical_jsonb_text(jsonb_build_object(
    'analysis',a,'analysis_evidence',ae-'evidence_hash')),'UTF8'),'sha256'),'hex');
  if ae->>'evidence_hash'<>v_expected_hash then raise exception 'META_LEARNING_HASH_INVALID'; end if;
  v_expected_hash:=encode(extensions.digest(convert_to(public.canonical_jsonb_text(jsonb_build_object(
    'lesson',l,'lesson_evidence',le-'evidence_hash')),'UTF8'),'sha256'),'hex');
  if le->>'evidence_hash'<>v_expected_hash then raise exception 'META_LEARNING_HASH_INVALID'; end if;
  insert into public.content_hypotheses(id,user_id,statement,changed_variable,expected_effect,rationale,evidence,status,confidence,topic_family_key,topic_action,decision_context_hash)
  values((h->>'id')::uuid,v_user,h->>'statement',h->>'changed_variable',h->>'expected_effect',h->>'rationale',h->'evidence',h->>'status',h->>'confidence',h->>'topic_family_key',h->>'topic_action',h->>'decision_context_hash') on conflict do nothing;
  if not exists(select 1 from public.content_hypotheses x where x.id=(h->>'id')::uuid and x.user_id=v_user
    and x.statement=h->>'statement' and x.changed_variable=h->>'changed_variable' and x.expected_effect=h->>'expected_effect'
    and x.rationale is not distinct from h->>'rationale' and x.evidence=h->'evidence' and x.status=h->>'status'
    and x.confidence=h->>'confidence' and x.topic_family_key=h->>'topic_family_key' and x.topic_action=h->>'topic_action'
    and x.decision_context_hash=h->>'decision_context_hash') then raise exception 'META_IMMUTABLE_CONFLICT'; end if;
  insert into public.experiments(id,user_id,hypothesis_id,hypothesis,changed_variable,constants,success_metrics,control_video_id,result,confidence,lessons,status,platform,control_youtube_short_id,variant_youtube_short_id,control_identity_map_id,variant_identity_map_id,control_creative_id,variant_creative_id,control_material_vector,variant_material_vector,metric_source,control_meta_binding_id,variant_meta_binding_id)
  values((e->>'id')::uuid,v_user,(e->>'hypothesis_id')::uuid,e->>'hypothesis',e->>'changed_variable',e->'constants',e->'success_metrics',null,e->>'result',e->>'confidence',e->>'lessons',e->>'status','meta_ads',null,null,null,null,e->>'control_creative_id',e->>'variant_creative_id',e->'control_material_vector',e->'variant_material_vector','meta',(e->>'control_meta_binding_id')::uuid,(e->>'variant_meta_binding_id')::uuid) on conflict do nothing;
  if not exists(select 1 from public.experiments x where x.id=(e->>'id')::uuid and x.user_id=v_user
    and x.hypothesis_id=(e->>'hypothesis_id')::uuid and x.hypothesis=e->>'hypothesis' and x.changed_variable=e->>'changed_variable'
    and x.constants=e->'constants' and x.success_metrics=e->'success_metrics' and x.control_video_id is null
    and x.result=e->>'result' and x.confidence=e->>'confidence' and x.lessons is not distinct from e->>'lessons' and x.status=e->>'status'
    and x.platform='meta_ads' and x.control_youtube_short_id is null and x.variant_youtube_short_id is null
    and x.control_identity_map_id is null and x.variant_identity_map_id is null
    and x.control_creative_id=e->>'control_creative_id' and x.variant_creative_id=e->>'variant_creative_id'
    and x.control_material_vector=e->'control_material_vector' and x.variant_material_vector=e->'variant_material_vector' and x.metric_source='meta'
    and x.control_meta_binding_id=(e->>'control_meta_binding_id')::uuid and x.variant_meta_binding_id=(e->>'variant_meta_binding_id')::uuid)
    then raise exception 'META_IMMUTABLE_CONFLICT'; end if;
  insert into public.meta_experiment_evidence(id,user_id,experiment_id,control_binding_id,variant_binding_id,control_snapshot_id,variant_snapshot_id,cohort_hash,policy_version,evidence_hash)
  values((me->>'id')::uuid,v_user,(me->>'experiment_id')::uuid,(me->>'control_binding_id')::uuid,(me->>'variant_binding_id')::uuid,(me->>'control_snapshot_id')::uuid,(me->>'variant_snapshot_id')::uuid,me->>'cohort_hash',me->>'policy_version',me->>'evidence_hash') on conflict do nothing;
  if not exists(select 1 from public.meta_experiment_evidence x where x.id=(me->>'id')::uuid and x.user_id=v_user
    and x.experiment_id=(me->>'experiment_id')::uuid and x.control_binding_id=(me->>'control_binding_id')::uuid
    and x.variant_binding_id=(me->>'variant_binding_id')::uuid and x.control_snapshot_id=(me->>'control_snapshot_id')::uuid
    and x.variant_snapshot_id=(me->>'variant_snapshot_id')::uuid and x.cohort_hash=me->>'cohort_hash'
    and x.policy_version=me->>'policy_version' and x.evidence_hash=me->>'evidence_hash') then raise exception 'META_IMMUTABLE_CONFLICT'; end if;
  insert into public.content_analysis_results(id,user_id,video_id,experiment_id,checkpoint,conclusion,evidence,metrics,metric_sources,confidence,sample_size,limitations,expected,actual,platform,youtube_short_id,youtube_snapshot_polled_at,meta_snapshot_id)
  values((a->>'id')::uuid,v_user,null,(a->>'experiment_id')::uuid,a->>'checkpoint',a->>'conclusion',a->'evidence',a->'metrics',a->'metric_sources',a->>'confidence',a->'sample_size',a->'limitations',a->'expected',a->'actual','meta_ads',null,null,(a->>'meta_snapshot_id')::uuid) on conflict do nothing;
  if not exists(select 1 from public.content_analysis_results x where x.id=(a->>'id')::uuid and x.user_id=v_user
    and x.video_id is null and x.experiment_id=(a->>'experiment_id')::uuid and x.checkpoint=a->>'checkpoint' and x.conclusion=a->>'conclusion'
    and x.evidence=a->'evidence' and x.metrics=a->'metrics' and x.metric_sources=a->'metric_sources' and x.confidence=a->>'confidence'
    and x.sample_size=a->'sample_size' and x.limitations=a->'limitations' and x.expected=a->'expected' and x.actual=a->'actual'
    and x.platform='meta_ads' and x.youtube_short_id is null and x.youtube_snapshot_polled_at is null
    and x.meta_snapshot_id=(a->>'meta_snapshot_id')::uuid) then raise exception 'META_IMMUTABLE_CONFLICT'; end if;
  insert into public.content_analysis_meta_evidence(analysis_id,user_id,meta_experiment_evidence_id,evidence_hash)
  values((ae->>'analysis_id')::uuid,v_user,(ae->>'meta_experiment_evidence_id')::uuid,ae->>'evidence_hash') on conflict do nothing;
  if not exists(select 1 from public.content_analysis_meta_evidence x where x.analysis_id=(ae->>'analysis_id')::uuid and x.user_id=v_user and x.meta_experiment_evidence_id=(ae->>'meta_experiment_evidence_id')::uuid and x.evidence_hash=ae->>'evidence_hash') then raise exception 'META_IMMUTABLE_CONFLICT'; end if;
  insert into public.content_lessons(id,user_id,lesson,category,evidence,videos_used,sample_size,confidence,status,applicable_topics,source_platform,changed_variable,creative_ids_used,metric_provenance,limitations,youtube_lesson_key,meta_lesson_key)
  values((l->>'id')::uuid,v_user,l->>'lesson',l->>'category',l->'evidence','{}'::uuid[],l->'sample_size',l->>'confidence',l->>'status',array(select jsonb_array_elements_text(l->'applicable_topics')),'meta_ads',l->>'changed_variable',array(select jsonb_array_elements_text(l->'creative_ids_used')),l->'metric_provenance',l->'limitations',null,l->>'meta_lesson_key') on conflict do nothing;
  if not exists(select 1 from public.content_lessons x where x.id=(l->>'id')::uuid and x.user_id=v_user
    and x.lesson=l->>'lesson' and x.category=l->>'category' and x.evidence=l->'evidence' and x.videos_used='{}'::uuid[]
    and x.sample_size=l->'sample_size' and x.confidence=l->>'confidence' and x.status=l->>'status'
    and x.applicable_topics=array(select jsonb_array_elements_text(l->'applicable_topics')) and x.source_platform='meta_ads'
    and x.changed_variable=l->>'changed_variable' and x.creative_ids_used=array(select jsonb_array_elements_text(l->'creative_ids_used'))
    and x.metric_provenance=l->'metric_provenance' and x.limitations=l->'limitations' and x.youtube_lesson_key is null
    and x.meta_lesson_key=l->>'meta_lesson_key') then raise exception 'META_IMMUTABLE_CONFLICT'; end if;
  insert into public.content_lesson_meta_evidence(lesson_id,user_id,analysis_id,meta_experiment_evidence_id,evidence_hash)
  values((le->>'lesson_id')::uuid,v_user,(le->>'analysis_id')::uuid,(le->>'meta_experiment_evidence_id')::uuid,le->>'evidence_hash') on conflict do nothing;
  if not exists(select 1 from public.content_lesson_meta_evidence x where x.lesson_id=(le->>'lesson_id')::uuid and x.user_id=v_user and x.analysis_id=(le->>'analysis_id')::uuid and x.meta_experiment_evidence_id=(le->>'meta_experiment_evidence_id')::uuid and x.evidence_hash=le->>'evidence_hash') then raise exception 'META_IMMUTABLE_CONFLICT'; end if;
  return jsonb_build_object('status','STORED','hypothesis_id',h->>'id','experiment_id',e->>'id','analysis_id',a->>'id','lesson_id',l->>'id');
end $$;

revoke execute on function public.persist_meta_readonly_batch(jsonb),public.persist_meta_learning_result(jsonb) from public,anon,authenticated;
grant execute on function public.persist_meta_readonly_batch(jsonb),public.persist_meta_learning_result(jsonb) to service_role;

comment on table public.meta_insight_snapshots is 'Normalized Meta ad-level read-only facts; UNKNOWN is explicit and never synthesized as zero.';
comment on table public.creative_analysis_dimensions is 'Owner/Text asserted analytical dimensions anchored to the existing canonical creative identity.';
