-- Связь «ролик ТикТока ↔ карточка завода» (12.10.2026).
-- Заказчица выкладывает в ТикТок со СВОИМИ подписями и хэштегами, поэтому по
-- тексту описания ни один из 76 роликов не связывался с карточкой, и аналитика
-- не видела, какой зверь, какая съёмка и какой замер дают просмотры.
-- Опознание — по обложке и подписи: Edge Function tiktok-opoznanie показывает
-- их Gemini вместе со списком карточек за 45 дней до выхода ролика.
create table if not exists public.tiktok_kartochki (
  external_video_id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  incoming_video_id uuid references public.incoming_videos (id) on delete set null,
  zver text,
  uverennost numeric,
  ne_nash boolean not null default false,
  poyasnenie text,
  opoznano_at timestamptz not null default now()
);
alter table public.tiktok_kartochki enable row level security;
drop policy if exists "tiktok_kartochki_owner_read" on public.tiktok_kartochki;
create policy "tiktok_kartochki_owner_read" on public.tiktok_kartochki
  for select using (auth.uid() = user_id);

-- Раз в сутки, 07:30 МСК — до утреннего разбора analitika (08:00).
select cron.unschedule(jobid) from cron.job where jobname = 'vibepost-tiktok-opoznanie';
select cron.schedule(
  'vibepost-tiktok-opoznanie',
  '30 4 * * *',
  $$select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'vibepost_project_url') || '/functions/v1/tiktok-opoznanie',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'vibepost_service_key')),
    body := '{"limit":6}'::jsonb, timeout_milliseconds := 140000)$$
);
