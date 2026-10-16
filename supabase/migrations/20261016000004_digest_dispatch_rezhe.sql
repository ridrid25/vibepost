-- Диспетчер дайджеста — раз в 5 минут и только днём (решение заказчицы 16.10.2026:
-- «зачем каждую минуту морочить голову… базы лопаются от бессмысленных дел»).
-- Сетка часовая (09:30…17:00 МСК), 5 минут точности хватает. 08:00–18:55 МСК
-- = 05:00–15:55 UTC: 144 запуска в сутки вместо 1440. Журнал запусков чистится
-- сам через 7 дней (vibepost-cron-history-cleanup).
select cron.unschedule(jobid) from cron.job where jobname = 'vibepost-digest-dispatch';
select cron.schedule(
  'vibepost-digest-dispatch',
  '*/5 5-15 * * *',
  $c$select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'vibepost_project_url') || '/functions/v1/digest-dispatch',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'vibepost_service_key')),
    body := '{}'::jsonb, timeout_milliseconds := 30000)$c$
);
