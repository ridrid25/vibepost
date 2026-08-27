-- Учёт опубликованных шортсов (см. shorts-stats/index.ts).
-- Публикация ручная, числа снимает расписание vibepost-shorts-stats раз в
-- 4 часа читательским ключом YouTube. Применено 27.08 через apply_migration;
-- файл здесь — чтобы репозиторий совпадал с базой.
create table if not exists public.published_shorts (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  youtube_id     text not null unique,
  title          text,
  idea_id        uuid references public.video_ideas(id) on delete set null,
  video_id       uuid references public.incoming_videos(id) on delete set null,
  published_at   timestamptz,
  added_at       timestamptz not null default now(),
  views          bigint,
  likes          bigint,
  comments       bigint,
  vph            numeric,
  last_polled_at timestamptz,
  poll_error     text
);
create table if not exists public.published_shorts_stats (
  short_id   uuid not null references public.published_shorts(id) on delete cascade,
  polled_at  timestamptz not null default now(),
  views      bigint,
  likes      bigint,
  comments   bigint,
  primary key (short_id, polled_at)
);
alter table public.published_shorts enable row level security;
alter table public.published_shorts_stats enable row level security;
