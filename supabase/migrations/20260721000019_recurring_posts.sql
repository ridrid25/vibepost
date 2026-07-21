-- Повторяющиеся посты: правило (ежедневно / по дням недели / ежемесячно)
-- в конкретный канал. Раз в минуту cron материализует ближайшее вхождение
-- в обычный posts (status='scheduled'), а его уже отправляет планировщик.

create table public.recurring_posts (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null default auth.uid() references auth.users (id) on delete cascade,
  bot_id               uuid not null references public.bots (id) on delete cascade,
  chat_id              uuid not null references public.chats (id) on delete cascade,
  name                 text,
  format               text not null default 'text' check (format in ('text', 'photo', 'poll', 'video')),
  text                 text,
  photo_url            text,
  video_url            text,
  video_autoplay       boolean not null default false,
  poll_question        text,
  poll_options         jsonb,
  poll_anonymous       boolean not null default true,
  inline_buttons       jsonb,
  is_silent            boolean not null default false,
  disable_link_preview boolean not null default false,
  freq                 text not null check (freq in ('daily', 'weekly', 'monthly')),
  weekdays             integer[],   -- weekly: ISO 1=Пн .. 7=Вс
  day_of_month         integer check (day_of_month between 1 and 31), -- monthly
  hour                 integer not null check (hour between 0 and 23),
  minute               integer not null check (minute between 0 and 59),
  is_active            boolean not null default true,
  next_run_at          timestamptz,
  created_at           timestamptz not null default now(),
  constraint recurring_schedule_valid check (
    freq = 'daily'
    or (freq = 'weekly' and weekdays is not null and array_length(weekdays, 1) >= 1)
    or (freq = 'monthly' and day_of_month is not null)
  )
);

create index idx_recurring_posts_user on public.recurring_posts (user_id);
create index idx_recurring_posts_due on public.recurring_posts (is_active, next_run_at);

-- Ссылка материализованного поста на своё правило (+защита от дублей)
alter table public.posts add column if not exists source_recurring_id uuid
  references public.recurring_posts (id) on delete set null;
create unique index if not exists uq_posts_recurring_occurrence
  on public.posts (source_recurring_id, scheduled_at)
  where source_recurring_id is not null;

-- RLS
alter table public.recurring_posts enable row level security;
create policy "recurring_owner_all" on public.recurring_posts
  for all using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Проверка: бот/чат принадлежат владельцу, чат привязан к боту
create or replace function public.validate_recurring_refs()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.bots b where b.id = new.bot_id and b.user_id = new.user_id) then
    raise exception 'Бот не найден или принадлежит другому пользователю';
  end if;
  if not exists (select 1 from public.chats c where c.id = new.chat_id and c.user_id = new.user_id and c.bot_id = new.bot_id) then
    raise exception 'Чат не найден, чужой или привязан к другому боту';
  end if;
  return new;
end;
$$;
revoke execute on function public.validate_recurring_refs() from public, anon, authenticated;
create trigger trg_recurring_validate_refs
  before insert or update of bot_id, chat_id, user_id on public.recurring_posts
  for each row execute function public.validate_recurring_refs();

-- Вычисление следующего запуска (в МСК → возвращаем timestamptz UTC)
create or replace function public.recurring_compute_next(
  p_freq text, p_weekdays integer[], p_day_of_month integer,
  p_hour integer, p_minute integer, p_after timestamptz
)
returns timestamptz
language plpgsql
immutable
set search_path = ''
as $$
declare
  tz constant text := 'Europe/Moscow';
  after_local timestamp := (p_after at time zone tz);
  candidate timestamp;
  found timestamp := null;
  i integer;
  d date;
  y integer; m integer; dim integer; dd integer;
begin
  if p_freq = 'daily' then
    candidate := date_trunc('day', after_local) + make_interval(hours => p_hour, mins => p_minute);
    if candidate <= after_local then candidate := candidate + interval '1 day'; end if;
    found := candidate;
  elsif p_freq = 'weekly' then
    for i in 0..14 loop
      d := (date_trunc('day', after_local) + make_interval(days => i))::date;
      if extract(isodow from d)::int = any(coalesce(p_weekdays, '{}')) then
        candidate := d::timestamp + make_interval(hours => p_hour, mins => p_minute);
        if candidate > after_local then found := candidate; exit; end if;
      end if;
    end loop;
  elsif p_freq = 'monthly' then
    y := extract(year from after_local); m := extract(month from after_local);
    for i in 0..1 loop
      dim := extract(day from (date_trunc('month', make_date(y, m, 1)) + interval '1 month - 1 day'));
      dd := least(p_day_of_month, dim);
      candidate := make_date(y, m, 1)::timestamp + make_interval(days => dd - 1, hours => p_hour, mins => p_minute);
      if candidate > after_local then found := candidate; exit; end if;
      m := m + 1; if m > 12 then m := 1; y := y + 1; end if;
    end loop;
  end if;

  if found is null then return null; end if;
  return (found at time zone tz);
end;
$$;
revoke execute on function public.recurring_compute_next(text, integer[], integer, integer, integer, timestamptz) from public, anon;

-- next_run_at пересчитывается только при вставке или смене расписания
-- (чтобы cron мог свободно двигать next_run_at, не запуская пересчёт с now()).
create or replace function public.recurring_set_next()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or
     new.freq is distinct from old.freq or
     new.weekdays is distinct from old.weekdays or
     new.day_of_month is distinct from old.day_of_month or
     new.hour is distinct from old.hour or
     new.minute is distinct from old.minute then
    new.next_run_at := public.recurring_compute_next(
      new.freq, new.weekdays, new.day_of_month, new.hour, new.minute, now());
  end if;
  return new;
end;
$$;
revoke execute on function public.recurring_set_next() from public, anon, authenticated;
create trigger trg_recurring_set_next
  before insert or update on public.recurring_posts
  for each row execute function public.recurring_set_next();

-- Материализация: превращает подошедшие правила в обычные posts
-- (с запасом 2 минуты) и двигает next_run_at на следующее вхождение.
create or replace function public.enqueue_due_recurring()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  cnt integer := 0;
begin
  for r in
    select * from public.recurring_posts
    where is_active and next_run_at is not null
      and next_run_at <= now() + interval '2 minutes'
    order by next_run_at
    for update skip locked
  loop
    insert into public.posts (
      user_id, bot_id, chat_id, format, text, photo_url, video_url, video_autoplay,
      poll_question, poll_options, poll_anonymous, inline_buttons,
      is_silent, disable_link_preview, scheduled_at, status, source_recurring_id
    ) values (
      r.user_id, r.bot_id, r.chat_id, r.format, r.text, r.photo_url, r.video_url, r.video_autoplay,
      r.poll_question, r.poll_options, r.poll_anonymous, r.inline_buttons,
      r.is_silent, r.disable_link_preview, r.next_run_at, 'scheduled', r.id
    )
    on conflict (source_recurring_id, scheduled_at) do nothing;

    update public.recurring_posts
    set next_run_at = public.recurring_compute_next(
      r.freq, r.weekdays, r.day_of_month, r.hour, r.minute, r.next_run_at)
    where id = r.id;

    cnt := cnt + 1;
  end loop;
  return cnt;
end;
$$;
revoke execute on function public.enqueue_due_recurring() from public, anon, authenticated;
grant execute on function public.enqueue_due_recurring() to service_role;

-- Cron: раз в минуту материализуем подошедшие правила
select cron.schedule('vibepost-recurring', '* * * * *', $cron$ select public.enqueue_due_recurring(); $cron$);
