begin;
set local request.jwt.claim.role = 'service_role';

do $$
declare
  v_user_id uuid;
  v_idea_id uuid := gen_random_uuid();
  v_task_id uuid := gen_random_uuid();
  v_prompt text := '{"duration_seconds":10,"aspect_ratio":"9:16","test":"rollback-only"}';
  v_hash text;
  v_saved public.video_prompt_records;
begin
  select decrypted_secret::uuid into strict v_user_id
  from vault.decrypted_secrets where name='vibepost_content_brigade_owner';
  v_hash := encode(extensions.digest(convert_to(v_prompt,'UTF8'),'sha256'),'hex');

  insert into public.video_ideas(
    id,user_id,slug,animal,hook,line,prompt,target_platform,status,route,decided_at,
    evidence_roots,market_reference_ids,why_this_idea,idea_pattern,
    idea_confidence,evidence_mode
  ) values (
    v_idea_id,v_user_id,'rollback-schema-check-'||substr(v_idea_id::text,1,8),
    'Гиена','ROLLBACK SCHEMA CHECK','Это только транзакционная проверка.',null,
    'youtube_shorts','approved','self',now(),
    jsonb_build_object('MARKET_REFERENCE',jsonb_build_array('SCHEMA_CHECK'),
      'OWN_PERFORMANCE','[]'::jsonb,
      'OWNER_PREFERENCE',jsonb_build_object('approved','[]'::jsonb,'rejected','[]'::jsonb)),
    array['SCHEMA_CHECK'],'rollback-only schema check','SCHEMA_CHECK','LOW','MARKET_REFERENCE_ONLY'
  );
  insert into public.claude_tasks(id,user_id,idea_id,text,prompt_task_kind)
  values(v_task_id,v_user_id,v_idea_id,'rollback-only schema check','SELECTED_PROMPT');

  select * into strict v_saved from public.persist_tiktok_prompt_provenance_v2(
    'CLAUDE_TASK',v_idea_id,v_task_id,v_prompt,v_hash
  );
  if v_saved.video_idea_id is distinct from v_idea_id
      or v_saved.claude_task_id is distinct from v_task_id
      or v_saved.prompt_hash is distinct from v_hash
      or v_saved.creative_id !~ '^creative-[0-9a-f]{64}$' then
    raise exception 'youtube_prompt_roundtrip_failed';
  end if;
end $$;

select 'YOUTUBE_PROMPT_ROUNDTRIP_OK_ROLLED_BACK' as result;
rollback;
