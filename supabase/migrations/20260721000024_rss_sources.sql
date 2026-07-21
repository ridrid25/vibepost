-- Автопостинг из RSS/Atom-лент.
create table public.rss_sources (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users (id) on delete cascade,
  bot_id          uuid not null references public.bots (id) on delete cascade,
  chat_id         uuid not null references public.chats (id) on delete cascade,
  feed_url        text not null,
  name            text,
  include_link    boolean not null default true,
  include_desc    boolean not null default true,
  is_active       boolean not null default true,
  last_checked_at timestamptz,
  created_at      timestamptz not null default now()
);
create index idx_rss_sources_user on public.rss_sources (user_id);
create index idx_rss_sources_active on public.rss_sources (is_active);

alter table public.rss_sources enable row level security;
create policy "rss_sources_owner_all" on public.rss_sources
  for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create or replace function public.validate_rss_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.bots b where b.id = new.bot_id and b.user_id = new.user_id) then
    raise exception 'Бот не найден или принадлежит другому пользователю';
  end if;
  if not exists (select 1 from public.chats c where c.id = new.chat_id and c.user_id = new.user_id and c.bot_id = new.bot_id) then
    raise exception 'Чат не найден, чужой или привязан к другому боту';
  end if;
  return new;
end; $$;
revoke execute on function public.validate_rss_refs() from public, anon, authenticated;
create trigger trg_rss_sources_validate
  before insert or update of bot_id, chat_id, user_id on public.rss_sources
  for each row execute function public.validate_rss_refs();

create table public.rss_seen_items (
  id         uuid primary key default gen_random_uuid(),
  source_id  uuid not null references public.rss_sources (id) on delete cascade,
  guid       text not null,
  created_at timestamptz not null default now(),
  unique (source_id, guid)
);
create index idx_rss_seen_source on public.rss_seen_items (source_id, created_at desc);
alter table public.rss_seen_items enable row level security;

select cron.schedule('vibepost-rss', '*/15 * * * *', $cron$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'vibepost_project_url') || '/functions/v1/fetch-rss',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'vibepost_service_key')),
    body := '{}'::jsonb, timeout_milliseconds := 55000);
$cron$);
