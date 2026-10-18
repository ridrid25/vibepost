-- 18.10: подача новости как у t.me/toporlive (решение заказчицы):
--   ⚡️ **заголовок-суть**, — источник.
--   (пустая строка) подробности, цифры **жирным**
--   (пустая строка) 👉 рИИдФинанс. Подписаться  ← ссылка t.me/Rid_Finance
-- Генератор пишет новость двумя строками: «• **заголовок**, — источник.» и строку
-- подробностей. Разбор собирает новость из строки-пункта и следующих за ней строк.
-- Подпись в HTML (жирный, ссылка) собирается здесь; send-post для DIGEST: шлёт
-- с parse_mode=HTML. Лимит 1024 считается по видимому тексту, без тегов.

create or replace function public.digest_caption(p_text text)
returns text language plpgsql immutable set search_path = public as $$
declare x text; заг text; ост text;
begin
  x := replace(replace(replace(coalesce(p_text, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;');
  x := regexp_replace(x, '\*\*(.+?)\*\*', '<b>\1</b>', 'gn');
  x := replace(x, '**', '');
  заг := trim(split_part(x, E'\n', 1));
  ост := trim(both E' \n' from substr(x, length(split_part(x, E'\n', 1)) + 2));
  ост := regexp_replace(ост, E'\n\s*\n+', E'\n', 'g');          -- без лишних пустых
  ост := replace(ост, E'\n', E'\n\n');                          -- абзацы через строку
  if position('<b>' in заг) = 0 then заг := '<b>' || заг || '</b>'; end if;
  return '⚡️ ' || заг
      || case when ост <> '' then E'\n\n' || ост else '' end
      || E'\n\n👉 <a href="https://t.me/Rid_Finance">рИИдФинанс. Подписаться</a>';
end $$;

-- Видимая длина подписи (как её считает Telegram): без тегов, сущности — один знак.
create or replace function public.digest_caption_len(p_text text)
returns int language sql immutable set search_path = public as $$
  select length(replace(replace(replace(
           regexp_replace(public.digest_caption(p_text), '<[^>]+>', '', 'g'),
           '&amp;', '&'), '&lt;', '<'), '&gt;', '>'))
$$;

create or replace function public.digest_approve_items(p_digest_id uuid, p_now timestamptz default now())
returns table (item_order smallint, publication_id uuid, base_slot_at timestamptz, caption_len int)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  д record;
  реж text;
  сетка text[] := array['09:30','10:30','11:30','15:00','16:00','17:00'];
  день date := (p_now at time zone 'Europe/Moscow')::date;
  л text;
  пункты text[] := '{}';
  стр text;
  n smallint := 0;
  ид uuid;
begin
  select nd.*, nc.digest_mode into д
    from news_digests nd join news_config nc on nc.user_id = nd.user_id
   where nd.id = p_digest_id
   for update of nd;
  if not found then raise exception 'дайджест % не найден', p_digest_id; end if;
  реж := д.digest_mode;
  if реж = 'single' then raise exception 'digest_mode=single: публикация по новостям выключена'; end if;

  -- Пункт начинается с •·-–— или «* » (звёздочка с пробелом: «**жирный**» — не пункт);
  -- строки после пункта до следующего — его подробности. Строки до первого пункта
  -- (заголовок «Коротко за день») отбрасываются.
  for л in
    select l from regexp_split_to_table(д.text, E'\n') with ordinality as t(l, i) order by i
  loop
    if л ~ '^\s*([•·\-–—]\s*|\*\s+)\S' then
      пункты := пункты || trim(regexp_replace(л, '^\s*([•·\-–—]\s*|\*\s+)', ''));
    elsif cardinality(пункты) > 0 and trim(л) <> '' then
      пункты[cardinality(пункты)] := пункты[cardinality(пункты)] || E'\n' || trim(л);
    end if;
  end loop;

  foreach стр in array пункты loop
    n := n + 1;
    exit when n > 6;
    insert into news_digest_items (digest_id, user_id, item_order, text)
    values (p_digest_id, д.user_id, n, стр)
    on conflict (digest_id, item_order) do nothing;
    select id into ид from news_digest_items where digest_id = p_digest_id and item_order = n;
    insert into news_digest_publications
      (item_id, digest_id, user_id, item_order, dry_run, approved_at, base_slot_at, status)
    values (ид, p_digest_id, д.user_id, n, реж = 'items_dry', p_now,
            digest_slot_utc(день, сетка[n]),
            case when digest_caption_len(стр) > 1024 then 'blocked_long_caption' else 'waiting_cover' end)
    on conflict (item_id) do nothing;
  end loop;

  if n = 0 then raise exception 'в подборке не найдено ни одной новости (пункты должны начинаться с •, * или тире)'; end if;

  update news_digests
     set status = case when реж = 'items_dry' then 'dry_items' else 'items_queued' end,
         decided_at = coalesce(decided_at, p_now)
   where id = p_digest_id and status in ('draft', 'failed');

  return query
    select p.item_order, p.id, p.base_slot_at, digest_caption_len(i.text)
      from news_digest_publications p join news_digest_items i on i.id = p.item_id
     where p.digest_id = p_digest_id order by p.item_order;
end $$;

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

revoke execute on function public.digest_approve_items(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.digest_approve_items(uuid, timestamptz) to service_role;
