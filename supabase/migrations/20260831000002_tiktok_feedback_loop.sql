-- POST-04: close the existing TikTok lesson -> idea -> prompt loop without
-- adding a second learning store. Existing verdict/promotion logic is unchanged.

alter table public.content_hypotheses
  add column if not exists constants jsonb not null default '{}'::jsonb,
  add column if not exists feedback_context jsonb,
  add column if not exists hypothesis_key text;

alter table public.content_hypotheses
  add constraint content_hypotheses_constants_object_check
    check (jsonb_typeof(constants) = 'object'),
  add constraint content_hypotheses_feedback_context_object_check
    check (feedback_context is null or jsonb_typeof(feedback_context) = 'object'),
  add constraint content_hypotheses_key_check
    check (hypothesis_key is null or hypothesis_key ~ '^[0-9a-f]{64}$');

create unique index content_hypotheses_owner_feedback_key
  on public.content_hypotheses (user_id, hypothesis_key)
  where hypothesis_key is not null;

alter table public.video_ideas
  add column if not exists hypothesis_id uuid,
  add column if not exists feedback_hypothesis_key text,
  add column if not exists feedback_context_hash text,
  add column if not exists selected_lesson_ids uuid[],
  add column if not exists avoided_lesson_ids uuid[],
  add column if not exists api_metric_snapshot_ids uuid[],
  add column if not exists studio_metric_ids uuid[],
  add column if not exists changed_variable text,
  add column if not exists experiment_constants jsonb,
  add column if not exists prompt_framework_id uuid,
  add column if not exists prompt_framework_version text,
  add column if not exists why_this_idea text,
  add column if not exists idea_pattern text,
  add column if not exists feedback_batch_key text,
  add column if not exists feedback_candidate_index smallint;

alter table public.video_ideas
  add constraint video_ideas_feedback_hypothesis_key_check
    check (feedback_hypothesis_key is null or feedback_hypothesis_key ~ '^[0-9a-f]{64}$'),
  add constraint video_ideas_feedback_context_hash_check
    check (feedback_context_hash is null or feedback_context_hash ~ '^[0-9a-f]{64}$'),
  add constraint video_ideas_feedback_batch_key_check
    check (feedback_batch_key is null or feedback_batch_key ~ '^[0-9a-f]{64}$'),
  add constraint video_ideas_feedback_constants_object_check
    check (experiment_constants is null or jsonb_typeof(experiment_constants) = 'object'),
  add constraint video_ideas_feedback_candidate_index_check
    check (feedback_candidate_index is null or feedback_candidate_index between 1 and 5),
  add constraint video_ideas_feedback_complete_check check (
    feedback_batch_key is null or (
      target_platform = 'tiktok'
      and hypothesis_id is not null
      and feedback_hypothesis_key is not null
      and feedback_context_hash is not null
      and selected_lesson_ids is not null
      and avoided_lesson_ids is not null
      and changed_variable is not null
      and experiment_constants is not null
      and prompt_framework_id is not null
      and prompt_framework_version is not null
      and why_this_idea is not null
      and idea_pattern is not null
      and feedback_candidate_index is not null
    )
  ),
  add constraint video_ideas_feedback_hypothesis_owner_fk
    foreign key (hypothesis_id, user_id)
    references public.content_hypotheses (id, user_id),
  add constraint video_ideas_feedback_framework_owner_fk
    foreign key (prompt_framework_id, user_id)
    references public.prompt_framework_versions (id, user_id);

create unique index video_ideas_feedback_batch_candidate_unique
  on public.video_ideas (user_id, feedback_batch_key, feedback_candidate_index)
  where feedback_batch_key is not null;
create index video_ideas_feedback_hypothesis_lookup
  on public.video_ideas (user_id, hypothesis_id, created_at desc)
  where hypothesis_id is not null;

alter table public.claude_tasks
  add constraint claude_tasks_id_user_unique unique (id, user_id),
  add column if not exists prompt_task_kind text;

