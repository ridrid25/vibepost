-- 19.10: решение заказчицы — рамки «новости часа» задаются в настройках VibePost:
-- send_hour = «С» (первая новость), post_hour = «До» (последняя), часы МСК.
-- Допустимо 06…23: кроны работают в этих часах, внутри news-hourly сверяет с настройками.
-- Сейчас ставим 08 и 18 — как было зашито в коде, чтобы ничего не сдвинулось.
update public.news_config set send_hour = 8, send_minute = 0, post_hour = 18, post_minute = 0 where enabled;

-- Новость часа: в :36 с 05:36 до 22:36 МСК (02…19 UTC) → публикации 06:00…23:00.
select cron.alter_job((select jobid from cron.job where jobname = 'vibepost-news-hourly'),
                      schedule := '36 2-19 * * *');
-- Диспетчер: каждые 5 минут с 06:00 до 23:55 МСК (03…20 UTC).
select cron.alter_job((select jobid from cron.job where jobname = 'vibepost-digest-dispatch'),
                      schedule := '*/5 3-20 * * *');
