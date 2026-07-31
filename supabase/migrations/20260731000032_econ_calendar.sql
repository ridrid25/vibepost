-- Экономический календарь: события, о которых канал предупреждает заранее.
-- Источник — не парсинг чужих сайтов, а даты, известные наперёд: график
-- заседаний ЦБ публикуется на год вперёд, налоговые сроки закреплены в НК РФ.
-- Так календарь не ломается от смены вёрстки и не требует ключей.
create table public.econ_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  event_date date not null,
  event_time time,
  title text not null,
  note text,
  kind text not null default 'other'
    check (kind in ('rate', 'tax', 'stat', 'other')),
  source text,
  posted_at timestamptz,
  created_at timestamptz not null default now()
);
create index idx_econ_events_date on public.econ_events (user_id, event_date);

alter table public.econ_events enable row level security;
create policy "econ_events_owner_all" on public.econ_events
  for all using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create table public.econ_config (
  user_id uuid primary key references auth.users (id) on delete cascade,
  bot_id uuid not null references public.bots (id) on delete cascade,
  chat_id uuid not null references public.chats (id) on delete cascade,
  days_before integer not null default 1 check (days_before between 0 and 7),
  post_hour integer not null default 10 check (post_hour between 0 and 23),
  post_minute integer not null default 0 check (post_minute between 0 and 59),
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.econ_config enable row level security;
create policy "econ_config_owner_all" on public.econ_config
  for all using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Раз в 5 минут: функция сама решает, её ли это час и минута.
select cron.schedule(
  'vibepost-econ',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'vibepost_project_url') || '/functions/v1/post-econ',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'vibepost_service_key')),
    body := '{}'::jsonb, timeout_milliseconds := 55000);
  $$
);
