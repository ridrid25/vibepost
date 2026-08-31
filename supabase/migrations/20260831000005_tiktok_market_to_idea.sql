-- POST-08: extend the accepted POST-04 TikTok feedback batch with immutable
-- MARKET_REFERENCE provenance. No collector, verdict, lesson or analytics store.

alter table public.video_ideas
  add column if not exists market_dna_ids uuid[] not null default '{}',
  add column if not exists owner_preference_ids uuid[] not null default '{}',
  add column if not exists market_context_hash text,
  add column if not exists market_mechanic_key text,
  add column if not exists novelty_status text,
  add column if not exists market_batch_contract_hash text;

alter table public.video_ideas
  add constraint video_ideas_market_context_hash_check
    check (market_context_hash is null or market_context_hash ~ '^[0-9a-f]{64}$'),
  add constraint video_ideas_market_contract_hash_check
    check (market_batch_contract_hash is null or market_batch_contract_hash ~ '^[0-9a-f]{64}$'),
  add constraint video_ideas_market_mechanic_key_check
    check (market_mechanic_key is null or market_mechanic_key in ('M1','M2','M3','M4','M5','NONE')),
  add constraint video_ideas_market_novelty_check
    check (novelty_status is null or novelty_status in
      ('NEW_CONCEPT','CONTROLLED_MUTATION','MARKET_INSPIRED_TEST')),
  add constraint video_ideas_market_feedback_complete_check check (
    market_context_hash is null or (
      target_platform='tiktok' and feedback_batch_key is not null
      and market_batch_contract_hash is not null and market_mechanic_key is not null
      and novelty_status is not null and evidence_roots is not null
      and idea_confidence is not null and evidence_mode is not null
      and jsonb_typeof(evidence_roots)='object' and jsonb_typeof(evidence_conflicts)='array'
      and ((market_mechanic_key='NONE' and cardinality(market_reference_ids)=0
        and cardinality(market_dna_ids)=0 and novelty_status='NEW_CONCEPT')
        or (market_mechanic_key<>'NONE' and cardinality(market_reference_ids)>0
          and cardinality(market_dna_ids)>0))
    )
  );

create index video_ideas_tiktok_market_context_lookup
  on public.video_ideas(user_id,market_context_hash,created_at desc)
  where market_context_hash is not null;

create or replace function public.tiktok_market_copy_text_forbidden(p_value text)
returns boolean language sql immutable set search_path='' as $$
  select coalesce(p_value,'')~*'(https?://|www\.|tiktok\.com|@[[:alnum:]_.-]+|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[0-9]{15,}|сдела(й|ть)[[:space:]]+(точно[[:space:]]+)?как|повтори(ть)?[[:space:]]+(этот[[:space:]]+)?(ролик|кадр)|(клонируй|скопируй)[[:space:]]+(этот[[:space:]]+)?ролик|дословно|кадр[[:space:]]*[0-9]|exact[[:space:]]+(caption|script|shot)|copy[[:space:]]+(this|the)|make[[:space:]]+((it|this)[[:space:]]+)?((exactly|just)[[:space:]]+)?like[[:space:]]+(this|the)[[:space:]]+tiktok|(clone|replicate)[[:space:]]+(this|the)[[:space:]]+tiktok|verbatim)'
$$;
revoke all on function public.tiktok_market_copy_text_forbidden(text)
  from public,anon,authenticated,service_role;

alter table public.video_prompt_records
  add column if not exists market_dna_ids uuid[] not null default '{}',
  add column if not exists owner_preference_ids uuid[] not null default '{}',
  add column if not exists evidence_conflicts jsonb not null default '[]'::jsonb,
  add column if not exists market_context_hash text,
  add column if not exists market_mechanic_key text,
  add column if not exists novelty_status text,
  add column if not exists idea_confidence text;

alter table public.video_prompt_records
  add constraint video_prompt_records_market_context_hash_check
    check (market_context_hash is null or market_context_hash ~ '^[0-9a-f]{64}$'),
  add constraint video_prompt_records_market_mechanic_key_check
    check (market_mechanic_key is null or market_mechanic_key in ('M1','M2','M3','M4','M5','NONE')),
  add constraint video_prompt_records_market_novelty_check
    check (novelty_status is null or novelty_status in
      ('NEW_CONCEPT','CONTROLLED_MUTATION','MARKET_INSPIRED_TEST')),
  add constraint video_prompt_records_market_confidence_check
    check (idea_confidence is null or idea_confidence in ('LOW','MEDIUM','HIGH')),
  add constraint video_prompt_records_market_conflicts_check
    check (jsonb_typeof(evidence_conflicts)='array');

create or replace function public.guard_video_idea_feedback_provenance()
returns trigger language plpgsql security invoker set search_path='' as $$
declare
  v_role text:=coalesce((select auth.role()),'');
  v_marker text:=coalesce(current_setting('app.post08_market_attach',true),'');
  v_market_changed boolean;
