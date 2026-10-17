-- 17.10: с 18.10 обложки дайджеста — H.264 + AAC со звуком (контракт Контент-завода
-- vibepost-digest-music-20261017.md). Посты DIGEST: заводятся с video_autoplay = false,
-- значит планировщик шлёт их sendVideo, а не sendAnimation (который звук не играет).
-- Остальные посты, слоты, одобрение и идемпотентность не меняются.
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
    пора := digest_due_at(п.id);
    if пора is null then
      if п.status = 'waiting_cover' and p_now > п.base_slot_at + interval '15 minutes'
         and п.alerted_at is null and п.cover_status <> 'ready' then
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

    подпись := п.item_text;
    if length(подпись) > 1024 then
      update news_digest_publications set status = 'blocked_long_caption',
        last_error = 'подпись ' || length(подпись) || ' знаков > 1024' where id = п.id;
      publication_id := п.id; item_order := п.item_order; action := 'blocked_long_caption';
      detail := length(подпись)::text; return next; continue;
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