alter table public.claude_tasks
  drop constraint if exists claude_tasks_idea_id_fkey;
alter table public.claude_tasks
  add constraint claude_tasks_prompt_kind_check
    check (prompt_task_kind is null or prompt_task_kind = 'SELECTED_PROMPT'),
  add constraint claude_tasks_idea_owner_fk
    foreign key (idea_id, user_id) references public.video_ideas (id, user_id);

-- The live factory may create several prompt revisions for one selected idea.
-- Idempotency belongs to video_prompt_records per task, not to the idea as a
-- whole, otherwise the existing rework loop is blocked after revision one.
create index claude_tasks_selected_prompt_lookup
  on public.claude_tasks (user_id, idea_id, prompt_task_kind);

alter table public.video_prompt_records
  alter column video_id drop not null,
  add column if not exists video_idea_id uuid,
  add column if not exists claude_task_id uuid,
  add column if not exists prompt_hash text,
  add column if not exists prompt_origin text,
  add column if not exists hypothesis_id uuid,
  add column if not exists selected_lesson_ids uuid[],
  add column if not exists avoided_lesson_ids uuid[],
  add column if not exists feedback_context_hash text,
  add column if not exists prompt_framework_id uuid,
  add column if not exists experiment_constants jsonb;

alter table public.video_prompt_records
  add constraint video_prompt_records_subject_check check (
    video_id is not null or video_idea_id is not null
  ),
  add constraint video_prompt_records_origin_check check (
    prompt_origin is null or prompt_origin in ('CLAUDE_TASK', 'OWNER_SELECTED_EXISTING')
  ),
  add constraint video_prompt_records_hash_check check (
    prompt_hash is null or prompt_hash ~ '^[0-9a-f]{64}$'
  ),
  add constraint video_prompt_records_context_hash_check check (
    feedback_context_hash is null or feedback_context_hash ~ '^[0-9a-f]{64}$'
  ),
  add constraint video_prompt_records_constants_object_check check (
    experiment_constants is null or jsonb_typeof(experiment_constants) = 'object'
  ),
  add constraint video_prompt_records_prepublication_complete_check check (
    video_idea_id is null or (
      prompt_hash is not null
      and prompt_origin is not null
      and selected_lesson_ids is not null
      and avoided_lesson_ids is not null
      and experiment_constants is not null
      and (
        (prompt_origin = 'CLAUDE_TASK' and claude_task_id is not null)
        or (prompt_origin = 'OWNER_SELECTED_EXISTING' and claude_task_id is null)
      )
    )
  ),
  add constraint video_prompt_records_idea_owner_fk
    foreign key (video_idea_id, user_id) references public.video_ideas (id, user_id),
  add constraint video_prompt_records_task_owner_fk
    foreign key (claude_task_id, user_id) references public.claude_tasks (id, user_id),
  add constraint video_prompt_records_hypothesis_owner_fk
    foreign key (hypothesis_id, user_id) references public.content_hypotheses (id, user_id),
  add constraint video_prompt_records_framework_owner_fk
    foreign key (prompt_framework_id, user_id)
    references public.prompt_framework_versions (id, user_id);

create unique index video_prompt_records_one_per_task
  on public.video_prompt_records (user_id, claude_task_id)
  where claude_task_id is not null;
create unique index video_prompt_records_one_owner_selected_per_idea
  on public.video_prompt_records (user_id, video_idea_id)
  where video_idea_id is not null and claude_task_id is null
    and prompt_origin = 'OWNER_SELECTED_EXISTING';

