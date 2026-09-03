-- Read/write transaction check for the production duplicate guard. The
-- attempted duplicate is caught by the trigger, so this script leaves no row.
do $guard$
declare
  v public.video_ideas%rowtype;
begin
  select * into v
    from public.video_ideas
   where target_platform = 'youtube_shorts'
   order by created_at desc
   limit 1;

  if v.id is null then
    raise exception 'no_youtube_history_for_guard_test';
  end if;

  begin
    insert into public.video_ideas(user_id, slug, animal, hook, line, prompt, target_platform)
    values(v.user_id, v.slug, v.animal, v.hook, v.line, v.prompt, 'youtube_shorts');
    raise exception 'duplicate_guard_failed';
  exception
    when unique_violation then
      if sqlerrm <> 'youtube_idea_duplicate' then
        raise;
      end if;
  end;
end
$guard$;
