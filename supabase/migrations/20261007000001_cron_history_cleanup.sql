-- Журнал запусков pg_cron никто не чистил: к 07.10.2026 в нём 425 тыс. строк
-- с 19.07 (по ~5300 в сутки), 308 МБ — половина базы при лимите Free 500 МБ.
-- Решение заказчицы 07.10: держать неделю, старше — удалять ежедневно.
delete from cron.job_run_details where end_time < now() - interval '7 days';

select cron.unschedule(jobid) from cron.job where jobname = 'vibepost-cron-history-cleanup';
select cron.schedule(
  'vibepost-cron-history-cleanup',
  '43 3 * * *',
  $$delete from cron.job_run_details where end_time < now() - interval '7 days'$$
);
