-- Основная схема VibePost: 11 таблиц по ТЗ (docs/01_TZ.md, раздел 3).
-- Всё время — timestamptz (UTC). Отображение в МСК — забота фронтенда.

-- ---------------------------------------------------------------------------
-- profiles — профиль пользователя (создаётся триггером при регистрации)
-- ---------------------------------------------------------------------------
create table public.profiles (
  id                  uuid primary key references auth.users (id) on delete cascade,
  timezone            text not null default 'Europe/Moscow',
  error_notify_tg_id  text,
  error_notify_bot_id uuid, -- FK на bots добавляется ниже, после создания bots
  created_at          timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- bots — подключённые Telegram-боты. Токен хранится ТОЛЬКО в Vault,
-- здесь лишь ссылка на секрет (token_secret_id).
-- ---------------------------------------------------------------------------
create table public.bots (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  name            text not null,
  username        text,
  token_secret_id uuid,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now()
);

alter table public.profiles
  add constraint profiles_error_notify_bot_id_fkey
  foreign key (error_notify_bot_id) references public.bots (id) on delete set null;

-- ---------------------------------------------------------------------------
-- chats — каналы/чаты, привязанные к ботам
-- ---------------------------------------------------------------------------
create table public.chats (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  bot_id           uuid not null references public.bots (id) on delete cascade,
  title            text,
  telegram_chat_id text not null,
  type             text not null check (type in ('private', 'channel', 'group')),
  created_at       timestamptz not null default now(),
  unique (bot_id, telegram_chat_id)
);

-- ---------------------------------------------------------------------------
-- message_templates — шаблоны сообщений
-- ---------------------------------------------------------------------------
create table public.message_templates (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users (id) on delete cascade,
  name                 text not null,
  format               text not null check (format in ('text', 'photo', 'poll')),
  text                 text,
  photo_url            text,
  poll_question        text,
  poll_options         jsonb,
  poll_anonymous       boolean not null default true,
  inline_buttons       jsonb,
  is_silent            boolean not null default false,
  disable_link_preview boolean not null default false,
  created_at           timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- posts — отложенные посты
-- ---------------------------------------------------------------------------
create table public.posts (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users (id) on delete cascade,
  bot_id               uuid not null references public.bots (id) on delete cascade,
  chat_id              uuid not null references public.chats (id) on delete cascade,
  template_id          uuid references public.message_templates (id) on delete set null,
  format               text not null default 'text' check (format in ('text', 'photo', 'poll')),
  text                 text,
  photo_url            text,
  poll_question        text,
  poll_options         jsonb,
  poll_anonymous       boolean not null default true,
  inline_buttons       jsonb,
  is_silent            boolean not null default false,
  disable_link_preview boolean not null default false,
  scheduled_at         timestamptz not null,
  status               text not null default 'scheduled'
                       check (status in ('draft', 'scheduled', 'processing', 'sent', 'failed')),
  tg_message_id        bigint,
  error                text,
  retry_count          integer not null default 0,
  sent_at              timestamptz,
  created_at           timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- message_chains — шаблоны цепочек (drip-рассылок)
-- ---------------------------------------------------------------------------
create table public.message_chains (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  name       text not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- chain_steps — шаги цепочки: либо ссылка на шаблон, либо инлайн-контент
-- ---------------------------------------------------------------------------
create table public.chain_steps (
  id                   uuid primary key default gen_random_uuid(),
  chain_id             uuid not null references public.message_chains (id) on delete cascade,
  position             integer not null,
  delay_minutes        integer not null check (delay_minutes >= 0),
  template_id          uuid references public.message_templates (id) on delete set null,
  format               text check (format in ('text', 'photo', 'poll')),
  text                 text,
  photo_url            text,
  poll_question        text,
  poll_options         jsonb,
  poll_anonymous       boolean not null default true,
  inline_buttons       jsonb,
  is_silent            boolean not null default false,
  disable_link_preview boolean not null default false,
  created_at           timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- active_chains — запущенные цепочки
-- ---------------------------------------------------------------------------
create table public.active_chains (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  chain_id   uuid not null references public.message_chains (id) on delete cascade,
  bot_id     uuid not null references public.bots (id) on delete cascade,
  chat_id    uuid not null references public.chats (id) on delete cascade,
  status     text not null default 'running' check (status in ('running', 'paused', 'done')),
  started_at timestamptz not null default now(),
  paused_at  timestamptz,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- active_chain_steps — конкретные запланированные шаги запущенной цепочки
-- ---------------------------------------------------------------------------
create table public.active_chain_steps (
  id              uuid primary key default gen_random_uuid(),
  active_chain_id uuid not null references public.active_chains (id) on delete cascade,
  step_id         uuid not null references public.chain_steps (id) on delete cascade,
  scheduled_at    timestamptz not null,
  status          text not null default 'scheduled'
                  check (status in ('scheduled', 'processing', 'sent', 'failed', 'skipped')),
  tg_message_id   bigint,
  error           text,
  sent_at         timestamptz,
  unique (active_chain_id, step_id)
);

-- ---------------------------------------------------------------------------
-- post_analytics — аналитика по отправленным сообщениям.
-- views всегда 0: Bot API не отдаёт просмотры (ограничение платформы).
-- ---------------------------------------------------------------------------
create table public.post_analytics (
  id                   uuid primary key default gen_random_uuid(),
  post_id              uuid references public.posts (id) on delete cascade,
  active_chain_step_id uuid references public.active_chain_steps (id) on delete cascade,
  chat_id              uuid not null references public.chats (id) on delete cascade,
  tg_message_id        bigint not null,
  views                integer not null default 0,
  reactions            jsonb not null default '{}',
  reactions_count      integer not null default 0,
  updated_at           timestamptz not null default now(),
  unique (chat_id, tg_message_id)
);

-- ---------------------------------------------------------------------------
-- notifications — уведомления пользователю (ошибки отправки и т.п.)
-- ---------------------------------------------------------------------------
create table public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  type       text not null,
  message    text not null,
  is_read    boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Индексы
-- ---------------------------------------------------------------------------
-- Рабочие индексы планировщика (из ТЗ)
create index idx_posts_status_scheduled_at on public.posts (status, scheduled_at);
create index idx_active_chain_steps_status_scheduled_at on public.active_chain_steps (status, scheduled_at);
-- (chat_id, tg_message_id) в post_analytics покрыт unique-констрейнтом выше

-- Индексы по внешним ключам и user_id (быстрые RLS-проверки и join'ы)
create index idx_bots_user_id on public.bots (user_id);
create index idx_chats_user_id on public.chats (user_id);
create index idx_chats_bot_id on public.chats (bot_id);
create index idx_message_templates_user_id on public.message_templates (user_id);
create index idx_posts_user_id on public.posts (user_id);
create index idx_posts_bot_id on public.posts (bot_id);
create index idx_posts_chat_id on public.posts (chat_id);
create index idx_posts_template_id on public.posts (template_id);
create index idx_message_chains_user_id on public.message_chains (user_id);
create index idx_chain_steps_chain_id on public.chain_steps (chain_id);
create index idx_chain_steps_template_id on public.chain_steps (template_id);
create index idx_active_chains_user_id on public.active_chains (user_id);
create index idx_active_chains_chain_id on public.active_chains (chain_id);
create index idx_active_chains_bot_id on public.active_chains (bot_id);
create index idx_active_chains_chat_id on public.active_chains (chat_id);
create index idx_active_chain_steps_step_id on public.active_chain_steps (step_id);
create index idx_post_analytics_post_id on public.post_analytics (post_id);
create index idx_post_analytics_active_chain_step_id on public.post_analytics (active_chain_step_id);
create index idx_notifications_user_id_is_read on public.notifications (user_id, is_read);
create index idx_profiles_error_notify_bot_id on public.profiles (error_notify_bot_id);

-- ---------------------------------------------------------------------------
-- Триггер updated_at для post_analytics
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger trg_post_analytics_updated_at
  before update on public.post_analytics
  for each row execute function public.set_updated_at();
