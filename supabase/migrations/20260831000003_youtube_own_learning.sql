-- POST-05: reuse the existing VibePost learning memory for own YouTube Shorts.
-- This is an additive platform adapter. It does not add an analytics/lesson engine.

create or replace function public.canonical_jsonb_text(p_value jsonb)
returns text language plpgsql immutable strict set search_path = '' as $$
declare v_result text;
begin
  case jsonb_typeof(p_value)
    when 'object' then
      select '{'||coalesce(string_agg(to_jsonb(e.key)::text||':'||
        public.canonical_jsonb_text(e.value),',' order by e.key),'')||'}'
        into v_result from jsonb_each(p_value) e;
    when 'array' then
      select '['||coalesce(string_agg(public.canonical_jsonb_text(a.value),','
        order by a.ordinality),'')||']' into v_result
        from jsonb_array_elements(p_value) with ordinality a(value,ordinality);
    else v_result := p_value::text;
  end case;
  return v_result;
end; $$;

alter table public.published_shorts_stats add column if not exists user_id uuid;
update public.published_shorts_stats s set user_id = p.user_id
  from public.published_shorts p where p.id = s.short_id and s.user_id is null;
alter table public.published_shorts_stats alter column user_id set not null;
alter table public.published_shorts_stats
  add constraint published_shorts_stats_subject_owner_unique
    unique (short_id, polled_at, user_id),
  add constraint published_shorts_stats_short_owner_fk
    foreign key (short_id, user_id) references public.published_shorts (id, user_id)
    on delete cascade;

alter table public.creative_identity_map
  add constraint creative_identity_map_id_user_unique unique (id, user_id);

alter table public.experiments
  add column if not exists platform text not null default 'tiktok',
  add column if not exists control_youtube_short_id uuid,
  add column if not exists variant_youtube_short_id uuid,
  add column if not exists control_identity_map_id uuid,
  add column if not exists variant_identity_map_id uuid,
  add column if not exists control_creative_id text,
  add column if not exists variant_creative_id text,
  add column if not exists control_material_vector jsonb,
  add column if not exists variant_material_vector jsonb,
  add column if not exists metric_source text;

alter table public.experiments
  add constraint experiments_platform_check
    check (platform in ('tiktok', 'youtube_shorts')),
  add constraint experiments_metric_source_check
    check (metric_source is null or metric_source in ('tiktok', 'youtube')),
  add constraint experiments_material_object_check
    check ((control_material_vector is null or jsonb_typeof(control_material_vector) = 'object')
      and (variant_material_vector is null or jsonb_typeof(variant_material_vector) = 'object')),
  add constraint experiments_youtube_subject_check check (
    (platform = 'tiktok' and control_youtube_short_id is null
      and variant_youtube_short_id is null and control_identity_map_id is null
      and variant_identity_map_id is null and control_creative_id is null
      and variant_creative_id is null and control_material_vector is null
      and variant_material_vector is null)
    or
    (platform = 'youtube_shorts' and control_video_id is null
      and control_youtube_short_id is not null and variant_youtube_short_id is not null
      and control_identity_map_id is not null and variant_identity_map_id is not null
      and control_creative_id ~ '^creative-[0-9a-f]{64}$'
      and variant_creative_id ~ '^creative-[0-9a-f]{64}$'
      and control_material_vector is not null and variant_material_vector is not null
      and metric_source = 'youtube')
  ),
  add constraint experiments_control_youtube_owner_fk
    foreign key (control_youtube_short_id, user_id)
    references public.published_shorts (id, user_id),
  add constraint experiments_variant_youtube_owner_fk
    foreign key (variant_youtube_short_id, user_id)
    references public.published_shorts (id, user_id),
  add constraint experiments_control_identity_owner_fk
    foreign key (control_identity_map_id, user_id)
    references public.creative_identity_map (id, user_id),
  add constraint experiments_variant_identity_owner_fk
    foreign key (variant_identity_map_id, user_id)
    references public.creative_identity_map (id, user_id);

create unique index experiments_youtube_pair_unique
  on public.experiments (user_id, control_youtube_short_id, variant_youtube_short_id, hypothesis_id)
  where platform = 'youtube_shorts';

alter table public.content_analysis_results alter column video_id drop not null;
alter table public.content_analysis_results
  add column if not exists platform text not null default 'tiktok',
  add column if not exists youtube_short_id uuid,
  add column if not exists youtube_snapshot_polled_at timestamptz;

alter table public.content_analysis_results
  add constraint content_analysis_platform_check
    check (platform in ('tiktok', 'youtube_shorts')),
  add constraint content_analysis_subject_check check (
    (platform = 'tiktok' and video_id is not null
      and youtube_short_id is null and youtube_snapshot_polled_at is null)
    or
    (platform = 'youtube_shorts' and video_id is null
      and youtube_short_id is not null and youtube_snapshot_polled_at is not null)
  ),
  add constraint content_analysis_youtube_short_owner_fk
    foreign key (youtube_short_id, user_id)
    references public.published_shorts (id, user_id) on delete cascade,
  add constraint content_analysis_youtube_snapshot_owner_fk
    foreign key (youtube_short_id, youtube_snapshot_polled_at, user_id)
    references public.published_shorts_stats (short_id, polled_at, user_id);

create unique index content_analysis_youtube_subject_unique
  on public.content_analysis_results (user_id, youtube_short_id, checkpoint, experiment_id)
  where platform = 'youtube_shorts';

alter table public.content_lessons
  add column if not exists source_platform text not null default 'tiktok',
  add column if not exists changed_variable text,
  add column if not exists creative_ids_used text[] not null default '{}',
  add column if not exists metric_provenance jsonb not null default '[]'::jsonb,
  add column if not exists limitations jsonb not null default '[]'::jsonb,
  add column if not exists youtube_lesson_key text;

alter table public.content_lessons
  add constraint content_lessons_source_platform_check
    check (source_platform in ('tiktok', 'youtube_shorts')),
  add constraint content_lessons_youtube_json_check
    check (jsonb_typeof(metric_provenance) = 'array' and jsonb_typeof(limitations) = 'array'),
  add constraint content_lessons_youtube_key_check
    check (youtube_lesson_key is null or youtube_lesson_key ~ '^[0-9a-f]{64}$'),
  add constraint content_lessons_platform_evidence_check check (
    (source_platform = 'tiktok' and cardinality(creative_ids_used) = 0
      and metric_provenance = '[]'::jsonb and limitations = '[]'::jsonb)
    or
    (source_platform = 'youtube_shorts' and cardinality(videos_used) = 0
      and changed_variable is not null and cardinality(creative_ids_used) > 0
      and jsonb_array_length(metric_provenance) > 0)
  );

create unique index content_lessons_youtube_key_unique
  on public.content_lessons (user_id,youtube_lesson_key)
  where youtube_lesson_key is not null;

