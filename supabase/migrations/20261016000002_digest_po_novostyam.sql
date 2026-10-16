-- Дайджест по отдельным новостям с движущимися обложками (16.10.2026).
--
-- Сценарий заказчицы: в 08:30 подборка, ОДНО нажатие «В канал» на всю подборку,
-- до шести отдельных постов, у каждой новости своя обложка от Контент-завода.
-- Слоты МСК: утро 09:30/10:30/11:30, день 15:00/16:00/17:00. Позднее одобрение
-- сдвигает только утро: первая — когда готова её обложка, следующие — через час
-- от ФАКТИЧЕСКОЙ отправки предыдущей. Дневные слоты неизменны.
--
-- ВКЛЮЧАЕТСЯ ТОЛЬКО news_config.digest_mode:
--   'single'   — как раньше, один текстовый пост (по умолчанию, НЕ ТРОГАЕТСЯ);
--   'items_dry'— сухой прогон: новости, публикации и расписание считаются,
--                постов в канал НЕ создаётся;
--   'items'    — боевой режим (включает только владелица после проверок).
--
-- Цепочка идентичностей: digest_id → item_id (порядок 1..6) → publication
-- (cover_id/media) → post_id (уникален) → tg_message_id (квитанция Telegram).

alter table public.news_config
  add column if not exists digest_mode text not null default 'single'
    check (digest_mode in ('single', 'items_dry', 'items'));


-- Новые статусы подборки добавляются, старые не меняются.
alter table public.news_digests drop constraint if exists news_digests_status_check;
alter table public.news_digests add constraint news_digests_status_check
  check (status in ('draft', 'queued', 'posted', 'skipped', 'failed', 'dry_items', 'items_queued'));

