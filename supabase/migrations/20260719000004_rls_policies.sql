-- Row Level Security: каждый пользователь видит и меняет ТОЛЬКО свои данные.
-- Edge Functions работают через service_role (обходит RLS), но обязаны сами
-- проверять владельца записи.
-- auth.uid() обёрнут в (select ...) — так Postgres вычисляет его один раз
-- на запрос, а не на каждую строку.

-- ---------------------------------------------------------------------------
-- Включаем RLS на всех 11 таблицах
-- ---------------------------------------------------------------------------
alter table public.profiles           enable row level security;
alter table public.bots               enable row level security;
alter table public.chats              enable row level security;
alter table public.message_templates  enable row level security;
alter table public.posts              enable row level security;
alter table public.message_chains     enable row level security;
alter table public.chain_steps        enable row level security;
alter table public.active_chains      enable row level security;
alter table public.active_chain_steps enable row level security;
alter table public.post_analytics     enable row level security;
alter table public.notifications      enable row level security;

-- ---------------------------------------------------------------------------
-- profiles: читать и менять только свой профиль.
-- Создание — только триггером (security definer), удаление — каскадом.
-- ---------------------------------------------------------------------------
create policy "profiles_select_own" on public.profiles
  for select using ((select auth.uid()) = id);

create policy "profiles_update_own" on public.profiles
  for update using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- ---------------------------------------------------------------------------
-- Таблицы с прямым user_id: полный доступ владельца
-- ---------------------------------------------------------------------------
create policy "bots_owner_all" on public.bots
  for all using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "chats_owner_all" on public.chats
  for all using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "message_templates_owner_all" on public.message_templates
  for all using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "posts_owner_all" on public.posts
  for all using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "message_chains_owner_all" on public.message_chains
  for all using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "active_chains_owner_all" on public.active_chains
  for all using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "notifications_owner_all" on public.notifications
  for all using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- chain_steps: доступ через владельца родительской цепочки
-- ---------------------------------------------------------------------------
create policy "chain_steps_owner_all" on public.chain_steps
  for all using (
    exists (
      select 1 from public.message_chains mc
      where mc.id = chain_id and mc.user_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1 from public.message_chains mc
      where mc.id = chain_id and mc.user_id = (select auth.uid())
    )
  );

-- ---------------------------------------------------------------------------
-- active_chain_steps: пользователю — только чтение (пишет планировщик
-- через service_role)
-- ---------------------------------------------------------------------------
create policy "active_chain_steps_owner_select" on public.active_chain_steps
  for select using (
    exists (
      select 1 from public.active_chains ac
      where ac.id = active_chain_id and ac.user_id = (select auth.uid())
    )
  );

-- ---------------------------------------------------------------------------
-- post_analytics: пользователю — только чтение (пишут планировщик и вебхук)
-- ---------------------------------------------------------------------------
create policy "post_analytics_owner_select" on public.post_analytics
  for select using (
    exists (
      select 1 from public.chats c
      where c.id = chat_id and c.user_id = (select auth.uid())
    )
  );
