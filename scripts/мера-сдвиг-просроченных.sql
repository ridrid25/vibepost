-- Мера против залпа просроченных постов. Готова сменой 85 (04.10.2026 19:05 МСК),
-- переписана на универсальный шаг сменой 91 (05.10.2026 02:05 МСК).
-- НЕ ПРИМЕНЯТЬ без прямого слова заказчицы: это сдвиг её расписания.

-- ==========================================================
-- ИЗМЕРЕНО СМЕНОЙ 101 (05.10.2026 17:06 МСК): ПОСЛЕ ОПЛАТЫ МЕРЫ НЕТ.
-- Окно между снятием 402 и залпом — не больше 60 секунд. Это замер, а не оценка:
--   * cron.job $$vibepost-scheduler$$ = $$* * * * *$$, и 20 прогонов подряд
--     16:51-17:10 МСК шли с шагом РОВНО 60 с, без единого пропуска;
--   * claim_due_posts прочитана дословно: where status=$$scheduled$$ and
--     scheduled_at <= now() — отсечки по давности НЕТ, а limit 25 > 7, поэтому
--     все просроченные попадают в ОДИН первый прогон, не по одному за минуту;
--   * process-scheduler/index.ts: PER_CHAT_LIMIT=19 (7 < 19, никого не
--     откладывает), SEND_INTERVAL_MS=80 → семь роликов уходят за ~560 мс;
--   * все 12 слотов в одном chat_id (проверено) — значит в одну ленту.
-- Дежурный ходит раз в час, а окно — 60 секунд. Значит «увидим снятие
-- блокировки и успеем применить» неправда, и держать меру наготове, ожидая
-- оплаты, нельзя. Защита существует ТОЛЬКО как применение ЗАРАНЕЕ, до оплаты.
--
-- ВАРИАНТ Б — предохранитель, который её расписание НЕ трогает вовсе.
-- ВНИМАНИЕ: строка, записанная здесь сменой 101, НЕРАБОТОСПОСОБНА. Прямой
--   update cron.job set active = false where jobname = $$vibepost-scheduler$$;
-- отбивается с ERROR 42501 permission denied for table job — даже под postgres,
-- который этим джобом и владеет (cron.job.username = postgres). pg_cron не даёт
-- UPDATE на свою таблицу никому, правка идёт только через функцию. Это прогон,
-- а не чтение: проверено сменой 102 (05.10.2026 18:12 МСК).
--
-- РАБОЧАЯ СТРОКА — ВЫКЛЮЧИТЬ:
--   select cron.alter_job((select jobid from cron.job
--                          where jobname = $$vibepost-scheduler$$), active := false);
-- ОБРАТНО — ВКЛЮЧИТЬ:
--   select cron.alter_job((select jobid from cron.job
--                          where jobname = $$vibepost-scheduler$$), active := true);
--
-- Обе строки прогнаны сменой 102 внутри begin...rollback и РАЗЛИЧАЮТ, а не
-- молчат впустую: после alter_job(active := false) внутри транзакции
-- cron.job.active читается false, schedule остаётся $$* * * * *$$, command цел;
-- после alter_job(active := true) в той же транзакции снова true — то есть путь
-- назад тоже измерен, а не обещан. После отката в базе 22 из 22 джоба активны
-- и планировщик тикает (20 прогонов за 20 минут, последний 18:10:00) — база не
-- изменена, вариант Б НЕ применён.
--
-- Чем Б лучше сдвига: слот 09:30 остаётся на своём дне, решение обратимо одной
-- строкой (той, что выше, а не той, что была записана), и срочность исчезает —
-- сдвиг можно сделать спокойно уже после оплаты.
-- Чем хуже: пока джоб выключен, не уедут и БУДУЩИЕ посты, поэтому включать
-- обратно нужно в ту же смену, в которой применён сдвиг.
--
-- ХВАТАЕТ ЛИ ОДНОГО ДЖОБА — проверено сменой 102 сплошным обходом всех 22
-- активных крон-джобов, а не предположено. К таблице posts прикасаются ровно
-- четыре, и ни один из трёх остальных не отправляет:
--   assign_queue_to_slots (*/5)   — двигает только status=$$queued$$ → scheduled,
--       отправки в теле нет вовсе; queued сейчас 0 (12 scheduled, 211 sent,
--       3 failed — других статусов в posts нет);
--   enqueue_due_recurring (* * * * *) — вставляет посты из recurring_posts;
--       активных recurring_posts 0, то есть вставлять нечего;
--   recover_stuck_posts (*/5)     — трогает только status=$$processing$$, а при
--       выключенном планировщике в processing ничего не попадает (сейчас 0);
--   worker_watchdog (*/10)        — sendMessage ей про незакрытые claude_tasks,
--       к постам не относится (открытых заданий 0).
-- Итог: у залпа ровно один путь — process-scheduler, и вариант Б режет именно
-- его. Расписаний $$* * * * *$$ в кроне четыре, но опасен из них один.
--
-- СТОРОЖ ВАРИАНТА Б (урок смены 100: охранять НОВОЕ, а не прошлый дефект).
-- Новое здесь одно — выключая джоб, можно отменить полезную отправку.
-- Что сегодня отменять нечего, прогнано 05.10.2026 17:12 МСК:
--   count(*) posts where sent_at > now() - interval $$24 hours$$   → 0
--   max(sent_at) posts where status=$$sent$$                  → 28.09 09:30
--   count(*) posts where status=$$processing$$                → 0
--   active_chain_steps по статусам                        → только sent, 4
--   count(*) recurring_posts where is_active              → 0
--   net._http_response по status_code  → ровно одна группа: 402, 942 ответа
--                                        за окно 11:13-17:12 МСК
-- Все шесть обязательны ПЕРЕД выключением. Проверка РАЗЛИЧАЕТ, а не зелена
-- всегда: после оплаты планировщик снова отправляет, и любая непустая строка
-- означает «выключать нельзя, он работает».
-- ==========================================================
--
-- Зачем: в claim_due_posts нет отсечки по давности, в process-scheduler
-- SEND_INTERVAL_MS=80 и PER_CHAT_LIMIT=19. В момент снятия блокировки 402 все
-- просроченные посты уйдут в один канал меньше чем за секунду. Под 402 не
-- уедет ничего, поэтому мера нужна ДО оплаты, а не после.
--
-- Запуск: через управляющий API, POST /v1/projects/<ref>/database/query,
-- по одному шагу. REST мёртв под 402, задания.mjs и scripts через него не пройдут.
--
-- ВАЖНО, находка смены 89 и ответ на неё (смена 91): прежний шаг «+12 дней»
-- имел срок годности. Он был посчитан под 04.10, и с 11.10 ломался: самый старый
-- просроченный (29.09 06:30 UTC) плюс 12 дней = 11.10 06:30 UTC, то есть первый же
-- сдвинутый пост снова оказывался в прошлом (11.10 → 1 просроченный, 12.10 → 2,
-- 15.10 → 5). Шаг 3 ниже от даты запуска не зависит вовсе — он считает сдвиг для
-- каждого поста сам, от последнего занятого слота. Пересчитывать его не нужно
-- ни 11.10, ни позже.

