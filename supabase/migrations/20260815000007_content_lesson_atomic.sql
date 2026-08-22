-- Atomically write a Lesson and its tenant-safe video evidence links.
create or replace function public.insert_content_lesson(
  p_user_id uuid,
  p_lesson text,
  p_category text,
  p_evidence jsonb,
  p_videos_used uuid[],
  p_sample_size jsonb,
  p_confidence text,
  p_status text,
  p_applicable_topics text[]
)
returns public.content_lessons
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lesson public.content_lessons;
  v_video_count integer;
  v_distinct_videos uuid[];
begin
  select coalesce(array_agg(distinct video_id), '{}'::uuid[])
    into v_distinct_videos
    from unnest(coalesce(p_videos_used, '{}'::uuid[])) as u(video_id);

  select count(*) into v_video_count
    from public.videos v
   where v.user_id = p_user_id
     and v.id = any(v_distinct_videos);
  if v_video_count <> cardinality(v_distinct_videos) then
    raise exception 'Lesson references a video outside its tenant';
  end if;

  insert into public.content_lessons (
    user_id, lesson, category, evidence, videos_used, sample_size,
    confidence, status, applicable_topics
  ) values (
    p_user_id, p_lesson, p_category, p_evidence, v_distinct_videos,
    p_sample_size, p_confidence, p_status, p_applicable_topics
  ) returning * into v_lesson;

  insert into public.content_lesson_videos (lesson_id, video_id, user_id)
  select v_lesson.id, video_id, p_user_id
    from unnest(v_distinct_videos) as u(video_id);

  return v_lesson;
end;
$$;

revoke execute on function public.insert_content_lesson(
  uuid, text, text, jsonb, uuid[], jsonb, text, text, text[]
) from public, anon, authenticated;
grant execute on function public.insert_content_lesson(
  uuid, text, text, jsonb, uuid[], jsonb, text, text, text[]
) to service_role;

-- Create the experiment and link/annotate its variant in the same transaction.
create or replace function public.create_content_experiment(
  p_user_id uuid,
  p_hypothesis text,
  p_changed_variable text,
  p_constants jsonb,
  p_success_metrics jsonb,
  p_control_video_id uuid,
  p_variant_video_id uuid,
  p_hypothesis_id uuid,
  p_status text,
  p_control_parameters jsonb,
  p_variant_parameters jsonb
)
returns public.experiments
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_experiment public.experiments;
begin
  if p_control_video_id = p_variant_video_id or not exists (
    select 1 from public.videos v
     where v.user_id = p_user_id and v.id = p_control_video_id
  ) or not exists (
    select 1 from public.videos v
     where v.user_id = p_user_id and v.id = p_variant_video_id
  ) then
    raise exception 'Experiment videos are invalid for this tenant';
  end if;

  insert into public.experiments (
    user_id, hypothesis_id, hypothesis, changed_variable, constants,
    success_metrics, control_video_id, status
  ) values (
    p_user_id, p_hypothesis_id, p_hypothesis, p_changed_variable,
    p_constants, p_success_metrics, p_control_video_id, p_status
  ) returning * into v_experiment;

  update public.videos set
    topic = case when p_control_parameters ? 'topic' then p_control_parameters->>'topic' else topic end,
    content_format = case when p_control_parameters ? 'content_format' then p_control_parameters->>'content_format' else content_format end,
    hook_type = case when p_control_parameters ? 'hook_type' then p_control_parameters->>'hook_type' else hook_type end,
    character_id = case when p_control_parameters ? 'character_id' then p_control_parameters->>'character_id' else character_id end,
    visual_style_id = case when p_control_parameters ? 'visual_style_id' then p_control_parameters->>'visual_style_id' else visual_style_id end,
    pacing_profile = case when p_control_parameters ? 'pacing_profile' then p_control_parameters->>'pacing_profile' else pacing_profile end,
    punch_type = case when p_control_parameters ? 'punch_type' then p_control_parameters->>'punch_type' else punch_type end,
    loop_type = case when p_control_parameters ? 'loop_type' then p_control_parameters->>'loop_type' else loop_type end,
    camera_profile = case when p_control_parameters ? 'camera_profile' then p_control_parameters->>'camera_profile' else camera_profile end,
    prompt_framework_version = case when p_control_parameters ? 'prompt_framework_version' then p_control_parameters->>'prompt_framework_version' else prompt_framework_version end
   where id = p_control_video_id and user_id = p_user_id;

  update public.videos set
    topic = case when p_variant_parameters ? 'topic' then p_variant_parameters->>'topic' else topic end,
    content_format = case when p_variant_parameters ? 'content_format' then p_variant_parameters->>'content_format' else content_format end,
    hook_type = case when p_variant_parameters ? 'hook_type' then p_variant_parameters->>'hook_type' else hook_type end,
    character_id = case when p_variant_parameters ? 'character_id' then p_variant_parameters->>'character_id' else character_id end,
    visual_style_id = case when p_variant_parameters ? 'visual_style_id' then p_variant_parameters->>'visual_style_id' else visual_style_id end,
    pacing_profile = case when p_variant_parameters ? 'pacing_profile' then p_variant_parameters->>'pacing_profile' else pacing_profile end,
    punch_type = case when p_variant_parameters ? 'punch_type' then p_variant_parameters->>'punch_type' else punch_type end,
    loop_type = case when p_variant_parameters ? 'loop_type' then p_variant_parameters->>'loop_type' else loop_type end,
    camera_profile = case when p_variant_parameters ? 'camera_profile' then p_variant_parameters->>'camera_profile' else camera_profile end,
    prompt_framework_version = case when p_variant_parameters ? 'prompt_framework_version' then p_variant_parameters->>'prompt_framework_version' else prompt_framework_version end,
    experiment_id = v_experiment.id,
    hypothesis_id = p_hypothesis_id
   where id = p_variant_video_id and user_id = p_user_id;

  return v_experiment;
end;
$$;

revoke execute on function public.create_content_experiment(
  uuid, text, text, jsonb, jsonb, uuid, uuid, uuid, text, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.create_content_experiment(
  uuid, text, text, jsonb, jsonb, uuid, uuid, uuid, text, jsonb, jsonb
) to service_role;