begin
  if tg_op='INSERT' then
    if v_role<>'service_role' and (
      new.hypothesis_id is not null or new.feedback_hypothesis_key is not null
      or new.feedback_context_hash is not null or new.selected_lesson_ids is not null
      or new.avoided_lesson_ids is not null or new.api_metric_snapshot_ids is not null
      or new.studio_metric_ids is not null or new.changed_variable is not null
      or new.experiment_constants is not null or new.prompt_framework_id is not null
      or new.prompt_framework_version is not null or new.why_this_idea is not null
      or new.idea_pattern is not null or new.feedback_batch_key is not null
      or new.feedback_candidate_index is not null or new.youtube_feedback_batch_key is not null
      or new.youtube_feedback_context_hash is not null or new.youtube_candidate_index is not null
      or cardinality(new.market_reference_ids)>0 or cardinality(new.market_dna_ids)>0
      or cardinality(new.own_experiment_ids)>0 or cardinality(new.owner_preference_ids)>0
      or new.evidence_roots is not null or new.evidence_conflicts<>'[]'::jsonb
      or new.idea_confidence is not null or new.evidence_mode is not null
      or new.youtube_batch_contract_hash is not null or new.market_context_hash is not null
      or new.market_mechanic_key is not null or new.novelty_status is not null
      or new.market_batch_contract_hash is not null
    ) then raise exception 'feedback_provenance_service_owned'; end if;
    return new;
  end if;

  if row(
    old.hypothesis_id,old.feedback_hypothesis_key,old.feedback_context_hash,
    old.selected_lesson_ids,old.avoided_lesson_ids,old.api_metric_snapshot_ids,
    old.studio_metric_ids,old.changed_variable,old.experiment_constants,
    old.prompt_framework_id,old.prompt_framework_version,old.why_this_idea,
    old.idea_pattern,old.feedback_batch_key,old.feedback_candidate_index,
    old.youtube_feedback_batch_key,old.youtube_feedback_context_hash,
    old.youtube_candidate_index,old.youtube_batch_contract_hash
  ) is distinct from row(
    new.hypothesis_id,new.feedback_hypothesis_key,new.feedback_context_hash,
    new.selected_lesson_ids,new.avoided_lesson_ids,new.api_metric_snapshot_ids,
    new.studio_metric_ids,new.changed_variable,new.experiment_constants,
    new.prompt_framework_id,new.prompt_framework_version,new.why_this_idea,
    new.idea_pattern,new.feedback_batch_key,new.feedback_candidate_index,
    new.youtube_feedback_batch_key,new.youtube_feedback_context_hash,
    new.youtube_candidate_index,new.youtube_batch_contract_hash
  ) then raise exception 'feedback_provenance_immutable'; end if;

  v_market_changed:=row(
    old.market_reference_ids,old.market_dna_ids,old.own_experiment_ids,
    old.owner_preference_ids,old.evidence_roots,old.evidence_conflicts,
    old.idea_confidence,old.evidence_mode,old.market_context_hash,
    old.market_mechanic_key,old.novelty_status,old.market_batch_contract_hash
  ) is distinct from row(
    new.market_reference_ids,new.market_dna_ids,new.own_experiment_ids,
    new.owner_preference_ids,new.evidence_roots,new.evidence_conflicts,
    new.idea_confidence,new.evidence_mode,new.market_context_hash,
    new.market_mechanic_key,new.novelty_status,new.market_batch_contract_hash
  );
  if v_market_changed and not (
    v_role='service_role' and old.target_platform='tiktok'
    and old.market_context_hash is null and old.market_batch_contract_hash is null
    and cardinality(old.market_reference_ids)=0 and cardinality(old.market_dna_ids)=0
    and cardinality(old.own_experiment_ids)=0 and cardinality(old.owner_preference_ids)=0
    and old.evidence_roots is null and old.evidence_conflicts='[]'::jsonb
    and old.idea_confidence is null and old.evidence_mode is null
    and old.market_mechanic_key is null and old.novelty_status is null
    and new.market_context_hash=v_marker and new.market_batch_contract_hash is not null
    and new.market_mechanic_key is not null and new.novelty_status is not null
    and new.evidence_roots is not null and new.idea_confidence is not null
    and new.evidence_mode is not null
  ) then raise exception 'feedback_provenance_immutable'; end if;
  return new;
end; $$;

create or replace function public.guard_video_prompt_provenance()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if row(
    old.user_id,old.video_id,old.video_idea_id,old.claude_task_id,
    old.prompt_hash,old.prompt_origin,old.prompt_version,old.prompt_structure,
    old.prompt_patterns,old.experiment_variable,old.hypothesis_id,
    old.selected_lesson_ids,old.avoided_lesson_ids,old.feedback_context_hash,
    old.prompt_framework_id,old.experiment_constants,old.creative_id,
    old.own_experiment_ids,old.market_reference_ids,old.evidence_roots,
    old.owner_selected_at,old.market_dna_ids,old.owner_preference_ids,
    old.evidence_conflicts,old.market_context_hash,old.market_mechanic_key,
    old.novelty_status,old.idea_confidence
  ) is distinct from row(
    new.user_id,new.video_id,new.video_idea_id,new.claude_task_id,
    new.prompt_hash,new.prompt_origin,new.prompt_version,new.prompt_structure,
    new.prompt_patterns,new.experiment_variable,new.hypothesis_id,
    new.selected_lesson_ids,new.avoided_lesson_ids,new.feedback_context_hash,
    new.prompt_framework_id,new.experiment_constants,new.creative_id,
    new.own_experiment_ids,new.market_reference_ids,new.evidence_roots,
    new.owner_selected_at,new.market_dna_ids,new.owner_preference_ids,
    new.evidence_conflicts,new.market_context_hash,new.market_mechanic_key,
    new.novelty_status,new.idea_confidence
  ) then raise exception 'prompt_provenance_immutable'; end if;
  return new;