-- ШАГ 0. Снимок расписания перед сдвигом — это и есть откат.
-- Делать ОБЯЗАТЕЛЬНО: шаг 3 сдвигает каждый пост на своё число дней, и плоского
-- «минус столько же» для него не существует.
create table if not exists posts_slots_backup_91 as
select id, scheduled_at from posts where status = $$scheduled$$;
select count(*) saved from posts_slots_backup_91;

-- ШАГ 1. Что сдвинется (только чтение). На 05.10 02:05 МСК — 6 строк, claimed пусто.
with ov as (
  select id, scheduled_at, row_number() over (order by scheduled_at) rn
  from posts where status = $$scheduled$$ and scheduled_at < now()
), a as (
  select greatest(max(scheduled_at), now()) m from posts where status = $$scheduled$$
)
-- ПОЧИНЕНО сменой 98 (05.10.2026 09:05 МСК). Скобки вокруг суммы обязательны:
-- `at time zone` сильнее плюса, без скобок он привязывался к интервалу, и шаг
-- падал целиком с 42883 "function pg_catalog.timezone(unknown, interval) does
-- not exist". Проверено прямо из файла: до починки — ошибка, после — 6 строк,
-- и они совпадают с тем, что делает ШАГ 3.
select ov.id,
       to_char(ov.scheduled_at at time zone $$Europe/Moscow$$, $$MM-DD HH24:MI$$) old_slot,
       to_char((ov.scheduled_at
         + ((ceil(extract(epoch from (a.m - ov.scheduled_at)) / 86400.0)::int + ov.rn) || $$ days$$)::interval)
         at time zone $$Europe/Moscow$$, $$MM-DD HH24:MI$$) new_slot
from ov, a order by ov.scheduled_at;

