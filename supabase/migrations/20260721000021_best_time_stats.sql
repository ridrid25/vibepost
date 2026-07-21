-- Статистика «лучшее время»: средние реакции на пост по часу и дню недели
-- (МСК), по отправленным одиночным постам текущего пользователя.
-- security invoker → RLS сама ограничивает выборку своими постами.
create or replace function public.best_time_stats()
returns table (
  weekday integer,
  hour integer,
  posts_count integer,
  total_reactions integer,
  avg_reactions numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    extract(isodow from p.sent_at at time zone 'Europe/Moscow')::int,
    extract(hour  from p.sent_at at time zone 'Europe/Moscow')::int,
    count(*)::int,
    coalesce(sum(pa.reactions_count), 0)::int,
    round(avg(coalesce(pa.reactions_count, 0)), 2)
  from public.posts p
  left join public.post_analytics pa on pa.post_id = p.id
  where p.status = 'sent' and p.sent_at is not null
  group by 1, 2;
$$;

revoke execute on function public.best_time_stats() from public, anon;
grant execute on function public.best_time_stats() to authenticated, service_role;