create or replace function public.guard_video_prompt_provenance()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if row(
    old.user_id, old.video_id, old.video_idea_id, old.claude_task_id,
    old.prompt_hash, old.prompt_origin, old.prompt_version,
    old.prompt_structure, old.prompt_patterns, old.experiment_variable,
    old.hypothesis_id, old.selected_lesson_ids, old.avoided_lesson_ids,
    old.feedback_context_hash, old.prompt_framework_id, old.experiment_constants
  ) is distinct from row(
    new.user_id, new.video_id, new.video_idea_id, new.claude_task_id,
    new.prompt_hash, new.prompt_origin, new.prompt_version,
    new.prompt_structure, new.prompt_patterns, new.experiment_variable,
    new.hypothesis_id, new.selected_lesson_ids, new.avoided_lesson_ids,
    new.feedback_context_hash, new.prompt_framework_id, new.experiment_constants
  ) then
    raise exception 'prompt_provenance_immutable';
  end if;
  return new;
end;
$$;

create trigger trg_video_prompt_provenance
  before update on public.video_prompt_records
  for each row execute function public.guard_video_prompt_provenance();

create or replace function public.guard_video_idea_feedback_provenance()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_role text := coalesce((select auth.role()), '');
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
      or new.feedback_candidate_index is not null
    ) then
      raise exception 'feedback_provenance_service_owned';
    end if;
  elsif row(
    old.hypothesis_id, old.feedback_hypothesis_key, old.feedback_context_hash,
    old.selected_lesson_ids, old.avoided_lesson_ids, old.api_metric_snapshot_ids,
    old.studio_metric_ids, old.changed_variable, old.experiment_constants,
    old.prompt_framework_id, old.prompt_framework_version, old.why_this_idea,
    old.idea_pattern, old.feedback_batch_key, old.feedback_candidate_index
  ) is distinct from row(
    new.hypothesis_id, new.feedback_hypothesis_key, new.feedback_context_hash,
    new.selected_lesson_ids, new.avoided_lesson_ids, new.api_metric_snapshot_ids,
    new.studio_metric_ids, new.changed_variable, new.experiment_constants,
    new.prompt_framework_id, new.prompt_framework_version, new.why_this_idea,
    new.idea_pattern, new.feedback_batch_key, new.feedback_candidate_index
  ) then
    raise exception 'feedback_provenance_immutable';
  end if;
  return new;
end;
$$;

create trigger trg_video_ideas_feedback_provenance
  before insert or update on public.video_ideas
  for each row execute function public.guard_video_idea_feedback_provenance();

create or replace function public.guard_hypothesis_feedback_identity()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if old.hypothesis_key is not null and row(
    old.hypothesis_key, old.constants, old.feedback_context
  ) is distinct from row(
    new.hypothesis_key, new.constants, new.feedback_context
  ) then
    raise exception 'feedback_hypothesis_identity_immutable';
  end if;
  return new;
end;
$$;

create trigger trg_content_hypotheses_feedback_identity
  before update on public.content_hypotheses
  for each row execute function public.guard_hypothesis_feedback_identity();

