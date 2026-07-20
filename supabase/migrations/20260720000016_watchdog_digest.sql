-- Контроль работоспособности постинга:
-- 1) finalize_done_chains теперь возвращает данные завершённых цепочек —
--    планировщик шлёт владельцу «✅ цепочка завершена».
-- 2) stuck_report — сколько публикаций у каждого пользователя зависло
--    (просрочено дольше N минут). Основа «сторожа».
-- 3) Две cron-задачи: watchdog раз в 10 минут, daily-digest в 21:00 МСК
--    (18:00 UTC). Секреты читаются из Vault, как у планировщика.

drop function if exists public.finalize_done_chains();

create function public.finalize_done_chains()
returns table (
  active_chain_id uuid,
  user_id uuid,
  chain_name text,
  steps_total integer,
  steps_sent integer
)
language sql
security definer
set search_path = ''
as $$
  with upd as (
    update public.active_chains ac
    set status = 'done'
    where ac.status = 'running'
      and exists (
        select 1 from public.active_chain_steps s
        where s.active_chain_id = ac.id
      )
      and not exists (
        select 1 from public.active_chain_steps s
        where s.active_chain_id = ac.id and s.status in ('scheduled', 'processing')
      )
    returning ac.id, ac.user_id, ac.chain_id
  )
  select
    u.id,
    u.user_id,
    mc.name,
    (select count(*)::integer from public.active_chain_steps s where s.active_chain_id = u.id),
    (select count(*)::integer from public.active_chain_steps s where s.active_chain_id = u.id and s.status = 'sent')
  from upd u
  join public.message_chains mc on mc.id = u.chain_id;
$$;

revoke execute on function public.finalize_done_chains() from public, anon, authenticated;
grant execute on function public.finalize_done_chains() to service_role;

create or replace function public.stuck_report(p_minutes integer default 10)
returns table (user_id uuid, stuck_count integer)
language sql
security definer
set search_path = ''
as $$
  select x.user_id, count(*)::integer
  from (
    select p.user_id
    from public.posts p
    where p.status in ('scheduled', 'processing')
      and p.scheduled_at < now() - make_interval(mins => p_minutes)
    union all
    select ac.user_id
    from public.active_chain_steps s
    join public.active_chains ac on ac.id = s.active_chain_id
    where ac.status = 'running'
      and s.status in ('scheduled', 'processing')
      and s.scheduled_at < now() - make_interval(mins => p_minutes)
  ) x
  group by x.user_id;
$$;

revoke execute on function public.stuck_report(integer) from public, anon, authenticated;
grant execute on function public.stuck_report(integer) to service_role;

-- Cron-задачи (секреты планировщика уже лежат в Vault)
do $$
begin
  if exists (select 1 from cron.job where jobname = 'vibepost-watchdog') then
    perform cron.unschedule('vibepost-watchdog');
  end if;
  if exists (select 1 from cron.job where jobname = 'vibepost-daily-digest') then
    perform cron.unschedule('vibepost-daily-digest');
  end if;

  perform cron.schedule(
    'vibepost-watchdog',
    '*/10 * * * *',
    $cron$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'vibepost_project_url') || '/functions/v1/watchdog',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'vibepost_service_key')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 30000
    );
    $cron$
  );

  perform cron.schedule(
    'vibepost-daily-digest',
    '0 18 * * *',
    $cron$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'vibepost_project_url') || '/functions/v1/daily-digest',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'vibepost_service_key')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 55000
    );
    $cron$
  );
end;
$$;