-- ШАГ 2. Наложения (только чтение). Применять ТОЛЬКО если вернулось ноль строк.
-- Шаг 3 кладёт посты строго ПОСЛЕ последнего занятого слота, по одному в день,
-- поэтому наложений быть не должно по построению — проверка страховочная.
with ov as (
  select id, scheduled_at, row_number() over (order by scheduled_at) rn
  from posts where status = $$scheduled$$ and scheduled_at < now()
), a as (
  select greatest(max(scheduled_at), now()) m from posts where status = $$scheduled$$
), nw as (
  select ov.id, ov.scheduled_at
    + ((ceil(extract(epoch from (a.m - ov.scheduled_at)) / 86400.0)::int + ov.rn) || $$ days$$)::interval new_at
  from ov, a
)
select nw.id, nw.new_at, p.id collided_with
from nw join posts p on p.scheduled_at = nw.new_at and p.status = $$scheduled$$ and p.id <> nw.id;

-- ШАГ 3. Сдвиг. Срока годности нет: сдвиг для каждого поста считается от
-- последнего занятого слота (или от now(), если будущих постов не осталось),
-- целым числом суток — время суток 09:30 МСК сохраняется точно.
with ov as (
  select id, scheduled_at, row_number() over (order by scheduled_at) rn
  from posts where status = $$scheduled$$ and scheduled_at < now()
), a as (
  select greatest(max(scheduled_at), now()) m from posts where status = $$scheduled$$
)
update posts p
set scheduled_at = p.scheduled_at
  + ((ceil(extract(epoch from (a.m - p.scheduled_at)) / 86400.0)::int + ov.rn) || $$ days$$)::interval
from ov, a
where p.id = ov.id
returning p.id, to_char(p.scheduled_at at time zone $$Europe/Moscow$$, $$MM-DD HH24:MI$$) new_slot;

-- ШАГ 4. Проверка: просроченных должно остаться ноль, всего столько же, по одному в день.
select count(*) total, count(*) filter (where scheduled_at < now()) overdue
from posts where status = $$scheduled$$;
select to_char(scheduled_at at time zone $$Europe/Moscow$$, $$MM-DD HH24:MI$$) slot
from posts where status = $$scheduled$$ order by scheduled_at;

-- ОТКАТ. Возвращает ровно те значения, что были до шага 3, из снимка шага 0.
update posts p set scheduled_at = b.scheduled_at
from posts_slots_backup_91 b
where p.id = b.id and p.scheduled_at <> b.scheduled_at
returning p.id, to_char(p.scheduled_at at time zone $$Europe/Moscow$$, $$MM-DD HH24:MI$$) back_to;
-- После удачного отката снимок можно убрать:
-- drop table posts_slots_backup_91;

-- ПРОВЕРЕНО смены 91 (05.10 02:05 МСК) на живых данных, целиком внутри
-- begin ... rollback, то есть виден результат, а не прогноз:
--   запуск сегодня          → 12 постов цепочкой 05.10-16.10, просроченных 0
--   запуск 15.10 (симуляция, все 12 просрочены) → цепочка 17.10-28.10, просроченных 0
-- После откатов в базе без изменений: всего 12, просроченных 6.

-- Расписание на 05.10 02:05 МСК (ШАГ 1 должен вернуть первые шесть):
--   ПРОСРОЧЕНЫ
--   1037e5f1-3671-4697-9c1e-745d8f4d8d5f  2026-09-29 06:30:00+00
--   b2cab296-837e-4afc-af60-3197f5269ba0  2026-09-30 06:30:00+00
--   acbb902c-5151-4344-9b20-cbb06d23c019  2026-10-01 06:30:00+00
--   e0b6603f-2f3d-4583-91f0-98fa0de49e6e  2026-10-02 06:30:00+00
--   391039b4-9bce-4e70-b4c5-ee6874a3d3c9  2026-10-03 06:30:00+00
--   f0145ee7-617b-4cff-b9b7-a856e7faa496  2026-10-04 06:30:00+00
--   БУДУЩИЕ
--   69e9c0de-1ba9-46a1-8e7f-8ffa3c7585ba  2026-10-05 06:30:00+00
--   f8c4d84d-ae03-4bd0-8feb-0097b3b55101  2026-10-06 06:30:00+00
--   65288317-6ddd-4ec2-b8fc-a55e1386fe9b  2026-10-07 06:30:00+00
--   4debe155-7101-4545-a582-306ab5247e41  2026-10-08 06:30:00+00
--   1293eb17-d5f8-4c8d-83bc-f414a49a1c17  2026-10-09 06:30:00+00
--   585cf49b-7f7a-442b-b32f-9c439a2a9422  2026-10-10 06:30:00+00
-- Каждый день без оплаты список просроченных растёт на одну строку (слот 09:30 МСК),
-- и шаг 3 подхватывает новую сам — список id ему не нужен.