create or replace function public.persist_tiktok_feedback_batch(
  p_user_id uuid,
  p_batch_key text,
  p_context_hash text,
  p_hypothesis_key text,
  p_hypothesis_statement text,
  p_changed_variable text,
  p_expected_effect text,
  p_rationale text,
  p_hypothesis_evidence jsonb,
  p_constants jsonb,
  p_feedback_context jsonb,
  p_selected_lesson_ids uuid[],
  p_avoided_lesson_ids uuid[],
  p_api_metric_snapshot_ids uuid[],
  p_studio_metric_ids uuid[],
  p_prompt_framework_id uuid,
  p_prompt_framework_version text,
  p_candidates jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hypothesis public.content_hypotheses;
  v_candidate_count integer;
  v_lesson_count integer;
  v_existing jsonb;
  v_requested jsonb;
  v_inserted jsonb;
begin
  if p_batch_key !~ '^[0-9a-f]{64}$'
      or p_context_hash !~ '^[0-9a-f]{64}$'
      or p_hypothesis_key !~ '^[0-9a-f]{64}$'
      or p_changed_variable not in (
        'topic', 'content_format', 'hook_type', 'character_id', 'visual_style_id',
        'pacing_profile', 'punch_type', 'loop_type', 'camera_profile',
        'prompt_framework_version'
      )
      or jsonb_typeof(p_constants) <> 'object'
      or jsonb_typeof(p_feedback_context) <> 'object'
      or jsonb_typeof(p_hypothesis_evidence) <> 'array'
      or jsonb_typeof(p_candidates) <> 'array' then
    raise exception 'invalid_feedback_batch';
  end if;
  v_candidate_count := jsonb_array_length(p_candidates);
  if v_candidate_count < 1 or v_candidate_count > 5 then
    raise exception 'invalid_feedback_candidate_count';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || p_batch_key, 0));
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || p_hypothesis_key, 0));

  select jsonb_agg(jsonb_build_object(
    'slug', i.slug, 'animal', i.animal, 'hook', i.hook, 'line', i.line,
    'prompt', i.prompt, 'why_this_idea', i.why_this_idea,
    'idea_pattern', i.idea_pattern
  ) order by i.feedback_candidate_index)
    into v_existing
    from public.video_ideas i
   where i.user_id = p_user_id and i.feedback_batch_key = p_batch_key;
  select jsonb_agg(jsonb_build_object(
    'slug', c.value->>'slug', 'animal', c.value->>'animal',
    'hook', c.value->>'hook', 'line', c.value->>'line',
    'prompt', c.value->>'prompt', 'why_this_idea', c.value->>'why_this_idea',
    'idea_pattern', c.value->>'idea_pattern'
  ) order by c.ordinality)
    into v_requested
    from jsonb_array_elements(p_candidates) with ordinality as c(value, ordinality);
  if v_existing is not null then
    select jsonb_build_object(
      'batch_key', i.feedback_batch_key,
      'context_hash', i.feedback_context_hash,
      'hypothesis_key', i.feedback_hypothesis_key,
      'hypothesis_statement', h.statement,
      'changed_variable', i.changed_variable,
      'expected_effect', h.expected_effect,
      'rationale', h.rationale,
      'hypothesis_evidence', h.evidence,
      'constants', i.experiment_constants,
      'feedback_context', h.feedback_context,
      'selected_lesson_ids', to_jsonb(i.selected_lesson_ids),
      'avoided_lesson_ids', to_jsonb(i.avoided_lesson_ids),
      'api_metric_snapshot_ids', to_jsonb(i.api_metric_snapshot_ids),
      'studio_metric_ids', to_jsonb(i.studio_metric_ids),
      'prompt_framework_id', to_jsonb(i.prompt_framework_id),
      'prompt_framework_version', i.prompt_framework_version,
      'candidates', v_existing
    ) into v_existing
      from public.video_ideas i
      join public.content_hypotheses h
        on h.id = i.hypothesis_id and h.user_id = i.user_id
     where i.user_id = p_user_id and i.feedback_batch_key = p_batch_key
     order by i.feedback_candidate_index
     limit 1;
    v_requested := jsonb_build_object(
      'batch_key', p_batch_key,
      'context_hash', p_context_hash,
      'hypothesis_key', p_hypothesis_key,
      'hypothesis_statement', p_hypothesis_statement,
      'changed_variable', p_changed_variable,
      'expected_effect', p_expected_effect,
      'rationale', p_rationale,
      'hypothesis_evidence', p_hypothesis_evidence,
      'constants', p_constants,
      'feedback_context', p_feedback_context,
      'selected_lesson_ids', to_jsonb(p_selected_lesson_ids),
      'avoided_lesson_ids', to_jsonb(p_avoided_lesson_ids),
      'api_metric_snapshot_ids', to_jsonb(p_api_metric_snapshot_ids),
      'studio_metric_ids', to_jsonb(p_studio_metric_ids),
      'prompt_framework_id', to_jsonb(p_prompt_framework_id),
      'prompt_framework_version', p_prompt_framework_version,
      'candidates', v_requested
    );
    if v_existing <> v_requested then raise exception 'feedback_batch_conflict'; end if;
    select jsonb_agg(to_jsonb(i) order by i.feedback_candidate_index)
      into v_inserted from public.video_ideas i
     where i.user_id = p_user_id and i.feedback_batch_key = p_batch_key;
    return v_inserted;
  end if;

  select count(*) into v_lesson_count
    from (
      select l.id from public.content_lessons l
       where l.user_id = p_user_id
         and l.id = any(coalesce(p_selected_lesson_ids, '{}'::uuid[]) ||
                        coalesce(p_avoided_lesson_ids, '{}'::uuid[]))
       for key share
    ) locked_lessons;
  if v_lesson_count <> cardinality(array(
      select distinct value from unnest(
        coalesce(p_selected_lesson_ids, '{}'::uuid[]) ||
        coalesce(p_avoided_lesson_ids, '{}'::uuid[])
      ) as u(value)
    )) then
    raise exception 'feedback_lesson_owner_conflict';
  end if;
  if exists (
    select 1 from public.content_lessons l
     where l.id = any(coalesce(p_selected_lesson_ids, '{}'::uuid[]))
       and l.user_id = p_user_id
       and not (l.category in ('CONFIRMED_LESSON', 'WINNING_PATTERN')
                and l.status in ('SUPPORTED', 'CONFIRMED'))
  ) or exists (
    select 1 from public.content_lessons l
     where l.id = any(coalesce(p_avoided_lesson_ids, '{}'::uuid[]))
       and l.user_id = p_user_id
       and not (l.category = 'FAILED_PATTERN' and l.status = 'REJECTED')
  ) then
    raise exception 'feedback_lesson_class_conflict';
  end if;
  perform 1 from public.prompt_framework_versions f
   where f.id = p_prompt_framework_id and f.user_id = p_user_id
     and f.is_current and f.status in ('STANDARD', 'SUPPORTED')
   for key share;
  if not found then raise exception 'feedback_framework_owner_conflict'; end if;

  insert into public.content_hypotheses (
    user_id, statement, changed_variable, expected_effect, rationale, evidence,
    status, confidence, constants, feedback_context, hypothesis_key
  ) values (
    p_user_id, p_hypothesis_statement, p_changed_variable, p_expected_effect,
    p_rationale, p_hypothesis_evidence, 'HYPOTHESIS', 'LOW', p_constants,
    p_feedback_context, p_hypothesis_key
  ) on conflict (user_id, hypothesis_key) where hypothesis_key is not null do nothing;
  select * into v_hypothesis from public.content_hypotheses h
   where h.user_id = p_user_id and h.hypothesis_key = p_hypothesis_key
   for update;
  if v_hypothesis.statement <> p_hypothesis_statement
      or v_hypothesis.changed_variable <> p_changed_variable
      or v_hypothesis.expected_effect <> p_expected_effect
      or v_hypothesis.rationale <> p_rationale
      or v_hypothesis.evidence <> p_hypothesis_evidence
      or v_hypothesis.constants <> p_constants
      or v_hypothesis.feedback_context <> p_feedback_context then
    raise exception 'feedback_hypothesis_conflict';
  end if;

  if (select count(distinct value->>'idea_pattern') from jsonb_array_elements(p_candidates))
      <> v_candidate_count then
    raise exception 'feedback_candidate_duplicate';
  end if;
  if exists (
    select 1 from (
      select coalesce(i.changed_variable, 'UNKNOWN') as changed_variable,
        coalesce(i.idea_pattern,
          lower(regexp_replace(btrim(i.animal), '\s+', ' ', 'g')) || '|' ||
          lower(regexp_replace(btrim(i.hook), '\s+', ' ', 'g'))) as idea_pattern
        from public.video_ideas i
       where i.user_id = p_user_id and i.target_platform = 'tiktok'
          and (i.decided_at is not null or i.feedback_batch_key is not null)
          and i.animal is not null and i.hook is not null
       order by coalesce(i.decided_at, i.created_at) desc, i.id
       limit 20
    ) recent
    join jsonb_array_elements(p_candidates) c
      on recent.changed_variable in (p_changed_variable, 'UNKNOWN')
     and recent.idea_pattern = c->>'idea_pattern'
  ) then
    raise exception 'feedback_candidate_recent_duplicate';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_candidates) c
     where coalesce(btrim(c->>'slug'), '') = ''
        or coalesce(btrim(c->>'hook'), '') = ''
        or coalesce(btrim(c->>'line'), '') = ''
        or coalesce(btrim(c->>'prompt'), '') = ''
        or coalesce(btrim(c->>'why_this_idea'), '') = ''
        or coalesce(btrim(c->>'idea_pattern'), '') = ''
  ) then
    raise exception 'invalid_feedback_candidate';
  end if;

  insert into public.video_ideas (
    user_id, slug, animal, hook, line, prompt, target_platform,
    hypothesis_id, feedback_hypothesis_key, feedback_context_hash,
    selected_lesson_ids, avoided_lesson_ids, api_metric_snapshot_ids,
    studio_metric_ids, changed_variable, experiment_constants,
    prompt_framework_id, prompt_framework_version, why_this_idea,
    idea_pattern, feedback_batch_key, feedback_candidate_index
  )
  select p_user_id, c.value->>'slug', c.value->>'animal', c.value->>'hook',
    c.value->>'line', c.value->>'prompt', 'tiktok', v_hypothesis.id,
    p_hypothesis_key, p_context_hash, p_selected_lesson_ids,
    p_avoided_lesson_ids, p_api_metric_snapshot_ids, p_studio_metric_ids,
    p_changed_variable, p_constants, p_prompt_framework_id,
    p_prompt_framework_version, c.value->>'why_this_idea',
    c.value->>'idea_pattern', p_batch_key, c.ordinality::smallint
  from jsonb_array_elements(p_candidates) with ordinality as c(value, ordinality);

  select jsonb_agg(to_jsonb(i) order by i.feedback_candidate_index)
    into v_inserted from public.video_ideas i
   where i.user_id = p_user_id and i.feedback_batch_key = p_batch_key;
  return v_inserted;
