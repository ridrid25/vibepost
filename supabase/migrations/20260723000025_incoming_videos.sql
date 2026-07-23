-- Входящие ролики от внешнего конвейера. Приёмник — Edge Function ingest-video.
create table public.incoming_videos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text, prompt text, source text, caption text,
  video_url text not null,
  status text not null default 'new' check (status in ('new','scheduled','dismissed')),
  created_at timestamptz not null default now()
);
create index idx_incoming_videos_user on public.incoming_videos (user_id, status, created_at desc);
alter table public.incoming_videos enable row level security;
create policy "incoming_videos_owner_all" on public.incoming_videos
  for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create or replace function public.store_ingest_config(p_secret text, p_owner uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v uuid;
begin
  select id into v from vault.secrets where name = 'vibepost_ingest_secret';
  if v is null then perform vault.create_secret(p_secret, 'vibepost_ingest_secret', 'VibePost: секрет ingest-video');
  else perform vault.update_secret(v, p_secret); end if;
  select id into v from vault.secrets where name = 'vibepost_ingest_owner';
  if v is null then perform vault.create_secret(p_owner::text, 'vibepost_ingest_owner', 'VibePost: владелец входящих роликов');
  else perform vault.update_secret(v, p_owner::text); end if;
  return 'ok';
end; $$;
revoke execute on function public.store_ingest_config(text, uuid) from public, anon, authenticated;
grant execute on function public.store_ingest_config(text, uuid) to service_role;

create or replace function public.get_ingest_secret()
returns text language sql security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'vibepost_ingest_secret'; $$;
revoke execute on function public.get_ingest_secret() from public, anon, authenticated;
grant execute on function public.get_ingest_secret() to service_role;

create or replace function public.get_ingest_owner()
returns text language sql security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'vibepost_ingest_owner'; $$;
revoke execute on function public.get_ingest_owner() from public, anon, authenticated;
grant execute on function public.get_ingest_owner() to service_role;
