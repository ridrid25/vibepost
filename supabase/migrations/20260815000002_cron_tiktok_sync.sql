-- Refresh authorized TikTok accounts independently of Telegram scheduling.
-- The Edge Function atomically claims due accounts and is idempotent per
-- 15-minute bucket.
select cron.unschedule(jobid)
  from cron.job
 where jobname = 'vibepost-tiktok-sync';

select cron.schedule(
  'vibepost-tiktok-sync',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'vibepost_project_url') || '/functions/v1/tiktok-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'vibepost_service_key')
    ),
    body := '{"limit":5}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);

select cron.unschedule(jobid)
  from cron.job
 where jobname = 'vibepost-tiktok-raw-retention';

select cron.schedule(
  'vibepost-tiktok-raw-retention',
  '17 3 * * *',
  $$ select public.purge_expired_tiktok_raw_items(); $$
);
