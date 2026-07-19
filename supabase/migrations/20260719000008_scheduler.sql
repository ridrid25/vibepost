-- Планировщик, часть SQL:
-- 1) claim_due_posts — атомарный захват постов к отправке (FOR UPDATE SKIP LOCKED),
--    исключает двойную отправку даже при параллельных запусках.
-- 2) setup_scheduler — кладёт URL проекта и service-ключ в Vault и регистрирует
--    cron-задачу раз в минуту. Ключ в тексте cron-задачи НЕ хранится —
--    читается из Vault в момент запуска.

create or replace function public.claim_due_posts(p_limit integer default 25)
returns setof public.posts
language sql
security definer
set search_path = ''
as $$
  with due as (
    select id from public.posts
    where status = 'scheduled' and scheduled_at <= now()
    order by scheduled_at
    limit p_limit
    for update skip locked
  )
  update public.posts p
  set status = 'processing'
  from due
  where p.id = due.id
  returning p.*;
$$;

revoke execute on function public.claim_due_posts(integer) from public, anon, authenticated;
grant execute on function public.claim_due_posts(integer) to service_role;

create or replace function public.setup_scheduler(p_project_url text, p_service_key text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
begin
  select id into v_secret_id from vault.secrets where name = 'vibepost_project_url';
  if v_secret_id is null then
    perform vault.create_secret(p_project_url, 'vibepost_project_url', 'VibePost: URL проекта для планировщика');
  else
    perform vault.update_secret(v_secret_id, p_project_url);
  end if;

  select id into v_secret_id from vault.secrets where name = 'vibepost_service_key';
  if v_secret_id is null then
    perform vault.create_secret(p_service_key, 'vibepost_service_key', 'VibePost: service_role ключ для планировщика');
  else
    perform vault.update_secret(v_secret_id, p_service_key);
  end if;

  if exists (select 1 from cron.job where jobname = 'vibepost-scheduler') then
    perform cron.unschedule('vibepost-scheduler');
  end if;

  perform cron.schedule(
    'vibepost-scheduler',
    '* * * * *',
    $cron$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'vibepost_project_url') || '/functions/v1/process-scheduler',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'vibepost_service_key')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 55000
    );
    $cron$
  );

  return 'scheduler configured';
end;
$$;

revoke execute on function public.setup_scheduler(text, text) from public, anon, authenticated;
grant execute on function public.setup_scheduler(text, text) to service_role;