create table public.content_lesson_youtube_publications (
  lesson_id uuid not null,
  user_id uuid not null,
  experiment_id uuid not null,
  short_id uuid not null,
  snapshot_polled_at timestamptz not null,
  identity_map_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (lesson_id, experiment_id, short_id, snapshot_polled_at),
  foreign key (lesson_id, user_id) references public.content_lessons (id, user_id)
    on delete cascade,
  foreign key (experiment_id, user_id) references public.experiments (id, user_id),
  foreign key (short_id, user_id) references public.published_shorts (id, user_id),
  foreign key (short_id, snapshot_polled_at, user_id)
    references public.published_shorts_stats (short_id, polled_at, user_id),
  foreign key (identity_map_id, user_id)
    references public.creative_identity_map (id, user_id)
);
alter table public.content_lesson_youtube_publications enable row level security;
create policy "content_lesson_youtube_publications_owner_read"
  on public.content_lesson_youtube_publications for select
  using ((select auth.uid()) = user_id);
revoke all on table public.content_lesson_youtube_publications
  from public, anon, authenticated, service_role;
grant select on table public.content_lesson_youtube_publications to authenticated, service_role;

alter table public.video_ideas
  add column if not exists youtube_feedback_batch_key text,
  add column if not exists youtube_feedback_context_hash text,
  add column if not exists youtube_candidate_index smallint,
  add column if not exists market_reference_ids text[] not null default '{}',
  add column if not exists own_experiment_ids uuid[] not null default '{}',
  add column if not exists evidence_roots jsonb,
  add column if not exists evidence_conflicts jsonb not null default '[]'::jsonb,
  add column if not exists idea_confidence text,
  add column if not exists evidence_mode text,
  add column if not exists youtube_batch_contract_hash text;

alter table public.video_ideas
  add constraint video_ideas_youtube_batch_key_check
    check (youtube_feedback_batch_key is null or youtube_feedback_batch_key ~ '^[0-9a-f]{64}$'),
  add constraint video_ideas_youtube_context_hash_check
    check (youtube_feedback_context_hash is null or youtube_feedback_context_hash ~ '^[0-9a-f]{64}$'),
  add constraint video_ideas_youtube_contract_hash_check
    check (youtube_batch_contract_hash is null or youtube_batch_contract_hash ~ '^[0-9a-f]{64}$'),
  add constraint video_ideas_youtube_candidate_index_check
    check (youtube_candidate_index is null or youtube_candidate_index between 1 and 5),
  add constraint video_ideas_youtube_evidence_json_check
    check ((evidence_roots is null or jsonb_typeof(evidence_roots) = 'object')
      and jsonb_typeof(evidence_conflicts) = 'array'),
  add constraint video_ideas_youtube_confidence_check
    check (idea_confidence is null or idea_confidence in ('LOW', 'MEDIUM', 'HIGH')),
  add constraint video_ideas_youtube_evidence_mode_check
    check (evidence_mode is null or evidence_mode in ('MARKET_REFERENCE_ONLY', 'OWN_PERFORMANCE_BOUND')),
  add constraint video_ideas_youtube_feedback_complete_check check (
    youtube_feedback_batch_key is null or (
      target_platform = 'youtube_shorts'
      and youtube_feedback_context_hash is not null
      and youtube_batch_contract_hash is not null
      and youtube_candidate_index is not null
      and cardinality(market_reference_ids) > 0
      and evidence_roots is not null and why_this_idea is not null
      and idea_pattern is not null and idea_confidence is not null
      and evidence_mode is not null
      and (
        (evidence_mode = 'MARKET_REFERENCE_ONLY' and hypothesis_id is null
          and changed_variable is null and experiment_constants is null
          and cardinality(selected_lesson_ids) = 0 and cardinality(avoided_lesson_ids) = 0
          and cardinality(own_experiment_ids) = 0)
        or
        (evidence_mode = 'OWN_PERFORMANCE_BOUND' and hypothesis_id is not null
          and changed_variable is not null and experiment_constants is not null
          and prompt_framework_id is not null and prompt_framework_version is not null
          and cardinality(selected_lesson_ids) > 0 and cardinality(own_experiment_ids) > 0)
      )
    )
  );

create unique index video_ideas_youtube_batch_candidate_unique
  on public.video_ideas (user_id, youtube_feedback_batch_key, youtube_candidate_index)
  where youtube_feedback_batch_key is not null;

create or replace function public.guard_youtube_experiment_service_owned()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op='INSERT' and new.platform='youtube_shorts'
      and coalesce((select auth.role()),'') <> 'service_role'
    then raise exception 'youtube_learning_service_owned';
  elsif tg_op='UPDATE' and old.platform='youtube_shorts' and row(
    old.user_id,old.hypothesis_id,old.hypothesis,old.changed_variable,old.constants,
    old.success_metrics,old.control_video_id,old.platform,old.control_youtube_short_id,
    old.variant_youtube_short_id,old.control_identity_map_id,old.variant_identity_map_id,
    old.control_creative_id,old.variant_creative_id,old.control_material_vector,
    old.variant_material_vector,old.metric_source
  ) is distinct from row(
    new.user_id,new.hypothesis_id,new.hypothesis,new.changed_variable,new.constants,
    new.success_metrics,new.control_video_id,new.platform,new.control_youtube_short_id,
    new.variant_youtube_short_id,new.control_identity_map_id,new.variant_identity_map_id,
    new.control_creative_id,new.variant_creative_id,new.control_material_vector,
    new.variant_material_vector,new.metric_source
  ) then raise exception 'youtube_experiment_identity_immutable';
  elsif tg_op='UPDATE' and old.platform='youtube_shorts'
      and coalesce((select auth.role()),'') <> 'service_role'
    then raise exception 'youtube_learning_service_owned'; end if;
  return new;
end; $$;
create trigger trg_youtube_experiment_service_owned before insert or update
  on public.experiments for each row execute function public.guard_youtube_experiment_service_owned();

create or replace function public.guard_youtube_analysis_service_owned()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if coalesce((select auth.role()),'') <> 'service_role'
      and (new.platform='youtube_shorts' or (tg_op='UPDATE' and old.platform='youtube_shorts'))
    then raise exception 'youtube_learning_service_owned'; end if;
  return new;
end; $$;
create trigger trg_youtube_analysis_service_owned before insert or update
  on public.content_analysis_results for each row
  execute function public.guard_youtube_analysis_service_owned();

create or replace function public.guard_youtube_lesson_service_owned()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if coalesce((select auth.role()),'') <> 'service_role'
      and (new.source_platform='youtube_shorts'
        or (tg_op='UPDATE' and old.source_platform='youtube_shorts'))
    then raise exception 'youtube_learning_service_owned'; end if;
  return new;
end; $$;
create trigger trg_youtube_lesson_service_owned before insert or update
  on public.content_lessons for each row execute function public.guard_youtube_lesson_service_owned();

alter table public.video_prompt_records
  add column if not exists creative_id text,
  add column if not exists own_experiment_ids uuid[] not null default '{}',
  add column if not exists market_reference_ids text[] not null default '{}',
  add column if not exists evidence_roots jsonb,
  add column if not exists owner_selected_at timestamptz;

