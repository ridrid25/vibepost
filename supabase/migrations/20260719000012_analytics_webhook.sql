-- Этап 5: аналитика реакций.
-- 1) Секрет вебхука хранится в Vault: setup_webhook_secret кладёт,
--    get_webhook_secret отдаёт (только service_role).
-- 2) set_reactions — полная замена счётчиков (из message_reaction_count).
-- 3) apply_reaction_delta — прибавка/убавка отдельных реакций
--    (из message_reaction: старый и новый набор от одного пользователя).

create or replace function public.setup_webhook_secret(p_secret text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
begin
  select id into v_secret_id from vault.secrets where name = 'vibepost_webhook_secret';
  if v_secret_id is null then
    perform vault.create_secret(p_secret, 'vibepost_webhook_secret', 'VibePost: секрет telegram-webhook');
  else
    perform vault.update_secret(v_secret_id, p_secret);
  end if;
  return 'ok';
end;
$$;

revoke execute on function public.setup_webhook_secret(text) from public, anon, authenticated;
grant execute on function public.setup_webhook_secret(text) to service_role;

create or replace function public.get_webhook_secret()
returns text
language sql
security definer
set search_path = ''
as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'vibepost_webhook_secret';
$$;

revoke execute on function public.get_webhook_secret() from public, anon, authenticated;
grant execute on function public.get_webhook_secret() to service_role;

-- Полная замена счётчиков реакций (message_reaction_count даёт агрегат)
create or replace function public.set_reactions(
  p_telegram_chat_id text,
  p_tg_message_id bigint,
  p_reactions jsonb,
  p_reactions_count integer
)
returns integer
language sql
security definer
set search_path = ''
as $$
  with upd as (
    update public.post_analytics pa
    set reactions = p_reactions,
        reactions_count = p_reactions_count
    from public.chats c
    where c.id = pa.chat_id
      and c.telegram_chat_id = p_telegram_chat_id
      and pa.tg_message_id = p_tg_message_id
    returning 1
  )
  select count(*)::integer from upd;
$$;

revoke execute on function public.set_reactions(text, bigint, jsonb, integer) from public, anon, authenticated;
grant execute on function public.set_reactions(text, bigint, jsonb, integer) to service_role;

-- Дельта реакций одного пользователя (message_reaction: old/new наборы)
create or replace function public.apply_reaction_delta(
  p_telegram_chat_id text,
  p_tg_message_id bigint,
  p_added text[],
  p_removed text[]
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated integer := 0;
  rec record;
  v_reactions jsonb;
  emoji text;
  cnt integer;
begin
  for rec in
    select pa.id, pa.reactions
    from public.post_analytics pa
    join public.chats c on c.id = pa.chat_id
    where c.telegram_chat_id = p_telegram_chat_id
      and pa.tg_message_id = p_tg_message_id
    for update of pa
  loop
    v_reactions := coalesce(rec.reactions, '{}'::jsonb);

    foreach emoji in array coalesce(p_added, '{}') loop
      cnt := coalesce((v_reactions ->> emoji)::integer, 0) + 1;
      v_reactions := jsonb_set(v_reactions, array[emoji], to_jsonb(cnt));
    end loop;

    foreach emoji in array coalesce(p_removed, '{}') loop
      cnt := greatest(0, coalesce((v_reactions ->> emoji)::integer, 0) - 1);
      if cnt = 0 then
        v_reactions := v_reactions - emoji;
      else
        v_reactions := jsonb_set(v_reactions, array[emoji], to_jsonb(cnt));
      end if;
    end loop;

    update public.post_analytics
    set reactions = v_reactions,
        reactions_count = (
          select coalesce(sum(value::integer), 0)
          from jsonb_each_text(v_reactions)
        )
    where id = rec.id;

    v_updated := v_updated + 1;
  end loop;

  return v_updated;
end;
$$;

revoke execute on function public.apply_reaction_delta(text, bigint, text[], text[]) from public, anon, authenticated;
grant execute on function public.apply_reaction_delta(text, bigint, text[], text[]) to service_role;
