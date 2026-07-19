-- Расширения для планировщика:
-- pg_cron — запуск задач по расписанию (раз в минуту)
-- pg_net  — HTTP-вызовы из базы (дёргает Edge Function process-scheduler)
create extension if not exists pg_cron;
create extension if not exists pg_net;