alter table public.video_prompt_records
  add constraint video_prompt_records_creative_id_check
    check (creative_id is null or creative_id ~ '^creative-[0-9a-f]{64}$'),
  add constraint video_prompt_records_evidence_roots_check
    check (evidence_roots is null or jsonb_typeof(evidence_roots) = 'object');

create or replace function public.guard_video_idea_feedback_provenance()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare v_role text := coalesce((select auth.role()), '');
begin
  if tg_op = 'INSERT' then
    if v_role <> 'service_role' and (
      new.hypothesis_id is not null or new.feedback_hypothesis_key is not null
      or new.feedback_context_hash is not null or new.selected_lesson_ids is not null
      or new.avoided_lesson_ids is not null or new.api_metric_snapshot_ids is not null
      or new.studio_metric_ids is not null or new.changed_variable is not null
      or new.experiment_constants is not null or new.prompt_framework_id is not null
      or new.prompt_framework_version is not null or new.why_this_idea is not null
      or new.idea_pattern is not null or new.feedback_batch_key is not null
      or new.feedback_candidate_index is not null or new.youtube_feedback_batch_key is not null
      or new.youtube_feedback_context_hash is not null or new.youtube_candidate_index is not null
      or cardinality(new.market_reference_ids) > 0 or cardinality(new.own_experiment_ids) > 0
      or new.evidence_roots is not null or new.evidence_conflicts <> '[]'::jsonb
      or new.idea_confidence is not null or new.evidence_mode is not null
      or new.youtube_batch_contract_hash is not null
    ) then raise exception 'feedback_provenance_service_owned'; end if;
  elsif row(
    old.hypothesis_id, old.feedback_hypothesis_key, old.feedback_context_hash,
    old.selected_lesson_ids, old.avoided_lesson_ids, old.api_metric_snapshot_ids,
    old.studio_metric_ids, old.changed_variable, old.experiment_constants,
    old.prompt_framework_id, old.prompt_framework_version, old.why_this_idea,
    old.idea_pattern, old.feedback_batch_key, old.feedback_candidate_index,
    old.youtube_feedback_batch_key, old.youtube_feedback_context_hash,
    old.youtube_candidate_index, old.market_reference_ids, old.own_experiment_ids,
    old.evidence_roots, old.evidence_conflicts, old.idea_confidence, old.evidence_mode,
    old.youtube_batch_contract_hash
  ) is distinct from row(
    new.hypothesis_id, new.feedback_hypothesis_key, new.feedback_context_hash,
    new.selected_lesson_ids, new.avoided_lesson_ids, new.api_metric_snapshot_ids,
    new.studio_metric_ids, new.changed_variable, new.experiment_constants,
    new.prompt_framework_id, new.prompt_framework_version, new.why_this_idea,
    new.idea_pattern, new.feedback_batch_key, new.feedback_candidate_index,
    new.youtube_feedback_batch_key, new.youtube_feedback_context_hash,
    new.youtube_candidate_index, new.market_reference_ids, new.own_experiment_ids,
    new.evidence_roots, new.evidence_conflicts, new.idea_confidence, new.evidence_mode,
    new.youtube_batch_contract_hash
  ) then raise exception 'feedback_provenance_immutable'; end if;
  return new;
end; $$;

create or replace function public.guard_video_prompt_provenance()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if row(
    old.user_id, old.video_id, old.video_idea_id, old.claude_task_id,
    old.prompt_hash, old.prompt_origin, old.prompt_version, old.prompt_structure,
    old.prompt_patterns, old.experiment_variable, old.hypothesis_id,
    old.selected_lesson_ids, old.avoided_lesson_ids, old.feedback_context_hash,
    old.prompt_framework_id, old.experiment_constants, old.creative_id,
    old.own_experiment_ids, old.market_reference_ids, old.evidence_roots,
    old.owner_selected_at
  ) is distinct from row(
    new.user_id, new.video_id, new.video_idea_id, new.claude_task_id,
    new.prompt_hash, new.prompt_origin, new.prompt_version, new.prompt_structure,
    new.prompt_patterns, new.experiment_variable, new.hypothesis_id,
    new.selected_lesson_ids, new.avoided_lesson_ids, new.feedback_context_hash,
    new.prompt_framework_id, new.experiment_constants, new.creative_id,
    new.own_experiment_ids, new.market_reference_ids, new.evidence_roots,
    new.owner_selected_at
  ) then raise exception 'prompt_provenance_immutable'; end if;
  return new;
end; $$;

create or replace function public.create_youtube_content_experiment(
  p_user_id uuid, p_hypothesis_id uuid, p_control_short_id uuid,
  p_variant_short_id uuid, p_changed_variable text, p_constants jsonb,
  p_success_metrics jsonb
) returns public.experiments
language plpgsql security definer set search_path = '' as $$
declare
  v_h public.content_hypotheses; v_control public.creative_identity_map;
  v_variant public.creative_identity_map; v_ci public.video_ideas; v_vi public.video_ideas;
  v_cv jsonb; v_vv jsonb; v_expected jsonb; v_diff integer; v_row public.experiments;
