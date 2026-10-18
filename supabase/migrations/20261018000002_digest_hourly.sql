-- 18.10: решение заказчицы — «каждый час выпускать свежую новость часа, с 8 до 18;
-- моё подтверждение — кнопка, которой можно остановить».
-- Режим news_config.digest_mode = 'hourly':
--   * в :36 (07:36…17:36 МСК) news-hourly берёт самую свежую денежную новость и
--     заводит публикацию на ближайший час (08:00…18:00) — отдельная «подборка» из
--     одной новости, item_order 1, без утверждения;
--   * ей приходит превью с кнопкой «🛑 Не публиковать» (dg:stop:<publication>);
--     не нажала — новость уходит в свой час;
--   * Контент-завод делает обложку как раньше (vid=need), без обложки не уходит;
--   * обложка не успела к часу + 40 мин — новость устарела, публикация гаснет молча.
-- Утренняя подборка 08:30 в этом режиме не пишется (write-digest выходит сразу).

alter table public.news_config drop constraint if exists news_config_digest_mode_check;
alter table public.news_config add constraint news_config_digest_mode_check
  check (digest_mode in ('single', 'items_dry', 'items', 'hourly'));

alter table public.news_digest_publications drop constraint if exists news_digest_publications_status_check;
alter table public.news_digest_publications add constraint news_digest_publications_status_check
  check (status in ('waiting_cover', 'waiting_slot', 'posted_to_queue', 'sent', 'failed',
                    'blocked_overlap', 'blocked_long_caption', 'dry_planned', 'cancelled', 'expired'));

alter table public.news_digest_publications add column if not exists hourly boolean not null default false;
create unique index if not exists news_digest_publications_hourly_slot
  on public.news_digest_publications (user_id, base_slot_at) where hourly;

-- Завести новость часа. Повторный вызов на тот же час ничего не создаёт (null).
create or replace function public.digest_hourly_create(p_user uuid, p_text text, p_slot timestamptz,
                                                       p_now timestamptz default now())
returns uuid language plpgsql security definer set search_path = public as $$
declare д uuid; и uuid; п uuid;
begin
  if exists (select 1 from news_digest_publications where user_id = p_user and hourly and base_slot_at = p_slot) then
    return null;
  end if;
  insert into news_digests (user_id, text, status, decided_at) values (p_user, p_text, 'items_queued', p_now)
  returning id into д;
  insert into news_digest_items (digest_id, user_id, item_order, text) values (д, p_user, 1, p_text)
  returning id into и;
  insert into news_digest_publications
    (item_id, digest_id, user_id, item_order, dry_run, approved_at, base_slot_at, status, hourly, ignore_overlap)
  values (и, д, p_user, 1, false, p_now, p_slot,
          case when digest_caption_len(p_text) > 1024 then 'blocked_long_caption' else 'waiting_cover' end,
          true, true)
  returning id into п;
  return п;
end $$;

-- Кнопка «🛑 Не публиковать»: гасит, пока пост не заведён.
create or replace function public.digest_hourly_stop(p_publication uuid)
returns text language plpgsql security definer set search_path = public as $$
declare п record;
begin
  select * into п from news_digest_publications where id = p_publication for update;
  if not found then return 'не найдено'; end if;
  if п.status = 'cancelled' then return 'уже остановлено'; end if;
  if п.post_id is not null then return 'уже в канале'; end if;
  update news_digest_publications set status = 'cancelled', last_error = 'остановлено кнопкой' where id = п.id;
  return 'остановлено';
end $$;

revoke execute on function public.digest_hourly_create(uuid, text, timestamptz, timestamptz) from public, anon, authenticated;
revoke execute on function public.digest_hourly_stop(uuid) from public, anon, authenticated;
grant execute on function public.digest_hourly_create(uuid, text, timestamptz, timestamptz) to service_role;
grant execute on function public.digest_hourly_stop(uuid) to service_role;

