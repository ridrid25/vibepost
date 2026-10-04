-- Мера против залпа просроченных постов. Готова сменой 85 (04.10.2026 19:05 МСК).
-- НЕ ПРИМЕНЯТЬ без прямого слова заказчицы: это сдвиг её расписания.
--
-- Зачем: в claim_due_posts нет отсечки по давности, в process-scheduler
-- SEND_INTERVAL_MS=80 и PER_CHAT_LIMIT=19. В момент снятия блокировки 402 все
-- просроченные посты уйдут в один канал меньше чем за секунду. Под 402 не
-- уедет ничего, поэтому мера нужна ДО оплаты, а не после.
--
-- Запуск: через управляющий API, POST /v1/projects/<ref>/database/query,
-- по одному шагу. REST мёртв под 402, задания.mjs и scripts через него не пройдут.

-- ШАГ 1. Что сдвинется (только чтение). Ожидание на 04.10: 6 строк, claimed пусто.
select id, scheduled_at, scheduled_at + interval $$12 days$$ as new_at, claimed_at
from posts where status = $$scheduled$$ and scheduled_at < now() order by scheduled_at;

-- ШАГ 2. Наложения (только чтение). Применять ТОЛЬКО если вернулось ноль строк.
select a.scheduled_at as src, b.scheduled_at as dst
from posts a join posts b
  on b.scheduled_at = a.scheduled_at + interval $$12 days$$ and b.status = $$scheduled$$
where a.status = $$scheduled$$ and a.scheduled_at < now();

-- ШАГ 3. Сдвиг. Шаг 12 дней подобран так, чтобы просроченные встали ПОСЛЕ
-- последнего занятого слота, по одному в день, без разрывов и наложений.
-- На 04.10: шесть постов 29.09-04.10 уходят в 11.10-16.10, за последним занятым 10.10.
update posts set scheduled_at = scheduled_at + interval $$12 days$$
where status = $$scheduled$$ and scheduled_at < now()
returning id, scheduled_at;

-- ШАГ 4. Проверка: просроченных должно остаться ноль.
select count(*) as overdue from posts where status = $$scheduled$$ and scheduled_at < now();

-- ОТКАТ (если сдвинули зря). Берёт только те, что сдвигали — по списку id из шага 3.
-- Вставить id вместо <id1>,... Без списка откат зацепит и чужие будущие посты.
update posts set scheduled_at = scheduled_at - interval $$12 days$$
where status = $$scheduled$$ and id in ($$<id1>$$::uuid, $$<id2>$$::uuid)
returning id, scheduled_at;

-- Список id, сдвигаемых на 04.10 19:05 МСК (если ШАГ 1 вернёт их же — список актуален):
--   1037e5f1-3671-4697-9c1e-745d8f4d8d5f  29.09 06:30 UTC
--   b2cab296-837e-4afc-af60-3197f5269ba0  30.09 06:30 UTC
--   acbb902c-5151-4344-9b20-cbb06d23c019  01.10 06:30 UTC
--   e0b6603f-2f3d-4583-91f0-98fa0de49e6e  02.10 06:30 UTC
--   391039b4-9bce-4e70-b4c5-ee6874a3d3c9  03.10 06:30 UTC
--   f0145ee7-617b-4cff-b9b7-a856e7faa496  04.10 06:30 UTC
-- Каждый день без оплаты список растёт на одну строку (слот 09:30 МСК).