begin
  if jsonb_typeof(p_constants) <> 'object' or jsonb_typeof(p_success_metrics) <> 'object'
      or p_changed_variable not in ('causal_pattern_class','payoff_class','prompt_framework_version','fidelity_constraints_hash')
      or p_success_metrics->>'primary_metric' not in ('like_rate','comment_rate')
      or p_success_metrics->>'direction' not in ('increase','decrease')
      or p_success_metrics->>'checkpoint' not in ('1h','6h','24h','72h','7d')
      or jsonb_typeof(p_success_metrics->'mde') <> 'number'
      or (p_success_metrics->>'mde')::numeric <= 0 or (p_success_metrics->>'mde')::numeric > 1
  then raise exception 'invalid_youtube_experiment_contract'; end if;
  select * into v_h from public.content_hypotheses h
    where h.id=p_hypothesis_id and h.user_id=p_user_id for key share;
  if not found or v_h.changed_variable <> p_changed_variable or v_h.constants <> p_constants
    then raise exception 'youtube_hypothesis_conflict'; end if;
  select * into strict v_control from public.creative_identity_map m
    where m.user_id=p_user_id and m.platform='youtube_shorts'
      and m.youtube_short_row_id=p_control_short_id and m.video_idea_id is not null;
  select * into strict v_variant from public.creative_identity_map m
    where m.user_id=p_user_id and m.platform='youtube_shorts'
      and m.youtube_short_row_id=p_variant_short_id and m.video_idea_id is not null;
  select * into v_ci from public.video_ideas i where i.id=v_control.video_idea_id and i.user_id=p_user_id;
  select * into v_vi from public.video_ideas i where i.id=v_variant.video_idea_id and i.user_id=p_user_id;
  v_cv := jsonb_build_object(
    'causal_pattern_class', v_ci.causal_pattern->>'pattern_class',
    'payoff_class', v_ci.payoff_class,
    'prompt_framework_version', v_ci.prompt_framework_version,
    'fidelity_constraints_hash', encode(extensions.digest(convert_to(
      public.canonical_jsonb_text(v_ci.fidelity_constraints),'UTF8'),'sha256'),'hex'));
  v_vv := jsonb_build_object(
    'causal_pattern_class', v_vi.causal_pattern->>'pattern_class',
    'payoff_class', v_vi.payoff_class,
    'prompt_framework_version', v_vi.prompt_framework_version,
    'fidelity_constraints_hash', encode(extensions.digest(convert_to(
      public.canonical_jsonb_text(v_vi.fidelity_constraints),'UTF8'),'sha256'),'hex'));
  if exists (select 1 from jsonb_each(v_cv) where value='null'::jsonb)
      or exists (select 1 from jsonb_each(v_vv) where value='null'::jsonb)
    then raise exception 'youtube_material_provenance_incomplete'; end if;
  select count(*) into v_diff from jsonb_each(v_cv) c join jsonb_each(v_vv) v using(key)
    where c.value is distinct from v.value;
  v_expected := v_cv - p_changed_variable;
  if v_diff <> 1 or v_cv->p_changed_variable = v_vv->p_changed_variable
      or v_expected <> p_constants then raise exception 'youtube_one_variable_contract_invalid'; end if;
  insert into public.experiments (
    user_id,hypothesis_id,hypothesis,changed_variable,constants,success_metrics,
    control_video_id,result,confidence,status,platform,control_youtube_short_id,
    variant_youtube_short_id,control_identity_map_id,variant_identity_map_id,
    control_creative_id,variant_creative_id,control_material_vector,
    variant_material_vector,metric_source
  ) values (
    p_user_id,p_hypothesis_id,v_h.statement,p_changed_variable,p_constants,p_success_metrics,
    null,null,'LOW','AWAITING_DATA','youtube_shorts',p_control_short_id,p_variant_short_id,
    v_control.id,v_variant.id,v_control.creative_id,v_variant.creative_id,v_cv,v_vv,'youtube'
  ) on conflict (user_id,control_youtube_short_id,variant_youtube_short_id,hypothesis_id)
    where platform='youtube_shorts' do nothing;
  select * into v_row from public.experiments e where e.user_id=p_user_id
    and e.control_youtube_short_id=p_control_short_id and e.variant_youtube_short_id=p_variant_short_id
    and e.hypothesis_id=p_hypothesis_id;
  if v_row.changed_variable<>p_changed_variable or v_row.constants<>p_constants
      or v_row.success_metrics<>p_success_metrics then raise exception 'youtube_experiment_replay_conflict'; end if;
  return v_row;
exception when no_data_found or too_many_rows then raise exception 'youtube_creative_mapping_required';
end; $$;

revoke execute on function public.create_youtube_content_experiment(uuid,uuid,uuid,uuid,text,jsonb,jsonb)
  from public,anon,authenticated;
grant execute on function public.create_youtube_content_experiment(uuid,uuid,uuid,uuid,text,jsonb,jsonb)
  to service_role;

create or replace function public.persist_youtube_content_analysis(
  p_user_id uuid, p_experiment_id uuid, p_short_id uuid, p_snapshot_polled_at timestamptz,
  p_checkpoint text, p_conclusion text, p_evidence jsonb, p_metrics jsonb,
  p_metric_sources jsonb, p_confidence text, p_sample_size jsonb,
  p_limitations jsonb, p_expected jsonb, p_actual jsonb
) returns public.content_analysis_results
language plpgsql security definer set search_path = '' as $$
declare v_e public.experiments; v_existing public.content_analysis_results; v_row public.content_analysis_results;
begin
  select * into v_e from public.experiments e where e.id=p_experiment_id and e.user_id=p_user_id for update;
  if not found or v_e.platform<>'youtube_shorts' or v_e.variant_youtube_short_id<>p_short_id
      or p_checkpoint not in ('1h','6h','24h','72h','7d')
      or p_conclusion not in ('PASS','FAIL','INCONCLUSIVE')
      or p_confidence not in ('LOW','MEDIUM','HIGH')
      or jsonb_typeof(p_evidence)<>'array' or jsonb_typeof(p_metrics)<>'object'
      or jsonb_typeof(p_metric_sources)<>'object' or jsonb_typeof(p_sample_size)<>'object'
      or jsonb_typeof(p_limitations)<>'array' or jsonb_typeof(p_expected)<>'object'
      or jsonb_typeof(p_actual)<>'object' then raise exception 'invalid_youtube_analysis'; end if;
  perform 1 from public.published_shorts_stats s where s.short_id=p_short_id
    and s.polled_at=p_snapshot_polled_at and s.user_id=p_user_id for key share;
  if not found then raise exception 'youtube_snapshot_owner_conflict'; end if;
  select * into v_existing from public.content_analysis_results a where a.user_id=p_user_id
    and a.experiment_id=p_experiment_id and a.youtube_short_id=p_short_id
    and a.checkpoint=p_checkpoint for update;
  if v_existing.id is not null then
    if row(v_existing.youtube_snapshot_polled_at,v_existing.conclusion,v_existing.evidence,
      v_existing.metrics,v_existing.metric_sources,v_existing.confidence,v_existing.sample_size,
      v_existing.limitations,v_existing.expected,v_existing.actual) is distinct from
      row(p_snapshot_polled_at,p_conclusion,p_evidence,p_metrics,p_metric_sources,p_confidence,
      p_sample_size,p_limitations,p_expected,p_actual) then raise exception 'youtube_analysis_replay_conflict'; end if;
    return v_existing;
  end if;
  insert into public.content_analysis_results (user_id,video_id,experiment_id,checkpoint,
    conclusion,evidence,metrics,metric_sources,confidence,sample_size,limitations,expected,
    actual,platform,youtube_short_id,youtube_snapshot_polled_at)
  values (p_user_id,null,p_experiment_id,p_checkpoint,p_conclusion,p_evidence,p_metrics,
    p_metric_sources,p_confidence,p_sample_size,p_limitations,p_expected,p_actual,
    'youtube_shorts',p_short_id,p_snapshot_polled_at) returning * into v_row;
  update public.experiments set result=p_conclusion,confidence=p_confidence,status='ANALYZED'
    where id=p_experiment_id and user_id=p_user_id;
  return v_row;
end; $$;

revoke execute on function public.persist_youtube_content_analysis(uuid,uuid,uuid,timestamptz,text,text,jsonb,jsonb,jsonb,text,jsonb,jsonb,jsonb,jsonb)
  from public,anon,authenticated;
grant execute on function public.persist_youtube_content_analysis(uuid,uuid,uuid,timestamptz,text,text,jsonb,jsonb,jsonb,text,jsonb,jsonb,jsonb,jsonb)
  to service_role;

create or replace function public.insert_youtube_content_lesson(
  p_user_id uuid, p_lesson text, p_category text, p_evidence jsonb,
  p_confidence text, p_status text, p_topics text[] default '{}'
) returns public.content_lessons
language plpgsql security definer set search_path = '' as $$
declare
  v_pass integer; v_fail integer; v_count integer; v_input_count integer;
  v_signature_count integer; v_ids jsonb; v_expected_category text;
  v_expected_status text; v_expected_confidence text; v_key text;
  v_row public.content_lessons;
