-- Автопост курсов валют/крипты: настройка на канал + ежедневный запуск.
create table public.rate_configs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  bot_id      uuid not null references public.bots (id) on delete cascade,
  chat_id     uuid not null references public.chats (id) on delete cascade,
  fiat        text[] not null default '{USD,EUR}',
  crypto      text[] not null default '{}',
  crypto_vs   text not null default 'usd' check (crypto_vs in ('usd', 'rub')),
  header      text,
  show_change boolean not null default true,
  hour        integer not null check (hour between 0 and 23),
  minute      integer not null check (minute between 0 and 59),
  is_active   boolean not null default true,
  next_run_at timestamptz,
  created_at  timestamptz not null default now()
);
create index idx_rate_configs_user on public.rate_configs (user_id);
create index idx_rate_configs_due on public.rate_configs (is_active, next_run_at);

alter table public.rate_configs enable row level security;
create policy "rate_configs_owner_all" on public.rate_configs
  for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create or replace function public.validate_rate_refs()
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
revoke execute on function public.validate_rate_refs() from public, anon, authenticated;
create trigger trg_rate_configs_validate
  before insert or update of bot_id, chat_id, user_id on public.rate_configs
  for each row execute function public.validate_rate_refs();

create or replace function public.rate_config_set_next()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' or new.hour is distinct from old.hour or new.minute is distinct from old.minute then
    new.next_run_at := public.recurring_compute_next('daily', null, null, new.hour, new.minute, now());
  end if;
  return new;
end; $$;
revoke execute on function public.rate_config_set_next() from public, anon, authenticated;
create trigger trg_rate_configs_set_next
  before insert or update on public.rate_configs
  for each row execute function public.rate_config_set_next();

grant execute on function public.recurring_compute_next(text, integer[], integer, integer, integer, timestamptz) to service_role;

select cron.schedule('vibepost-rates', '*/5 * * * *', $cron$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'vibepost_project_url') || '/functions/v1/post-rates',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'vibepost_service_key')),
    body := '{}'::jsonb, timeout_milliseconds := 55000);
$cron$);
