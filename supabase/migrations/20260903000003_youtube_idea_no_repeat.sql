-- Never deliver the same YouTube idea to one owner twice. The Edge Function
-- performs a friendly pre-check; this trigger is the concurrency-safe final
-- guard immediately before persistence and Telegram delivery.

create or replace function public.reject_duplicate_youtube_idea()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_hook text;
  v_line text;
  v_slug text;
  v_prompt text;
begin
  if new.target_platform <> 'youtube_shorts' then
    return new;
  end if;

  -- Serialize YouTube idea inserts per owner so simultaneous button presses
  -- cannot both pass the history check.
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text || ':youtube-ideas', 0));

  v_hook := lower(regexp_replace(coalesce(new.hook, ''), '[^[:alnum:]]+', '', 'g'));
  v_line := lower(regexp_replace(coalesce(new.line, ''), '[^[:alnum:]]+', '', 'g'));
  v_slug := lower(trim(coalesce(new.slug, '')));
  v_prompt := lower(regexp_replace(coalesce(new.prompt, ''), '[^[:alnum:]]+', '', 'g'));

  if exists (
    select 1
      from public.video_ideas existing
     where existing.user_id = new.user_id
       and existing.target_platform = 'youtube_shorts'
       and (
         lower(trim(existing.slug)) = v_slug
         or lower(regexp_replace(coalesce(existing.hook, ''), '[^[:alnum:]]+', '', 'g')) = v_hook
         or lower(regexp_replace(coalesce(existing.line, ''), '[^[:alnum:]]+', '', 'g')) = v_line
         or lower(regexp_replace(coalesce(existing.prompt, ''), '[^[:alnum:]]+', '', 'g')) = v_prompt
       )
  ) then
    raise exception using
      errcode = '23505',
      message = 'youtube_idea_duplicate',
      detail = 'A YouTube idea with the same slug, hook, dialogue, or prompt was already delivered.';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_reject_duplicate_youtube_idea on public.video_ideas;
create trigger trg_reject_duplicate_youtube_idea
before insert on public.video_ideas
for each row execute function public.reject_duplicate_youtube_idea();