begin
  if btrim(coalesce(p_lesson,''))='' or jsonb_typeof(p_evidence)<>'array'
      or p_category not in ('CONFIRMED_LESSON','WINNING_PATTERN','FAILED_PATTERN','HYPOTHESIS')
      or p_confidence not in ('LOW','MEDIUM','HIGH')
      or p_status not in ('HYPOTHESIS','SUPPORTED','CONFIRMED','REJECTED')
    then raise exception 'invalid_youtube_lesson'; end if;
  with ids as (select distinct (x->>'experiment_id')::uuid id from jsonb_array_elements(p_evidence) x),
  latest as (select distinct on (a.experiment_id) a.experiment_id,a.conclusion,
      e.changed_variable,e.constants
    from public.content_analysis_results a join ids on ids.id=a.experiment_id
    join public.experiments e on e.id=a.experiment_id and e.user_id=p_user_id
      and e.platform='youtube_shorts'
    where a.user_id=p_user_id and a.platform='youtube_shorts'
    order by a.experiment_id,a.created_at desc,a.id)
  select count(*),count(*) filter(where conclusion='PASS'),count(*) filter(where conclusion='FAIL'),
    count(distinct changed_variable||'|'||public.canonical_jsonb_text(constants)),
    jsonb_agg(experiment_id order by experiment_id)
    into v_count,v_pass,v_fail,v_signature_count,v_ids from latest;
  select count(distinct (x->>'experiment_id')::uuid) into v_input_count
    from jsonb_array_elements(p_evidence) x;
  if v_count=0 or v_count<>v_input_count or v_signature_count<>1
      or (v_pass>0 and v_fail>0) or (v_pass+v_fail)<>v_count
    then raise exception 'youtube_lesson_evidence_inconsistent'; end if;
  if v_pass=v_count and v_count=1 then
    v_expected_category:='HYPOTHESIS'; v_expected_status:='HYPOTHESIS'; v_expected_confidence:='LOW';
  elsif v_pass=v_count and v_count=2 then
    v_expected_category:=p_category; v_expected_status:='SUPPORTED'; v_expected_confidence:='MEDIUM';
    if p_category not in ('CONFIRMED_LESSON','WINNING_PATTERN') then raise exception 'youtube_lesson_category_invalid'; end if;
  elsif v_pass=v_count and v_count>=3 then
    v_expected_category:=p_category; v_expected_status:='CONFIRMED'; v_expected_confidence:='HIGH';
    if p_category not in ('CONFIRMED_LESSON','WINNING_PATTERN') then raise exception 'youtube_lesson_category_invalid'; end if;
  elsif v_fail=v_count and v_count=1 then
    v_expected_category:='HYPOTHESIS'; v_expected_status:='HYPOTHESIS'; v_expected_confidence:='LOW';
  else
    v_expected_category:='FAILED_PATTERN'; v_expected_status:='REJECTED'; v_expected_confidence:='MEDIUM';
  end if;
  if p_category<>v_expected_category or p_status<>v_expected_status
      or p_confidence<>v_expected_confidence then raise exception 'youtube_lesson_promotion_conflict'; end if;
  v_key:=encode(extensions.digest(convert_to(public.canonical_jsonb_text(jsonb_build_object(
    'lesson',btrim(p_lesson),'category',v_expected_category,'status',v_expected_status,
    'confidence',v_expected_confidence,'experiment_ids',v_ids,'topics',to_jsonb(p_topics)
  )),'UTF8'),'sha256'),'hex');
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text||v_key,0));
  select * into v_row from public.content_lessons l where l.user_id=p_user_id
    and l.youtube_lesson_key=v_key for update;
  if v_row.id is not null then return v_row; end if;
  insert into public.content_lessons (user_id,lesson,category,evidence,videos_used,sample_size,
    confidence,status,applicable_topics,source_platform,changed_variable,creative_ids_used,
    metric_provenance,limitations,youtube_lesson_key)
  select p_user_id,btrim(p_lesson),v_expected_category,p_evidence,'{}'::uuid[],
    jsonb_build_object('independent_experiments',v_count),v_expected_confidence,v_expected_status,p_topics,
    'youtube_shorts',min(e.changed_variable),array_agg(distinct m.creative_id),
    jsonb_agg(distinct jsonb_build_object('short_id',a.youtube_short_id,
      'polled_at',a.youtube_snapshot_polled_at,'analysis_id',a.id)),
    coalesce(jsonb_agg(distinct l.value) filter(where l.value is not null),'[]'::jsonb),v_key
  from (select distinct (x->>'experiment_id')::uuid id from jsonb_array_elements(p_evidence) x) ids
  join public.experiments e on e.id=ids.id and e.user_id=p_user_id and e.platform='youtube_shorts'
  join lateral (select a.* from public.content_analysis_results a where a.experiment_id=e.id
    and a.user_id=p_user_id and a.platform='youtube_shorts' order by a.created_at desc,a.id limit 1) a on true
  join public.creative_identity_map m on m.id=e.variant_identity_map_id and m.user_id=p_user_id
  left join lateral jsonb_array_elements(a.limitations) l(value) on true
  returning * into v_row;
  insert into public.content_lesson_youtube_publications
    (lesson_id,user_id,experiment_id,short_id,snapshot_polled_at,identity_map_id)
  select v_row.id,p_user_id,e.id,a.youtube_short_id,a.youtube_snapshot_polled_at,e.variant_identity_map_id
  from (select distinct (x->>'experiment_id')::uuid id from jsonb_array_elements(p_evidence) x) ids
  join public.experiments e on e.id=ids.id and e.user_id=p_user_id
  join lateral (select a.* from public.content_analysis_results a where a.experiment_id=e.id
    and a.user_id=p_user_id and a.platform='youtube_shorts' order by a.created_at desc,a.id limit 1) a on true
  on conflict do nothing;
  return v_row;
end; $$;

revoke execute on function public.insert_youtube_content_lesson(uuid,text,text,jsonb,text,text,text[])
  from public,anon,authenticated;
grant execute on function public.insert_youtube_content_lesson(uuid,text,text,jsonb,text,text,text[])
  to service_role;

