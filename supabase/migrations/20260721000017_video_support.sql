-- Поддержка формата «видео» (короткие ролики через Telegram sendVideo).
-- 1) Разрешаем format='video' в постах, шаблонах и шагах цепочек.
-- 2) Ссылка на файл видео — колонка video_url (в тот же бакет post-photos).
-- 3) Пересоздаём claim_due_chain_steps с video_url в выборке.

alter table public.posts             drop constraint if exists posts_format_check;
alter table public.message_templates drop constraint if exists message_templates_format_check;
alter table public.chain_steps       drop constraint if exists chain_steps_format_check;

alter table public.posts
  add constraint posts_format_check check (format in ('text', 'photo', 'poll', 'video'));
alter table public.message_templates
  add constraint message_templates_format_check check (format in ('text', 'photo', 'poll', 'video'));
alter table public.chain_steps
  add constraint chain_steps_format_check check (format in ('text', 'photo', 'poll', 'video'));

alter table public.posts             add column if not exists video_url text;
alter table public.message_templates add column if not exists video_url text;
alter table public.chain_steps       add column if not exists video_url text;

drop function if exists public.claim_due_chain_steps(integer);

create function public.claim_due_chain_steps(p_limit integer default 25)
returns table (
  id uuid,
  active_chain_id uuid,
  user_id uuid,
  bot_id uuid,
  chat_id uuid,
  retry_count integer,
  format text,
  text text,
  photo_url text,
  video_url text,
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
    ac.user_id,
    ac.bot_id,
    ac.chat_id,
    c.retry_count,
    case when cs.template_id is not null then t.format else cs.format end,
    case when cs.template_id is not null then t.text else cs.text end,
    case when cs.template_id is not null then t.photo_url else cs.photo_url end,
    case when cs.template_id is not null then t.video_url else cs.video_url end,
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
