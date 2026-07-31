-- Утренняя порция идей: пять карточек в бота каждый день в 9:00 МСК (6:00 UTC).
select cron.schedule(
  'vibepost-ideas',
  '0 6 * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'vibepost_project_url') || '/functions/v1/suggest-ideas',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'vibepost_service_key')),
    body := '{"count":5}'::jsonb, timeout_milliseconds := 55000);
  $$
);