create or replace function public.persist_youtube_feedback_batch(
  p_user_id uuid, p_batch_key text, p_context_hash text, p_hypothesis_key text,
  p_hypothesis jsonb, p_selected_lesson_ids uuid[], p_avoided_lesson_ids uuid[],
  p_prompt_framework_id uuid, p_prompt_framework_version text, p_candidates jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_h public.content_hypotheses; v_existing text; v_result jsonb; v_count integer;
  v_contract_hash text; v_own_bound boolean; v_expected_count integer; v_locked_count integer;
begin
  if p_batch_key!~'^[0-9a-f]{64}$' or p_context_hash!~'^[0-9a-f]{64}$'
      or (p_hypothesis_key is not null and p_hypothesis_key!~'^[0-9a-f]{64}$')
      or (p_hypothesis is not null and jsonb_typeof(p_hypothesis)<>'object')
      or jsonb_typeof(p_candidates)<>'array' then raise exception 'invalid_youtube_feedback_batch'; end if;
  v_count:=jsonb_array_length(p_candidates);
  if v_count<1 or v_count>5 then raise exception 'invalid_youtube_candidate_count'; end if;
  v_contract_hash:=encode(extensions.digest(convert_to(public.canonical_jsonb_text(jsonb_build_object(
    'context_hash',p_context_hash,'hypothesis_key',p_hypothesis_key,'hypothesis',p_hypothesis,
    'selected_lesson_ids',to_jsonb(p_selected_lesson_ids),'avoided_lesson_ids',to_jsonb(p_avoided_lesson_ids),
    'prompt_framework_id',p_prompt_framework_id,'prompt_framework_version',p_prompt_framework_version,
    'candidates',p_candidates
  )),'UTF8'),'sha256'),'hex');
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text||p_batch_key,0));
  select i.youtube_batch_contract_hash into v_existing from public.video_ideas i
    where i.user_id=p_user_id and i.youtube_feedback_batch_key=p_batch_key limit 1 for update;
  if v_existing is not null then
    if v_existing<>v_contract_hash then raise exception 'youtube_feedback_batch_conflict'; end if;
    select jsonb_agg(to_jsonb(i) order by i.youtube_candidate_index) into v_result
      from public.video_ideas i where i.user_id=p_user_id and i.youtube_feedback_batch_key=p_batch_key;
    return v_result;
  end if;
  if p_hypothesis is not null then
    perform 1 from public.prompt_framework_versions f where f.id=p_prompt_framework_id
      and f.user_id=p_user_id and f.is_current and f.status in ('STANDARD','SUPPORTED') for key share;
    if not found then raise exception 'youtube_framework_owner_conflict'; end if;
    insert into public.content_hypotheses (user_id,statement,changed_variable,expected_effect,
      rationale,evidence,status,confidence,constants,feedback_context,hypothesis_key)
    values (p_user_id,p_hypothesis->>'statement',p_hypothesis->>'changed_variable',
      p_hypothesis->>'expected_effect',p_hypothesis->>'rationale',p_hypothesis->'evidence',
      'HYPOTHESIS','LOW',p_hypothesis->'constants',p_hypothesis->'feedback_context',p_hypothesis_key)
    on conflict (user_id,hypothesis_key) where hypothesis_key is not null do nothing;
    select * into v_h from public.content_hypotheses h where h.user_id=p_user_id
      and h.hypothesis_key=p_hypothesis_key for update;
    if v_h.id is null or row(v_h.statement,v_h.changed_variable,v_h.expected_effect,
      v_h.rationale,v_h.evidence,v_h.status,v_h.confidence,v_h.constants,v_h.feedback_context)
      is distinct from row(p_hypothesis->>'statement',p_hypothesis->>'changed_variable',
      p_hypothesis->>'expected_effect',p_hypothesis->>'rationale',p_hypothesis->'evidence',
      'HYPOTHESIS','LOW',p_hypothesis->'constants',p_hypothesis->'feedback_context')
      then raise exception 'youtube_hypothesis_replay_conflict'; end if;
  end if;
  select exists(select 1 from jsonb_array_elements(p_candidates) c
    where c->>'evidence_mode'='OWN_PERFORMANCE_BOUND') into v_own_bound;
  if v_own_bound and p_hypothesis is null then raise exception 'youtube_own_hypothesis_required'; end if;
  if exists(select 1 from jsonb_array_elements(p_candidates) c
    where c->>'evidence_mode'='MARKET_REFERENCE_ONLY' and (
      jsonb_array_length(coalesce(c->'selected_lesson_ids','[]'::jsonb))>0
      or jsonb_array_length(coalesce(c->'avoided_lesson_ids','[]'::jsonb))>0
      or jsonb_array_length(coalesce(c->'own_experiment_ids','[]'::jsonb))>0))
    then raise exception 'youtube_market_candidate_false_own_provenance'; end if;
  if exists(select 1 from jsonb_array_elements(p_candidates) c where
      jsonb_typeof(c->'evidence_roots') is distinct from 'object'
      or jsonb_typeof(c->'evidence_roots'->'MARKET_REFERENCE') is distinct from 'array'
      or jsonb_typeof(c->'evidence_roots'->'OWN_PERFORMANCE') is distinct from 'array'
      or jsonb_typeof(c->'evidence_roots'->'OWNER_PREFERENCE') is distinct from 'object'
      or jsonb_typeof(c->'evidence_roots'->'OWNER_PREFERENCE'->'approved') is distinct from 'array'
      or jsonb_typeof(c->'evidence_roots'->'OWNER_PREFERENCE'->'rejected') is distinct from 'array'
      or (c->'evidence_roots') - array['MARKET_REFERENCE','OWN_PERFORMANCE','OWNER_PREFERENCE']::text[]
        <> '{}'::jsonb
      or (c->'evidence_roots'->'OWNER_PREFERENCE') - array['approved','rejected']::text[]
        <> '{}'::jsonb)
    then raise exception 'youtube_evidence_roots_invalid'; end if;
  if exists(select 1 from jsonb_array_elements(p_candidates) c where
      c->'evidence_roots'->'MARKET_REFERENCE'<>c->'market_reference_ids'
      or (c->>'evidence_mode'='MARKET_REFERENCE_ONLY'
        and c->'evidence_roots'->'OWN_PERFORMANCE'<>'[]'::jsonb)
      or (c->>'evidence_mode'='OWN_PERFORMANCE_BOUND'
        and c->'evidence_roots'->'OWN_PERFORMANCE'<>to_jsonb(coalesce(p_selected_lesson_ids,'{}'::uuid[]))))
    then raise exception 'youtube_evidence_roots_conflict'; end if;
  with ids as (select distinct x.value::uuid id from jsonb_array_elements(p_candidates) c
    cross join lateral jsonb_array_elements_text(c->'evidence_roots'->'OWNER_PREFERENCE'->'approved') x(value))
  select count(*) into v_expected_count from ids;
  with ids as (select distinct x.value::uuid id from jsonb_array_elements(p_candidates) c
    cross join lateral jsonb_array_elements_text(c->'evidence_roots'->'OWNER_PREFERENCE'->'approved') x(value))
  select count(*) into v_locked_count from (
    select i.id from public.video_ideas i join ids on ids.id=i.id
      where i.user_id=p_user_id and i.target_platform='youtube_shorts'
        and i.decided_at is not null and i.route in ('self','paid')
        and i.status in ('approved','generating','done') for key share
  ) locked_owner_approved;
  if v_locked_count<>v_expected_count then raise exception 'youtube_owner_preference_conflict'; end if;
  with ids as (select distinct x.value::uuid id from jsonb_array_elements(p_candidates) c
    cross join lateral jsonb_array_elements_text(c->'evidence_roots'->'OWNER_PREFERENCE'->'rejected') x(value))
  select count(*) into v_expected_count from ids;
  with ids as (select distinct x.value::uuid id from jsonb_array_elements(p_candidates) c
    cross join lateral jsonb_array_elements_text(c->'evidence_roots'->'OWNER_PREFERENCE'->'rejected') x(value))
  select count(*) into v_locked_count from (
    select i.id from public.video_ideas i join ids on ids.id=i.id
      where i.user_id=p_user_id and i.target_platform='youtube_shorts'
        and i.decided_at is not null and i.route is null and i.status='rejected' for key share
  ) locked_owner_rejected;
  if v_locked_count<>v_expected_count then raise exception 'youtube_owner_preference_conflict'; end if;
  if v_own_bound then
    if exists(select 1 from jsonb_array_elements(p_candidates) c
      where c->>'evidence_mode'='OWN_PERFORMANCE_BOUND' and (
        coalesce(c->'selected_lesson_ids','[]'::jsonb)<>to_jsonb(coalesce(p_selected_lesson_ids,'{}'::uuid[]))
        or coalesce(c->'avoided_lesson_ids','[]'::jsonb)<>to_jsonb(coalesce(p_avoided_lesson_ids,'{}'::uuid[]))))
      then raise exception 'youtube_candidate_lesson_contract_conflict'; end if;
    select cardinality(array(select distinct value from unnest(
      coalesce(p_selected_lesson_ids,'{}'::uuid[])||coalesce(p_avoided_lesson_ids,'{}'::uuid[])
    ) u(value))) into v_expected_count;
    select count(*) into v_locked_count from (
      select l.id from public.content_lessons l where l.user_id=p_user_id
        and l.source_platform='youtube_shorts'
        and l.id=any(coalesce(p_selected_lesson_ids,'{}'::uuid[])||coalesce(p_avoided_lesson_ids,'{}'::uuid[]))
        for key share
    ) locked;
    if v_locked_count<>v_expected_count then raise exception 'youtube_lesson_owner_conflict'; end if;
    if exists(select 1 from public.content_lessons l where l.user_id=p_user_id
      and l.id=any(coalesce(p_selected_lesson_ids,'{}'::uuid[]))
      and not (l.category in ('CONFIRMED_LESSON','WINNING_PATTERN') and l.status in ('SUPPORTED','CONFIRMED')))
      or exists(select 1 from public.content_lessons l where l.user_id=p_user_id
      and l.id=any(coalesce(p_avoided_lesson_ids,'{}'::uuid[]))
      and not (l.category='FAILED_PATTERN' and l.status='REJECTED'))
      then raise exception 'youtube_lesson_class_conflict'; end if;
    with ids as (select distinct x.value::uuid id from jsonb_array_elements(p_candidates) c
      cross join lateral jsonb_array_elements_text(coalesce(c->'own_experiment_ids','[]'::jsonb)) x(value))
    select count(*) into v_expected_count from ids;
    with ids as (select distinct x.value::uuid id from jsonb_array_elements(p_candidates) c
      cross join lateral jsonb_array_elements_text(coalesce(c->'own_experiment_ids','[]'::jsonb)) x(value))
    select count(*) into v_locked_count from (
      select e.id from public.experiments e join ids on ids.id=e.id
        where e.user_id=p_user_id and e.platform='youtube_shorts' for key share
    ) locked_experiments;
    if v_locked_count<>v_expected_count then raise exception 'youtube_experiment_owner_conflict'; end if;
    if exists(
      with candidate_ids as (
        select distinct x.value::uuid id from jsonb_array_elements(p_candidates) c
        cross join lateral jsonb_array_elements_text(coalesce(c->'own_experiment_ids','[]'::jsonb)) x(value)
      ), lesson_ids as (
        select distinct (ev.value->>'experiment_id')::uuid id
        from public.content_lessons l
        cross join lateral jsonb_array_elements(l.evidence) ev(value)
        where l.user_id=p_user_id and l.id=any(coalesce(p_selected_lesson_ids,'{}'::uuid[]))
      ) select 1 from candidate_ids c where not exists(select 1 from lesson_ids l where l.id=c.id)
    ) then raise exception 'youtube_experiment_lesson_chain_conflict'; end if;
  end if;
  if exists(select 1 from jsonb_array_elements(p_candidates) c where
      coalesce(btrim(c->>'slug'),'')='' or coalesce(btrim(c->>'hook'),'')=''
      or coalesce(btrim(c->>'line'),'')='' or coalesce(btrim(c->>'why_this_idea'),'')=''
      or jsonb_array_length(coalesce(c->'market_reference_ids','[]'::jsonb))=0)
    then raise exception 'invalid_youtube_candidate'; end if;
  insert into public.video_ideas (user_id,slug,animal,hook,line,prompt,target_platform,
    trend_signal,reference_source_id,reference_source_url,reference_title,
    reference_published_at,reference_views,reference_vph,reference_snapshot_at,
    reference_channel_baseline_views,reference_outlier_ratio,causal_pattern,payoff_class,
    fidelity_constraints,hypothesis_id,selected_lesson_ids,avoided_lesson_ids,
    changed_variable,experiment_constants,prompt_framework_id,prompt_framework_version,
    why_this_idea,idea_pattern,youtube_feedback_batch_key,youtube_feedback_context_hash,
    youtube_candidate_index,market_reference_ids,own_experiment_ids,evidence_roots,
    evidence_conflicts,idea_confidence,evidence_mode,youtube_batch_contract_hash)
  select p_user_id,c->>'slug',c->>'animal',c->>'hook',c->>'line',c->>'prompt',
    'youtube_shorts',c->>'trend_signal',c->>'reference_source_id',c->>'reference_source_url',
    c->>'reference_title',(c->>'reference_published_at')::timestamptz,
    (c->>'reference_views')::bigint,(c->>'reference_vph')::numeric,
    (c->>'reference_snapshot_at')::timestamptz,(c->>'reference_channel_baseline_views')::bigint,
    (c->>'reference_outlier_ratio')::numeric,c->'causal_pattern',c->>'payoff_class',
    c->'fidelity_constraints',case when c->>'evidence_mode'='OWN_PERFORMANCE_BOUND' then v_h.id else null end,
    case when c->>'evidence_mode'='OWN_PERFORMANCE_BOUND' then p_selected_lesson_ids else '{}'::uuid[] end,
    case when c->>'evidence_mode'='OWN_PERFORMANCE_BOUND' then p_avoided_lesson_ids else '{}'::uuid[] end,
    case when c->>'evidence_mode'='OWN_PERFORMANCE_BOUND' then p_hypothesis->>'changed_variable' else null end,
    case when c->>'evidence_mode'='OWN_PERFORMANCE_BOUND' then p_hypothesis->'constants' else null end,
    case when c->>'evidence_mode'='OWN_PERFORMANCE_BOUND' then p_prompt_framework_id else null end,
    case when c->>'evidence_mode'='OWN_PERFORMANCE_BOUND' then p_prompt_framework_version else null end,
    c->>'why_this_idea',c->>'idea_pattern',p_batch_key,p_context_hash,ordinality::smallint,
    array(select jsonb_array_elements_text(c->'market_reference_ids')),
    array(select jsonb_array_elements_text(coalesce(c->'own_experiment_ids','[]'::jsonb)))::uuid[],
    c->'evidence_roots',coalesce(c->'evidence_conflicts','[]'::jsonb),c->>'idea_confidence',c->>'evidence_mode',
    v_contract_hash
  from jsonb_array_elements(p_candidates) with ordinality x(c,ordinality);
  select jsonb_agg(to_jsonb(i) order by i.youtube_candidate_index) into v_result
    from public.video_ideas i where i.user_id=p_user_id and i.youtube_feedback_batch_key=p_batch_key;
  return v_result;
