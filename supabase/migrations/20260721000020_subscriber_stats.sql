-- Замеры числа подписчиков каналов для графика роста.
-- Раз в день edge-функция snapshot-subscribers спрашивает у Telegram
-- getChatMemberCount по каждому чату и пишет снимок (один на чат в день).

create table public.chat_subscriber_stats (
  id            uuid primary key default gen_random_uuid(),
  chat_id       uuid not null references public.chats (id) on delete cascade,
  snapshot_date date not null,
  member_count  integer not null,
  captured_at   timestamptz not null default now(),
  unique (chat_id, snapshot_date)
);

create index idx_chat_sub_stats_chat_date on public.chat_subscriber_stats (chat_id, snapshot_date);

alter table public.chat_subscriber_stats enable row level security;

-- Пользователь видит статистику только своих каналов (пишет service_role)
create policy "chat_sub_stats_owner_select" on public.chat_subscriber_stats
  for select using (
    exists (select 1 from public.chats c where c.id = chat_id and c.user_id = (select auth.uid()))
  );

-- Ежедневный замер в 00:10 МСК (21:10 UTC)
select cron.schedule('vibepost-subscribers', '10 21 * * *', $cron$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'vibepost_project_url') || '/functions/v1/snapshot-subscribers',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'vibepost_service_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
$cron$);
