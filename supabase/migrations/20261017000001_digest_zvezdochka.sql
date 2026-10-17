-- 17.10: сухой прогон сорвался — write-digest написал пункты со звёздочкой «* »,
-- а разбор понимал только •·-–—. Теперь понимает и «*». И при нуле найденных
-- новостей отказывает (кнопка ответит «Не принялось»), а не ставит dry_items молча.
create or replace function public.digest_approve_items(p_digest_id uuid, p_now timestamptz default now())
returns table (item_order smallint, publication_id uuid, base_slot_at timestamptz, caption_len int)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  д record;
  реж text;
  сетка text[] := array['09:30','10:30','11:30','15:00','16:00','17:00'];
  день date := (p_now at time zone 'Europe/Moscow')::date;
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

  for стр in
    -- «*» только с пробелом после: «**Жирный**» — не пункт
    select trim(regexp_replace(l, '^\s*([•·\-–—]\s*|\*\s+)', ''))
      from regexp_split_to_table(д.text, E'\n') with ordinality as t(l, i)
     where l ~ '^\s*([•·\-–—]\s*|\*\s+)\S'
     order by i
  loop
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
            case when length(стр) > 1024 then 'blocked_long_caption' else 'waiting_cover' end)
    on conflict (item_id) do nothing;
  end loop;

  if n = 0 then raise exception 'в подборке не найдено ни одной новости (пункты должны начинаться с •, * или тире)'; end if;

  update news_digests
     set status = case when реж = 'items_dry' then 'dry_items' else 'items_queued' end,
         decided_at = coalesce(decided_at, p_now)
   where id = p_digest_id and status in ('draft', 'failed');

  return query
    select p.item_order, p.id, p.base_slot_at, length(i.text)
      from news_digest_publications p join news_digest_items i on i.id = p.item_id
     where p.digest_id = p_digest_id order by p.item_order;
end $$;
