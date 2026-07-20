-- Пары «фото + опрос» уходят одним прогоном планировщика и строго
-- по порядку. Тонкость: при одинаковом scheduled_at сортировка по
-- format ставит 'photo' раньше 'poll' (алфавит работает на нас),
-- поэтому фото всегда отправляется первым, опрос — сразу следом.
create or replace function public.claim_due_posts(p_limit integer default 25)
returns setof public.posts
language sql
security definer
set search_path = ''
as $$
  with due as (
    select id from public.posts
    where status = 'scheduled' and scheduled_at <= now()
    order by scheduled_at, format, created_at
    limit p_limit
    for update skip locked
  )
  update public.posts p
  set status = 'processing'
  from due
  where p.id = due.id
  returning p.*;
$$;