create table if not exists public.news_digest_items (
  id uuid primary key default gen_random_uuid(),
  digest_id uuid not null references public.news_digests (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  item_order smallint not null check (item_order between 1 and 6),
  text text not null,
  created_at timestamptz not null default now(),
  unique (digest_id, item_order)
);
alter table public.news_digest_items enable row level security;
drop policy if exists news_digest_items_owner on public.news_digest_items;
create policy news_digest_items_owner on public.news_digest_items
  for select using (auth.uid() = user_id);

create table if not exists public.news_digest_publications (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null unique references public.news_digest_items (id) on delete cascade,
  digest_id uuid not null references public.news_digests (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  item_order smallint not null,
  dry_run boolean not null default false,
  approved_at timestamptz not null,
  base_slot_at timestamptz not null,          -- слот по сетке (09:30…17:00 МСК)
  cover_status text not null default 'requested'
    check (cover_status in ('requested', 'ready', 'failed')),
  cover_id text,
  media_path text,                            -- путь в бакете post-photos
  media_sha256 text,
  cover_ready_at timestamptz,
  status text not null default 'waiting_cover'
    check (status in ('waiting_cover', 'waiting_slot', 'posted_to_queue', 'sent',
                      'failed', 'blocked_overlap', 'blocked_long_caption', 'dry_planned')),
  due_at timestamptz,                         -- когда фактически пора (последний расчёт)
  post_id uuid unique references public.posts (id) on delete set null,
  tg_message_id bigint,
  sent_at timestamptz,
  last_error text,
  alerted_at timestamptz,                     -- владелице уже сказано о задержке/ошибке
  created_at timestamptz not null default now(),
  unique (digest_id, item_order)
);
alter table public.news_digest_publications enable row level security;
drop policy if exists news_digest_publications_owner on public.news_digest_publications;
create policy news_digest_publications_owner on public.news_digest_publications
  for select using (auth.uid() = user_id);
create index if not exists news_digest_publications_open_idx
  on public.news_digest_publications (status) where status not in ('sent', 'failed');

-- ── Сетка слотов: МСК → UTC для дня одобрения ─────────────────────────────
create or replace function public.digest_slot_utc(p_day date, p_hhmm text)
returns timestamptz language sql immutable as $$
  select ((p_day::text || ' ' || p_hhmm)::timestamp at time zone 'Europe/Moscow')
$$;

-- ── Одобрение: подборка → новости → публикации. Идемпотентно. ─────────────
-- Пункты берутся из текста дайджеста построчно («• …»). Пустых слотов не
-- заполняем: 3 новости → 3 публикации. Повторный вызов ничего не дублирует.
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
    select trim(regexp_replace(l, '^\s*[•·\-–—]\s*', ''))
      from regexp_split_to_table(д.text, E'\n') with ordinality as t(l, i)
     where l ~ '^\s*[•·\-–—]\s*\S'
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

  update news_digests
     set status = case when реж = 'items_dry' then 'dry_items' else 'items_queued' end,
         decided_at = coalesce(decided_at, p_now)
   where id = p_digest_id and status in ('draft', 'failed');

  return query
    select p.item_order, p.id, p.base_slot_at, length(i.text)
      from news_digest_publications p join news_digest_items i on i.id = p.item_id
     where p.digest_id = p_digest_id order by p.item_order;
end $$;

-- ── Обложка готова (вызывает только digest-covers по ключу Контент-завода) ─
-- Идемпотентно: тот же cover_id — повтор без изменений; другой cover_id после
-- того, как пост уже заведён, — отказ (обложку отправленного/запланированного
-- поста не подменяем).
create or replace function public.digest_cover_ready(
  p_publication_id uuid, p_cover_id text, p_media_path text, p_sha256 text,
  p_now timestamptz default now())
returns text language plpgsql security definer set search_path = public as $$
declare п record;
begin
  select * into п from news_digest_publications where id = p_publication_id for update;
  if not found then return 'нет такой публикации'; end if;
  if п.cover_status = 'ready' and п.cover_id = p_cover_id then return 'повтор'; end if;
  if п.post_id is not null then return 'пост уже заведён — обложку не меняем'; end if;
  if p_media_path !~ '^content-factory/digest/' then return 'путь вне content-factory/digest/'; end if;
  update news_digest_publications
     set cover_status = 'ready', cover_id = p_cover_id, media_path = p_media_path,
         media_sha256 = p_sha256, cover_ready_at = p_now
   where id = p_publication_id;
  return 'принято';
end $$;

-- ── Когда пора: детерминированный расчёт ──────────────────────────────────
-- Дневные (4–6): ровно свой слот. Утренние (1–3): max(сетка, одобрение,
-- готовность обложки) для первой; для 2 и 3 — ещё и не раньше часа после
-- ФАКТИЧЕСКОЙ отправки предыдущей утренней. Если утренняя выходит позже
-- 14:30 МСК — пересечение с дневной сеткой: НЕ отправляем, blocked_overlap
-- (правило для этого случая владелица ещё не утвердила).
create or replace function public.digest_due_at(p_publication_id uuid)
returns timestamptz language plpgsql stable security definer set search_path = public as $$
declare п record; пред record; t timestamptz;
begin
  select * into п from news_digest_publications where id = p_publication_id;
  if п.cover_status <> 'ready' then return null; end if;
  if п.item_order >= 4 then return п.base_slot_at; end if;
  t := greatest(п.base_slot_at, п.approved_at, п.cover_ready_at);
  if п.item_order > 1 then
    select * into пред from news_digest_publications
     where digest_id = п.digest_id and item_order = п.item_order - 1;
    if пред.sent_at is null and not (п.dry_run and пред.due_at is not null) then return null; end if;
    t := greatest(t, coalesce(пред.sent_at, пред.due_at) + interval '1 hour');
  end if;
  return t;
end $$;

-- ── Диспетчер: заводит пост ровно один раз, когда пора ────────────────────
-- Возвращает, что сделал, чтобы Edge Function могла сообщить владелице.
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
    if п.item_order <= 3 and пора > рубеж then
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
            true, p_now, 'scheduled', 'DIGEST:' || п.digest_id || ':' || п.item_order)
    returning id into пост;
    update news_digest_publications set post_id = пост, status = 'posted_to_queue' where id = п.id;
    publication_id := п.id; item_order := п.item_order; action := 'posted_to_queue';
    detail := пост::text; return next;
  end loop;
end $$;

revoke execute on function public.digest_approve_items(uuid, timestamptz) from public, anon, authenticated;
revoke execute on function public.digest_cover_ready(uuid, text, text, text, timestamptz) from public, anon, authenticated;
revoke execute on function public.digest_due_at(uuid) from public, anon, authenticated;
revoke execute on function public.digest_dispatch(timestamptz) from public, anon, authenticated;
grant execute on function public.digest_approve_items(uuid, timestamptz) to service_role;
grant execute on function public.digest_cover_ready(uuid, text, text, text, timestamptz) to service_role;
grant execute on function public.digest_due_at(uuid) to service_role;
grant execute on function public.digest_dispatch(timestamptz) to service_role;