create or replace function public.digest_dispatch(p_now timestamptz default now())
returns table (publication_id uuid, item_order smallint, action text, detail text)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare п record; пора timestamptz; пост uuid; cfg record; рубеж timestamptz; подпись text;
begin
  -- 1. квитанции: пост ушёл/упал → публикация
  update news_digest_publications p
     set status = 'sent', tg_message_id = po.tg_message_id, sent_at = po.sent_at
    from posts po
   where po.id = p.post_id and p.status = 'posted_to_queue'
     and po.status = 'sent' and po.tg_message_id is not null;
  for п in
    update news_digest_publications p set status = 'failed', last_error = po.error
      from posts po
     where po.id = p.post_id and p.status = 'posted_to_queue' and po.status = 'failed'
    returning p.id, p.item_order, po.error
  loop
    publication_id := п.id; item_order := п.item_order; action := 'failed'; detail := п.error;
    return next;
  end loop;

  -- 2. кому пора
  for п in
    select p.*, i.text as item_text from news_digest_publications p
      join news_digest_items i on i.id = p.item_id
     where p.status in ('waiting_cover', 'waiting_slot')   -- dry_planned уже посчитан: не повторяем
       and p.post_id is null
     order by p.digest_id, p.item_order
     for update of p skip locked
  loop
    -- новость часа устарела: к часу + 40 мин обложки нет — гасим молча
    if п.hourly and p_now > п.base_slot_at + interval '40 minutes' then
      update news_digest_publications set status = 'expired',
        last_error = 'устарела: обложка не успела к своему часу' where id = п.id;
      publication_id := п.id; item_order := п.item_order; action := 'expired';
      detail := to_char(п.base_slot_at at time zone 'Europe/Moscow', 'HH24:MI'); return next;
      continue;
    end if;
    пора := digest_due_at(п.id);
    if пора is null then
      if п.status = 'waiting_cover' and p_now > п.base_slot_at + interval '15 minutes'
         and п.alerted_at is null and п.cover_status <> 'ready' and not п.hourly then
        update news_digest_publications set alerted_at = p_now where id = п.id;
        publication_id := п.id; item_order := п.item_order; action := 'cover_late';
        detail := 'обложки нет, слот ' || to_char(п.base_slot_at at time zone 'Europe/Moscow', 'HH24:MI');
        return next;
      end if;
      continue;
    end if;
    update news_digest_publications set due_at = пора,
      status = case when dry_run then 'dry_planned' else 'waiting_slot' end
     where id = п.id;

    рубеж := digest_slot_utc((п.approved_at at time zone 'Europe/Moscow')::date, '14:30');
    if п.item_order <= 3 and пора > рубеж and not п.ignore_overlap then
      update news_digest_publications set status = 'blocked_overlap',
        last_error = 'утренняя новость сдвинулась за 14:30 МСК — пересечение с дневной сеткой'
       where id = п.id;
      publication_id := п.id; item_order := п.item_order; action := 'blocked_overlap';
      detail := to_char(пора at time zone 'Europe/Moscow', 'HH24:MI'); return next;
      continue;
    end if;

    if п.dry_run then
      publication_id := п.id; item_order := п.item_order; action := 'dry_planned';
      detail := to_char(пора at time zone 'Europe/Moscow', 'DD.MM HH24:MI'); return next;
      continue;
    end if;
    if пора > p_now then continue; end if;

    подпись := digest_caption(п.item_text);
    if digest_caption_len(п.item_text) > 1024 then
      update news_digest_publications set status = 'blocked_long_caption',
        last_error = 'подпись ' || digest_caption_len(п.item_text) || ' знаков > 1024' where id = п.id;
      publication_id := п.id; item_order := п.item_order; action := 'blocked_long_caption';
      detail := digest_caption_len(п.item_text)::text; return next; continue;
    end if;

    select nc.bot_id, nc.chat_id into cfg from news_config nc where nc.user_id = п.user_id;
    insert into posts (user_id, bot_id, chat_id, format, text, video_url, video_autoplay,
                       scheduled_at, status, label)
    values (п.user_id, cfg.bot_id, cfg.chat_id, 'video', подпись,
            (select decrypted_secret from vault.decrypted_secrets where name = 'vibepost_project_url')
              || '/storage/v1/object/public/post-photos/' || п.media_path,
            false, p_now, 'scheduled', 'DIGEST:' || п.digest_id || ':' || п.item_order)
    returning id into пост;
    update news_digest_publications set post_id = пост, status = 'posted_to_queue' where id = п.id;
    publication_id := п.id; item_order := п.item_order; action := 'posted_to_queue';
    detail := пост::text; return next;
  end loop;
end $$;

revoke execute on function public.digest_dispatch(timestamptz) from public, anon, authenticated;
grant execute on function public.digest_dispatch(timestamptz) to service_role;

-- Сбор новостей дважды в час (:07 и :32), чтобы к :36 была свежая новость часа.
select cron.alter_job((select jobid from cron.job where jobname = 'vibepost-news-fetch'),
                      schedule := '7,32 * * * *');

-- Новость часа: 07:36…17:36 МСК (04…14 UTC) → публикации 08:00…18:00.
select cron.schedule('vibepost-news-hourly', '36 4-14 * * *', $cron$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'vibepost_project_url') || '/functions/v1/news-hourly',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'vibepost_service_key')),
    body := '{}'::jsonb, timeout_milliseconds := 110000);
$cron$);