end; $$;

create or replace function public.populate_tiktok_market_prompt_provenance()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_idea public.video_ideas;
begin
  if new.video_idea_id is null then return new; end if;
  select * into v_idea from public.video_ideas i
    where i.id=new.video_idea_id and i.user_id=new.user_id;
  if v_idea.target_platform='tiktok' and v_idea.market_context_hash is not null then
    if new.market_reference_ids is distinct from v_idea.market_reference_ids
      or new.evidence_roots is distinct from v_idea.evidence_roots
      then raise exception 'market_prompt_base_provenance_conflict'; end if;
    new.market_dna_ids:=v_idea.market_dna_ids;
    new.owner_preference_ids:=v_idea.owner_preference_ids;
    new.evidence_conflicts:=v_idea.evidence_conflicts;
    new.market_context_hash:=v_idea.market_context_hash;
    new.market_mechanic_key:=v_idea.market_mechanic_key;
    new.novelty_status:=v_idea.novelty_status;
    new.idea_confidence:=v_idea.idea_confidence;
  end if;
  return new;
end; $$;

create trigger trg_populate_tiktok_market_prompt_provenance
  before insert on public.video_prompt_records for each row
  execute function public.populate_tiktok_market_prompt_provenance();

create or replace function public.persist_tiktok_market_feedback_batch(
  p_user_id uuid,p_batch_key text,p_context_hash text,p_hypothesis_key text,
  p_hypothesis jsonb,p_selected_lesson_ids uuid[],p_avoided_lesson_ids uuid[],
  p_api_metric_snapshot_ids uuid[],p_studio_metric_ids uuid[],
  p_prompt_framework_id uuid,p_prompt_framework_version text,
  p_market_context jsonb,p_candidates jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_candidate jsonb; v_reference_id uuid; v_dna_id uuid; v_preference_id uuid;
  v_experiment_id uuid; v_metric_id uuid; v_base_candidates jsonb; v_result jsonb;
  v_contract_hash text; v_existing_hash text; v_existing_context text; v_updated integer;
begin
  if coalesce((select auth.role()),'')<>'service_role'
      then raise exception 'market_feedback_service_owned'; end if;
  if p_batch_key!~'^[0-9a-f]{64}$' or p_context_hash!~'^[0-9a-f]{64}$'
      or p_hypothesis_key!~'^[0-9a-f]{64}$' then raise exception 'invalid_market_feedback_batch'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text||p_batch_key,0));
  select i.market_batch_contract_hash,i.market_context_hash into v_existing_hash,v_existing_context
    from public.video_ideas i where i.user_id=p_user_id and i.feedback_batch_key=p_batch_key
    order by i.feedback_candidate_index limit 1 for update;
  if v_existing_hash is not null and p_hypothesis is null and p_candidates is null then
    if v_existing_context<>p_context_hash then raise exception 'market_feedback_batch_conflict'; end if;
    select jsonb_agg(to_jsonb(i) order by i.feedback_candidate_index) into v_result
      from public.video_ideas i where i.user_id=p_user_id and i.feedback_batch_key=p_batch_key;
    return v_result;
  end if;
  if jsonb_typeof(p_hypothesis)<>'object' or jsonb_typeof(p_market_context)<>'object'
      or jsonb_typeof(p_candidates)<>'array' or jsonb_array_length(p_candidates)<1
      or jsonb_array_length(p_candidates)>5 or jsonb_typeof(p_hypothesis->'constants')<>'object'
      or jsonb_typeof(p_hypothesis->'evidence')<>'array'
      or jsonb_typeof(p_hypothesis->'feedback_context')<>'object'
      or p_hypothesis->>'changed_variable' not in
        ('topic','content_format','hook_type','character_id','visual_style_id','pacing_profile',
         'punch_type','loop_type','camera_profile','prompt_framework_version')
      or coalesce(btrim(p_hypothesis->>'statement'),'')=''
      or coalesce(btrim(p_hypothesis->>'expected_effect'),'')=''
      or coalesce(btrim(p_hypothesis->>'rationale'),'')=''
    then raise exception 'invalid_market_feedback_batch'; end if;
  if not public.jsonb_has_exact_keys(p_hypothesis,array[
      'statement','changed_variable','constants','expected_effect','rationale','evidence',
      'uncertainty','feedback_context'])
      or p_hypothesis->'feedback_context' is distinct from p_market_context
      or not public.jsonb_has_exact_keys(p_market_context,array[
        'integration_version','platform','OWN_PERFORMANCE','OWNER_PREFERENCE',
        'MARKET_REFERENCE','conflicts'])
      or p_market_context->>'platform'<>'tiktok'
      or (p_market_context->>'integration_version')::integer<>1
      or not public.jsonb_has_exact_keys(p_market_context->'OWN_PERFORMANCE',array[
        'source_type','selected_lessons','avoided_lessons','primary','prompt_framework'])
      or p_market_context->'OWN_PERFORMANCE'->>'source_type'<>'OWN_PERFORMANCE'
      or jsonb_typeof(p_market_context->'OWN_PERFORMANCE'->'selected_lessons') is distinct from 'array'
      or jsonb_typeof(p_market_context->'OWN_PERFORMANCE'->'avoided_lessons') is distinct from 'array'
      or jsonb_typeof(p_market_context->'OWN_PERFORMANCE'->'prompt_framework') is distinct from 'object'
      or not public.jsonb_has_exact_keys(p_market_context->'OWN_PERFORMANCE'->'prompt_framework',array[
        'id','version_label','status','rule_ids'])
      or not public.jsonb_has_exact_keys(p_market_context->'OWNER_PREFERENCE',array[
        'source_type','approved','rejected','MARKET_AVOIDANCE'])
      or p_market_context->'OWNER_PREFERENCE'->>'source_type'<>'OWNER_PREFERENCE'
      or jsonb_typeof(p_market_context->'OWNER_PREFERENCE'->'approved') is distinct from 'array'
      or jsonb_typeof(p_market_context->'OWNER_PREFERENCE'->'rejected') is distinct from 'array'
      or jsonb_typeof(p_market_context->'OWNER_PREFERENCE'->'MARKET_AVOIDANCE') is distinct from 'array'
      or not public.jsonb_has_exact_keys(p_market_context->'MARKET_REFERENCE',array[
        'source_type','references','selected_changed_variable','confidence','limitations'])
      or p_market_context->'MARKET_REFERENCE'->>'source_type'<>'MARKET_REFERENCE'
      or jsonb_typeof(p_market_context->'MARKET_REFERENCE'->'references') is distinct from 'array'
      or jsonb_typeof(p_market_context->'MARKET_REFERENCE'->'limitations') is distinct from 'array'
      or jsonb_typeof(p_market_context->'conflicts') is distinct from 'array'
      or coalesce(btrim(p_hypothesis->>'uncertainty'),'')=''
    then raise exception 'market_evidence_roots_invalid'; end if;
  if p_market_context->'OWN_PERFORMANCE'->'primary'<>'null'::jsonb and (
      jsonb_typeof(p_market_context->'OWN_PERFORMANCE'->'primary') is distinct from 'object'
      or not public.jsonb_has_exact_keys(p_market_context->'OWN_PERFORMANCE'->'primary',array[
        'lesson_id','experiment_id','analysis_id','changed_variable','constants','success_metrics']))
    then raise exception 'market_own_primary_invalid'; end if;
  if exists(select 1 from jsonb_array_elements(
      (p_market_context->'OWN_PERFORMANCE'->'selected_lessons') ||
      (p_market_context->'OWN_PERFORMANCE'->'avoided_lessons')) l
      where not public.jsonb_has_exact_keys(l,array[
        'lesson_id','lesson','category','status','confidence','conclusive_evidence'])
        or jsonb_typeof(l->'conclusive_evidence') is distinct from 'array')
      or exists(select 1 from jsonb_array_elements(
        (p_market_context->'OWN_PERFORMANCE'->'selected_lessons') ||
        (p_market_context->'OWN_PERFORMANCE'->'avoided_lessons')) l
        cross join lateral jsonb_array_elements(l->'conclusive_evidence') e
        where not public.jsonb_has_exact_keys(e,array[
          'experiment_id','experiment_status','latest_analysis_id','latest_conclusion']))
      or exists(select 1 from jsonb_array_elements(
        (p_market_context->'OWNER_PREFERENCE'->'approved') ||
        (p_market_context->'OWNER_PREFERENCE'->'rejected')) o
        where not public.jsonb_has_exact_keys(o,array[
          'idea_id','animal','hook','route','decided_at']))
      or exists(select 1 from jsonb_array_elements(p_market_context->'OWNER_PREFERENCE'->'MARKET_AVOIDANCE') a
        where not public.jsonb_has_exact_keys(a,array['preference_id','dna_evidence_id','mechanics'])
          or jsonb_typeof(a->'mechanics') is distinct from 'array')
      or exists(select 1 from jsonb_array_elements(p_market_context->'OWNER_PREFERENCE'->'MARKET_AVOIDANCE') a
        cross join lateral jsonb_array_elements(a->'mechanics') m
        where not public.jsonb_has_exact_keys(m,array['field','value']))
      or exists(select 1 from jsonb_array_elements(p_market_context->'MARKET_REFERENCE'->'references') r
        where not public.jsonb_has_exact_keys(r,array[
          'key','market_reference_id','market_dna_id','disposition','mechanics'])
          or jsonb_typeof(r->'mechanics') is distinct from 'array')
      or exists(select 1 from jsonb_array_elements(p_market_context->'MARKET_REFERENCE'->'references') r
        cross join lateral jsonb_array_elements(r->'mechanics') m
        where not public.jsonb_has_exact_keys(m,array[
          'key','field','value','confidence','limitations'])
          or jsonb_typeof(m->'limitations') is distinct from 'array')
      or exists(select 1 from jsonb_array_elements(p_market_context->'conflicts') c
        where not public.jsonb_has_exact_keys(c,array[
          'conflict_type','market_reference_ids','market_dna_ids','own_evidence_ids',
          'owner_preference_ids','resolution','confidence','limitations'])
          or jsonb_typeof(c->'market_reference_ids') is distinct from 'array'
          or jsonb_typeof(c->'market_dna_ids') is distinct from 'array'
          or jsonb_typeof(c->'own_evidence_ids') is distinct from 'array'
          or jsonb_typeof(c->'owner_preference_ids') is distinct from 'array'
          or jsonb_typeof(c->'limitations') is distinct from 'array'
          or c->>'resolution' not in ('AVOID','CONTROLLED_RETEST','USE_WITH_MODIFICATION','INSUFFICIENT_EVIDENCE')
          or c->>'confidence' not in ('LOW','MEDIUM','HIGH'))
    then raise exception 'market_evidence_nested_schema_invalid'; end if;
  if exists(select 1 from jsonb_array_elements(p_hypothesis->'evidence') e where
      (e->>'source_type'='MARKET_REFERENCE' and not public.jsonb_has_exact_keys(e,array[
        'source_type','market_reference_ids','market_dna_ids']))
      or (e->>'source_type'='OWN_PERFORMANCE' and not public.jsonb_has_exact_keys(e,array[
        'source_type','lesson_ids','avoided_lesson_ids','experiment_id','analysis_id']))
      or e->>'source_type' not in ('MARKET_REFERENCE','OWN_PERFORMANCE'))
    then raise exception 'market_hypothesis_evidence_invalid'; end if;
  if p_market_context::text~*'"(verdict|experiment_verdict|create_lesson|publish|publishing|auto_production|generation_command)"[[:space:]]*:'
    then raise exception 'market_context_command_forbidden'; end if;
  if p_market_context::text~*'"(canonical_url|external_reference_id|creator_name|creator_handle|source_locator|title|caption|transcript|html)"[[:space:]]*:'
    then raise exception 'market_context_source_identity_forbidden'; end if;
  if jsonb_typeof(p_market_context->'OWN_PERFORMANCE')<>'object'
      or jsonb_typeof(p_market_context->'OWNER_PREFERENCE')<>'object'
      or jsonb_typeof(p_market_context->'MARKET_REFERENCE')<>'object'
    then raise exception 'market_evidence_roots_invalid'; end if;
  if exists(select 1 from jsonb_array_elements(p_candidates) c
    where not public.jsonb_has_exact_keys(c,array[
        'slug','animal','hook','line','prompt','why_this_idea','idea_pattern',
        'market_mechanic_key','novelty_status','market_reference_ids','market_dna_ids',
        'own_lesson_ids','avoided_lesson_ids','own_experiment_ids','owner_preference_ids',
        'evidence_roots','evidence_conflicts','idea_confidence','evidence_mode','market_context_hash'])
      or jsonb_typeof(c->'market_reference_ids') is distinct from 'array'
      or jsonb_typeof(c->'market_dna_ids') is distinct from 'array'
      or jsonb_typeof(c->'own_lesson_ids') is distinct from 'array'
      or jsonb_typeof(c->'avoided_lesson_ids') is distinct from 'array'
      or jsonb_typeof(c->'own_experiment_ids') is distinct from 'array'
      or jsonb_typeof(c->'owner_preference_ids') is distinct from 'array'
      or jsonb_typeof(c->'evidence_roots') is distinct from 'object'
      or jsonb_typeof(c->'evidence_conflicts') is distinct from 'array'
      or c->>'market_context_hash'<>p_context_hash
      or c->>'market_mechanic_key' not in ('M1','M2','M3','M4','M5','NONE')
      or c->>'novelty_status' not in ('NEW_CONCEPT','CONTROLLED_MUTATION','MARKET_INSPIRED_TEST')
      or c->>'idea_confidence' not in ('LOW','MEDIUM','HIGH')
      or c->>'evidence_mode' not in ('MARKET_REFERENCE_ONLY','OWN_PERFORMANCE_BOUND')
      or (c->'evidence_roots')-array['MARKET_REFERENCE','OWN_PERFORMANCE','OWNER_PREFERENCE']::text[]<>'{}'::jsonb
      or jsonb_typeof(c->'evidence_roots'->'MARKET_REFERENCE') is distinct from 'object'
      or not public.jsonb_has_exact_keys(c->'evidence_roots'->'MARKET_REFERENCE',array[
        'market_reference_ids','market_dna_ids','mechanics'])
      or jsonb_typeof(c->'evidence_roots'->'MARKET_REFERENCE'->'market_reference_ids') is distinct from 'array'
      or jsonb_typeof(c->'evidence_roots'->'MARKET_REFERENCE'->'market_dna_ids') is distinct from 'array'
      or jsonb_typeof(c->'evidence_roots'->'MARKET_REFERENCE'->'mechanics') is distinct from 'array'
      or jsonb_typeof(c->'evidence_roots'->'OWN_PERFORMANCE') is distinct from 'object'
      or not public.jsonb_has_exact_keys(c->'evidence_roots'->'OWN_PERFORMANCE',array[
        'lesson_ids','experiment_ids'])
      or jsonb_typeof(c->'evidence_roots'->'OWNER_PREFERENCE') is distinct from 'object'
      or (c->'evidence_roots'->'OWNER_PREFERENCE')-
        array['approved_idea_ids','rejected_idea_ids','market_disposition_reference_ids',
          'market_avoidance_reference_ids','market_avoidance']::text[]<>'{}'::jsonb
      or jsonb_typeof(c->'evidence_roots'->'OWNER_PREFERENCE'->'approved_idea_ids') is distinct from 'array'
      or jsonb_typeof(c->'evidence_roots'->'OWNER_PREFERENCE'->'rejected_idea_ids') is distinct from 'array'
      or jsonb_typeof(c->'evidence_roots'->'OWNER_PREFERENCE'->'market_disposition_reference_ids') is distinct from 'array'
      or jsonb_typeof(c->'evidence_roots'->'OWNER_PREFERENCE'->'market_avoidance_reference_ids') is distinct from 'array'
      or jsonb_typeof(c->'evidence_roots'->'OWNER_PREFERENCE'->'market_avoidance') is distinct from 'array'
      or c->'evidence_roots'->'MARKET_REFERENCE'->'market_reference_ids'<>c->'market_reference_ids'
      or c->'evidence_roots'->'MARKET_REFERENCE'->'market_dna_ids'<>c->'market_dna_ids'
      or c->'evidence_roots'->'OWN_PERFORMANCE'->'lesson_ids'<>c->'own_lesson_ids'
      or c->'evidence_roots'->'OWN_PERFORMANCE'->'experiment_ids'<>c->'own_experiment_ids'
      or c->'evidence_roots'->'OWNER_PREFERENCE'->'market_disposition_reference_ids'<>
        c->'market_reference_ids'
      or not (c->'owner_preference_ids' @>
        ((c->'evidence_roots'->'OWNER_PREFERENCE'->'approved_idea_ids') ||
         (c->'evidence_roots'->'OWNER_PREFERENCE'->'rejected_idea_ids') ||
         (c->'evidence_roots'->'OWNER_PREFERENCE'->'market_disposition_reference_ids') ||
         (c->'evidence_roots'->'OWNER_PREFERENCE'->'market_avoidance_reference_ids')))
      or not (c->'owner_preference_ids' <@
        ((c->'evidence_roots'->'OWNER_PREFERENCE'->'approved_idea_ids') ||
         (c->'evidence_roots'->'OWNER_PREFERENCE'->'rejected_idea_ids') ||
         (c->'evidence_roots'->'OWNER_PREFERENCE'->'market_disposition_reference_ids') ||
         (c->'evidence_roots'->'OWNER_PREFERENCE'->'market_avoidance_reference_ids')))
      or c->'own_lesson_ids'<>to_jsonb(coalesce(p_selected_lesson_ids,'{}'::uuid[]))
      or c->'avoided_lesson_ids'<>to_jsonb(coalesce(p_avoided_lesson_ids,'{}'::uuid[]))
      or (c->>'market_mechanic_key'='NONE' and
        (jsonb_array_length(c->'market_reference_ids')<>0 or jsonb_array_length(c->'market_dna_ids')<>0
          or c->>'novelty_status'<>'NEW_CONCEPT' or jsonb_array_length(c->'evidence_conflicts')<>0))
      or (c->>'market_mechanic_key'<>'NONE' and
        (jsonb_array_length(c->'market_reference_ids')=0 or jsonb_array_length(c->'market_dna_ids')=0))
      or public.tiktok_market_copy_text_forbidden(concat_ws(' ',c->>'slug',c->>'animal',
        c->>'hook',c->>'line',c->>'prompt',c->>'why_this_idea'))
    then raise exception 'market_candidate_identity_leak'; end if;
  if exists(select 1 from jsonb_array_elements(p_candidates) c
      cross join lateral jsonb_array_elements(c->'evidence_conflicts') x
      where not public.jsonb_has_exact_keys(x,array[
        'conflict_type','market_reference_ids','market_dna_ids','own_evidence_ids',
        'owner_preference_ids','resolution','confidence','limitations'])
        or jsonb_typeof(x->'market_reference_ids') is distinct from 'array'
        or jsonb_typeof(x->'market_dna_ids') is distinct from 'array'
        or jsonb_typeof(x->'own_evidence_ids') is distinct from 'array'
        or jsonb_typeof(x->'owner_preference_ids') is distinct from 'array'
        or jsonb_typeof(x->'limitations') is distinct from 'array'
        or not (x->'market_reference_ids' <@ c->'market_reference_ids')
        or not (x->'market_dna_ids' <@ c->'market_dna_ids')
        or not (x->'own_evidence_ids' <@ c->'own_experiment_ids')
        or not (x->'owner_preference_ids' <@ c->'owner_preference_ids')
        or x->>'resolution' not in ('AVOID','CONTROLLED_RETEST','USE_WITH_MODIFICATION','INSUFFICIENT_EVIDENCE')
        or x->>'confidence' not in ('LOW','MEDIUM','HIGH'))
    then raise exception 'market_candidate_conflict_invalid'; end if;
  if not exists(select 1 from jsonb_array_elements(p_candidates) c
      where jsonb_array_length(c->'market_reference_ids')>0)
    then raise exception 'market_candidate_required'; end if;
  if exists(select 1 from jsonb_array_elements(p_candidates) c
      cross join lateral jsonb_array_elements(c->'evidence_roots'->'MARKET_REFERENCE'->'mechanics') m
      where not public.jsonb_has_exact_keys(m,array['field','value','confidence','limitations'])
        or jsonb_typeof(m->'limitations') is distinct from 'array'
        or m->>'field'<>p_hypothesis->>'changed_variable'
        or coalesce(btrim(m->>'value'),'')=''
        or public.tiktok_market_copy_text_forbidden(m->>'value'))
    then raise exception 'market_candidate_identity_leak'; end if;
  if exists(select 1 from jsonb_array_elements(p_candidates) c
      cross join lateral jsonb_array_elements(c->'evidence_roots'->'OWNER_PREFERENCE'->'market_avoidance') m
      where not public.jsonb_has_exact_keys(m,array['field','value'])
        or coalesce(btrim(m->>'field'),'')='' or coalesce(btrim(m->>'value'),'')=''
        or public.tiktok_market_copy_text_forbidden(m->>'value'))
    then raise exception 'market_candidate_identity_leak'; end if;
  if exists(select 1 from jsonb_array_elements(p_candidates) c
      where c->>'market_mechanic_key'<>'NONE'
      group by c->>'market_mechanic_key' having count(*)>2)
    then raise exception 'market_candidate_diversity_violation'; end if;

  for v_candidate in select value from jsonb_array_elements(p_candidates) loop
    for v_reference_id in select value::uuid from jsonb_array_elements_text(v_candidate->'market_reference_ids') loop
      perform 1 from public.market_references r where r.id=v_reference_id and r.user_id=p_user_id
        and r.platform='tiktok' and r.owner_disposition in ('TAKE','INTERESTING_MECHANIC') for key share;
      if not found then raise exception 'market_reference_owner_conflict'; end if;
    end loop;
    for v_dna_id in select value::uuid from jsonb_array_elements_text(v_candidate->'market_dna_ids') loop
      perform 1 from public.market_reference_evidence e where e.id=v_dna_id and e.user_id=p_user_id
        and e.market_reference_id=any(array(select value::uuid
          from jsonb_array_elements_text(v_candidate->'market_reference_ids')))
        and e.evidence_kind='DNA_INFERENCE' and e.analysis_identity='HUMAN_REVIEW'
        and e.payload->>'reviewer_status'='ACCEPTED' for key share;
      if not found then raise exception 'market_dna_owner_conflict'; end if;
    end loop;
    for v_experiment_id in select value::uuid from jsonb_array_elements_text(v_candidate->'own_experiment_ids') loop
      perform 1 from public.experiments e where e.id=v_experiment_id and e.user_id=p_user_id
        and e.platform='tiktok' for key share;
      if not found then raise exception 'market_own_experiment_conflict'; end if;
    end loop;
    for v_preference_id in select value::uuid from jsonb_array_elements_text(
      v_candidate->'evidence_roots'->'OWNER_PREFERENCE'->'market_avoidance_reference_ids') loop
      perform 1 from public.market_references r where r.id=v_preference_id and r.user_id=p_user_id
        and r.owner_disposition='NOT_MY_STYLE' for key share;
      if not found then raise exception 'market_owner_preference_conflict'; end if;
    end loop;
    for v_preference_id in select value::uuid from jsonb_array_elements_text(
      v_candidate->'evidence_roots'->'OWNER_PREFERENCE'->'approved_idea_ids') loop
      perform 1 from public.video_ideas i where i.id=v_preference_id and i.user_id=p_user_id
        and i.target_platform='tiktok' and i.decided_at is not null and i.route in ('self','paid')
        and i.status in ('approved','generating','done') for key share;
      if not found then raise exception 'market_owner_preference_conflict'; end if;
    end loop;
    for v_preference_id in select value::uuid from jsonb_array_elements_text(
      v_candidate->'evidence_roots'->'OWNER_PREFERENCE'->'rejected_idea_ids') loop
      perform 1 from public.video_ideas i where i.id=v_preference_id and i.user_id=p_user_id
        and i.target_platform='tiktok' and i.decided_at is not null and i.route is null
        and i.status='rejected' for key share;
      if not found then raise exception 'market_owner_preference_conflict'; end if;
    end loop;
  end loop;
  for v_metric_id in select unnest(coalesce(p_api_metric_snapshot_ids,'{}'::uuid[])) loop
    perform 1 from public.video_metric_snapshots s where s.id=v_metric_id and s.user_id=p_user_id
      for key share;
    if not found then raise exception 'market_api_metric_owner_conflict'; end if;
  end loop;
  for v_metric_id in select unnest(coalesce(p_studio_metric_ids,'{}'::uuid[])) loop
    perform 1 from public.studio_metrics s where s.id=v_metric_id and s.user_id=p_user_id
      for key share;
    if not found then raise exception 'market_studio_metric_owner_conflict'; end if;
  end loop;

  v_contract_hash:=encode(extensions.digest(convert_to(public.canonical_jsonb_text(jsonb_build_object(
    'batch_key',p_batch_key,'context_hash',p_context_hash,'hypothesis_key',p_hypothesis_key,
    'hypothesis',p_hypothesis,'selected_lesson_ids',to_jsonb(coalesce(p_selected_lesson_ids,'{}'::uuid[])),
    'avoided_lesson_ids',to_jsonb(coalesce(p_avoided_lesson_ids,'{}'::uuid[])),
    'api_metric_snapshot_ids',to_jsonb(coalesce(p_api_metric_snapshot_ids,'{}'::uuid[])),
    'studio_metric_ids',to_jsonb(coalesce(p_studio_metric_ids,'{}'::uuid[])),
    'framework_id',p_prompt_framework_id,'framework_version',p_prompt_framework_version,
    'market_context',p_market_context,'candidates',p_candidates)),'UTF8'),'sha256'),'hex');
  if v_existing_hash is not null then
    if v_existing_hash<>v_contract_hash then raise exception 'market_feedback_batch_conflict'; end if;
    select jsonb_agg(to_jsonb(i) order by i.feedback_candidate_index) into v_result
      from public.video_ideas i where i.user_id=p_user_id and i.feedback_batch_key=p_batch_key;
    return v_result;
  end if;
  select jsonb_agg(jsonb_build_object(
    'slug',c->>'slug','animal',c->>'animal','hook',c->>'hook','line',c->>'line',
    'prompt',c->>'prompt','why_this_idea',c->>'why_this_idea','idea_pattern',c->>'idea_pattern'
  ) order by ordinality) into v_base_candidates
    from jsonb_array_elements(p_candidates) with ordinality x(c,ordinality);
  perform public.persist_tiktok_feedback_batch(
    p_user_id,p_batch_key,p_context_hash,p_hypothesis_key,p_hypothesis->>'statement',
    p_hypothesis->>'changed_variable',p_hypothesis->>'expected_effect',p_hypothesis->>'rationale',
    p_hypothesis->'evidence',p_hypothesis->'constants',p_hypothesis->'feedback_context',
    coalesce(p_selected_lesson_ids,'{}'::uuid[]),coalesce(p_avoided_lesson_ids,'{}'::uuid[]),
    coalesce(p_api_metric_snapshot_ids,'{}'::uuid[]),coalesce(p_studio_metric_ids,'{}'::uuid[]),
    p_prompt_framework_id,p_prompt_framework_version,v_base_candidates);
  perform set_config('app.post08_market_attach',p_context_hash,true);
  with candidates as (
    select c,ordinality::smallint candidate_index from jsonb_array_elements(p_candidates)
      with ordinality x(c,ordinality)
  ) update public.video_ideas i set
    market_reference_ids=array(select jsonb_array_elements_text(c.c->'market_reference_ids')),
    market_dna_ids=array(select jsonb_array_elements_text(c.c->'market_dna_ids'))::uuid[],
    own_experiment_ids=array(select jsonb_array_elements_text(c.c->'own_experiment_ids'))::uuid[],
    owner_preference_ids=array(select jsonb_array_elements_text(c.c->'owner_preference_ids'))::uuid[],
    evidence_roots=c.c->'evidence_roots',evidence_conflicts=c.c->'evidence_conflicts',
    idea_confidence=c.c->>'idea_confidence',evidence_mode=c.c->>'evidence_mode',
    market_context_hash=p_context_hash,market_mechanic_key=c.c->>'market_mechanic_key',
    novelty_status=c.c->>'novelty_status',market_batch_contract_hash=v_contract_hash
  from candidates c where i.user_id=p_user_id and i.feedback_batch_key=p_batch_key
    and i.feedback_candidate_index=c.candidate_index;
  get diagnostics v_updated=row_count;
  if v_updated<>jsonb_array_length(p_candidates) then raise exception 'market_feedback_attachment_incomplete'; end if;
  select jsonb_agg(to_jsonb(i) order by i.feedback_candidate_index) into v_result
    from public.video_ideas i where i.user_id=p_user_id and i.feedback_batch_key=p_batch_key;
  return v_result;
end; $$;

create or replace function public.persist_tiktok_prompt_provenance_v2(
  p_mode text,p_video_idea_id uuid,p_claude_task_id uuid,p_prompt text,p_prompt_hash text
) returns public.video_prompt_records language plpgsql security definer set search_path='' as $$
declare v_idea public.video_ideas; v_result public.video_prompt_records;
begin
  select * into v_idea from public.video_ideas i where i.id=p_video_idea_id;
  if not found then raise exception 'prompt_idea_not_found'; end if;
  if v_idea.target_platform='tiktok' and v_idea.market_context_hash is not null and
      public.tiktok_market_copy_text_forbidden(p_prompt)
    then raise exception 'market_candidate_identity_leak'; end if;
  v_result:=public.persist_tiktok_prompt_provenance(
    p_mode,p_video_idea_id,p_claude_task_id,p_prompt,p_prompt_hash);
  return v_result;
end; $$;

revoke execute on function public.persist_tiktok_prompt_provenance(text,uuid,uuid,text,text)
  from service_role;
revoke all on function public.persist_tiktok_market_feedback_batch(
  uuid,text,text,text,jsonb,uuid[],uuid[],uuid[],uuid[],uuid,text,jsonb,jsonb)
  from public,anon,authenticated;
revoke all on function public.persist_tiktok_prompt_provenance_v2(text,uuid,uuid,text,text)
  from public,anon,authenticated;
grant execute on function public.persist_tiktok_market_feedback_batch(
  uuid,text,text,text,jsonb,uuid[],uuid[],uuid[],uuid[],uuid,text,jsonb,jsonb)
  to service_role;
grant execute on function public.persist_tiktok_prompt_provenance_v2(text,uuid,uuid,text,text)
  to service_role;

comment on function public.persist_tiktok_market_feedback_batch is
  'POST-08 service-only atomic wrapper over the existing TikTok feedback batch.';
comment on function public.persist_tiktok_prompt_provenance_v2 is
  'POST-08 source-identity guard delegating to the accepted owner-gated prompt provenance function.';
