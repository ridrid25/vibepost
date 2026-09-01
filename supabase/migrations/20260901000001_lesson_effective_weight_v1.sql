-- POST-10: keep lesson history canonical while persisting the derived effective
-- decision snapshot. No table, canonical status, verdict, or market store changes.

create or replace function public.post10_legacy_market_context(p_context jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare v_own jsonb; v_selected jsonb; v_avoided jsonb; v_primary jsonb;
begin
  if jsonb_typeof(p_context) is distinct from 'object'
      or jsonb_typeof(p_context->'OWN_PERFORMANCE') is distinct from 'object'
    then return null; end if;
  v_own:=p_context->'OWN_PERFORMANCE';
  if jsonb_typeof(v_own->'selected_lessons') is distinct from 'array'
      or jsonb_typeof(v_own->'avoided_lessons') is distinct from 'array'
    then return null; end if;
  select coalesce(jsonb_agg(value-'effective_evidence' order by ordinality),'[]'::jsonb)
    into v_selected from jsonb_array_elements(v_own->'selected_lessons') with ordinality;
  select coalesce(jsonb_agg(value-'effective_evidence' order by ordinality),'[]'::jsonb)
    into v_avoided from jsonb_array_elements(v_own->'avoided_lessons') with ordinality;
  v_primary:=case when jsonb_typeof(v_own->'primary')='object'
    then (v_own->'primary')-'effective_evidence' else v_own->'primary' end;
  v_own:=(v_own-'lesson_effective_policy_version'-'evaluation_at'-
    'lesson_effective_states'-'controlled_retests') || jsonb_build_object(
      'selected_lessons',v_selected,'avoided_lessons',v_avoided,'primary',v_primary);
  return jsonb_set(p_context,'{OWN_PERFORMANCE}',v_own,false);
end; $$;

create or replace function public.post10_legacy_market_hypothesis(p_hypothesis jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare v_evidence jsonb;
begin
  if jsonb_typeof(p_hypothesis) is distinct from 'object'
      or jsonb_typeof(p_hypothesis->'evidence') is distinct from 'array'
    then return null; end if;
  select coalesce(jsonb_agg(case when value->>'source_type'='OWN_PERFORMANCE'
      then value-'policy_version'-'effective_state' else value end order by ordinality),'[]'::jsonb)
    into v_evidence from jsonb_array_elements(p_hypothesis->'evidence') with ordinality;
  return jsonb_set(jsonb_set(p_hypothesis,'{evidence}',v_evidence,false),'{feedback_context}',
    public.post10_legacy_market_context(p_hypothesis->'feedback_context'),false);
end; $$;

create or replace function public.post10_jsonb_text_array(p_value jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select jsonb_typeof(p_value)='array' and not exists(
    select 1 from jsonb_array_elements(p_value) value where jsonb_typeof(value)<>'string')
$$;

create or replace function public.post10_jsonb_uuid_array(p_value jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select public.post10_jsonb_text_array(p_value) and not exists(
    select 1 from jsonb_array_elements_text(p_value) value
      where value!~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
$$;

create or replace function public.post10_effective_retest_valid(p_value jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select jsonb_typeof(p_value)='object'
    and public.jsonb_has_exact_keys(p_value,array[
      'action','target_platform','source_lesson_id','changed_variable','constants',
      'supporting_experiment_ids','contradictory_experiment_ids','retest_reason',
      'policy_version','limitations'])
    and p_value->>'action'='CONTROLLED_RETEST'
    and p_value->>'target_platform' in ('tiktok','youtube_shorts')
    and p_value->>'source_lesson_id'~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    and p_value->>'changed_variable' in (
      'topic','content_format','hook_type','character_id','visual_style_id','pacing_profile',
      'punch_type','loop_type','camera_profile','prompt_framework_version')
    and jsonb_typeof(p_value->'constants')='object'
    and public.post10_jsonb_uuid_array(p_value->'supporting_experiment_ids')
    and public.post10_jsonb_uuid_array(p_value->'contradictory_experiment_ids')
    and p_value->>'retest_reason' in (
      'CURRENT_EVIDENCE_CONFLICTED','HISTORICAL_STALE','HISTORICAL_VERY_STALE')
    and p_value->>'policy_version'='LESSON_EFFECTIVE_WEIGHT_V1'
    and public.post10_jsonb_text_array(p_value->'limitations')
$$;

create or replace function public.post10_effective_state_valid(p_value jsonb,p_evaluation_at text)
returns boolean language sql immutable set search_path = '' as $$
  select jsonb_typeof(p_value)='object'
    and public.jsonb_has_exact_keys(p_value,array[
      'lesson_id','canonical_status','source_platform','platform_scope','effective_strength',
      'freshness_bucket','age_since_last_support_seconds','independent_confirmation_count',
      'independent_failure_count','lineage_independence','context_match','contradiction_state',
      'recent_contradiction_count','supporting_experiment_ids','supporting_evidence',
      'cross_platform_supporting_experiment_ids','contradictory_experiment_ids',
      'contradictory_evidence','last_supported_at','last_contradicted_at','evidence_diversity',
      'mechanism_fingerprint','policy_version','evaluation_at','selection_role',
      'controlled_retest','reasons','limitations'])
    and p_value->>'lesson_id'~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    and p_value->>'canonical_status' in ('CONFIRMED','SUPPORTED','REJECTED','HYPOTHESIS')
    and p_value->>'source_platform' in ('tiktok','youtube_shorts')
    and p_value->>'platform_scope' in ('TIKTOK_ONLY','YOUTUBE_ONLY','CROSS_PLATFORM','UNKNOWN')
    and p_value->>'effective_strength' in
      ('VERY_HIGH','HIGH','MEDIUM','LOW','WEAK','CONFLICTED','UNKNOWN')
    and p_value->>'freshness_bucket' in ('FRESH','AGING','STALE','VERY_STALE','UNKNOWN')
    and ((jsonb_typeof(p_value->'age_since_last_support_seconds')='number'
        and p_value->>'age_since_last_support_seconds'~'^[0-9]+$')
      or (jsonb_typeof(p_value->'age_since_last_support_seconds')='string'
        and p_value->>'age_since_last_support_seconds'='UNKNOWN'))
    and jsonb_typeof(p_value->'independent_confirmation_count')='number'
    and p_value->>'independent_confirmation_count'~'^[0-9]+$'
    and jsonb_typeof(p_value->'independent_failure_count')='number'
    and p_value->>'independent_failure_count'~'^[0-9]+$'
    and p_value->>'lineage_independence' in ('HIGH','MEDIUM','LOW','UNKNOWN')
    and p_value->>'context_match' in ('EXACT','COMPATIBLE','WEAK','UNKNOWN','CONFLICTING')
    and p_value->>'contradiction_state' in (
      'NO_CONTRADICTION','INSUFFICIENT_EVIDENCE','WEAK_CONTRADICTION',
      'CONTEXTUAL_CONTRADICTION','PLATFORM_CONTRADICTION','DIRECT_CONTRADICTION')
    and jsonb_typeof(p_value->'recent_contradiction_count')='number'
    and p_value->>'recent_contradiction_count'~'^[0-9]+$'
    and public.post10_jsonb_uuid_array(p_value->'supporting_experiment_ids')
    and public.post10_jsonb_uuid_array(p_value->'cross_platform_supporting_experiment_ids')
    and public.post10_jsonb_uuid_array(p_value->'contradictory_experiment_ids')
    and jsonb_typeof(p_value->'supporting_evidence')='array'
    and jsonb_typeof(p_value->'contradictory_evidence')='array'
    and not exists(select 1 from jsonb_array_elements(
      (p_value->'supporting_evidence')||(p_value->'contradictory_evidence')) evidence
      where not public.jsonb_has_exact_keys(evidence,array[
          'experiment_id','analysis_id','conclusion','platform','evidence_at'])
        or evidence->>'experiment_id'!~
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or evidence->>'analysis_id'!~
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or evidence->>'conclusion' not in ('PASS','FAIL')
        or evidence->>'platform' not in ('tiktok','youtube_shorts')
        or coalesce(evidence->>'evidence_at','')!~
          '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$')
    and (p_value->>'last_supported_at'='UNKNOWN' or p_value->>'last_supported_at'~
      '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$')
    and (p_value->>'last_contradicted_at'='UNKNOWN' or p_value->>'last_contradicted_at'~
      '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$')
    and public.jsonb_has_exact_keys(p_value->'evidence_diversity',array[
      'platforms','independent_roots','matched_experiments'])
    and public.post10_jsonb_text_array(p_value->'evidence_diversity'->'platforms')
    and not exists(select 1 from jsonb_array_elements_text(
      p_value->'evidence_diversity'->'platforms') platform
      where platform not in ('tiktok','youtube_shorts'))
    and jsonb_typeof(p_value->'evidence_diversity'->'independent_roots')='number'
    and p_value->'evidence_diversity'->>'independent_roots'~'^[0-9]+$'
    and jsonb_typeof(p_value->'evidence_diversity'->'matched_experiments')='number'
    and p_value->'evidence_diversity'->>'matched_experiments'~'^[0-9]+$'
    and jsonb_typeof(p_value->'mechanism_fingerprint')='string'
    and p_value->>'policy_version'='LESSON_EFFECTIVE_WEIGHT_V1'
    and p_value->>'evaluation_at'=p_evaluation_at
    and p_value->>'selection_role' in ('POSITIVE','AVOIDANCE','INACTIVE')
    and (jsonb_typeof(p_value->'controlled_retest')='null' or (
      public.post10_effective_retest_valid(p_value->'controlled_retest')
      and p_value->'controlled_retest'->>'source_lesson_id'=p_value->>'lesson_id'))
    and public.post10_jsonb_text_array(p_value->'reasons')
    and public.post10_jsonb_text_array(p_value->'limitations')
$$;

alter function public.persist_tiktok_market_feedback_batch(
  uuid,text,text,text,jsonb,uuid[],uuid[],uuid[],uuid[],uuid,text,jsonb,jsonb
) rename to persist_tiktok_market_feedback_batch_pre_post10;

create or replace function public.guard_hypothesis_feedback_identity()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if old.hypothesis_key is not null and row(
    old.hypothesis_key,old.constants,old.feedback_context
  ) is distinct from row(
    new.hypothesis_key,new.constants,new.feedback_context
  ) then
    if old.hypothesis_key is not distinct from new.hypothesis_key
        and old.constants is not distinct from new.constants
        and current_setting('app.post10_effective_context_upgrade',true)=old.id::text
        and old.feedback_context->'OWN_PERFORMANCE'->>'lesson_effective_policy_version' is null
        and new.feedback_context->'OWN_PERFORMANCE'->>'lesson_effective_policy_version'=
          'LESSON_EFFECTIVE_WEIGHT_V1'
        and old.feedback_context is not distinct from
          public.post10_legacy_market_context(new.feedback_context)
      then return new; end if;
    raise exception 'feedback_hypothesis_identity_immutable';
  end if;
  return new;
end; $$;

create or replace function public.persist_tiktok_market_feedback_batch(
  p_user_id uuid,p_batch_key text,p_context_hash text,p_hypothesis_key text,
  p_hypothesis jsonb,p_selected_lesson_ids uuid[],p_avoided_lesson_ids uuid[],
  p_api_metric_snapshot_ids uuid[],p_studio_metric_ids uuid[],
  p_prompt_framework_id uuid,p_prompt_framework_version text,
  p_market_context jsonb,p_candidates jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_result jsonb; v_existing_hash text; v_existing_context text; v_contract_hash text;
  v_existing_feedback jsonb; v_hypothesis_id uuid; v_legacy_context jsonb; v_legacy_hypothesis jsonb;
  v_expected_retests jsonb;
begin
  if coalesce((select auth.role()),'')<>'service_role'
    then raise exception 'market_feedback_service_owned'; end if;
  if p_batch_key!~'^[0-9a-f]{64}$' or p_context_hash!~'^[0-9a-f]{64}$'
      or p_hypothesis_key!~'^[0-9a-f]{64}$'
    then raise exception 'invalid_market_feedback_batch'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text||p_batch_key,0));
  select i.market_batch_contract_hash,i.market_context_hash,i.hypothesis_id,h.feedback_context
    into v_existing_hash,v_existing_context,v_hypothesis_id,v_existing_feedback
    from public.video_ideas i join public.content_hypotheses h
      on h.id=i.hypothesis_id and h.user_id=i.user_id
    where i.user_id=p_user_id and i.feedback_batch_key=p_batch_key
    order by i.feedback_candidate_index limit 1 for update of i;
  if v_existing_hash is not null and p_hypothesis is null and p_candidates is null then
    if v_existing_context<>p_context_hash then raise exception 'market_feedback_batch_conflict'; end if;
    select jsonb_agg(to_jsonb(i) order by i.feedback_candidate_index) into v_result
      from public.video_ideas i where i.user_id=p_user_id and i.feedback_batch_key=p_batch_key;
    return v_result;
  end if;
  if jsonb_typeof(p_hypothesis) is distinct from 'object'
      or p_hypothesis->'feedback_context' is distinct from p_market_context
      or not public.jsonb_has_exact_keys(p_market_context,array[
        'integration_version','platform','OWN_PERFORMANCE','OWNER_PREFERENCE',
        'MARKET_REFERENCE','conflicts'])
      or not public.jsonb_has_exact_keys(p_market_context->'OWN_PERFORMANCE',array[
        'source_type','lesson_effective_policy_version','evaluation_at','lesson_effective_states',
        'controlled_retests','selected_lessons','avoided_lessons','primary','prompt_framework'])
      or p_market_context->'OWN_PERFORMANCE'->>'source_type'<>'OWN_PERFORMANCE'
      or p_market_context->'OWN_PERFORMANCE'->>'lesson_effective_policy_version'<>
        'LESSON_EFFECTIVE_WEIGHT_V1'
      or coalesce(p_market_context->'OWN_PERFORMANCE'->>'evaluation_at','') !~
        '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
      or jsonb_typeof(p_market_context->'OWN_PERFORMANCE'->'lesson_effective_states')
        is distinct from 'array'
      or jsonb_typeof(p_market_context->'OWN_PERFORMANCE'->'controlled_retests')
        is distinct from 'array'
      or exists(select 1 from jsonb_array_elements(
        (p_market_context->'OWN_PERFORMANCE'->'selected_lessons')||
        (p_market_context->'OWN_PERFORMANCE'->'avoided_lessons')) l
        where not public.jsonb_has_exact_keys(l,array[
          'lesson_id','lesson','category','status','confidence','effective_evidence','conclusive_evidence'])
          or jsonb_typeof(l->'effective_evidence') is distinct from 'object')
      or (p_market_context->'OWN_PERFORMANCE'->'primary'<>'null'::jsonb and
        not public.jsonb_has_exact_keys(p_market_context->'OWN_PERFORMANCE'->'primary',array[
          'lesson_id','experiment_id','analysis_id','changed_variable','constants','success_metrics',
          'effective_evidence']))
    then raise exception 'post10_effective_context_invalid'; end if;
  if p_market_context::text~*'"(verdict|experiment_verdict|create_lesson|publish|publishing|auto_production|generation_command)"[[:space:]]*:'
    then raise exception 'market_context_command_forbidden'; end if;
  if p_market_context::text~*'"(canonical_url|external_reference_id|creator_name|creator_handle|source_locator|title|caption|transcript|html)"[[:space:]]*:'
    then raise exception 'market_context_source_identity_forbidden'; end if;
  if exists(select 1 from jsonb_array_elements(
      p_market_context->'OWN_PERFORMANCE'->'lesson_effective_states') state
      where not public.post10_effective_state_valid(
        state,p_market_context->'OWN_PERFORMANCE'->>'evaluation_at'))
      or (select count(*)<>count(distinct state->>'lesson_id') from jsonb_array_elements(
        p_market_context->'OWN_PERFORMANCE'->'lesson_effective_states') state)
      or exists(select 1 from jsonb_array_elements(
        (p_market_context->'OWN_PERFORMANCE'->'selected_lessons')||
        (p_market_context->'OWN_PERFORMANCE'->'avoided_lessons')) lesson
        where not exists(select 1 from jsonb_array_elements(
          p_market_context->'OWN_PERFORMANCE'->'lesson_effective_states') state
          where state->>'lesson_id'=lesson->>'lesson_id'
            and state is not distinct from lesson->'effective_evidence'))
      or (p_market_context->'OWN_PERFORMANCE'->'primary'<>'null'::jsonb and not exists(
        select 1 from jsonb_array_elements(
          p_market_context->'OWN_PERFORMANCE'->'lesson_effective_states') state
        where state->>'lesson_id'=
          p_market_context->'OWN_PERFORMANCE'->'primary'->>'lesson_id'
          and state is not distinct from
            p_market_context->'OWN_PERFORMANCE'->'primary'->'effective_evidence'))
    then raise exception 'post10_effective_state_invalid'; end if;
  select coalesce(jsonb_agg(state->'controlled_retest' order by
      case state->>'effective_strength' when 'VERY_HIGH' then 6 when 'HIGH' then 5
        when 'MEDIUM' then 4 when 'LOW' then 3 when 'WEAK' then 2
        when 'CONFLICTED' then 1 else 0 end desc,
      case state->>'context_match' when 'EXACT' then 4 when 'COMPATIBLE' then 3
        when 'WEAK' then 2 when 'UNKNOWN' then 1 else 0 end desc,
      case state->>'freshness_bucket' when 'FRESH' then 4 when 'AGING' then 3
        when 'STALE' then 2 when 'VERY_STALE' then 1 else 0 end desc,
      case state->>'lineage_independence' when 'HIGH' then 3 when 'MEDIUM' then 2
        when 'LOW' then 1 else 0 end desc,
      case state->>'canonical_status' when 'CONFIRMED' then 3 when 'SUPPORTED' then 2
        when 'REJECTED' then 1 else 0 end desc,
      state->>'last_supported_at' desc,state->>'lesson_id')
      filter(where jsonb_typeof(state->'controlled_retest')='object'),'[]'::jsonb)
    into v_expected_retests from jsonb_array_elements(
      p_market_context->'OWN_PERFORMANCE'->'lesson_effective_states')
      with ordinality item(state,ordinality);
  if v_expected_retests is distinct from
      p_market_context->'OWN_PERFORMANCE'->'controlled_retests'
    then raise exception 'post10_controlled_retests_invalid'; end if;
  v_legacy_context:=public.post10_legacy_market_context(p_market_context);
  v_legacy_hypothesis:=public.post10_legacy_market_hypothesis(p_hypothesis);
  if v_legacy_context is null or v_legacy_hypothesis is null
    then raise exception 'post10_effective_context_invalid'; end if;
  v_contract_hash:=encode(extensions.digest(convert_to(public.canonical_jsonb_text(jsonb_build_object(
    'batch_key',p_batch_key,'context_hash',p_context_hash,'hypothesis_key',p_hypothesis_key,
    'hypothesis',v_legacy_hypothesis,
    'selected_lesson_ids',to_jsonb(coalesce(p_selected_lesson_ids,'{}'::uuid[])),
    'avoided_lesson_ids',to_jsonb(coalesce(p_avoided_lesson_ids,'{}'::uuid[])),
    'api_metric_snapshot_ids',to_jsonb(coalesce(p_api_metric_snapshot_ids,'{}'::uuid[])),
    'studio_metric_ids',to_jsonb(coalesce(p_studio_metric_ids,'{}'::uuid[])),
    'framework_id',p_prompt_framework_id,'framework_version',p_prompt_framework_version,
    'market_context',v_legacy_context,'candidates',p_candidates)),'UTF8'),'sha256'),'hex');
  if v_existing_hash is not null then
    if v_existing_context<>p_context_hash
        or v_existing_feedback is distinct from p_market_context
        or v_existing_hash<>v_contract_hash
      then raise exception 'market_feedback_batch_conflict'; end if;
    select jsonb_agg(to_jsonb(i) order by i.feedback_candidate_index) into v_result
      from public.video_ideas i where i.user_id=p_user_id and i.feedback_batch_key=p_batch_key;
    return v_result;
  end if;
  v_result:=public.persist_tiktok_market_feedback_batch_pre_post10(
    p_user_id,p_batch_key,p_context_hash,p_hypothesis_key,v_legacy_hypothesis,
    p_selected_lesson_ids,p_avoided_lesson_ids,p_api_metric_snapshot_ids,p_studio_metric_ids,
    p_prompt_framework_id,p_prompt_framework_version,v_legacy_context,p_candidates);
  v_hypothesis_id:=(v_result->0->>'hypothesis_id')::uuid;
  if v_hypothesis_id is null then raise exception 'post10_hypothesis_missing'; end if;
  perform set_config('app.post10_effective_context_upgrade',v_hypothesis_id::text,true);
  update public.content_hypotheses set feedback_context=p_market_context
    where id=v_hypothesis_id and user_id=p_user_id
      and feedback_context is distinct from p_market_context;
  if not found then
    perform 1 from public.content_hypotheses h where h.id=v_hypothesis_id and h.user_id=p_user_id
      and h.feedback_context is not distinct from p_market_context;
    if not found then raise exception 'post10_snapshot_persistence_failed'; end if;
  end if;
  return v_result;
end; $$;

revoke execute on function public.post10_legacy_market_context(jsonb) from public,anon,authenticated,service_role;
revoke execute on function public.post10_legacy_market_hypothesis(jsonb) from public,anon,authenticated,service_role;
revoke execute on function public.post10_jsonb_text_array(jsonb) from public,anon,authenticated,service_role;
revoke execute on function public.post10_jsonb_uuid_array(jsonb) from public,anon,authenticated,service_role;
revoke execute on function public.post10_effective_retest_valid(jsonb) from public,anon,authenticated,service_role;
revoke execute on function public.post10_effective_state_valid(jsonb,text) from public,anon,authenticated,service_role;
revoke execute on function public.persist_tiktok_market_feedback_batch_pre_post10(
  uuid,text,text,text,jsonb,uuid[],uuid[],uuid[],uuid[],uuid,text,jsonb,jsonb
) from public,anon,authenticated,service_role;
revoke execute on function public.persist_tiktok_market_feedback_batch(
  uuid,text,text,text,jsonb,uuid[],uuid[],uuid[],uuid[],uuid,text,jsonb,jsonb
) from public,anon,authenticated;
grant execute on function public.persist_tiktok_market_feedback_batch(
  uuid,text,text,text,jsonb,uuid[],uuid[],uuid[],uuid[],uuid,text,jsonb,jsonb
) to service_role;
-- The existing SECURITY INVOKER immutability trigger needs this pure projection
-- to return its stable domain error for direct service writes. It has no writes.
grant execute on function public.post10_legacy_market_context(jsonb) to service_role;
