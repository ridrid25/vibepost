-- Этап 4: цепочки (drip-рассылки).
-- 1) retry_count у шагов — те же ретраи, что у постов.
-- 2) claim_due_chain_steps — атомарный захват шагов (SKIP LOCKED),
--    контент берётся из шаблона шага (если задан) или из самого шага;
--    шаги пауз-цепочек не выбираются.
-- 3) resume_chain_shift — возобновление: сдвиг неотправленных шагов
--    на длительность паузы.
-- 4) finalize_done_chains — цепочка done, когда не осталось шагов
--    в scheduled/processing.

alter table public.active_chain_steps
  add column retry_count integer not null default 0;

create or replace function public.claim_due_chain_steps(p_limit integer default 25)
returns table (
  id uuid,
  active_chain_id uuid,
  bot_id uuid,
  chat_id uuid,
  retry_count integer,
  format text,
  text text,
  photo_url text,
  poll_question text,
  poll_options jsonb,
  poll_anonymous boolean,
  inline_buttons jsonb,
  is_silent boolean,
  disable_link_preview boolean
)
language sql
security definer
set search_path = ''
as $$
  with due as (
    select acs.id
    from public.active_chain_steps acs
    join public.active_chains ac on ac.id = acs.active_chain_id
    where acs.status = 'scheduled'
      and acs.scheduled_at <= now()
      and ac.status = 'running'
    order by acs.scheduled_at
    limit p_limit
    for update of acs skip locked
  ),
  claimed as (
    update public.active_chain_steps s
    set status = 'processing'
    from due
    where s.id = due.id
    returning s.id, s.active_chain_id, s.step_id, s.retry_count
  )
  select
    c.id,
    c.active_chain_id,
    ac.bot_id,
    ac.chat_id,
    c.retry_count,
    case when cs.template_id is not null then t.format else cs.format end,
    case when cs.template_id is not null then t.text else cs.text end,
    case when cs.template_id is not null then t.photo_url else cs.photo_url end,
    case when cs.template_id is not null then t.poll_question else cs.poll_question end,
    case when cs.template_id is not null then t.poll_options else cs.poll_options end,
    case when cs.template_id is not null then t.poll_anonymous else cs.poll_anonymous end,
    case when cs.template_id is not null then t.inline_buttons else cs.inline_buttons end,
    case when cs.template_id is not null then t.is_silent else cs.is_silent end,
    case when cs.template_id is not null then t.disable_link_preview else cs.disable_link_preview end
  from claimed c
  join public.active_chains ac on ac.id = c.active_chain_id
  join public.chain_steps cs on cs.id = c.step_id
  left join public.message_templates t on t.id = cs.template_id;
$$;

revoke execute on function public.claim_due_chain_steps(integer) from public, anon, authenticated;
grant execute on function public.claim_due_chain_steps(integer) to service_role;

create or replace function public.resume_chain_shift(p_active_chain_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.active_chain_steps s
  set scheduled_at = s.scheduled_at + (now() - ac.paused_at)
  from public.active_chains ac
  where ac.id = p_active_chain_id
    and s.active_chain_id = ac.id
    and ac.status = 'paused'
    and ac.paused_at is not null
    and s.status = 'scheduled';

  update public.active_chains
  set status = 'running', paused_at = null
  where id = p_active_chain_id and status = 'paused';
end;
$$;

revoke execute on function public.resume_chain_shift(uuid) from public, anon, authenticated;
grant execute on function public.resume_chain_shift(uuid) to service_role;

create or replace function public.finalize_done_chains()
returns integer
language sql
security definer
set search_path = ''
as $$
  with upd as (
    update public.active_chains ac
    set status = 'done'
    where ac.status = 'running'
      and exists (
        select 1 from public.active_chain_steps s
        where s.active_chain_id = ac.id
      )
      and not exists (
        select 1 from public.active_chain_steps s
        where s.active_chain_id = ac.id and s.status in ('scheduled', 'processing')
      )
    returning 1
  )
  select count(*)::integer from upd;
$$;

revoke execute on function public.finalize_done_chains() from public, anon, authenticated;
grant execute on function public.finalize_done_chains() to service_role;
