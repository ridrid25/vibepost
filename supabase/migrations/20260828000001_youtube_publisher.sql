-- YouTube-публикатор: аккаунт канала, одноразовые OAuth state, очередь публикаций.
-- Токены — только в Vault, по образцу tiktok_accounts.
-- Применена в облаке 28.08.2026 (apply_migration youtube_publisher_foundation).

create table public.youtube_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  channel_id text not null,
  channel_title text,
  scopes text[] not null default '{}',
  token_secret_id uuid,
  token_generation bigint not null default 0,
  access_expires_at timestamptz,
  auth_status text not null default 'active'
    check (auth_status in ('active', 'error', 'reauth_required')),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, channel_id),
  unique (id, user_id)
);
alter table public.youtube_accounts enable row level security;
create policy "youtube_accounts_owner_read" on public.youtube_accounts
  for select using ((select auth.uid()) = user_id);

create table public.youtube_oauth_states (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  state_hash text not null unique,
  redirect_uri text not null,
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index idx_youtube_oauth_states_expiry on public.youtube_oauth_states (expires_at);
alter table public.youtube_oauth_states enable row level security;

create or replace function public.consume_youtube_oauth_state(p_state_hash text)
returns table (state_id uuid, user_id uuid, redirect_uri text)
language sql
security definer
set search_path = ''
as $$
  update public.youtube_oauth_states as s
     set used_at = now()
   where s.state_hash = p_state_hash
     and s.used_at is null
     and s.expires_at > now()
  returning s.id, s.user_id, s.redirect_uri;
$$;
revoke execute on function public.consume_youtube_oauth_state(text) from public, anon, authenticated;
grant execute on function public.consume_youtube_oauth_state(text) to service_role;

create or replace function public.store_youtube_token_bundle(
  p_account_id uuid,
  p_bundle text,
  p_expected_generation bigint default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
  v_generation bigint;
begin
  select a.token_secret_id, a.token_generation
    into v_secret_id, v_generation
    from public.youtube_accounts a
   where a.id = p_account_id
   for update;
  if not found then
    raise exception 'YouTube account not found';
  end if;
  if p_expected_generation is not null and v_generation <> p_expected_generation then
    raise exception using errcode = '40001', message = 'token_generation_conflict';
  end if;

  if v_secret_id is null then
    v_secret_id := vault.create_secret(
      p_bundle,
      'youtube_account_' || p_account_id::text,
      'VibePost YouTube OAuth token bundle'
    );
  else
    perform vault.update_secret(v_secret_id, p_bundle);
  end if;
  update public.youtube_accounts
     set token_secret_id = v_secret_id,
         token_generation = token_generation + 1,
         updated_at = now()
   where id = p_account_id;
  return v_secret_id;
end;
$$;

create or replace function public.get_youtube_token_bundle(p_account_id uuid)
returns text
language sql
security definer
set search_path = ''
as $$
  select s.decrypted_secret
    from public.youtube_accounts a
    join vault.decrypted_secrets s on s.id = a.token_secret_id
   where a.id = p_account_id;
$$;

revoke execute on function public.store_youtube_token_bundle(uuid, text, bigint)
  from public, anon, authenticated;
revoke execute on function public.get_youtube_token_bundle(uuid)
  from public, anon, authenticated;
grant execute on function public.store_youtube_token_bundle(uuid, text, bigint) to service_role;
grant execute on function public.get_youtube_token_bundle(uuid) to service_role;

-- Очередь публикаций: воркер берёт задания с for update skip locked.
create table public.youtube_publish_queue (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  account_id uuid references public.youtube_accounts (id) on delete set null,
  source text not null default 'tiktok' check (source in ('tiktok', 'incoming', 'manual')),
  title text not null,
  description text not null default '',
  tags text[] not null default '{}',
  storage_bucket text,
  storage_path text,
  video_url text,
  tiktok_video_id text,
  scheduled_at timestamptz not null,
  status text not null default 'scheduled'
    check (status in ('draft', 'scheduled', 'processing', 'published', 'failed')),
  youtube_video_id text,
  attempts integer not null default 0,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_youtube_publish_queue_due
  on public.youtube_publish_queue (status, scheduled_at);
alter table public.youtube_publish_queue enable row level security;
create policy "youtube_publish_queue_owner_read" on public.youtube_publish_queue
  for select using ((select auth.uid()) = user_id);

-- Захват срочных заданий очереди публикации: for update skip locked,
-- статус processing — двойная загрузка исключена (правило планировщика №4).
-- Применено отдельной миграцией youtube_publish_claim 28.08.
create or replace function public.claim_due_youtube_publish(p_limit integer default 1)
returns setof public.youtube_publish_queue
language sql
security definer
set search_path = ''
as $$
  update public.youtube_publish_queue q
     set status = 'processing',
         attempts = q.attempts + 1,
         updated_at = now()
   where q.id in (
     select id from public.youtube_publish_queue
      where status = 'scheduled'
        and scheduled_at <= now()
      order by scheduled_at
      limit greatest(p_limit, 1)
      for update skip locked
   )
  returning q.*;
$$;
revoke execute on function public.claim_due_youtube_publish(integer) from public, anon, authenticated;
grant execute on function public.claim_due_youtube_publish(integer) to service_role;

-- Возобновление очереди после «стоп ютуб» (применено миграцией
-- youtube_queue_resume 28.08). Будущие сроки не трогаем; просроченные
-- разводим по 5 часов — квота пускает ~6 загрузок в сутки.
create or replace function public.youtube_queue_resume(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  with due as (
    select id, row_number() over (order by scheduled_at) as rn
      from public.youtube_publish_queue
     where user_id = p_user_id and status = 'draft'
  )
  update public.youtube_publish_queue q
     set status = 'scheduled',
         scheduled_at = case
           when q.scheduled_at > now() then q.scheduled_at
           else now() + (d.rn * interval '5 hours')
         end,
         updated_at = now()
    from due d
   where q.id = d.id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke execute on function public.youtube_queue_resume(uuid) from public, anon, authenticated;
grant execute on function public.youtube_queue_resume(uuid) to service_role;

-- ── Музыка (применено миграциями youtube_queue_music, youtube_music_library,
--    youtube_music_mixed_at, music_tracks_attribution — 28.08) ──────────────
-- Татьяна выбирает трек к ролику в приложении; микшер вшивает и ставит в
-- расписание. Фонотека наполнена треками Kevin MacLeod (CC BY 4.0).

create table public.music_tracks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null,
  storage_bucket text not null default 'post-photos',
  storage_path text not null,
  attribution text,
  created_at timestamptz not null default now()
);
alter table public.music_tracks enable row level security;
create policy "music_tracks_owner_all" on public.music_tracks
  for all using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

alter table public.youtube_publish_queue
  add column music_storage_path text,
  add column music_added_at timestamptz,
  add column music_mixed_at timestamptz,
  add column incoming_video_id uuid references public.incoming_videos (id) on delete set null,
  add column music_track_id uuid references public.music_tracks (id) on delete set null;

create policy "youtube_publish_queue_owner_insert" on public.youtube_publish_queue
  for insert with check ((select auth.uid()) = user_id);
create policy "youtube_publish_queue_owner_update" on public.youtube_publish_queue
  for update using ((select auth.uid()) = user_id and status in ('draft', 'scheduled', 'failed'))
  with check ((select auth.uid()) = user_id);
create policy "youtube_publish_queue_owner_delete" on public.youtube_publish_queue
  for delete using ((select auth.uid()) = user_id and status in ('draft', 'scheduled', 'failed'));
revoke update on public.youtube_publish_queue from authenticated;
grant update (title, description, tags, music_track_id, music_storage_path, music_added_at)
  on public.youtube_publish_queue to authenticated;

-- ── Заливка в студию скрытым (применено миграцией youtube_queue_uploaded_status,
--    28.08 ночь) ─────────────────────────────────────────────────────────────
-- status='uploaded' = ролик в студии с publishAt, публикует сам YouTube.
alter table public.youtube_publish_queue
  drop constraint youtube_publish_queue_status_check;
alter table public.youtube_publish_queue
  add constraint youtube_publish_queue_status_check
  check (status in ('draft', 'scheduled', 'processing', 'uploaded', 'published', 'failed'));

-- Захват — за 48 часов до выхода (замена той же функции).
create or replace function public.claim_due_youtube_publish(p_limit integer default 1)
returns setof public.youtube_publish_queue
language sql
security definer
set search_path = ''
as $$
  update public.youtube_publish_queue q
     set status = 'processing',
         attempts = q.attempts + 1,
         updated_at = now()
   where q.id in (
     select id from public.youtube_publish_queue
      where status = 'scheduled'
        and scheduled_at <= now() + interval '48 hours'
      order by scheduled_at
      limit greatest(p_limit, 1)
      for update skip locked
   )
  returning q.*;
$$;

-- 31.08: описание — свойство ролика, не площадки (одно на YouTube/ТикТок/Дзен).
alter table public.youtube_publish_queue add column if not exists description_options jsonb;
alter table public.incoming_videos
  add column if not exists description_options jsonb,
  add column if not exists post_description text;
grant update (post_description) on public.incoming_videos to authenticated;