end; $$;

revoke execute on function public.persist_youtube_feedback_batch(uuid,text,text,text,jsonb,uuid[],uuid[],uuid,text,jsonb)
  from public,anon,authenticated;
grant execute on function public.persist_youtube_feedback_batch(uuid,text,text,text,jsonb,uuid[],uuid[],uuid,text,jsonb)
  to service_role;

-- Extend the accepted POST-04 prompt provenance function in place. Its name is
-- retained for compatibility; no parallel prompt engine is introduced.
create or replace function public.persist_tiktok_prompt_provenance(
  p_mode text, p_video_idea_id uuid, p_claude_task_id uuid,
  p_prompt text, p_prompt_hash text
) returns public.video_prompt_records
language plpgsql security definer set search_path = '' as $$
declare
  v_task public.claude_tasks; v_idea public.video_ideas;
  v_existing public.video_prompt_records; v_record public.video_prompt_records;
  v_mapping public.creative_identity_map; v_actual_hash text;
begin
  if p_mode not in ('CLAUDE_TASK','OWNER_SELECTED_EXISTING')
      or p_prompt_hash!~'^[0-9a-f]{64}$' or btrim(coalesce(p_prompt,''))=''
      or octet_length(p_prompt)>65536 then raise exception 'invalid_prompt_provenance'; end if;
  v_actual_hash:=encode(extensions.digest(convert_to(p_prompt,'UTF8'),'sha256'),'hex');
  if v_actual_hash<>p_prompt_hash then raise exception 'prompt_hash_mismatch'; end if;
  if p_mode='CLAUDE_TASK' then
    if p_claude_task_id is null then raise exception 'prompt_task_required'; end if;
    select * into v_task from public.claude_tasks t where t.id=p_claude_task_id for update;
    if not found or v_task.idea_id<>p_video_idea_id or v_task.prompt_task_kind<>'SELECTED_PROMPT'
      then raise exception 'prompt_task_chain_invalid'; end if;
    select * into v_idea from public.video_ideas i where i.id=v_task.idea_id
      and i.user_id=v_task.user_id for update;
    select * into v_existing from public.video_prompt_records r where r.user_id=v_task.user_id
      and r.claude_task_id=v_task.id for update;
  else
    if p_claude_task_id is not null then raise exception 'prompt_task_forbidden'; end if;
    select * into v_idea from public.video_ideas i where i.id=p_video_idea_id for update;
    select * into v_existing from public.video_prompt_records r where r.user_id=v_idea.user_id
      and r.video_idea_id=v_idea.id and r.claude_task_id is null
      and r.prompt_origin='OWNER_SELECTED_EXISTING' for update;
  end if;
  if v_idea.id is null or v_idea.target_platform not in ('tiktok','youtube_shorts')
      or v_idea.decided_at is null or v_idea.route not in ('self','paid')
      or v_idea.status not in ('approved','generating','done')
    then raise exception 'prompt_owner_approval_required'; end if;
  if p_mode='OWNER_SELECTED_EXISTING' and (v_idea.route<>'paid' or v_idea.prompt is distinct from p_prompt)
    then raise exception 'owner_selected_prompt_conflict'; end if;
  if v_idea.target_platform='youtube_shorts' then
    select * into strict v_mapping from public.creative_identity_map m
      where m.user_id=v_idea.user_id and m.platform='youtube_shorts' and m.video_idea_id=v_idea.id;
    if v_idea.evidence_roots is null or jsonb_typeof(v_idea.evidence_roots)<>'object'
      then raise exception 'youtube_prompt_evidence_required'; end if;
  end if;
  if v_existing.id is not null then
    if v_existing.prompt_hash<>p_prompt_hash then raise exception 'prompt_provenance_conflict'; end if;
    return v_existing;
  end if;
  if p_mode='CLAUDE_TASK' then update public.video_ideas set prompt=p_prompt,
    generated_prompt_at=now() where id=v_idea.id and user_id=v_idea.user_id; end if;
  insert into public.video_prompt_records (user_id,video_id,video_idea_id,claude_task_id,
    prompt_hash,prompt_origin,prompt_version,prompt_structure,prompt_patterns,
    experiment_variable,technical_valid,hypothesis_id,selected_lesson_ids,
    avoided_lesson_ids,feedback_context_hash,prompt_framework_id,experiment_constants,
    creative_id,own_experiment_ids,market_reference_ids,evidence_roots,owner_selected_at)
  values (v_idea.user_id,null,v_idea.id,case when p_mode='CLAUDE_TASK' then v_task.id end,
    p_prompt_hash,p_mode,coalesce(v_idea.prompt_framework_version,'UNVERSIONED'),
    jsonb_build_object('source','video_ideas.prompt','prompt_sha256',p_prompt_hash),
    '[]'::jsonb,v_idea.changed_variable,null,v_idea.hypothesis_id,
    coalesce(v_idea.selected_lesson_ids,'{}'::uuid[]),coalesce(v_idea.avoided_lesson_ids,'{}'::uuid[]),
    coalesce(v_idea.feedback_context_hash,v_idea.youtube_feedback_context_hash),
    v_idea.prompt_framework_id,coalesce(v_idea.experiment_constants,'{}'::jsonb),
    v_mapping.creative_id,coalesce(v_idea.own_experiment_ids,'{}'::uuid[]),
    coalesce(v_idea.market_reference_ids,'{}'::text[]),v_idea.evidence_roots,v_idea.decided_at)
  returning * into v_record;
  return v_record;
exception when no_data_found or too_many_rows then raise exception 'youtube_creative_mapping_required';
end; $$;

revoke execute on function public.persist_tiktok_prompt_provenance(text,uuid,uuid,text,text)
  from public,anon,authenticated;
grant execute on function public.persist_tiktok_prompt_provenance(text,uuid,uuid,text,text)
  to service_role;

comment on function public.create_youtube_content_experiment is
  'POST-05 service-only YouTube subject adapter for the existing experiments table.';
comment on function public.persist_youtube_content_analysis is
  'POST-05 service-only YouTube metric adapter for existing content_analysis_results.';
comment on function public.insert_youtube_content_lesson is
  'POST-05 service-only reuse of existing content_lessons; promotion counts distinct experiments.';
