-- Задания на генерацию ролика через Veo. Генерация идёт минутами, поэтому
-- отправка и получение разнесены: одна функция ставит задание, другая раз в
-- минуту опрашивает Google и немедленно забирает готовый файл.
create table public.veo_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  idea_id uuid references public.video_ideas (id) on delete set null,
  operation text not null,
  model text not null,
  status text not null default 'running'
    check (status in ('running', 'done', 'failed')),
  error text,
  video_url text,
  cost_usd numeric(8,3) not null default 0,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index idx_veo_jobs_running on public.veo_jobs (status, created_at)
  where status = 'running';

alter table public.veo_jobs enable row level security;
create policy "veo_jobs_owner_all" on public.veo_jobs
  for all using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Согласие на траты и месячный лимит: без согласия генерация не запускается.
alter table public.profiles
  add column veo_confirmed_at timestamptz,
  add column veo_month_limit_usd numeric(8,2) not null default 15;

-- Потрачено за текущий месяц и что осталось от лимита.
create or replace function public.veo_spend(p_user uuid)
returns table (
  за_месяц_usd numeric,
  лимит_usd numeric,
  осталось_usd numeric,
  роликов_за_месяц integer
) language sql security definer set search_path = '' as $$
  select
    coalesce(sum(j.cost_usd), 0)::numeric(8,2),
    p.veo_month_limit_usd,
    greatest(p.veo_month_limit_usd - coalesce(sum(j.cost_usd), 0), 0)::numeric(8,2),
    count(j.id)::int
  from public.profiles p
  left join public.veo_jobs j
    on j.user_id = p.id
   and j.status <> 'failed'
   and j.created_at >= date_trunc('month', now())
  where p.id = p_user
  group by p.veo_month_limit_usd;
$$;
revoke execute on function public.veo_spend(uuid) from public, anon;
grant execute on function public.veo_spend(uuid) to service_role, authenticated;
