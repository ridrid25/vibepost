-- Работа с токенами ботов через Supabase Vault.
-- Токен в открытом виде живёт ТОЛЬКО в Vault; таблица bots хранит лишь
-- token_secret_id. Функции доступны исключительно service_role
-- (то есть только Edge Functions) — фронтенд вызвать их не может.

-- Сохранить токен, вернуть id секрета
create or replace function public.store_bot_token(p_token text)
returns uuid
language sql
security definer
set search_path = ''
as $$
  select vault.create_secret(p_token, 'bot_token_' || gen_random_uuid()::text, 'Telegram bot token (VibePost)');
$$;

-- Достать токен по id секрета
create or replace function public.get_bot_token(p_secret_id uuid)
returns text
language sql
security definer
set search_path = ''
as $$
  select decrypted_secret from vault.decrypted_secrets where id = p_secret_id;
$$;

-- Удалить секрет
create or replace function public.delete_bot_token(p_secret_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from vault.secrets where id = p_secret_id;
$$;

-- Только service_role может вызывать эти функции
revoke execute on function public.store_bot_token(text) from public, anon, authenticated;
revoke execute on function public.get_bot_token(uuid) from public, anon, authenticated;
revoke execute on function public.delete_bot_token(uuid) from public, anon, authenticated;
grant execute on function public.store_bot_token(text) to service_role;
grant execute on function public.get_bot_token(uuid) to service_role;
grant execute on function public.delete_bot_token(uuid) to service_role;

-- При удалении бота автоматически чистим его секрет из Vault
create or replace function public.cleanup_bot_token()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.token_secret_id is not null then
    delete from vault.secrets where id = old.token_secret_id;
  end if;
  return old;
end;
$$;

revoke execute on function public.cleanup_bot_token() from public, anon, authenticated;

create trigger trg_bots_cleanup_token
  after delete on public.bots
  for each row execute function public.cleanup_bot_token();
