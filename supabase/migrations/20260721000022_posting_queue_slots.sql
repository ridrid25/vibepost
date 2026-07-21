-- Очередь по слотам: недельное расписание слотов на канал + очередь
-- «нерасставленных» постов, которые cron сам раскладывает по свободным слотам.

create table public.posting_slots (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  chat_id    uuid not null references public.chats (id) on delete cascade,
  weekday    integer not null check (weekday between 1 and 7),
  hour       integer not null check (hour between 0 and 23),
  minute     integer not null check (minute between 0 and 59),
  created_at timestamptz not null default now(),
  unique (chat_id, weekday, hour, minute)
);
create index idx_posting_slots_user on public.posting_slots (user_id);

alter table public.posting_slots enable row level security;
create policy "posting_slots_owner_all" on public.posting_slots
  for all using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create or replace function public.validate_slot_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.chats c where c.id = new.chat_id and c.user_id = new.user_id) then
    raise exception 'Чат не найден или принадлежит другому пользователю';
  end if;
  return new;
end; $$;
revoke execute on function public.validate_slot_refs() from public, anon, authenticated;
create trigger trg_posting_slots_validate
  before insert or update of chat_id, user_id on public.posting_slots
  for each row execute function public.validate_slot_refs();

alter table public.posts drop constraint if exists posts_status_check;
alter table public.posts add constraint posts_status_check
  check (status in ('draft', 'queued', 'scheduled', 'processing', 'sent', 'failed'));
alter table public.posts alter column scheduled_at drop not null;
alter table public.posts add constraint posts_time_required
  check (scheduled_at is not null or status in ('draft', 'queued'));
alter table public.posts add column if not exists queue_position integer;

create or replace function public.assign_queue_to_slots()
returns integer language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  with days as (
    select gs::date as day
    from generate_series(
      (now() at time zone 'Europe/Moscow')::date::timestamp,
      ((now() at time zone 'Europe/Moscow')::date + 14)::timestamp,
      interval '1 day'
    ) gs
  ),
  slots_future as (
    select s.chat_id,
           ((day::timestamp + make_time(s.hour, s.minute, 0)) at time zone 'Europe/Moscow') as slot_at
    from public.posting_slots s
    join days on extract(isodow from day)::int = s.weekday
  ),
  free_slots as (
    select sf.chat_id, sf.slot_at,
           row_number() over (partition by sf.chat_id order by sf.slot_at) as rn
    from slots_future sf
    where sf.slot_at > now()
      and not exists (
        select 1 from public.posts p
        where p.chat_id = sf.chat_id and p.status = 'scheduled' and p.scheduled_at = sf.slot_at
      )
  ),
  queued as (
    select p.id, p.chat_id,
           row_number() over (partition by p.chat_id order by coalesce(p.queue_position, 0), p.created_at) as rn
    from public.posts p
    where p.status = 'queued'
  ),
  upd as (
    update public.posts p
    set scheduled_at = fs.slot_at, status = 'scheduled', queue_position = null
    from queued q
    join free_slots fs on fs.chat_id = q.chat_id and fs.rn = q.rn
    where p.id = q.id
    returning 1
  )
  select count(*) into n from upd;
  return n;
end; $$;
revoke execute on function public.assign_queue_to_slots() from public, anon, authenticated;
grant execute on function public.assign_queue_to_slots() to service_role;

select cron.schedule('vibepost-queue', '*/5 * * * *', $cron$ select public.assign_queue_to_slots(); $cron$);
