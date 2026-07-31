-- Идеи роликов серии «уличное интервью»: Gemini предлагает, владелица
-- утверждает кнопками в боте. Развилка route: self — делает сама в приложении
-- Gemini (бесплатно), paid — генерируем через Veo (платно).
create table public.video_ideas (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  slug text not null,
  animal text,
  hook text not null,          -- надпись-хук сверху ролика, капсом
  line text not null,          -- реплика зверя, её же ставим подписью к посту
  prompt text not null,        -- промпт для видеомодели, по-английски
  status text not null default 'new'
    check (status in ('new', 'approved', 'rejected', 'generating', 'done')),
  route text check (route in ('self', 'paid')),
  tg_message_id bigint,        -- карточка в боте, чтобы поправить кнопки после нажатия
  video_url text,
  error text,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index idx_video_ideas_user on public.video_ideas (user_id, status, created_at desc);

alter table public.video_ideas enable row level security;
create policy "video_ideas_owner_all" on public.video_ideas
  for all using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
