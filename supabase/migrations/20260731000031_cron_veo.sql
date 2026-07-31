-- Раз в минуту забираем готовые генерации. Ждать дольше нельзя: Google держит
-- результат недолго, а терять оплаченный ролик недопустимо.
select cron.schedule(
  'vibepost-veo',
  '* * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'vibepost_project_url') || '/functions/v1/veo-poll',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'vibepost_service_key')),
    body := '{}'::jsonb, timeout_milliseconds := 55000);
  $$
);
