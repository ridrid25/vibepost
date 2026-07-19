-- Этап 3: шаблоны.
-- 1) Триггер-страж: пост может ссылаться только на СВОИ бота/чат/шаблон,
--    а чат обязан принадлежать этому же боту. Работает для любых вставок,
--    включая прямые insert из фронтенда.
-- 2) create_post_from_template — пост из шаблона одним вызовом
--    (security invoker: RLS сама скрывает чужие шаблоны).

create or replace function public.validate_post_refs()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.bots b
    where b.id = new.bot_id and b.user_id = new.user_id
  ) then
    raise exception 'Бот не найден или принадлежит другому пользователю';
  end if;

  if not exists (
    select 1 from public.chats c
    where c.id = new.chat_id and c.user_id = new.user_id and c.bot_id = new.bot_id
  ) then
    raise exception 'Чат не найден, принадлежит другому пользователю или привязан к другому боту';
  end if;

  if new.template_id is not null and not exists (
    select 1 from public.message_templates t
    where t.id = new.template_id and t.user_id = new.user_id
  ) then
    raise exception 'Шаблон не найден или принадлежит другому пользователю';
  end if;

  return new;
end;
$$;

revoke execute on function public.validate_post_refs() from public, anon, authenticated;

create trigger trg_posts_validate_refs
  before insert or update of bot_id, chat_id, template_id, user_id on public.posts
  for each row execute function public.validate_post_refs();

create or replace function public.create_post_from_template(
  p_template_id uuid,
  p_bot_id uuid,
  p_chat_id uuid,
  p_scheduled_at timestamptz
)
returns public.posts
language plpgsql
security invoker
set search_path = ''
as $$
declare
  t public.message_templates%rowtype;
  new_post public.posts%rowtype;
begin
  -- security invoker: RLS отдаст шаблон только владельцу
  select * into t from public.message_templates where id = p_template_id;
  if not found then
    raise exception 'Шаблон не найден или недоступен';
  end if;

  insert into public.posts (
    user_id, bot_id, chat_id, template_id,
    format, text, photo_url, poll_question, poll_options, poll_anonymous,
    inline_buttons, is_silent, disable_link_preview,
    scheduled_at, status
  )
  values (
    (select auth.uid()), p_bot_id, p_chat_id, t.id,
    t.format, t.text, t.photo_url, t.poll_question, t.poll_options, t.poll_anonymous,
    t.inline_buttons, t.is_silent, t.disable_link_preview,
    p_scheduled_at, 'scheduled'
  )
  returning * into new_post;

  return new_post;
end;
$$;

revoke execute on function public.create_post_from_template(uuid, uuid, uuid, timestamptz) from public, anon;
grant execute on function public.create_post_from_template(uuid, uuid, uuid, timestamptz) to authenticated, service_role;