end;
$$;

revoke execute on function public.persist_tiktok_feedback_batch(
  uuid, text, text, text, text, text, text, text, jsonb, jsonb, jsonb,
  uuid[], uuid[], uuid[], uuid[], uuid, text, jsonb
) from public, anon, authenticated;
grant execute on function public.persist_tiktok_feedback_batch(
  uuid, text, text, text, text, text, text, text, jsonb, jsonb, jsonb,
  uuid[], uuid[], uuid[], uuid[], uuid, text, jsonb
) to service_role;

create or replace function public.persist_tiktok_prompt_provenance(
  p_mode text,
  p_video_idea_id uuid,
  p_claude_task_id uuid,
  p_prompt text,
  p_prompt_hash text
)
returns public.video_prompt_records
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task public.claude_tasks;
  v_idea public.video_ideas;
  v_existing public.video_prompt_records;
  v_record public.video_prompt_records;
  v_actual_hash text;
begin
  if p_mode not in ('CLAUDE_TASK', 'OWNER_SELECTED_EXISTING')
      or p_prompt_hash !~ '^[0-9a-f]{64}$'
      or p_prompt is null or btrim(p_prompt) = ''
      or octet_length(p_prompt) > 65536 then
    raise exception 'invalid_prompt_provenance';
  end if;
  v_actual_hash := encode(extensions.digest(convert_to(p_prompt, 'UTF8'), 'sha256'), 'hex');
  if v_actual_hash <> p_prompt_hash then raise exception 'prompt_hash_mismatch'; end if;

  if p_mode = 'CLAUDE_TASK' then
    if p_claude_task_id is null then raise exception 'prompt_task_required'; end if;
    select * into v_task from public.claude_tasks t
     where t.id = p_claude_task_id for update;
    if not found or v_task.idea_id is null or v_task.idea_id <> p_video_idea_id
        or v_task.prompt_task_kind <> 'SELECTED_PROMPT' then
      raise exception 'prompt_task_chain_invalid';
    end if;
    select * into v_idea from public.video_ideas i
     where i.id = v_task.idea_id and i.user_id = v_task.user_id for update;
    select * into v_existing from public.video_prompt_records r
     where r.user_id = v_task.user_id and r.claude_task_id = v_task.id for update;
  else
    if p_claude_task_id is not null then raise exception 'prompt_task_forbidden'; end if;
    select * into v_idea from public.video_ideas i
     where i.id = p_video_idea_id for update;
    select * into v_existing from public.video_prompt_records r
     where r.user_id = v_idea.user_id and r.video_idea_id = v_idea.id
       and r.claude_task_id is null and r.prompt_origin = 'OWNER_SELECTED_EXISTING'
     for update;
  end if;
  if v_idea.id is null or v_idea.target_platform <> 'tiktok'
      or v_idea.decided_at is null or v_idea.route not in ('self', 'paid')
      or v_idea.status not in ('approved', 'generating', 'done') then
    raise exception 'prompt_owner_approval_required';
  end if;
  if p_mode = 'OWNER_SELECTED_EXISTING' and (
      v_idea.route <> 'paid' or v_idea.prompt is distinct from p_prompt
  ) then
    raise exception 'owner_selected_prompt_conflict';
  end if;
  if v_existing.id is not null then
    if v_existing.prompt_hash <> p_prompt_hash then
      raise exception 'prompt_provenance_conflict';
    end if;
    return v_existing;
  end if;

  if p_mode = 'CLAUDE_TASK' then
    update public.video_ideas set
      prompt = p_prompt,
      generated_prompt_at = now()
    where id = v_idea.id and user_id = v_idea.user_id;
  end if;
  insert into public.video_prompt_records (
    user_id, video_id, video_idea_id, claude_task_id, prompt_hash,
    prompt_origin, prompt_version, prompt_structure, prompt_patterns,
    experiment_variable, technical_valid, hypothesis_id,
    selected_lesson_ids, avoided_lesson_ids, feedback_context_hash,
    prompt_framework_id, experiment_constants
  ) values (
    v_idea.user_id, null, v_idea.id,
    case when p_mode = 'CLAUDE_TASK' then v_task.id else null end,
    p_prompt_hash, p_mode, coalesce(v_idea.prompt_framework_version, 'UNVERSIONED'),
    jsonb_build_object('source', 'video_ideas.prompt', 'prompt_sha256', p_prompt_hash),
    '[]'::jsonb, v_idea.changed_variable, null, v_idea.hypothesis_id,
    coalesce(v_idea.selected_lesson_ids, '{}'::uuid[]),
    coalesce(v_idea.avoided_lesson_ids, '{}'::uuid[]),
    v_idea.feedback_context_hash, v_idea.prompt_framework_id,
    coalesce(v_idea.experiment_constants, '{}'::jsonb)
  ) returning * into v_record;
  return v_record;
end;
$$;

revoke execute on function public.persist_tiktok_prompt_provenance(
  text, uuid, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.persist_tiktok_prompt_provenance(
  text, uuid, uuid, text, text
) to service_role;

comment on function public.persist_tiktok_feedback_batch is
  'POST-04 service-only atomic extension of existing TikTok memory and video_ideas.';
comment on function public.persist_tiktok_prompt_provenance is
  'POST-04 service-only prompt provenance guard; never approves, generates or publishes.';
